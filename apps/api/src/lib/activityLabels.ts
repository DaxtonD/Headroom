/**
 * What the household calls each kind of row, for the activity log.
 *
 * The database's word and the household's word are not always the same, and
 * the log is written for the household. `paycheque` is the schema's term;
 * on screen it has always been a payday.
 *
 * This matters beyond vocabulary: `@headroom/core`'s wording picks the verb
 * from it, because money arriving is received where money leaving is paid,
 * and both are the same action in the database.
 */
import type { TemplateKind } from "../generated/prisma/client.js";

export function labelKindFor(kind: TemplateKind): string {
  switch (kind) {
    case "paycheque":
      return "payday";
    case "bill":
      return "bill";
    case "deposit":
      return "deposit";
    case "transfer":
      return "transfer";
  }
}
