-- Database-level integrity guards (HANDOFF section 8 and section 16.1 rule 9).
--
-- These are deliberately enforced by Postgres rather than only by application
-- code. Two people edit this data from two phones, and a bug in a route must
-- not be able to rewrite history or silently corrupt an amount.

-- ---------------------------------------------------------------------------
-- Insert-only tables
-- ---------------------------------------------------------------------------
-- A balance snapshot is a statement of fact at a moment in time: a correction
-- is a NEW snapshot, and the latest as_of wins (section 16.1 rule 5).
-- Activity is the audit log that powers history, undo and conflict detection
-- (section 16.4), so it can only ever grow.

CREATE OR REPLACE FUNCTION headroom_forbid_update_delete()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'Table % is insert-only. Record a new row instead of changing or removing one.',
    TG_TABLE_NAME
    USING ERRCODE = 'restrict_violation';
END;
$$;

CREATE TRIGGER balance_snapshot_insert_only
  BEFORE UPDATE OR DELETE ON "balance_snapshot"
  FOR EACH ROW EXECUTE FUNCTION headroom_forbid_update_delete();

CREATE TRIGGER activity_insert_only
  BEFORE UPDATE OR DELETE ON "activity"
  FOR EACH ROW EXECUTE FUNCTION headroom_forbid_update_delete();

-- ---------------------------------------------------------------------------
-- Occurrence shape
-- ---------------------------------------------------------------------------
-- "The way the bank sees it" (section 6.2): an automatic item has a real date
-- and the money must be there on that date; a flexible item has no date and
-- hangs off a paycheque instead (a null anchor meaning "now"). Allowing both
-- or neither would make the timeline ordering ambiguous.
ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_dated_xor_flexible CHECK (
    ("withdrawal" = 'auto' AND "date" IS NOT NULL)
    OR ("withdrawal" = 'flexible' AND "date" IS NULL)
  );

-- A flexible item cannot be its own anchor.
ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_anchor_not_self CHECK (
    "anchorOccurrenceId" IS NULL OR "anchorOccurrenceId" <> "id"
  );

-- Verification and clearing each record who did it and when, together or not
-- at all. A half-set pair would make "Carol verified this" unanswerable.
ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_verified_pair CHECK (
    ("verifiedAt" IS NULL) = ("verifiedById" IS NULL)
  );

ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_cleared_pair CHECK (
    ("clearedAt" IS NULL) = ("clearedById" IS NULL)
  );

-- ---------------------------------------------------------------------------
-- Versions
-- ---------------------------------------------------------------------------
-- Optimistic concurrency depends on a version that only ever moves forward
-- (section 16.1 rule 3). Version 0 or a negative version would make If-Match
-- meaningless.
ALTER TABLE "household"            ADD CONSTRAINT household_version_positive            CHECK ("version" > 0);
ALTER TABLE "user"                 ADD CONSTRAINT user_version_positive                 CHECK ("version" > 0);
ALTER TABLE "account"              ADD CONSTRAINT account_version_positive              CHECK ("version" > 0);
ALTER TABLE "pay_schedule"         ADD CONSTRAINT pay_schedule_version_positive         CHECK ("version" > 0);
ALTER TABLE "template"             ADD CONSTRAINT template_version_positive             CHECK ("version" > 0);
ALTER TABLE "occurrence"           ADD CONSTRAINT occurrence_version_positive           CHECK ("version" > 0);
ALTER TABLE "budget_line"          ADD CONSTRAINT budget_line_version_positive          CHECK ("version" > 0);
ALTER TABLE "goal"                 ADD CONSTRAINT goal_version_positive                 CHECK ("version" > 0);
ALTER TABLE "reimbursement"        ADD CONSTRAINT reimbursement_version_positive        CHECK ("version" > 0);
ALTER TABLE "banked_hours_entry"   ADD CONSTRAINT banked_hours_version_positive         CHECK ("version" > 0);
ALTER TABLE "asset"                ADD CONSTRAINT asset_version_positive                CHECK ("version" > 0);
ALTER TABLE "retirement_settings"  ADD CONSTRAINT retirement_settings_version_positive  CHECK ("version" > 0);

