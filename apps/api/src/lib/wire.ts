/**
 * The wire format for money.
 *
 * **Amounts cross the wire as integer cents in a string**, in both directions.
 * `"-18600"` is minus one hundred and eighty-six dollars. Never a decimal,
 * never a `number`.
 *
 * Why a string: JSON has no bigint, and a `number` would risk precision above
 * 2^53. Why integer cents rather than `"186.00"`: there is then exactly one
 * representation of an amount, so no layer can convert twice.
 *
 * That last point is not hypothetical. An earlier version accepted a decimal
 * dollar string here and used `parseCents` to read it, while the web app was
 * already sending integer cents. Typing 186 into a bill therefore saved
 * $18,600: the client turned "186" into 18600 cents, and the server read
 * "18600" as a dollar amount. Both sides had tests and both passed, because
 * neither test crossed the seam.
 *
 * So: `parseCents` is for HUMAN INPUT and belongs only at the UI edge, where
 * someone types "186" or "$1,234.56". Anything arriving over HTTP uses the
 * schema below, which refuses a decimal outright rather than guessing which
 * convention the caller meant.
 */
import { z } from "zod";

/** A decimal point in an amount means the caller has the wrong convention. */
const DECIMAL_HINT =
  'Amounts are integer cents, so $186.00 is "18600". A value with a decimal point is ambiguous and is refused on purpose.';

/**
 * An amount of money arriving over HTTP: integer cents, as a string.
 *
 * A `number` is accepted too, for convenience from scripts, but only when it
 * is a safe integer.
 */
/**
 * The union only decides string-versus-number; all the checking happens in the
 * transform.
 *
 * Deliberately NOT a union of two validating branches: when every branch of a
 * `z.union` fails, Zod reports its own generic "Invalid input" and throws away
 * the branch's message. The whole value of this schema is the message it gives
 * when it refuses, so the branches must always succeed and the transform must
 * raise the issues.
 */
export const wireCents = z.union([z.string(), z.number()]).transform((value, ctx) => {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      ctx.addIssue({ code: "custom", message: DECIMAL_HINT });
      return z.NEVER;
    }
    if (!Number.isSafeInteger(value)) {
      ctx.addIssue({
        code: "custom",
        message: "That amount is too large to be sent as a number; send it as a string instead.",
      });
      return z.NEVER;
    }
    return BigInt(value);
  }

  const trimmed = value.trim();

  if (trimmed === "") {
    ctx.addIssue({ code: "custom", message: `An amount is required. ${DECIMAL_HINT}` });
    return z.NEVER;
  }

  if (trimmed.includes(".") || trimmed.includes(",")) {
    ctx.addIssue({ code: "custom", message: DECIMAL_HINT });
    return z.NEVER;
  }

  if (!/^[-+]?\d+$/.test(trimmed)) {
    ctx.addIssue({
      code: "custom",
      message: `"${value}" is not an amount in integer cents. ${DECIMAL_HINT}`,
    });
    return z.NEVER;
  }

  return BigInt(trimmed);
});

/** Integer cents, and never negative. Used for the chequing balance. */
export const wireCentsNonNegative = wireCents.refine((value) => value >= 0n, {
  message: "A balance cannot be negative. Enter it without a minus sign.",
});
