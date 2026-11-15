"""Fail if a real household figure or first name has reached a tracked file.

The owner's standing rule is that no real financial data goes into git, ever,
and that the household's first names stay out of anything new. The
risk is not a reckless paste; it is the small, reasonable-looking one. While
building the mortgage engine, four real figures ended up in source comments and
test expectations in a single sitting - a basis-point example, a "reject a
fractional rate" case, the real annual prepayment cap, and the real prepayment
history - every one of them chosen because it was the number already in mind.

So this script does not hard-code anything to look for. That would put the
figures in a committed file and defeat its own purpose. Instead it reads the
git-ignored seed on this machine, treats every amount in it as a needle, and
searches the tracked tree for them.

It does the same for the two first names in the seed's `users`, which is the
only place in this tree that still knows them.

Run:
    python3 scripts/scan_for_real_figures.py            # tracked files
    python3 scripts/scan_for_real_figures.py --staged   # only what is staged

Exits 0 when clean, 1 on a hit, and 0 with a notice when the seed is absent
(CI has no copy, by design, so there is nothing to check there).
"""
from __future__ import annotations

import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SEED = ROOT / "seed" / "household-nov-2026.json"
ALLOWLIST = ROOT / "scripts" / "scan_allowlist.txt"

# Below $10 an amount collides with array indexes, counts and version numbers
# far more often than it reveals anything.
MIN_CENTS = 1_000

# A four-digit year is a date, not an amount, and dates are everywhere.
YEAR_RANGE = range(1900, 2101)

TEXT_SUFFIXES = {
    ".ts", ".tsx", ".js", ".mjs", ".cjs", ".json", ".md", ".sql",
    ".yml", ".yaml", ".css", ".html", ".prisma", ".py", ".txt", ".example",
}

# Files whose whole purpose is to hold the real numbers, or to look for them.
SKIP = {
    "seed/household-nov-2026.json",
    "scripts/scan_for_real_figures.py",
    "scripts/scan_allowlist.txt",
}


def collect_amounts(node: object, found: set[int]) -> None:
    """Every integer in the seed, however deeply nested."""
    if isinstance(node, bool):
        return
    if isinstance(node, int):
        if abs(node) >= MIN_CENTS and node not in YEAR_RANGE:
            found.add(abs(node))
    elif isinstance(node, dict):
        for value in node.values():
            collect_amounts(value, found)
    elif isinstance(node, list):
        for value in node:
            collect_amounts(value, found)


def is_distinctive(value: int) -> bool:
    """
    Would finding this number somewhere actually tell you something?

    A real bank figure almost always carries odd cents - a mortgage payment, a
    paycheque, an account balance. An invented test value almost never does;
    people reach for round hundreds. Scanning for round numbers produced 140
    hits across the tree, almost all of them coincidence: a `sortIndex` capped
    at 100_000, test amounts of 200000. Every one of those would have to be
    allowlisted, and a gate with a 140-line allowlist is a gate nobody reads.

    That blind spot is real, and on 2026-11-15 a hand audit found three round
    figures it had let through: a mortgage payment and a savings transfer
    quoted in comments, and a bill amount used as a worked example in a dozen
    files. What gave each away was not the number but the prose around it -
    the text said the figure was the household's. No gate catches that, so a
    round amount being below the threshold here is not a clearance: do not
    write a real one into a comment and expect this script to object.

    So this deliberately trades recall for precision: it catches the figures
    that fingerprint this household and ignores round ones. A round real figure
    - an annual cap, a planned lump sum - will NOT be caught here, so the rule
    still needs care from whoever is writing the code. This is a safety net,
    not a substitute for the rule.
    """
    return value % 100 != 0


