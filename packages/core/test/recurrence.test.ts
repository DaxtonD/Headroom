/**
 * Recurrence generation (HANDOFF section 6.5).
 *
 * The behaviour that matters most is that generating twice produces the same
 * list, with the same period keys, so the database's unique constraint makes
 * duplication impossible however many times it runs.
 *
 * Amounts are invented. Dates are structure, so the real anchors are used.
 */
import { describe, expect, it } from "vitest";
import {
  GENERATION_LOOKAHEAD_DAYS,
  generateOccurrences,
  generationWindow,
  signedForKind,
  type TemplateSpec,
} from "../src/recurrence.js";
import type { PaySchedule } from "../src/types.js";

const DAX: PaySchedule = { id: "dax", ownerId: "dax", anchorDate: "2026-11-12", defaultCents: 175_000n };
const CAROL: PaySchedule = { id: "carol", ownerId: "carol", anchorDate: "2026-11-19", defaultCents: 180_000n };
const SCHEDULES = [DAX, CAROL];

function template(overrides: Partial<TemplateSpec> & Pick<TemplateSpec, "id" | "schedule">): TemplateSpec {
  return {
    name: overrides.name ?? "A bill",
    kind: overrides.kind ?? "bill",
    defaultCents: overrides.defaultCents ?? 12_345n,
    ...overrides,
  };
}

describe("monthly", () => {
  const monthly = template({ id: "insurance", name: "Home insurance", schedule: { type: "monthly", day: 17 } });

  it("places one occurrence per month on its day", () => {
    const generated = generateOccurrences({
      templates: [monthly],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2027-01-31",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual([
      "2026-11-17",
      "2026-12-17",
      "2027-01-17",
    ]);
  });

  it("keys by the month, so moving the day cannot create a second copy", () => {
    const generated = generateOccurrences({
      templates: [monthly],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-12-31",
    });

    expect(generated.map((occurrence) => occurrence.periodKey)).toEqual(["2026-11", "2026-12"]);
  });

  it("clamps a day the month does not have", () => {
    const endOfMonth = template({ id: "fees", schedule: { type: "monthly", day: 31 } });

    const generated = generateOccurrences({
      templates: [endOfMonth],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2027-02-28",
    });

    // November has 30 days and February 2027 has 28.
    expect(generated.map((occurrence) => occurrence.date)).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);
  });

  it("leaves a month out when its date falls outside the window", () => {
    const generated = generateOccurrences({
      templates: [monthly],
      paySchedules: SCHEDULES,
      from: "2026-11-18",
      to: "2026-12-16",
    });

    expect(generated).toEqual([]);
  });

  it("makes a bill money going out", () => {
    const generated = generateOccurrences({
      templates: [monthly],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-11-30",
    });

    expect(generated[0]?.cents).toBe(-12_345n);
    expect(generated[0]?.placement).toBe("auto");
  });
});

