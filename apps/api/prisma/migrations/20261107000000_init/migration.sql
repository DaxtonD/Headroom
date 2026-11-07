-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "TemplateKind" AS ENUM ('paycheque', 'bill', 'deposit', 'transfer');

-- CreateEnum
CREATE TYPE "ScheduleType" AS ENUM ('monthly', 'monthly_last', 'relative_to_pay', 'biweekly', 'flexible');

-- CreateEnum
CREATE TYPE "WithdrawalKind" AS ENUM ('auto', 'flexible');

-- CreateEnum
CREATE TYPE "BudgetSection" AS ENUM ('income', 'fixed', 'variable');

-- CreateEnum
CREATE TYPE "AssetKind" AS ENUM ('asset', 'liability');

-- CreateEnum
CREATE TYPE "PayCadence" AS ENUM ('biweekly');

-- CreateEnum
CREATE TYPE "WeekendWithdrawalRule" AS ENUM ('as_scheduled', 'friday_before', 'next_business_day');

-- CreateEnum
CREATE TYPE "ActivityAction" AS ENUM ('create', 'update', 'verify', 'unverify', 'clear', 'unclear', 'move', 'soft_delete', 'restore', 'snapshot');

-- CreateTable
CREATE TABLE "household" (
    "id" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "timezone" TEXT NOT NULL DEFAULT 'America/Regina',
    "currency" TEXT NOT NULL DEFAULT 'CAD',
    "cushionCents" BIGINT NOT NULL DEFAULT 0,
    "horizonRule" TEXT NOT NULL DEFAULT 'through_day_before_nth_paycheque',
    "horizonPaychequeCount" INTEGER NOT NULL DEFAULT 4,
    "weekendWithdrawalRule" "WeekendWithdrawalRule" NOT NULL DEFAULT 'as_scheduled',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "household_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "initial" VARCHAR(2) NOT NULL,
    "email" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "colorFg" TEXT NOT NULL DEFAULT '#3F4844',
    "colorBg" TEXT NOT NULL DEFAULT '#ECEAE3',
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "user_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "session" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMPTZ(6) NOT NULL,
    "lastSeenAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "userAgent" TEXT,
    "ip" TEXT,

    CONSTRAINT "session_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "account" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "account_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "balance_snapshot" (
    "id" UUID NOT NULL,
    "accountId" UUID NOT NULL,
    "cents" BIGINT NOT NULL,
    "asOf" TIMESTAMPTZ(6) NOT NULL,
    "enteredById" UUID NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "note" TEXT,

    CONSTRAINT "balance_snapshot_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "pay_schedule" (
    "id" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "cadence" "PayCadence" NOT NULL DEFAULT 'biweekly',
    "anchorDate" DATE NOT NULL,
    "defaultCents" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "pay_schedule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "template" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "kind" "TemplateKind" NOT NULL,
    "name" TEXT NOT NULL,
    "defaultCents" BIGINT NOT NULL,
    "ownerUserId" UUID,
    "withdrawal" "WithdrawalKind" NOT NULL,
    "scheduleType" "ScheduleType" NOT NULL,
    "scheduleJson" JSONB NOT NULL,
    "section" "BudgetSection",
    "budgetLineId" UUID,
    "active" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "template_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "occurrence" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "templateId" UUID,
    "periodKey" TEXT,
    "name" TEXT NOT NULL,
    "cents" BIGINT NOT NULL,
    "kind" "TemplateKind" NOT NULL,
    "date" DATE,
    "anchorOccurrenceId" UUID,
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "withdrawal" "WithdrawalKind" NOT NULL,
    "isOneOff" BOOLEAN NOT NULL DEFAULT false,
    "ownerUserId" UUID,
    "verifiedById" UUID,
    "verifiedAt" TIMESTAMPTZ(6),
    "clearedById" UUID,
    "clearedAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdById" UUID,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "occurrence_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "budget_line" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "section" "BudgetSection" NOT NULL,
    "name" TEXT NOT NULL,
    "monthlyCents" BIGINT NOT NULL,
    "yearlyCentsOverride" BIGINT,
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "budget_line_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "goal" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "name" TEXT NOT NULL,
    "targetCents" BIGINT NOT NULL,
    "savedCents" BIGINT NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "goal_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "reimbursement" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "purchase" TEXT NOT NULL,
    "cents" BIGINT NOT NULL,
    "boughtOn" DATE NOT NULL,
    "submittedAt" TIMESTAMPTZ(6),
    "paidAt" TIMESTAMPTZ(6),
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "reimbursement_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "banked_hours_entry" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "hours" DECIMAL(6,2) NOT NULL,
    "note" TEXT,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "banked_hours_entry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "asset" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "kind" "AssetKind" NOT NULL,
    "name" TEXT NOT NULL,
    "cents" BIGINT NOT NULL,
    "asOf" DATE,
    "note" TEXT,
    "sortIndex" INTEGER NOT NULL DEFAULT 0,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,
    "deletedAt" TIMESTAMPTZ(6),
    "deletedById" UUID,

    CONSTRAINT "asset_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "retirement_settings" (
    "householdId" UUID NOT NULL,
    "rrspCurrentPlusContribCents" BIGINT NOT NULL,
    "mortgageMonthlyCents" BIGINT NOT NULL,
    "redirectYears" INTEGER NOT NULL,
    "flatGrowthPct" INTEGER NOT NULL,
    "compoundYearly" BOOLEAN NOT NULL DEFAULT false,
    "drawdownYears" INTEGER NOT NULL,
    "govPensionAnnualCents" BIGINT NOT NULL,
    "retirementExpensesAnnualCents" BIGINT NOT NULL,
    "version" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedById" UUID,

    CONSTRAINT "retirement_settings_pkey" PRIMARY KEY ("householdId")
);

-- CreateTable
CREATE TABLE "activity" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "action" "ActivityAction" NOT NULL,
    "entity" TEXT NOT NULL,
    "entityId" UUID NOT NULL,
    "versionAfter" INTEGER NOT NULL,
    "fields" TEXT[],
    "beforeJson" JSONB,
    "afterJson" JSONB,

    CONSTRAINT "activity_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "idempotency_key" (
    "key" UUID NOT NULL,
    "userId" UUID NOT NULL,
    "method" TEXT NOT NULL,
    "path" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER NOT NULL,
    "responseJson" JSONB NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "idempotency_key_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "user_email_key" ON "user"("email");

-- CreateIndex
CREATE INDEX "user_householdId_idx" ON "user"("householdId");

-- CreateIndex
CREATE INDEX "session_userId_idx" ON "session"("userId");

-- CreateIndex
CREATE INDEX "session_expiresAt_idx" ON "session"("expiresAt");

-- CreateIndex
CREATE INDEX "account_householdId_idx" ON "account"("householdId");

-- CreateIndex
CREATE INDEX "balance_snapshot_accountId_asOf_idx" ON "balance_snapshot"("accountId", "asOf");

-- CreateIndex
CREATE INDEX "pay_schedule_userId_idx" ON "pay_schedule"("userId");

-- CreateIndex
CREATE INDEX "template_householdId_active_idx" ON "template"("householdId", "active");

-- CreateIndex
CREATE INDEX "occurrence_householdId_date_idx" ON "occurrence"("householdId", "date");

-- CreateIndex
CREATE INDEX "occurrence_householdId_clearedAt_idx" ON "occurrence"("householdId", "clearedAt");

-- CreateIndex
CREATE INDEX "occurrence_anchorOccurrenceId_sortIndex_idx" ON "occurrence"("anchorOccurrenceId", "sortIndex");

-- CreateIndex
CREATE UNIQUE INDEX "occurrence_templateId_periodKey_key" ON "occurrence"("templateId", "periodKey");

-- CreateIndex
CREATE INDEX "budget_line_householdId_section_idx" ON "budget_line"("householdId", "section");

-- CreateIndex
CREATE INDEX "goal_householdId_idx" ON "goal"("householdId");

-- CreateIndex
CREATE INDEX "reimbursement_householdId_idx" ON "reimbursement"("householdId");

-- CreateIndex
CREATE INDEX "banked_hours_entry_householdId_idx" ON "banked_hours_entry"("householdId");

-- CreateIndex
CREATE INDEX "banked_hours_entry_userId_idx" ON "banked_hours_entry"("userId");

-- CreateIndex
CREATE INDEX "asset_householdId_kind_idx" ON "asset"("householdId", "kind");

-- CreateIndex
CREATE INDEX "activity_entity_entityId_versionAfter_idx" ON "activity"("entity", "entityId", "versionAfter");

-- CreateIndex
CREATE INDEX "activity_householdId_at_idx" ON "activity"("householdId", "at");

-- CreateIndex
CREATE INDEX "idempotency_key_createdAt_idx" ON "idempotency_key"("createdAt");

-- AddForeignKey
ALTER TABLE "user" ADD CONSTRAINT "user_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "session" ADD CONSTRAINT "session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_accountId_fkey" FOREIGN KEY ("accountId") REFERENCES "account"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "balance_snapshot" ADD CONSTRAINT "balance_snapshot_enteredById_fkey" FOREIGN KEY ("enteredById") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "pay_schedule" ADD CONSTRAINT "pay_schedule_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_budgetLineId_fkey" FOREIGN KEY ("budgetLineId") REFERENCES "budget_line"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_templateId_fkey" FOREIGN KEY ("templateId") REFERENCES "template"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_ownerUserId_fkey" FOREIGN KEY ("ownerUserId") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_anchorOccurrenceId_fkey" FOREIGN KEY ("anchorOccurrenceId") REFERENCES "occurrence"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "goal" ADD CONSTRAINT "goal_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "reimbursement" ADD CONSTRAINT "reimbursement_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banked_hours_entry" ADD CONSTRAINT "banked_hours_entry_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "banked_hours_entry" ADD CONSTRAINT "banked_hours_entry_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "asset" ADD CONSTRAINT "asset_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "retirement_settings" ADD CONSTRAINT "retirement_settings_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "activity" ADD CONSTRAINT "activity_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "idempotency_key" ADD CONSTRAINT "idempotency_key_userId_fkey" FOREIGN KEY ("userId") REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;