def collect_names(seed: dict) -> set[str]:
    """
    The household's first names, read from the seed rather than written here.

    Same reasoning as the amounts: naming them in a committed file would be the
    leak this script exists to prevent. Matched on a word boundary and case
    insensitively, so the owner's GitHub handle - which is public, appears in
    the remote URL and the image name, and merely starts with one of them - is
    not a hit.
    """
    out: set[str] = set()
    for user in seed.get("users", []):
        name = str(user.get("name", "")).strip()
        key = str(user.get("key", "")).strip()
        for value in (name, key):
            if len(value) >= 3:
                out.add(value.lower())
    return out


def needles_from(cents: set[int]) -> dict[str, int]:
    """Each amount as it might be written: raw cents, and dollars with a point."""
    out: dict[str, int] = {}
    for value in cents:
        if not is_distinctive(value):
            continue
        out[str(value)] = value
        out[f"{value // 100}.{value % 100:02d}"] = value
    return out


def tracked_files(staged_only: bool) -> list[str]:
    if staged_only:
        command = ["git", "diff", "--cached", "--name-only", "--diff-filter=ACMR"]
    else:
        command = ["git", "ls-files"]
    result = subprocess.run(command, cwd=ROOT, capture_output=True, text=True, check=True)
    return [line.strip() for line in result.stdout.splitlines() if line.strip()]


def main() -> int:
    staged_only = "--staged" in sys.argv

    if not SEED.exists():
        print(f"SKIP: {SEED.relative_to(ROOT)} is not on this machine, so there is nothing to scan for.")
        return 0

    seed = json.loads(SEED.read_text(encoding="utf-8"))
    amounts: set[int] = set()
    collect_amounts(seed, amounts)
    needles = needles_from(amounts)
    names = collect_names(seed)
    name_pattern = (
        re.compile(r"\b(" + "|".join(sorted(re.escape(n) for n in names)) + r")\b", re.IGNORECASE)
        if names
        else None
    )

    allowed: set[str] = set()
    if ALLOWLIST.exists():
        for line in ALLOWLIST.read_text(encoding="utf-8").splitlines():
            entry = line.split("#", 1)[0].strip()
            if entry:
                allowed.add(entry)

    hits: list[str] = []
    name_hits: list[str] = []
    scanned = 0

    for relative in tracked_files(staged_only):
        if relative in SKIP:
            continue
        path = ROOT / relative
        if path.suffix not in TEXT_SUFFIXES or not path.is_file():
            continue

        scanned += 1
        text = path.read_text(encoding="utf-8", errors="replace")

        for line_number, line in enumerate(text.splitlines(), 1):
            # `115_887` and `115887` have to compare equal, and a digit run must
            # match in full so that 1300 does not fire inside 213000.
            flat = line.replace("_", "")
            for run in re.findall(r"\d+(?:\.\d+)?", flat):
                value = needles.get(run)
                if value is None:
                    continue
                key = f"{relative}:{run}"
                if key in allowed or run in allowed:
                    continue
                hits.append(f"  {relative}:{line_number}  {run}\n      {line.strip()[:110]}")

            if name_pattern is not None:
                for found in name_pattern.findall(line):
                    key = f"{relative}:{found.lower()}"
                    if key in allowed or found.lower() in allowed:
                        continue
                    name_hits.append(
                        f"  {relative}:{line_number}  (first name)\n      {line.strip()[:110]}"
                    )

    print(
        f"Scanned {scanned} tracked file(s) against {len(amounts)} real amount(s) "
        f"and {len(names)} first name(s)."
    )

    if hits:
        print(f"\n{len(hits)} possible real figure(s) in tracked files:\n")
        print("\n".join(hits))
        print(
            "\nReplace the value with an invented one, or - if it is a genuine "
            "coincidence - add a line to scripts/scan_allowlist.txt."
        )

    if name_hits:
        print(f"\n{len(name_hits)} household first name(s) in tracked files:\n")
        print("\n".join(name_hits))
        print(
            "\nUse a role - 'the owner', 'the household', 'one person' - or one of "
            "the placeholder names the fixtures use."
        )

    if hits or name_hits:
        return 1

    print("Clean: no real household figure or first name in a tracked file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
