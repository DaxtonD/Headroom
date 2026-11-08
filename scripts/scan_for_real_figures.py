"""Fail if a real household figure has made it into a tracked file.

Dax's standing rule is that no real financial data goes into git, ever. The
risk is not a reckless paste; it is the small, reasonable-looking one. While
building the mortgage engine, four real figures ended up in source comments and
test expectations in a single sitting - a basis-point example, a "reject a
fractional rate" case, the real annual prepayment cap, and the real prepayment
history - every one of them chosen because it was the number already in mind.

So this script does not hard-code anything to look for. That would put the
figures in a committed file and defeat its own purpose. Instead it reads the
git-ignored seed on this machine, treats every amount in it as a needle, and
searches the tracked tree for them.

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
    hits across the tree, effectively all of them coincidence: a `sortIndex`
    capped at 100_000, test amounts of 200000, a documented $186.00 that is the
    codebase's own cautionary tale. Every one of those would have to be
    allowlisted, and a gate with a 140-line allowlist is a gate nobody reads.

    So this deliberately trades recall for precision: it catches the figures
    that fingerprint this household and ignores round ones. A round real figure
    - an annual cap, a planned lump sum - will NOT be caught here, so the rule
    still needs care from whoever is writing the code. This is a safety net,
    not a substitute for the rule.
    """
    return value % 100 != 0


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

    amounts: set[int] = set()
    collect_amounts(json.loads(SEED.read_text(encoding="utf-8")), amounts)
    needles = needles_from(amounts)

    allowed: set[str] = set()
    if ALLOWLIST.exists():
        for line in ALLOWLIST.read_text(encoding="utf-8").splitlines():
            entry = line.split("#", 1)[0].strip()
            if entry:
                allowed.add(entry)

    hits: list[str] = []
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

    print(f"Scanned {scanned} tracked file(s) against {len(amounts)} real amount(s).")

    if hits:
        print(f"\n{len(hits)} possible real figure(s) in tracked files:\n")
        print("\n".join(hits))
        print(
            "\nReplace the value with an invented one, or - if it is a genuine "
            "coincidence - add a line to scripts/scan_allowlist.txt."
        )
        return 1

    print("Clean: no real household figure found in a tracked file.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
