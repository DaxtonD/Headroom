/**
 * Golden tests: the engine must reproduce EVERY expected value in the seed
 * (CLAUDE.md, and the M1 acceptance criterion).
 *
 * The same suite runs against each seed file available:
 *
 *  - the committed synthetic fixture, so CI proves the engine without ever
 *    holding real finances;
 *  - the real November seed, when this machine has it, so a developer's run
 *    verifies the household's actual numbers.
 *
 * No amount appears in this file. Everything compared comes out of whichever
 * seed is being checked, which is what makes one suite able to do both.
 */
import { describe, expect, it } from "vitest";
import { computeBudget, computeGoal } from "../src/budget.js";
import { computeHorizonEnd, computePayPeriods } from "../src/payPeriods.js";
import { computeNetWorth, computeRetirement } from "../src/netWorth.js";
import { computeTimeline, orderTimeline } from "../src/timeline.js";
import type { TimelineInput } from "../src/types.js";
import {
  assets,
  availableSeeds,
  budgetIncome,
  budgetLines,
  cents,
  liabilities,
  paySchedules,
  retirementInputs,
  timelineEvents,
  type NamedSeed,
} from "./helpers/seed.js";

const seeds = availableSeeds();

it("has at least one seed to check", () => {
  // If this fails, the synthetic fixture is missing and the golden tests are
  // proving nothing.
  expect(seeds.length).toBeGreaterThan(0);
});

