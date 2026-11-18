-- Credit cards, and which account each row's money moves between.
--
-- Every column added here is nullable with no default, so every existing row
-- keeps meaning exactly what it meant: a null source is chequing, which is
-- what the single-account app always assumed.
--
-- `ALTER TYPE ... ADD VALUE` runs in this transaction on Postgres 12+ as long
-- as nothing in the same transaction uses the new value. Nothing here does.

-- AlterEnum
ALTER TYPE "AccountKind" ADD VALUE 'credit_card';

-- AlterTable
ALTER TABLE "template" ADD COLUMN     "paidFromAccountId" UUID;

-- AlterTable
ALTER TABLE "occurrence" ADD COLUMN     "paidFromAccountId" UUID,
ADD COLUMN     "transferToAccountId" UUID;

-- CreateIndex
CREATE INDEX "template_paidFromAccountId_idx" ON "template"("paidFromAccountId");

-- CreateIndex
CREATE INDEX "occurrence_paidFromAccountId_idx" ON "occurrence"("paidFromAccountId");

-- CreateIndex
CREATE INDEX "occurrence_transferToAccountId_idx" ON "occurrence"("transferToAccountId");

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_paidFromAccountId_fkey" FOREIGN KEY ("paidFromAccountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_paidFromAccountId_fkey" FOREIGN KEY ("paidFromAccountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_transferToAccountId_fkey" FOREIGN KEY ("transferToAccountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