ALTER TABLE "activity"
  ADD CONSTRAINT activity_version_after_positive CHECK ("versionAfter" > 0);

-- ---------------------------------------------------------------------------
-- Soft delete
-- ---------------------------------------------------------------------------
-- There can be a deletion without a known actor, but never an actor without
-- a deletion.
ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_deleted_pair CHECK (
    "deletedAt" IS NOT NULL OR "deletedById" IS NULL
  );

ALTER TABLE "template"
  ADD CONSTRAINT template_deleted_pair CHECK (
    "deletedAt" IS NOT NULL OR "deletedById" IS NULL
  );

-- ---------------------------------------------------------------------------
-- Values that cannot be negative
-- ---------------------------------------------------------------------------
-- Occurrence and budget amounts are signed on purpose (money in and money
-- out), so they are NOT constrained here. These are magnitudes.
ALTER TABLE "goal"
  ADD CONSTRAINT goal_amounts_sane CHECK ("targetCents" > 0 AND "savedCents" >= 0);

ALTER TABLE "asset"
  ADD CONSTRAINT asset_cents_non_negative CHECK ("cents" >= 0);

ALTER TABLE "reimbursement"
  ADD CONSTRAINT reimbursement_cents_positive CHECK ("cents" > 0);

-- Submitted before paid back, when both are known.
ALTER TABLE "reimbursement"
  ADD CONSTRAINT reimbursement_order CHECK (
    "paidAt" IS NULL OR "submittedAt" IS NULL OR "paidAt" >= "submittedAt"
  );

ALTER TABLE "household"
  ADD CONSTRAINT household_cushion_non_negative CHECK ("cushionCents" >= 0);

ALTER TABLE "household"
  ADD CONSTRAINT household_horizon_count_sane CHECK (
    "horizonPaychequeCount" BETWEEN 1 AND 52
  );

-- ---------------------------------------------------------------------------
-- Retirement assumptions
-- ---------------------------------------------------------------------------
-- All editable settings, but a zero drawdown would divide by zero in the
-- engine and a nonsensical growth rate would quietly produce nonsense.
ALTER TABLE "retirement_settings"
  ADD CONSTRAINT retirement_settings_sane CHECK (
    "redirectYears" >= 0
    AND "drawdownYears" > 0
    AND "flatGrowthPct" BETWEEN -100 AND 1000
    AND "rrspCurrentPlusContribCents" >= 0
    AND "mortgageMonthlyCents" >= 0
    AND "govPensionAnnualCents" >= 0
    AND "retirementExpensesAnnualCents" >= 0
  );

-- ---------------------------------------------------------------------------
-- People and sessions
-- ---------------------------------------------------------------------------
ALTER TABLE "user"
  ADD CONSTRAINT user_initial_present CHECK (length(btrim("initial")) BETWEEN 1 AND 2);

ALTER TABLE "user"
  ADD CONSTRAINT user_name_present CHECK (length(btrim("name")) > 0);

ALTER TABLE "session"
  ADD CONSTRAINT session_expires_after_creation CHECK ("expiresAt" > "createdAt");

-- ---------------------------------------------------------------------------
-- Names
-- ---------------------------------------------------------------------------
-- A blank row name reads as an empty line in the timeline, which is worse
-- than being asked to name it.
ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_name_present CHECK (length(btrim("name")) > 0);

ALTER TABLE "template"
  ADD CONSTRAINT template_name_present CHECK (length(btrim("name")) > 0);

ALTER TABLE "budget_line"
  ADD CONSTRAINT budget_line_name_present CHECK (length(btrim("name")) > 0);
