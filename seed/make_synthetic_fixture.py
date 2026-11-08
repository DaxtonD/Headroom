"""Generate the committed synthetic fixture for the engine's golden tests.

Run:  python3 seed/make_synthetic_fixture.py

Why this exists
---------------
No real household financial data is committed to this repository (Dax's
decision, 2026-11-07). The golden tests still need a seed with expected values
to check the engine against, so this script writes one whose amounts are
entirely invented.

The fixture keeps the real seed's *structure* exactly: the same event ids,
dates, types and anchors, and the same pay-schedule anchor dates. That is what
makes it exercise the same engine behaviour - timeline ordering, anchoring,
two-week windows, coverage, the shortfall case and the moved-bill case.

Every amount below is made up. Every expected value is recomputed from those
amounts here, using the same ROUND_HALF_UP arithmetic as `check_seed.py`, so
the fixture is self-consistent and `check_seed.py` can verify it.
"""
import json
from decimal import Decimal, ROUND_HALF_UP
from pathlib import Path

OUT_PATH = Path(__file__).resolve().parent.parent / "packages/core/test/fixtures/household-synthetic.json"


def rhu(value):
    """Round half away from zero, matching Python's decimal ROUND_HALF_UP."""
    return int(Decimal(value).quantize(Decimal("1"), rounding=ROUND_HALF_UP))


# ---------------------------------------------------------------------------
# Invented inputs
# ---------------------------------------------------------------------------

CUSHION_CENTS = 0
START_BALANCE_CENTS = 41_000

PAY_SCHEDULES = [
    {"user": "dax", "cadence": "biweekly", "weekday": "Thu", "anchorDate": "2026-11-12", "defaultCents": 200_000},
    {"user": "carol", "cadence": "biweekly", "weekday": "Thu", "anchorDate": "2026-11-19", "defaultCents": 180_000},
]

# Same ids, dates, types and anchors as the real fixture; invented amounts.
# The Nov 19 cheque deliberately differs from Carol's template amount, which
# mirrors the real quirk the engine has to cope with.
EVENTS = [
    {"id": "power", "name": "Power", "type": "flexible", "anchor": "now", "cents": -15_000},
    {"id": "pay_dax_2026-11-12", "name": "Dax's pay", "type": "paycheque", "date": "2026-11-12", "cents": 200_000},
    {"id": "energy", "name": "Energy", "type": "flexible", "anchor": "pay_dax_2026-11-12", "cents": -9_000},
    {"id": "sasktel_refund", "name": "Phone refund", "type": "one_off", "anchor": "pay_dax_2026-11-12", "cents": 4_000},
    {"id": "mortgage_1", "name": "Mortgage", "type": "auto", "date": "2026-11-13", "cents": -100_000},
    {"id": "home_insurance", "name": "Home insurance", "type": "auto", "date": "2026-11-17", "cents": -20_000},
    {"id": "pay_carol_2026-11-19", "name": "Carol's pay", "type": "paycheque", "date": "2026-11-19", "cents": 185_000},
    {"id": "water", "name": "Water", "type": "flexible", "anchor": "pay_carol_2026-11-19", "cents": -16_000},
    {"id": "savings", "name": "Savings transfer", "type": "flexible", "anchor": "pay_carol_2026-11-19", "cents": -120_000},
    {"id": "child_tax_credit", "name": "Child tax credit", "type": "auto_deposit", "date": "2026-11-20", "cents": 10_000},
    {"id": "tacoma_license", "name": "Truck license", "type": "auto", "date": "2026-11-21", "cents": -8_000},
    {"id": "rogers_wireless", "name": "Wireless", "type": "auto", "date": "2026-11-22", "cents": -17_000},
    {"id": "pay_dax_2026-11-26", "name": "Dax's pay", "type": "paycheque", "date": "2026-11-26", "cents": 200_000},
    {"id": "mortgage_2", "name": "Mortgage", "type": "auto", "date": "2026-11-27", "cents": -100_000},
    {"id": "bank_fees", "name": "Bank fees", "type": "auto", "date": "2026-11-30", "cents": -1_200},
    {"id": "property_tax", "name": "Property tax", "type": "auto", "date": "2026-12-01", "cents": -30_000},
    {"id": "rav_license", "name": "Car license", "type": "auto", "date": "2026-12-02", "cents": -10_000},
]

