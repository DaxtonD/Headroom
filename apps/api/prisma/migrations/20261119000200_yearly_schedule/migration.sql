-- A schedule that recurs once a year, for annual insurance and the yearly
-- subscriptions.
--
-- One new enum value and nothing else: no table, no column, no row rewritten.
-- Every existing template keeps the schedule type it has, and nothing can
-- become `yearly` without somebody choosing it on the expense form.
--
-- `ALTER TYPE ... ADD VALUE` runs inside this transaction on Postgres 12+ as
-- long as nothing in the same transaction uses the new value. Nothing here
-- does.

-- AlterEnum
ALTER TYPE "ScheduleType" ADD VALUE 'yearly';
