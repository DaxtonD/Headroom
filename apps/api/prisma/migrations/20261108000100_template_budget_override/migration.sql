-- A stated monthly budget figure for a recurring bill.
--
-- Headroom derives what a bill costs per month from its cadence: biweekly is
-- 26 times a year, so 26/12 of the amount, which is more than twice it. Where
-- Carol's sheet states a different monthly figure, hers is the spec and this
-- column holds it. NULL means use the derived figure.

ALTER TABLE "template" ADD COLUMN     "monthlyBudgetOverrideCents" BIGINT;