# The spreadsheet's own row order, which differs from the app's in one place.
SHEET_ORDER = [
    "power", "pay_dax_2026-11-12", "mortgage_1", "rogers_wireless", "home_insurance",
    "sasktel_refund", "energy", "pay_carol_2026-11-19", "water", "child_tax_credit",
    "tacoma_license", "savings", "pay_dax_2026-11-26", "mortgage_2", "bank_fees",
    "property_tax", "rav_license",
]

# Large enough to push the wireless bill past the available balance.
SHORTFALL_EDIT = {"id": "rogers_wireless", "cents": -170_000}
MOVED_FLEXIBLE = {"id": "savings", "toAnchor": "pay_dax_2026-11-26"}

INCOME_NET_MONTHLY_CENTS = 900_000
# Deliberately not exactly monthly x 12, mirroring the real sheet's quirk.
INCOME_NET_YEARLY_CENTS = 10_850_000

FIXED = [
    {"name": "Mortgage", "monthlyCents": 200_000},
    {"name": "Saving", "monthlyCents": 200_000},
    {"name": "Netflix", "monthlyCents": 2_000},
    {"name": "Property Tax", "monthlyCents": 30_000},
    {"name": "Spotify", "monthlyCents": 1_500},
    {"name": "Rogers tv", "monthlyCents": 10_000},
    {"name": "Power", "monthlyCents": 15_000},
    {"name": "Energy", "monthlyCents": 9_000},
    {"name": "Cell Phone", "monthlyCents": 16_000},
    {"name": "RAV Insurance", "monthlyCents": 10_000},
    {"name": "Truck insurance", "monthlyCents": 8_000},
    {"name": "Water", "monthlyCents": 16_000},
    {"name": "Home Insurance", "monthlyCents": 20_000},
    {"name": "Bank Fees", "monthlyCents": 1_200},
]
FIXED_SHARE_NAMES = ["Mortgage", "Saving", "Property Tax", "Home Insurance", "Water", "Power", "Cell Phone"]

VARIABLE = [
    {"name": "Food", "monthlyCents": 140_000},
    {"name": "Gas", "monthlyCents": 12_000},
    {"name": "Misc. Expenses", "monthlyCents": 40_000},
]

GOAL = {"name": "Trip fund", "targetCents": 450_000, "savedCents": 320_000}

NET_WORTH_ASSETS = [
    {"name": "Home (market estimate)", "cents": 40_000_000},
    {"name": "RRSPs", "cents": 15_000_000},
    {"name": "RAV4", "cents": 1_200_000},
    {"name": "Tacoma", "cents": 800_000},
]
NET_WORTH_LIABILITIES = [{"name": "Mortgage", "cents": 14_000_000}]

RETIREMENT_INPUTS = {
    # Not a round number, so the growth step has something to round.
    "rrspCurrentPlusFourYearsCents": 30_000_005,
    "mortgageMonthlyCents": 200_000,
    "redirectYears": 16,
    "flatGrowthPct": 10,
    "drawdownYears": 25,
    "governmentPensionAnnualCents": 2_000_000,
    "retirementExpensesAnnualCents": 2_200_000,
}


# ---------------------------------------------------------------------------
# The same ordering and arithmetic check_seed.py uses
# ---------------------------------------------------------------------------