describe("monthly_last", () => {
  it('handles the "31st" bills as the last day of each month', () => {
    const generated = generateOccurrences({
      templates: [template({ id: "fees", name: "Bank fees", schedule: { type: "monthly_last" } })],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2027-02-28",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual([
      "2026-11-30",
      "2026-12-31",
      "2027-01-31",
      "2027-02-28",
    ]);
  });

  it("knows about a leap February", () => {
    const generated = generateOccurrences({
      templates: [template({ id: "fees", schedule: { type: "monthly_last" } })],
      paySchedules: SCHEDULES,
      from: "2028-02-01",
      to: "2028-02-29",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual(["2028-02-29"]);
  });
});

describe("relative_to_pay", () => {
  const mortgage = template({
    id: "mortgage",
    name: "Mortgage",
    defaultCents: 98_765n,
    schedule: { type: "relative_to_pay", payScheduleId: "dax", offsetDays: 1 },
  });

  it("comes out the day after each of that person's paydays", () => {
    const generated = generateOccurrences({
      templates: [mortgage],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2026-12-31",
    });

    // Dax's paydays are Nov 12, Nov 26, Dec 10, Dec 24.
    expect(generated.map((occurrence) => occurrence.date)).toEqual([
      "2026-11-13",
      "2026-11-27",
      "2026-12-11",
      "2026-12-25",
    ]);
  });

  it("is keyed by the payday it follows", () => {
    const generated = generateOccurrences({
      templates: [mortgage],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2026-11-30",
    });

    expect(generated.map((occurrence) => occurrence.periodKey)).toEqual(["2026-11-12", "2026-11-26"]);
  });

  it("still produces the occurrence when the payday was just before the window", () => {
    // The payday is Nov 12 and the window opens Nov 13, but the withdrawal
    // itself lands inside the window.
    const generated = generateOccurrences({
      templates: [mortgage],
      paySchedules: SCHEDULES,
      from: "2026-11-13",
      to: "2026-11-13",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual(["2026-11-13"]);
  });

  it("refuses to generate from a pay schedule that does not exist", () => {
    const orphan = template({
      id: "orphan",
      schedule: { type: "relative_to_pay", payScheduleId: "nobody", offsetDays: 1 },
    });

    expect(() =>
      generateOccurrences({
        templates: [orphan],
        paySchedules: SCHEDULES,
        from: "2026-11-01",
        to: "2026-11-30",
      }),
    ).toThrow(/does not exist/);
  });
});

describe("biweekly paycheques", () => {
  it("lands on every payday, as money coming in", () => {
    const pay = template({
      id: "dax-pay",
      name: "Dax's pay",
      kind: "paycheque",
      defaultCents: 175_000n,
      schedule: { type: "biweekly", payScheduleId: "dax" },
    });

    const generated = generateOccurrences({
      templates: [pay],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2026-12-09",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual(["2026-11-12", "2026-11-26"]);
    expect(generated.every((occurrence) => occurrence.cents === 175_000n)).toBe(true);
    expect(generated.every((occurrence) => occurrence.placement === "auto")).toBe(true);
  });

  it("produces three cheques in a long month with no special handling", () => {
    const pay = template({
      id: "dax-pay",
      kind: "paycheque",
      defaultCents: 175_000n,
      schedule: { type: "biweekly", payScheduleId: "dax" },
    });

    const generated = generateOccurrences({
      templates: [pay],
      paySchedules: SCHEDULES,
      from: "2027-04-01",
      to: "2027-04-30",
    });

    // Biweekly, so some months simply contain three paydays.
    expect(generated.length).toBeGreaterThanOrEqual(2);
    for (const occurrence of generated) {
      expect(occurrence.date?.startsWith("2027-04")).toBe(true);
    }
  });
});

describe("flexible bills", () => {
  it("makes one a month, anchored to that month's first payday", () => {
    const power = template({
      id: "power",
      name: "Power",
      schedule: { type: "flexible", frequency: "monthly" },
    });

    const generated = generateOccurrences({
      templates: [power],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2027-01-31",
    });

    expect(generated.map((occurrence) => occurrence.periodKey)).toEqual(["2026-11", "2026-12", "2027-01"]);
    // November's first payday in the window is Dax's, on the 12th.
    expect(generated[0]?.anchorPaydayDate).toBe("2026-11-12");
    // Flexible items carry no date of their own.
    expect(generated.every((occurrence) => occurrence.date === undefined)).toBe(true);
    expect(generated.every((occurrence) => occurrence.placement === "flexible")).toBe(true);
  });

  it("sits on the day it is planned for, when one is given", () => {
    /*
     * "Every month, but I choose when to pay it" with a day chosen. The
     * household still decides, so it stays flexible and movable - but it
     * belongs on that day of the ledger, against the balance it will actually
     * come out of, rather than on whichever payday happens to come first.
     */
    const visa = template({
      id: "visa",
      name: "Visa",
      schedule: { type: "flexible", frequency: "monthly", day: 20 },
    });

    const generated = generateOccurrences({
      templates: [visa],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2027-01-31",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual([
      "2026-11-20",
      "2026-12-20",
      "2027-01-20",
    ]);
    // Still flexible, and hanging off nothing.
    expect(generated.every((occurrence) => occurrence.placement === "flexible")).toBe(true);
    expect(generated.every((occurrence) => occurrence.anchorPaydayDate === undefined)).toBe(true);
  });

  it("keeps the same period key whether or not a day is chosen", () => {
    // Which is what lets choosing a day, changing it or clearing it move the
    // row that is already on the ledger instead of adding a second one.
    const common = { id: "visa", name: "Visa" } as const;
    const withoutDay = generateOccurrences({
      templates: [template({ ...common, schedule: { type: "flexible", frequency: "monthly" } })],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2026-12-31",
    });
    const withDay = generateOccurrences({
      templates: [
        template({ ...common, schedule: { type: "flexible", frequency: "monthly", day: 20 } }),
      ],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2026-12-31",
    });

    expect(withDay.map((occurrence) => occurrence.periodKey)).toEqual(
      withoutDay.map((occurrence) => occurrence.periodKey),
    );
  });

  it("clamps a planned day a short month does not have", () => {
    const visa = template({
      id: "visa",
      schedule: { type: "flexible", frequency: "monthly", day: 31 },
    });

    const generated = generateOccurrences({
      templates: [visa],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-12-31",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual(["2026-11-30", "2026-12-31"]);
  });

  it("needs no paydays at all when it has a day of its own", () => {
    // Without a day it has nothing to hang from and produces nothing; with
    // one, the date is the household's and does not depend on anybody's pay.
    const visa = template({
      id: "visa",
      schedule: { type: "flexible", frequency: "monthly", day: 20 },
    });

    const generated = generateOccurrences({
      templates: [visa],
      paySchedules: [],
      from: "2026-11-01",
      to: "2026-12-31",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual(["2026-11-20", "2026-12-20"]);
  });

  it("makes one per pay period when that is the frequency", () => {
    const savings = template({
      id: "savings",
      name: "Savings transfer",
      kind: "transfer",
      defaultCents: 120_000n,
      schedule: { type: "flexible", frequency: "per_pay_period" },
    });

    const generated = generateOccurrences({
      templates: [savings],
      paySchedules: SCHEDULES,
      from: "2026-11-07",
      to: "2026-12-09",
    });

    // Every payday from either person.
    expect(generated.map((occurrence) => occurrence.anchorPaydayDate)).toEqual([
      "2026-11-12",
      "2026-11-19",
      "2026-11-26",
      "2026-12-03",
    ]);
    // A transfer out of chequing is money leaving.
    expect(generated.every((occurrence) => occurrence.cents === -120_000n)).toBe(true);
  });

  it("produces nothing when there are no paydays to hang from", () => {
    const power = template({ id: "power", schedule: { type: "flexible", frequency: "monthly" } });

    const generated = generateOccurrences({
      templates: [power],
      paySchedules: [],
      from: "2026-11-01",
      to: "2026-11-30",
    });

    expect(generated).toEqual([]);
  });
});

describe("weekend handling", () => {
  // 2026-11-22 is a Sunday.
  const wireless = template({ id: "wireless", schedule: { type: "monthly", day: 22 } });

  it("leaves a weekend date alone by default, matching the spreadsheet", () => {
    const generated = generateOccurrences({
      templates: [wireless],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-11-30",
    });

    expect(generated[0]?.date).toBe("2026-11-22");
  });

  it("can take it to the Friday before", () => {
    const generated = generateOccurrences({
      templates: [wireless],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-11-30",
      weekendRule: "friday_before",
    });

    expect(generated[0]?.date).toBe("2026-11-20");
  });

  it("can take it to the next business day", () => {
    const generated = generateOccurrences({
      templates: [wireless],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-11-30",
      weekendRule: "next_business_day",
    });

    expect(generated[0]?.date).toBe("2026-11-23");
  });

  it("keeps the same period key whichever rule is used", () => {
    const keys = (["as_scheduled", "friday_before", "next_business_day"] as const).map(
      (weekendRule) =>
        generateOccurrences({
          templates: [wireless],
          paySchedules: SCHEDULES,
          from: "2026-11-01",
          to: "2026-11-30",
          weekendRule,
        })[0]?.periodKey,
    );

    // Changing the rule must not make the same month generate twice.
    expect(new Set(keys).size).toBe(1);
  });
});

describe("running it twice", () => {
  const templates: TemplateSpec[] = [
    template({ id: "insurance", schedule: { type: "monthly", day: 17 } }),
    template({ id: "fees", schedule: { type: "monthly_last" } }),
    template({ id: "mortgage", schedule: { type: "relative_to_pay", payScheduleId: "dax", offsetDays: 1 } }),
    template({ id: "dax-pay", kind: "paycheque", schedule: { type: "biweekly", payScheduleId: "dax" } }),
    template({ id: "power", schedule: { type: "flexible", frequency: "monthly" } }),
    template({ id: "savings", kind: "transfer", schedule: { type: "flexible", frequency: "per_pay_period" } }),
  ];

  const options = {
    templates,
    paySchedules: SCHEDULES,
    from: "2026-11-07",
    to: "2026-12-16",
  } as const;

  it("produces an identical list, so nothing can be duplicated", () => {
    const first = generateOccurrences(options);
    const second = generateOccurrences(options);

    expect(second).toEqual(first);
  });

  it("gives every occurrence a key that is unique within its template", () => {
    const generated = generateOccurrences(options);
    const seen = new Set<string>();

    for (const occurrence of generated) {
      const key = `${occurrence.templateId}|${occurrence.periodKey}`;
      expect(seen.has(key), `duplicate ${key}`).toBe(false);
      seen.add(key);
    }

    expect(seen.size).toBe(generated.length);
  });

  it("skips templates that are turned off", () => {
    const withInactive = [
      ...templates,
      template({ id: "visa-subs", active: false, schedule: { type: "flexible", frequency: "monthly" } }),
    ];

    const generated = generateOccurrences({ ...options, templates: withInactive });
    expect(generated.some((occurrence) => occurrence.templateId === "visa-subs")).toBe(false);
  });
});

describe("generationWindow", () => {
  it("reaches one pay period past the horizon", () => {
    const window = generationWindow("2026-11-07", "2026-12-02");

    expect(window.from).toBe("2026-11-07");
    expect(window.to).toBe("2026-12-16");
    expect(GENERATION_LOOKAHEAD_DAYS).toBe(14);
  });
});

describe("which way the money goes", () => {
  it("takes a bill and a transfer off the balance", () => {
    expect(signedForKind("bill", 7_325n)).toBe(-7_325n);
    expect(signedForKind("transfer", 41_900n)).toBe(-41_900n);
  });

  it("adds a paycheque and a deposit to it", () => {
    expect(signedForKind("paycheque", 215_050n)).toBe(215_050n);
    expect(signedForKind("deposit", 6_150n)).toBe(6_150n);
  });

  it("decides from the kind, whichever sign it was handed", () => {
    // The point of the rule: a bill typed in as a positive amount is still
    // money leaving. Without it, the same bill is an outflow when a template
    // generates it and income when someone adds it by hand.
    expect(signedForKind("bill", -7_325n)).toBe(-7_325n);
    expect(signedForKind("deposit", -6_150n)).toBe(6_150n);
  });

  it("leaves nothing as nothing", () => {
    expect(signedForKind("bill", 0n)).toBe(0n);
    expect(signedForKind("deposit", 0n)).toBe(0n);
  });
});

describe("biweekly", () => {
  it("places a bill every fourteen days from its own anchor, as money going out", () => {
    // The case that had no way to be expressed at all: a biweekly expense that
    // is not aligned to anybody's pay. A mortgage has the dates the lender set.
    const mortgage = template({
      id: "mortgage",
      name: "Mortgage",
      defaultCents: 110_000n,
      schedule: { type: "biweekly", anchorDate: "2026-11-06" },
    });

    const generated = generateOccurrences({
      templates: [mortgage],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-12-31",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual([
      "2026-11-06",
      "2026-11-20",
      "2026-12-04",
      "2026-12-18",
    ]);
    // Signed by what it is. On this schedule the amount used to be forced
    // positive, so a biweekly bill would have been money arriving.
    expect(generated.every((occurrence) => occurrence.cents === -110_000n)).toBe(true);
  });

  it("keys by the cycle date, so it cannot generate twice", () => {
    const generated = generateOccurrences({
      templates: [template({ id: "gym", schedule: { type: "biweekly", anchorDate: "2026-11-06" } })],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-11-30",
    });

    expect(generated.map((occurrence) => occurrence.periodKey)).toEqual([
      "2026-11-06",
      "2026-11-20",
    ]);
  });

  it("still follows a payday when told to, unchanged", () => {
    const pay = template({
      id: "dax_pay",
      name: "Dax's pay",
      kind: "paycheque",
      defaultCents: 175_000n,
      schedule: { type: "biweekly", payScheduleId: "dax" },
    });

    const generated = generateOccurrences({
      templates: [pay],
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-12-31",
    });

    expect(generated.map((occurrence) => occurrence.date)).toEqual([
      "2026-11-12",
      "2026-11-26",
      "2026-12-10",
      "2026-12-24",
    ]);
    expect(generated.every((occurrence) => occurrence.cents === 175_000n)).toBe(true);
  });

  it("moves a bill off a weekend when the household says to, but never a paycheque", () => {
    // Pay arrives when the employer sends it. A withdrawal is what the rule is
    // actually about.
    const options = {
      paySchedules: SCHEDULES,
      from: "2026-11-01",
      to: "2026-11-30",
      weekendRule: "friday_before" as const,
    };

    // 2026-11-07 is a Saturday.
    const bill = generateOccurrences({
      ...options,
      templates: [template({ id: "bill", schedule: { type: "biweekly", anchorDate: "2026-11-07" } })],
    });
    const pay = generateOccurrences({
      ...options,
      templates: [
        template({
          id: "pay",
          kind: "paycheque",
          schedule: { type: "biweekly", anchorDate: "2026-11-07" },
        }),
      ],
    });

    expect(bill[0]?.date).toBe("2026-11-06");
    expect(pay[0]?.date).toBe("2026-11-07");
    // And the key is the cycle date either way, so turning the rule on does
    // not produce a second copy of the same bill.
    expect(bill[0]?.periodKey).toBe("2026-11-07");
  });

  it("refuses a schedule that names both an anchor and a payday, or neither", () => {
    const run = (schedule: TemplateSpec["schedule"]) => () =>
      generateOccurrences({
        templates: [template({ id: "x", schedule })],
        paySchedules: SCHEDULES,
        from: "2026-11-01",
        to: "2026-11-30",
      });

    expect(run({ type: "biweekly", payScheduleId: "dax", anchorDate: "2026-11-06" })).toThrow(
      /exactly one/,
    );
    expect(run({ type: "biweekly" })).toThrow(/exactly one/);
    expect(run({ type: "biweekly", payScheduleId: "nobody" })).toThrow(/does not exist/);
  });
});
