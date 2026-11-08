-- CreateEnum
CREATE TYPE "EarmarkPurpose" AS ENUM ('general', 'mortgage_lump_sum');

-- CreateEnum
CREATE TYPE "RateCompounding" AS ENUM ('simple_division', 'semi_annual');

-- CreateEnum
CREATE TYPE "PrivilegePeriod" AS ENUM ('calendar_year');

-- AlterTable
ALTER TABLE "goal" ADD COLUMN     "purpose" "EarmarkPurpose" NOT NULL DEFAULT 'general',
ADD COLUMN     "sortIndex" INTEGER NOT NULL DEFAULT 0,
ALTER COLUMN "targetCents" DROP NOT NULL;

-- AlterTable
ALTER TABLE "template" ADD COLUMN     "transferToAccountId" UUID;

-- CreateTable
CREATE TABLE "mortgage" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "balanceCents" BIGINT NOT NULL,
    "asOf" DATE NOT NULL,
    "rateBasisPoints" INTEGER NOT NULL,
    "paymentCents" BIGINT NOT NULL,
    "payScheduleId" UUID NOT NULL,
    "offsetDays" INTEGER NOT NULL DEFAULT 1,
    "periodsPerYear" INTEGER NOT NULL DEFAULT 26,
    "cadenceDays" INTEGER NOT NULL DEFAULT 14,
    "compounding" "RateCompounding" NOT NULL DEFAULT 'simple_division',
    "prepaymentCapCents" BIGINT NOT NULL DEFAULT 0,
    "privilegePeriod" "PrivilegePeriod" NOT NULL DEFAULT 'calendar_year',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "mortgage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "prepayment" (
    "id" UUID NOT NULL,
    "mortgageId" UUID NOT NULL,
    "paidOn" DATE NOT NULL,
    "cents" BIGINT NOT NULL,
    "note" TEXT,
    "paid" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "prepayment_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "mortgage_householdId_idx" ON "mortgage"("householdId");

-- CreateIndex
CREATE INDEX "prepayment_mortgageId_paidOn_idx" ON "prepayment"("mortgageId", "paidOn");

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_transferToAccountId_fkey" FOREIGN KEY ("transferToAccountId") REFERENCES "account"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mortgage" ADD CONSTRAINT "mortgage_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "mortgage" ADD CONSTRAINT "mortgage_payScheduleId_fkey" FOREIGN KEY ("payScheduleId") REFERENCES "pay_schedule"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "prepayment" ADD CONSTRAINT "prepayment_mortgageId_fkey" FOREIGN KEY ("mortgageId") REFERENCES "mortgage"("id") ON DELETE CASCADE ON UPDATE CASCADE;
