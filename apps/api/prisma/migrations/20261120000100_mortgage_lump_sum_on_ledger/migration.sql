-- A lump sum off the mortgage, recorded where money actually moves.
--
-- Reported on 2026-11-20: "How do I make a lump sum payment to the mortgage?
-- It's not accessible from the ledger screen (one-off). The only way to do it
-- is from the savings screen (Add a lump sum) but it doesn't specify where the
-- money is coming out of."
--
-- It did not specify because, as built, none did: a `prepayment` row fed the
-- payoff projection and the prepayment allowance and moved no balance
-- anywhere. Recording a real lump sum took two unrelated entries, and doing
-- only the first left the Savings screen saying the mortgage was years shorter
-- while chequing had never dropped.
--
-- The mortgage is not an `account`, so a lump sum cannot be an ordinary
-- transfer: there is no balance for the money to arrive in, only a loan to be
-- made smaller. This column says where it went instead, and the row carries
-- everything else already - the source account, the date, the amount and
-- whether it has settled.
--
-- The row is the whole record. The Savings screen derives its paid lump sums
-- from these rather than keeping a second copy, so there is nothing to keep in
-- step when one is edited, ticked or deleted on the ledger. `prepayment` goes
-- on holding lump sums that are only INTENDED - those move no money and have
-- no row - and every `prepayment` already in the database is untouched.
--
-- Additive and reversible by hand: one nullable column with no default and one
-- index. Every existing occurrence keeps a NULL mortgageId, which means what
-- it has always meant: this row is not a mortgage payment.
--
-- ON DELETE CASCADE, unlike the account references beside it. Deleting a
-- mortgage is already a deliberate act that takes its prepayments with it, and
-- a lump sum off a mortgage that no longer exists is not a row anybody could
-- act on.

-- AlterTable
ALTER TABLE "occurrence" ADD COLUMN     "mortgageId" UUID;

-- CreateIndex
CREATE INDEX "occurrence_mortgageId_date_idx" ON "occurrence"("mortgageId", "date");

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_mortgageId_fkey" FOREIGN KEY ("mortgageId") REFERENCES "mortgage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
