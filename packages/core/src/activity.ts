/**
 * Turning an activity row into a sentence a person would say.
 *
 * "Alex verified the mortgage", not "update occurrence 4f3a... fields
 * [verifiedAt]". The database records the second kind; this is the only place
 * that knows how to say the first.
 *
 * ## Why it lives in the engine
 *
 * Two things need this wording and they must never disagree: the activity log
 * on screen, and the push notification that says the same thing on the other
 * person's phone. If the server worded notifications and the client worded the
 * log, the two would drift apart the first time either was edited, and the
 * household would be told two different stories about one event.
 *
 * ## No figures
 *
 * Nothing here ever includes an amount. That is a deliberate continuation of
 * the rule the live-update ping already follows: a notification travels
 * through a push service and lands on a lock screen, and the household asked
 * for what happened, not for how much. The log on screen is behind the sign-in
 * and could afford amounts, but it uses the same sentence so that the two
 * cannot drift - and a log that reads the same as the notification is one
 * fewer thing to learn.
 */

/** The actions the database records. Mirrors the `ActivityAction` enum. */
export type ActivityAction =
  | "create"
  | "update"
  | "verify"
  | "unverify"
  | "clear"
  | "unclear"
  | "move"
  | "soft_delete"
  | "restore"
  | "snapshot";

/**
 * One row of the log, as much of it as the wording needs.
 *
 * `label` and `labelKind` are nullable because rows written before they
 * existed have neither, and because a few things genuinely have no name.
 */
export interface ActivityEvent {
  readonly action: ActivityAction;
  /** The table the row lives in: "occurrence", "reimbursement", and so on. */
  readonly entity: string;
  /** What it was called at the time. */
  readonly label: string | null;
  /** What sort of thing it was, in the household's words: "bill", "payday". */
  readonly labelKind: string | null;
  /** Exactly which fields this change touched. */
  readonly fields: readonly string[];
  /** The changed fields' values afterwards, when the wording turns on them. */
  readonly after?: Readonly<Record<string, unknown>> | null;
}

/** Kinds that money arrives in rather than leaves by. */
const INCOMING = new Set(["payday", "paycheque", "deposit"]);

/**
 * What to call the thing, with no amount and no invented name.
 *
 * A row with no label falls back to its kind - "a bill" rather than a blank
 * or an id. Rows from before labels existed take this path, and so does
 * anything genuinely nameless.
 */
function subjectOf(event: ActivityEvent): string {
  const named = event.label ?? nameInside(event.after);

  if (named !== null && named.trim() !== "") {
    const label = named.trim();
    // "the Chequing balance" reads; "Chequing" on its own does not say what
    // changed, and the balance is the one thing both people watch.
    if (event.labelKind === "balance") return `the ${label} balance`;
    return label;
  }

  if (event.labelKind !== null && event.labelKind.trim() !== "") {
    return withArticle(event.labelKind.trim());
  }

  return withArticle(nounFor(event.entity));
}

/**
 * The name sitting in the snapshot, for rows written before labels existed.
 *
 * Every creation stored the whole row it created, so its name is already
 * there. Reading it costs nothing and is the reason this needed no back-fill
 * - which is just as well, because `activity` is insert-only and the database
 * refuses to be rewritten.
 */
function nameInside(after: ActivityEvent["after"]): string | null {
  // `purchase` is what a work expense calls its name, and the only other
  // field in the schema that serves the same job.
  for (const field of ["name", "purchase"]) {
    const value = after?.[field];
    if (typeof value === "string" && value.trim() !== "") return value;
  }
  return null;
}