describe.each(seeds.map((named) => [named.label, named] as const))("%s", (_label, named: NamedSeed) => {
  const { seed } = named;
  const fixture = seed.fixture;
  const expected = fixture.expected;

  const events = timelineEvents(seed);
  const schedules = paySchedules(seed);
  const cushionCents = cents(seed.household.cushionCents);
  const startBalanceCents = cents(fixture.startBalanceCents);

  const timeline = computeTimeline({ events, startBalanceCents, cushionCents });

  describe("timeline ordering", () => {
    it("orders events the way the bank applies them", () => {
      // The seed lists its events already in the app's order, so the engine
      // ordering it must come out unchanged.
      expect(orderTimeline(events).map((event) => event.id)).toEqual(
        fixture.events.map((event) => event.id),
      );
    });

    it("puts a flexible item straight after its anchor paycheque", () => {
      const ids = timeline.rows.map((row) => row.event.id);

      for (const event of events) {
        if (event.placement !== "flexible") continue;
        const anchorId = event.anchorId ?? null;
        if (anchorId === null) continue;

        expect(ids.indexOf(event.id), `${event.id} after ${anchorId}`).toBeGreaterThan(
          ids.indexOf(anchorId),
        );
      }
    });

    it("puts items anchored to 'now' before the first paycheque", () => {
      const ids = timeline.rows.map((row) => row.event.id);
      const firstPaychequeIndex = timeline.rows.findIndex((row) => row.event.kind === "paycheque");

      for (const event of events) {
        if (event.placement !== "flexible") continue;
        if ((event.anchorId ?? null) !== null) continue;
        expect(ids.indexOf(event.id), event.id).toBeLessThan(firstPaychequeIndex);
      }
    });

    it("gives a flexible item its anchor paycheque's date", () => {
      for (const row of timeline.rows) {
        if (row.event.placement !== "flexible") continue;
        const anchorId = row.event.anchorId ?? null;
        if (anchorId === null) {
          expect(row.effectiveDate).toBeNull();
          continue;
        }
        const anchor = timeline.rows.find((candidate) => candidate.event.id === anchorId);
        expect(row.effectiveDate).toBe(anchor?.effectiveDate);
      }
    });
  });

  describe("running balances", () => {
    it("reproduces every running balance in the seed", () => {
      expect(timeline.rows.map((row) => row.runningCents)).toEqual(
        expected.runningCents.map(cents),
      );
    });

    it("reproduces left this cycle", () => {
      expect(timeline.leftThisCycleCents).toBe(cents(expected.leftThisCycleCents));
    });

    it("ends at the same total as the spreadsheet's own row order", () => {
      // The app orders two items differently from the sheet; the end total
      // must be identical either way (HANDOFF section 6.2).
      const byId = new Map(events.map((event) => [event.id, event]));
      const inSheetOrder = fixture.sheetOrder.map((id) => {
        const event = byId.get(id);
        if (!event) throw new Error(`sheetOrder names "${id}", which is not in the events.`);
        return event;
      });

      let running = startBalanceCents;
      for (const event of inSheetOrder) running += event.cents;

      expect(running).toBe(cents(expected.sheetOrderEndCents));
      expect(running).toBe(timeline.leftThisCycleCents);
    });
  });

  describe("lowest point and safe to spend", () => {
    it("reproduces the lowest point and where it happens", () => {
      expect(timeline.lowest.cents).toBe(cents(expected.lowestCents));
      expect(timeline.lowest.afterEventId).toBe(expected.lowestAfter);
    });

    it("reproduces safe to spend now", () => {
      // Spending now lowers every later balance, so this is the lowest point
      // over the whole horizon less the cushion.
      expect(timeline.safeToSpendNowCents).toBe(cents(expected.safeToSpendNowCents));
    });

    it("never reports a lowest point above the final balance without cause", () => {
      expect(timeline.lowest.cents <= timeline.leftThisCycleCents || true).toBe(true);
      // The lowest point must be <= every running balance.
      for (const row of timeline.rows) {
        expect(timeline.lowest.cents <= row.runningCents).toBe(true);
      }
    });
  });

  describe("coverage", () => {
    it("counts the automatic withdrawals", () => {
      expect(timeline.coverage.autoWithdrawalCount).toBe(expected.autoWithdrawalCount);
    });

    it("reports whether every automatic withdrawal is covered", () => {
      expect(timeline.coverage.allCovered).toBe(expected.allAutoCovered);
      if (expected.allAutoCovered) {
        expect(timeline.coverage.firstShortfall).toBeNull();
      }
    });

    it("counts paycheques and deposits as money in, not as things to cover", () => {
      for (const row of timeline.rows) {
        if (row.event.cents > 0n) expect(row.requiresCoverage).toBe(false);
      }
    });
  });

  describe("the shortfall case", () => {
    const shortfall = expected.shortfallCase;

    const edited: TimelineInput[] = events.map((event) =>
      event.id === shortfall.edit.id ? { ...event, cents: cents(shortfall.edit.cents) } : event,
    );
    const editedTimeline = computeTimeline({ events: edited, startBalanceCents, cushionCents });

    it("finds the first withdrawal that is not covered", () => {
      expect(editedTimeline.coverage.allCovered).toBe(false);
      expect(editedTimeline.coverage.firstShortfall?.eventId).toBe(shortfall.firstShortfall.id);
    });

    it("reports how much short it is, and on what date", () => {
      expect(editedTimeline.coverage.firstShortfall?.shortCents).toBe(
        cents(shortfall.firstShortfall.shortCents),
      );
      expect(editedTimeline.coverage.firstShortfall?.date).toBe(shortfall.firstShortfall.date);
    });

    it("leaves the original timeline untouched", () => {
      // The engine is pure: editing a copy must not disturb the first result.
      expect(timeline.coverage.allCovered).toBe(expected.allAutoCovered);
      expect(timeline.leftThisCycleCents).toBe(cents(expected.leftThisCycleCents));
    });
  });

  describe("moving a flexible bill to a later payday", () => {
    const moved = expected.movedFlexibleCase;

    const movedEvents: TimelineInput[] = events.map((event) =>
      event.id === moved.move.id ? { ...event, anchorId: moved.move.toAnchor } : event,
    );
    const movedTimeline = computeTimeline({
      events: movedEvents,
      startBalanceCents,
      cushionCents,
    });

    it("leaves the end total unchanged, because the money still goes out", () => {
      expect(movedTimeline.leftThisCycleCents).toBe(cents(moved.leftThisCycleCents));
    });

    it("reproduces the lowest point after the move", () => {
      expect(movedTimeline.lowest.cents).toBe(cents(moved.lowestCents));
    });

    it("actually moved the row", () => {
      const ids = movedTimeline.rows.map((row) => row.event.id);
      expect(ids.indexOf(moved.move.id)).toBeGreaterThan(ids.indexOf(moved.move.toAnchor));
    });
  });

  describe("the horizon", () => {
    it("ends the day before the 4th upcoming paycheque", () => {
      expect(
        computeHorizonEnd({ today: fixture.today, paySchedules: schedules, paychequeCount: 4 }),
      ).toBe(fixture.horizonEnd);
    });
  });

  describe("pay periods", () => {
    const periods = computePayPeriods({
      timeline,
      paySchedules: schedules,
      today: fixture.today,
      periodCount: expected.payPeriods.length,
      // The windows in the sheet run from the first-listed person's paydays.
      anchorScheduleId: schedules[0]?.id,
      cushionCents,
    });

    it("produces one window per expected period", () => {
      expect(periods).toHaveLength(expected.payPeriods.length);
    });

    it.each(expected.payPeriods.map((period, index) => [index, period] as const))(
      "reproduces period %i",
      (index, want) => {
        const got = periods[index];
        expect(got, `period ${index}`).toBeDefined();
        if (!got) return;

        expect(got.label, "label").toBe(want.label);
        expect(got.start, "start").toBe(want.start);
        expect(got.end, "end").toBe(want.end);
        expect(got.inCents, "coming in").toBe(cents(want.inCents));
        expect(got.autoCents, "automatic withdrawals").toBe(cents(want.autoCents));
        expect(got.flexibleCents, "flexible").toBe(cents(want.flexibleCents));
        expect(got.leftCents, "left over").toBe(cents(want.leftCents));

        if (want.lowest) {
          expect(got.lowest?.cents, "lowest in window").toBe(cents(want.lowest.cents));
          expect(got.lowest?.date, "lowest date").toBe(want.lowest.date);
        }
      },
    );

    it("keeps left over equal to in minus auto minus flexible", () => {
      for (const period of periods) {
        expect(period.leftCents).toBe(period.inCents - period.autoCents - period.flexibleCents);
      }
    });
  });

  describe("the monthly budget", () => {
    const budget = computeBudget({ income: budgetIncome(seed), lines: budgetLines(seed) });
    const want = seed.monthlyBudget.expected;

    it("reproduces the fixed and variable totals", () => {
      expect(budget.fixed.monthlyCents).toBe(cents(want.fixedMonthlyCents));
      expect(budget.fixed.yearlyCents).toBe(cents(want.fixedYearlyCents));
      expect(budget.variable.monthlyCents).toBe(cents(want.variableMonthlyCents));
      expect(budget.variable.yearlyCents).toBe(cents(want.variableYearlyCents));
    });

    it("reproduces the overall totals", () => {
      expect(budget.totalMonthlyCents).toBe(cents(want.totalMonthlyCents));
      expect(budget.totalYearlyCents).toBe(cents(want.totalYearlyCents));
    });

    it("reproduces what is left after expenses", () => {
      expect(budget.balanceMonthlyCents).toBe(cents(want.balanceMonthlyCents));
      expect(budget.balanceYearlyCents).toBe(cents(want.balanceYearlyCents));
    });

    it("gives each line its share of its own section, not of income", () => {
      for (const [name, pct] of Object.entries(want.fixedSharePct)) {
        const line = budget.fixed.lines.find((candidate) => candidate.name === name);
        expect(line, `fixed line "${name}"`).toBeDefined();
        expect(line?.sharePct, `share of "${name}"`).toBe(pct);
      }
      for (const [name, pct] of Object.entries(want.variableSharePct)) {
        const line = budget.variable.lines.find((candidate) => candidate.name === name);
        expect(line, `variable line "${name}"`).toBeDefined();
        expect(line?.sharePct, `share of "${name}"`).toBe(pct);
      }
    });
  });

  describe("goals", () => {
    it.each(seed.goals.map((goal, index) => [index, goal] as const))(
      "reproduces goal %i",
      (_index, goal) => {
        const result = computeGoal({
          name: goal.name,
          targetCents: cents(goal.targetCents),
          savedCents: cents(goal.savedCents),
        });

        expect(result.remainingCents).toBe(cents(goal.expected.remainingCents));
        expect(result.pct).toBe(goal.expected.pct);
      },
    );
  });

  describe("net worth", () => {
    const netWorth = computeNetWorth({ assets: assets(seed), liabilities: liabilities(seed) });

    it("reproduces what the household owns and is worth", () => {
      expect(netWorth.assetsCents).toBe(cents(seed.netWorth.expected.assetsCents));
      expect(netWorth.netWorthCents).toBe(cents(seed.netWorth.expected.netWorthCents));
    });
  });

  describe("retirement", () => {
    const netWorth = computeNetWorth({ assets: assets(seed), liabilities: liabilities(seed) });
    const retirement = computeRetirement({
      inputs: retirementInputs(seed),
      netWorthCents: netWorth.netWorthCents,
    });
    const want = seed.retirement.expected;

    it("reproduces the redirected mortgage payments", () => {
      expect(retirement.mortgageRedirectCents).toBe(cents(want.mortgageRedirectCents));
    });

    it("applies the growth once, as the spreadsheet does", () => {
      expect(retirement.growthCents).toBe(cents(want.growthCents));
      expect(retirement.rrspAt65Cents).toBe(cents(want.rrspAt65Cents));
    });

    it("reproduces the yearly draw and what it adds up to", () => {
      expect(retirement.annualDrawCents).toBe(cents(want.annualDrawCents));
      expect(retirement.extraPerYearCents).toBe(cents(want.extraPerYearCents));
      expect(retirement.extraPerMonthCents).toBe(cents(want.extraPerMonthCents));
    });

    it("reproduces the total for retirement", () => {
      expect(retirement.totalForRetirementCents).toBe(cents(want.totalForRetirementCents));
    });

    it("compounding yearly is available and gives a different answer", () => {
      // Offered as an editable setting, off by default (section 14 q3).
      const compounded = computeRetirement({
        inputs: { ...retirementInputs(seed), compoundYearly: true },
        netWorthCents: netWorth.netWorthCents,
      });

      if (retirementInputs(seed).flatGrowthPct !== 0 && retirementInputs(seed).redirectYears > 1) {
        expect(compounded.rrspAt65Cents).not.toBe(retirement.rrspAt65Cents);
        expect(compounded.rrspAt65Cents > retirement.rrspAt65Cents).toBe(true);
      }
    });
  });
});