def order(events):
    """Date order; flexible items right after their anchor paycheque."""
    pays = {e["id"]: e["date"] for e in events if e["type"] == "paycheque"}

    def key(indexed):
        i, e = indexed
        if "date" in e:
            return (e["date"], 0 if e["type"] == "paycheque" else 2, i)
        anchor_date = "0000-00-00" if e["anchor"] == "now" else pays[e["anchor"]]
        return (anchor_date, 1, i)

    return [e for _, e in sorted(enumerate(events), key=key)]


def running_balances(events, start):
    run, out = start, []
    for e in events:
        run += e["cents"]
        out.append(run)
    return out


def build():
    ordered = order(EVENTS)
    if [e["id"] for e in ordered] != [e["id"] for e in EVENTS]:
        raise SystemExit(
            "EVENTS must already be listed in the app's order, so the fixture "
            "documents that order. Reorder them to match `order()`."
        )

    run = running_balances(ordered, START_BALANCE_CENTS)
    lowest = min([START_BALANCE_CENTS] + run)
    lowest_after = ordered[run.index(lowest)]["id"]

    autos = [(e, r) for e, r in zip(ordered, run) if e["type"] == "auto"]

    # ---- Pay periods ----
    by_anchor_now = [e for e in ordered if e.get("anchor") == "now"]
    p0_left = START_BALANCE_CENTS + sum(e["cents"] for e in by_anchor_now)

    def in_window(e, start, end, anchors_in_window):
        if "date" in e:
            return start <= e["date"] <= end
        return e.get("anchor") in anchors_in_window

    p1_anchors = ("pay_dax_2026-11-12", "pay_carol_2026-11-19")
    p1 = [e for e in ordered if in_window(e, "2026-11-12", "2026-11-25", p1_anchors)]
    p1_in = sum(e["cents"] for e in p1 if e["cents"] > 0)
    p1_auto = -sum(e["cents"] for e in p1 if e["type"] == "auto")
    p1_flex = -sum(e["cents"] for e in p1 if e["type"] == "flexible")
    p1_runs = [r for e, r in zip(ordered, run) if e in p1]
    p1_lowest = min(p1_runs)
    p1_lowest_date = next(e["date"] for e, r in zip(ordered, run) if r == p1_lowest and "date" in e)

    p2 = [e for e in ordered if "date" in e and "2026-11-26" <= e["date"] <= "2026-12-09"]
    # Carol's next cheque falls inside this window but past the horizon, so it
    # is projected from her pay schedule rather than placed on the timeline.
    carol_projected = PAY_SCHEDULES[1]["defaultCents"]
    p2_in = sum(e["cents"] for e in p2 if e["cents"] > 0) + carol_projected
    p2_auto = -sum(e["cents"] for e in p2 if e["type"] == "auto")
    p2_flex = -sum(e["cents"] for e in p2 if e["type"] == "flexible")

    # ---- Shortfall case ----
    edited = [dict(e, cents=SHORTFALL_EDIT["cents"]) if e["id"] == SHORTFALL_EDIT["id"] else e for e in ordered]
    edited_run = running_balances(edited, START_BALANCE_CENTS)
    first_short = next(
        ((e, r) for e, r in zip(edited, edited_run) if e["type"] == "auto" and r < CUSHION_CENTS),
        None,
    )
    if first_short is None:
        raise SystemExit("SHORTFALL_EDIT does not actually cause a shortfall; make it larger.")

    # ---- Moved flexible case ----
    moved = [dict(e, anchor=MOVED_FLEXIBLE["toAnchor"]) if e["id"] == MOVED_FLEXIBLE["id"] else e for e in EVENTS]
    moved_run = running_balances(order(moved), START_BALANCE_CENTS)

    # ---- Budget ----
    fixed_monthly = sum(x["monthlyCents"] for x in FIXED)
    variable_monthly = sum(x["monthlyCents"] for x in VARIABLE)

    fixed_share = {
        x["name"]: rhu(Decimal(x["monthlyCents"]) * 100 / fixed_monthly)
        for x in FIXED
        if x["name"] in FIXED_SHARE_NAMES
    }
    variable_share = {
        x["name"]: rhu(Decimal(x["monthlyCents"]) * 100 / variable_monthly) for x in VARIABLE
    }

    # ---- Net worth ----
    assets = sum(a["cents"] for a in NET_WORTH_ASSETS)
    net_worth = assets - sum(l["cents"] for l in NET_WORTH_LIABILITIES)

    # ---- Retirement ----
    ri = RETIREMENT_INPUTS
    redirect = ri["mortgageMonthlyCents"] * 12 * ri["redirectYears"]
    base = ri["rrspCurrentPlusFourYearsCents"] + redirect
    at65 = rhu(Decimal(base) * (100 + ri["flatGrowthPct"]) / 100)
    draw = rhu(Decimal(at65) / ri["drawdownYears"])
    extra_year = draw + ri["governmentPensionAnnualCents"] - ri["retirementExpensesAnnualCents"]

    return {
        "_about": (
            "SYNTHETIC fixture for the engine's golden tests. Every amount here is "
            "invented and no real household data is present. The structure - event "
            "ids, dates, types, anchors and pay-schedule anchor dates - matches the "
            "real seed so the same engine behaviour is exercised. Regenerate with: "
            "python3 seed/make_synthetic_fixture.py"
        ),
        "household": {
            "name": "Synthetic household",
            "timezone": "America/Regina",
            "currency": "CAD",
            "cushionCents": CUSHION_CENTS,
        },
        "users": [
            {"key": "dax", "name": "Dax", "initial": "D"},
            {"key": "carol", "name": "Carol", "initial": "C"},
        ],
        "account": {"name": "Chequing", "balanceCents": START_BALANCE_CENTS, "asOf": "2026-11-07T09:58:00-06:00"},
        "paySchedules": PAY_SCHEDULES,
        "fixture": {
            "_about": "Synthetic ledger for Nov 7 to Dec 2, 2026, in the app's date order.",
            "today": "2026-11-07",
            "startBalanceCents": START_BALANCE_CENTS,
            "horizonEnd": "2026-12-02",
            "anchors": ["now", "pay_dax_2026-11-12", "pay_carol_2026-11-19", "pay_dax_2026-11-26"],
            "events": EVENTS,
            "sheetOrder": SHEET_ORDER,
            "expected": {
                "runningCents": run,
                "leftThisCycleCents": run[-1],
                "lowestCents": lowest,
                "lowestAfter": lowest_after,
                "safeToSpendNowCents": lowest - CUSHION_CENTS,
                "autoWithdrawalCount": len(autos),
                "allAutoCovered": all(r >= CUSHION_CENTS for _, r in autos),
                "sheetOrderEndCents": running_balances(
                    [next(e for e in EVENTS if e["id"] == i) for i in SHEET_ORDER], START_BALANCE_CENTS
                )[-1],
                "payPeriods": [
                    {
                        "label": "Now-Nov 11",
                        "start": "2026-11-07",
                        "end": "2026-11-11",
                        "inCents": START_BALANCE_CENTS,
                        "autoCents": 0,
                        "flexibleCents": -sum(e["cents"] for e in by_anchor_now if e["type"] == "flexible"),
                        "leftCents": p0_left,
                    },
                    {
                        "label": "Nov 12-25",
                        "start": "2026-11-12",
                        "end": "2026-11-25",
                        "inCents": p1_in,
                        "autoCents": p1_auto,
                        "flexibleCents": p1_flex,
                        "leftCents": p1_in - p1_auto - p1_flex,
                        "lowest": {"cents": p1_lowest, "date": p1_lowest_date},
                    },
                    {
                        "label": "Nov 26-Dec 9",
                        "start": "2026-11-26",
                        "end": "2026-12-09",
                        "inCents": p2_in,
                        "autoCents": p2_auto,
                        "flexibleCents": p2_flex,
                        "leftCents": p2_in - p2_auto - p2_flex,
                        "_note": "Includes the next cheque projected from the pay schedule, which falls past the horizon.",
                    },
                ],
                "shortfallCase": {
                    "_about": f"Same fixture with {SHORTFALL_EDIT['id']} edited to {SHORTFALL_EDIT['cents']}.",
                    "edit": SHORTFALL_EDIT,
                    "firstShortfall": {
                        "id": first_short[0]["id"],
                        "date": first_short[0]["date"],
                        "shortCents": CUSHION_CENTS - first_short[1],
                    },
                },
                "movedFlexibleCase": {
                    "_about": "Move the savings transfer to the following paycheque. End total and lowest point unchanged.",
                    "move": MOVED_FLEXIBLE,
                    "leftThisCycleCents": moved_run[-1],
                    "lowestCents": min([START_BALANCE_CENTS] + moved_run),
                },
            },
        },
        "monthlyBudget": {
            "income": {
                "netMonthlyCents": INCOME_NET_MONTHLY_CENTS,
                "netYearlyCents": INCOME_NET_YEARLY_CENTS,
                "_note": "Yearly is deliberately not monthly x 12, mirroring the real sheet.",
            },
            "fixed": FIXED,
            "variable": VARIABLE,
            "expected": {
                "fixedMonthlyCents": fixed_monthly,
                "fixedYearlyCents": fixed_monthly * 12,
                "variableMonthlyCents": variable_monthly,
                "variableYearlyCents": variable_monthly * 12,
                "totalMonthlyCents": fixed_monthly + variable_monthly,
                "totalYearlyCents": (fixed_monthly + variable_monthly) * 12,
                "balanceMonthlyCents": INCOME_NET_MONTHLY_CENTS - fixed_monthly - variable_monthly,
                "balanceYearlyCents": INCOME_NET_YEARLY_CENTS - (fixed_monthly + variable_monthly) * 12,
                "fixedSharePct": fixed_share,
                "variableSharePct": variable_share,
            },
        },
        "goals": [
            {
                **GOAL,
                "expected": {
                    "remainingCents": GOAL["targetCents"] - GOAL["savedCents"],
                    "pct": float(round(Decimal(GOAL["savedCents"]) * 100 / GOAL["targetCents"], 1)),
                },
            }
        ],
        "reimbursements": {"employer": "Example Co", "statuses": ["bought", "submitted", "paid"], "items": [], "expectedTotalCents": 0},
        "bankedHours": {"total": 0},
        "netWorth": {
            "assets": NET_WORTH_ASSETS,
            "liabilities": NET_WORTH_LIABILITIES,
            "expected": {"assetsCents": assets, "netWorthCents": net_worth},
        },
        "retirement": {
            "inputs": RETIREMENT_INPUTS,
            "_formula": (
                "rrspAt65 = (rrspCurrentPlusFourYears + mortgageMonthly*12*redirectYears) "
                "* (1 + flatGrowthPct/100); draw = rrspAt65 / drawdownYears; "
                "extraPerYear = draw + gov - expenses; extraPerMonth = extraPerYear / 12; "
                "totalForRetirement = netWorth + rrspAt65. Round half up to cents."
            ),
            "expected": {
                "mortgageRedirectCents": redirect,
                "growthCents": at65 - base,
                "rrspAt65Cents": at65,
                "annualDrawCents": draw,
                "extraPerYearCents": extra_year,
                "extraPerMonthCents": rhu(Decimal(extra_year) / 12),
                "totalForRetirementCents": net_worth + at65,
            },
        },
    }


def main():
    fixture = build()
    OUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    OUT_PATH.write_text(json.dumps(fixture, indent=2) + "\n", encoding="utf-8")
    print(f"Wrote {OUT_PATH}")
    print("Now verify it with:  python3 seed/check_seed.py", OUT_PATH)


if __name__ == "__main__":
    main()