/** A readable noun for an entity nobody gave a kind to. */
function nounFor(entity: string): string {
  switch (entity) {
    case "occurrence":
      return "item";
    case "balance_snapshot":
      return "balance";
    case "reimbursement":
      return "work expense";
    case "budget_line":
      return "budget category";
    case "banked_hours_entry":
      return "banked hours entry";
    case "pay_schedule":
      return "payday schedule";
    case "retirement_settings":
      return "retirement plan";
    case "net_worth":
    case "asset":
      return "net worth entry";
    case "prepayment":
      return "lump sum";
    case "template":
      /*
       * Not "bill": a template can be a paycheque, a deposit or a transfer
       * too, and rows from before `labelKind` existed do not say which. Not
       * "template" either - that is the schema's word, and nobody using this
       * app has ever seen it.
       */
      return "recurring item";
    default:
      return entity.replace(/_/g, " ");
  }
}

function withArticle(noun: string): string {
  return /^[aeiou]/i.test(noun) ? `an ${noun}` : `a ${noun}`;
}

/** Did this change touch exactly these fields and no others? */
function only(event: ActivityEvent, ...names: readonly string[]): boolean {
  return event.fields.length === names.length && names.every((name) => event.fields.includes(name));
}

function became(event: ActivityEvent, field: string): boolean | undefined {
  const value = event.after?.[field];
  return typeof value === "boolean" ? value : undefined;
}

/**
 * What somebody did, without their name: "verified the mortgage".
 *
 * Every branch has a sentence that still reads when the label is missing,
 * because a log that shows "verified" on its own is a log nobody trusts.
 */
export function describeActivity(event: ActivityEvent): string {
  const subject = subjectOf(event);
  const incoming = INCOMING.has(event.labelKind ?? "");

  switch (event.action) {
    case "create":
      if (event.entity === "balance_snapshot") return `updated ${subject}`;
      if (event.entity === "reimbursement") return `bought ${subject}`;
      return `added ${subject}`;

    case "snapshot":
      return `updated ${subject}`;

    case "verify":
      return `verified ${subject}`;

    case "unverify":
      return `undid verifying ${subject}`;

    case "clear":
      /*
       * Two different flags arrive here. `paid` is the ledger's tick - the
       * two of them have dealt with it. `cleared` is the balance-update
       * checklist saying the money is already inside the figure just typed.
       * They mean different things and must not read the same.
       */
      if (event.fields.includes("cleared")) return `counted ${subject} in the new balance`;
      return incoming ? `marked ${subject} received` : `marked ${subject} paid`;

    case "unclear":
      if (event.fields.includes("cleared")) return `took ${subject} back out of the balance`;
      return incoming ? `undid received on ${subject}` : `undid paid on ${subject}`;

    case "move":
      return `moved ${subject} to another payday`;

    case "soft_delete":
      return `removed ${subject}`;

    case "restore":
      return `brought ${subject} back`;

    case "update":
      return describeUpdate(event, subject);
  }
}

/** An update says what kind of update it was, where the fields make that clear. */
function describeUpdate(event: ActivityEvent, subject: string): string {
  if (event.entity === "reimbursement") {
    if (only(event, "submitted")) {
      return became(event, "submitted") === false
        ? `undid submitting ${subject}`
        : `submitted ${subject} for reimbursement`;
    }
    if (only(event, "paid")) {
      return became(event, "paid") === false
        ? `undid paid back on ${subject}`
        : `marked ${subject} paid back`;
    }
  }

  if (only(event, "active")) {
    return became(event, "active") === false ? `turned ${subject} off` : `turned ${subject} back on`;
  }

  if (only(event, "cents") || only(event, "defaultCents") || only(event, "monthlyCents")) {
    return `changed the amount of ${subject}`;
  }
  if (only(event, "date")) return `moved ${subject} to another day`;
  if (only(event, "name")) return `renamed ${subject}`;
  if (only(event, "ownerUserId")) return `changed whose ${subject} it is`;

  return `updated ${subject}`;
}

/** The whole sentence, for a notification or a line of the log. */
export function activitySentence(actor: string, event: ActivityEvent): string {
  return `${actor} ${describeActivity(event)}`;
}
