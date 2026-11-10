-- A flexible item may now sit on a date.
--
-- "Monthly, but I choose when to pay it" used to mean "undated, hung off the
-- first paycheque of the month". That is right about who chooses and wrong
-- about where it appears: a household that plans to pay the card on the 20th
-- wants to see it on the 20th, with the balance it will actually come out of,
-- while still being free to move it.
--
-- So the two halves of the old rule are separated. `withdrawal` says who
-- decides - 'auto' is the bank, 'flexible' is us - and the date says where it
-- sits. An automatic withdrawal still must have a date, because the bank has
-- already chosen one. A flexible item may have a date, or hang off a paycheque,
-- or neither (which means "now"), but never a date and an anchor at once:
-- that is the ambiguity the original constraint existed to prevent, and it is
-- still forbidden.
ALTER TABLE "occurrence" DROP CONSTRAINT occurrence_dated_xor_flexible;

ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_placed_one_way CHECK (
    ("withdrawal" = 'auto' AND "date" IS NOT NULL)
    OR (
      "withdrawal" = 'flexible'
      AND NOT ("date" IS NOT NULL AND "anchorOccurrenceId" IS NOT NULL)
    )
  );
