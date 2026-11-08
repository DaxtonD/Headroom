-- Carol's stated net income, for the Budget screen (HANDOFF section 4.3).
--
-- Both a monthly and a yearly figure, because hers do not agree exactly
-- (section 14 q2 says to use her numbers as given rather than reconcile them).
-- Defaults of 0 so existing rows stay valid; the Budget screen shows zeroes
-- until someone fills them in.

ALTER TABLE "household" ADD COLUMN     "netMonthlyIncomeCents" BIGINT NOT NULL DEFAULT 0,
ADD COLUMN "netYearlyIncomeCents" BIGINT NOT NULL DEFAULT 0;
