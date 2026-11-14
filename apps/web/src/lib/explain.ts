/**
 * The working behind each headline figure, in words and amounts.
 *
 * Pure: it takes the figures the engine already produced and arranges them
 * into something a person can read. It computes no totals of its own - an
 * explanation that could disagree with the number it explains would be worse
 * than no explanation at all, so every amount here arrives from the dashboard.
 *
 * Separate from the component so that file exports only a component (fast
 * refresh needs that) and so the wording can be tested without rendering.
 */
import { formatDateShort } from "@headroom/core";
import type { Cents } from "@headroom/core";

/** One line of the working: a label, and the amount it contributes. */
export interface WorkingLine {
  readonly label: string;
  readonly cents?: Cents;
  /** Shown as a subtraction, with the minus in front of the amount. */
  readonly negative?: boolean;
  /** The last line: the figure being explained. */
  readonly total?: boolean;
}

export interface Working {
  readonly title: string;
  /** One sentence saying what the figure means, before the sums. */
  readonly meaning: string;
  readonly lines: readonly WorkingLine[];
  /** Anything worth adding after the sums. */
  readonly notes?: readonly string[];
}

export function explainInChequing(input: {
  readonly cents: Cents;
  readonly snapshotCents: Cents;
  readonly asOf: Date | null;
  readonly enteredBy: { readonly name: string } | null;
}): Working {
  const clearedSince = input.cents - input.snapshotCents;

  const lines: WorkingLine[] = [
    {
      label: input.asOf
        ? `Typed in on ${formatDateShort(input.asOf.toISOString().slice(0, 10))}${
            input.enteredBy ? ` by ${input.enteredBy.name}` : ""
          }`
        : "Not entered yet",
      cents: input.snapshotCents,
    },
  ];

  // Only worth a line when it is not nothing.
  if (clearedSince !== 0n) {
    lines.push({
      label: "Marked as already gone since then",
      cents: clearedSince,
      negative: clearedSince < 0n,
    });
  }

  lines.push({ label: "In chequing", cents: input.cents, total: true });

  return {
    title: "In chequing",
    meaning: "The balance you last read off the bank, and anything settled since.",
    lines,
    notes:
      clearedSince === 0n
        ? ["This only changes when you enter a new balance."]
        : undefined,
  };
}

export function explainSafeToSpend(input: {
  readonly safeToSpendNowCents: Cents;
  readonly cushionCents: Cents;
  readonly lowest: { readonly cents: Cents; readonly date: string | null };
  readonly lowestAfterName: string | null;
  readonly horizonEnd: string;
}): Working {
  const atTheStart = input.lowestAfterName === null;

  const lines: WorkingLine[] = [
    {
      label: atTheStart
        ? "The lowest your balance gets is right now"
        : `The lowest your balance gets, after ${input.lowestAfterName}${
            input.lowest.date ? ` on ${formatDateShort(input.lowest.date)}` : ""
          }`,
      cents: input.lowest.cents,
    },
    { label: "Less your cushion", cents: input.cushionCents, negative: true },
    { label: "Safe to spend now", cents: input.safeToSpendNowCents, total: true },
  ];

  const notes: string[] = [
    "Spending today lowers every balance after it, so what limits you is the lowest point ahead — not what is left at the end.",
  ];

  if (atTheStart) {
    notes.push(
      "Nothing dips below today's balance between now and " +
        `${formatDateShort(input.horizonEnd)}, because money arrives before it goes out.`,
    );
  }

  if (input.cushionCents === 0n) {
    notes.push(
      "Your cushion is set to nothing, so this figure will let you spend right down to zero at that lowest point. You can set one under Manage.",
    );
  }

  return {
    title: "Safe to spend now",
    meaning: `The most you could spend today without any balance between now and ${formatDateShort(
      input.horizonEnd,
    )} falling below your cushion.`,
    lines,
    notes,
  };
}

export function explainLeftThisCycle(input: {
  readonly breakdown: {
    readonly startBalanceCents: Cents;
    readonly inCents: Cents;
    readonly inCount: number;
    readonly outCents: Cents;
    readonly outCount: number;
    readonly endCents: Cents;
  };
  readonly horizonEnd: string;
}): Working {
  const { breakdown } = input;

  return {
    title: "Left this cycle",
    meaning: `What is left once everything on the ledger has happened, through ${formatDateShort(
      input.horizonEnd,
    )}.`,
    lines: [
      { label: "In chequing now", cents: breakdown.startBalanceCents },
      {
        label: `Coming in (${breakdown.inCount} ${breakdown.inCount === 1 ? "item" : "items"})`,
        cents: breakdown.inCents,
      },
      {
        label: `Going out (${breakdown.outCount} ${breakdown.outCount === 1 ? "item" : "items"})`,
        cents: breakdown.outCents,
        negative: true,
      },
      { label: "Left this cycle", cents: breakdown.endCents, total: true },
    ],
    notes: [
      "Marking something paid does not change this: the money is counted once either way.",
    ],
  };
}
