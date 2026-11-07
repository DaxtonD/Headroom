"""Recompute every expected number in household-nov-2026.json from its inputs.

Run:  python3 seed/check_seed.py [path-to-seed.json]
This checks the spec itself. The real engine (packages/core) must reproduce the same numbers in its own tests.
"""
import json
import sys
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

DEFAULT_SEED = Path(__file__).parent / "household-nov-2026.json"
seed_path = Path(sys.argv[1]) if len(sys.argv) > 1 else DEFAULT_SEED
if not seed_path.exists():
    print(f"SKIP: {seed_path} not present (real seed is git-ignored; pass a fixture path instead)")
    sys.exit(0)
seed = json.loads(seed_path.read_text(encoding="utf-8"))
fails = []


def check(label, got, want):
    if got != want:
        fails.append(f"{label}: got {got}, want {want}")


def rhu(x):
    return int(Decimal(x).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


# ---- Timeline ----
fx = seed["fixture"]
exp = fx["expected"]


def timeline(events, start):
    run, out = start, []
    for e in events:
        run += e["cents"]
        out.append(run)
    return out


def order(events):
    """Date order; flexible/one-off items right after their anchor paycheque (anchor 'now' = before everything)."""
    pays = {e["id"]: e["date"] for e in events if e["type"] == "paycheque"}
    def key(ie):
        i, e = ie
        if "date" in e:
            return (e["date"], 0 if e["type"] == "paycheque" else 2, i)
        anchor_date = "0000-00-00" if e["anchor"] == "now" else pays[e["anchor"]]
        return (anchor_date, 1, i)
    return [e for _, e in sorted(enumerate(events), key=key)]


events = order(fx["events"])
check("event order", [e["id"] for e in events], [e["id"] for e in fx["events"]])
run = timeline(events, fx["startBalanceCents"])
check("running", run, exp["runningCents"])
check("left this cycle", run[-1], exp["leftThisCycleCents"])
low = min([fx["startBalanceCents"]] + run)
check("lowest", low, exp["lowestCents"])
check("lowest after", events[run.index(low)]["id"], exp["lowestAfter"])
check("safe now", low - seed["household"]["cushionCents"], exp["safeToSpendNowCents"])
autos = [(e, r) for e, r in zip(events, run) if e["type"] == "auto"]
check("auto count", len(autos), exp["autoWithdrawalCount"])
check("all covered", all(r >= seed["household"]["cushionCents"] for _, r in autos), exp["allAutoCovered"])

by_id = {e["id"]: e for e in fx["events"]}
check("sheet order end", timeline([by_id[i] for i in fx["sheetOrder"]], fx["startBalanceCents"])[-1], exp["sheetOrderEndCents"])

# Pay periods
p = exp["payPeriods"]
p0 = [e for e in events if e.get("anchor") == "now"]
check("P0 left", fx["startBalanceCents"] + sum(e["cents"] for e in p0), p[0]["leftCents"])
in_window = lambda e, a, b: ("date" in e and a <= e["date"] <= b) or (e.get("anchor") in ("pay_dax_2026-11-12", "pay_carol_2026-11-19") and a == "2026-11-12")
p1 = [e for e in events if in_window(e, "2026-11-12", "2026-11-25")]
p1_in = sum(e["cents"] for e in p1 if e["cents"] > 0)
p1_auto = -sum(e["cents"] for e in p1 if e["type"] == "auto")
p1_flex = -sum(e["cents"] for e in p1 if e["type"] == "flexible")
check("P1 in", p1_in, p[1]["inCents"])
check("P1 auto", p1_auto, p[1]["autoCents"])
check("P1 flex", p1_flex, p[1]["flexibleCents"])
check("P1 left", p1_in - p1_auto - p1_flex, p[1]["leftCents"])
p1_runs = [r for e, r in zip(events, run) if e in p1]
check("P1 lowest", min(p1_runs), p[1]["lowest"]["cents"])
p2 = [e for e in events if "date" in e and "2026-11-26" <= e["date"] <= "2026-12-09"]
carol_dec3 = seed["paySchedules"][1]["defaultCents"]
p2_in = sum(e["cents"] for e in p2 if e["cents"] > 0) + carol_dec3
p2_auto = -sum(e["cents"] for e in p2 if e["type"] == "auto")
check("P2 in", p2_in, p[2]["inCents"])
check("P2 auto", p2_auto, p[2]["autoCents"])
check("P2 left", p2_in - p2_auto, p[2]["leftCents"])

# Shortfall case
sc = exp["shortfallCase"]
edited = [dict(e, cents=sc["edit"]["cents"]) if e["id"] == sc["edit"]["id"] else e for e in events]
r2 = timeline(edited, fx["startBalanceCents"])
first = next(((e, r) for e, r in zip(edited, r2) if e["type"] == "auto" and r < 0), None)
check("shortfall id", first and first[0]["id"], sc["firstShortfall"]["id"])
check("shortfall cents", first and -first[1], sc["firstShortfall"]["shortCents"])

# Moved flexible case
mc = exp["movedFlexibleCase"]
moved = [dict(e, anchor=mc["move"]["toAnchor"]) if e["id"] == mc["move"]["id"] else e for e in fx["events"]]
r3 = timeline(order(moved), fx["startBalanceCents"])
check("moved left", r3[-1], mc["leftThisCycleCents"])
check("moved lowest", min([fx["startBalanceCents"]] + r3), mc["lowestCents"])

# ---- Monthly budget ----
mb = seed["monthlyBudget"]
me = mb["expected"]
fixed = sum(x["monthlyCents"] for x in mb["fixed"])
var = sum(x["monthlyCents"] for x in mb["variable"])
check("fixed mo", fixed, me["fixedMonthlyCents"])
check("fixed yr", fixed * 12, me["fixedYearlyCents"])
check("var mo", var, me["variableMonthlyCents"])
check("var yr", var * 12, me["variableYearlyCents"])
check("total mo", fixed + var, me["totalMonthlyCents"])
check("total yr", (fixed + var) * 12, me["totalYearlyCents"])
check("balance mo", mb["income"]["netMonthlyCents"] - fixed - var, me["balanceMonthlyCents"])
check("balance yr", mb["income"]["netYearlyCents"] - (fixed + var) * 12, me["balanceYearlyCents"])
for x in mb["fixed"]:
    if x["name"] in me["fixedSharePct"]:
        check(f"share {x['name']}", rhu(Decimal(x["monthlyCents"]) * 100 / fixed), me["fixedSharePct"][x["name"]])
for x in mb["variable"]:
    check(f"share {x['name']}", rhu(Decimal(x["monthlyCents"]) * 100 / var), me["variableSharePct"][x["name"]])

# ---- Goals ----
g = seed["goals"][0]
check("goal remaining", g["targetCents"] - g["savedCents"], g["expected"]["remainingCents"])
check("goal pct", float(round(Decimal(g["savedCents"]) * 100 / g["targetCents"], 1)), g["expected"]["pct"])

# ---- Net worth ----
nw = seed["netWorth"]
assets = sum(a["cents"] for a in nw["assets"])
net = assets - sum(l["cents"] for l in nw["liabilities"])
check("assets", assets, nw["expected"]["assetsCents"])
check("net worth", net, nw["expected"]["netWorthCents"])

# ---- Retirement ----
ri, re_ = seed["retirement"]["inputs"], seed["retirement"]["expected"]
redirect = ri["mortgageMonthlyCents"] * 12 * ri["redirectYears"]
base = ri["rrspCurrentPlusFourYearsCents"] + redirect
at65 = rhu(Decimal(base) * (100 + ri["flatGrowthPct"]) / 100)
draw = rhu(Decimal(at65) / ri["drawdownYears"])
extra_yr = draw + ri["governmentPensionAnnualCents"] - ri["retirementExpensesAnnualCents"]
check("redirect", redirect, re_["mortgageRedirectCents"])
check("growth", at65 - base, re_["growthCents"])
check("rrsp at 65", at65, re_["rrspAt65Cents"])
check("annual draw", draw, re_["annualDrawCents"])
check("extra per year", extra_yr, re_["extraPerYearCents"])
check("extra per month", rhu(Decimal(extra_yr) / 12), re_["extraPerMonthCents"])
check("total for retirement", net + at65, re_["totalForRetirementCents"])

if fails:
    print("FAIL\n  " + "\n  ".join(fails))
    sys.exit(1)
print(f"OK: every expected value in {seed_path.name} reproduces from its inputs.")
