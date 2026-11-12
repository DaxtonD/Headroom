-- "Paid" and "already in the balance" are two different statements.
--
-- They were one flag, and that flag did both jobs: marking a bill paid took it
-- off the timeline AND subtracted it from the balance. Which meant a bill that
-- had already come out before the balance was read off the bank got subtracted
-- twice - once inside the typed figure, and once again by the tick - leaving
-- the household short by the amount of the bill, silently.
--
-- It also meant the row vanished, which is the opposite of what a ledger is
-- for: "when an item is marked as paid it disappears; Carol doesn't like this".
--
-- So the tick becomes its own thing. It records that the two of them have dealt
-- with something, changes no figure at all, and leaves the row on the timeline
-- still being counted. `cleared` keeps its one real job: the balance-update
-- checklist saying "this is already inside the figure I just typed", which is
-- the only place that can know.
ALTER TABLE "occurrence" ADD COLUMN "paidAt"   TIMESTAMPTZ(6);
ALTER TABLE "occurrence" ADD COLUMN "paidById" UUID;

ALTER TABLE "occurrence"
  ADD CONSTRAINT "occurrence_paidById_fkey" FOREIGN KEY ("paidById")
  REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Who and when, together or not at all, like the other two pairs.
ALTER TABLE "occurrence"
  ADD CONSTRAINT occurrence_paid_pair CHECK (
    ("paidAt" IS NULL) = ("paidById" IS NULL)
  );

-- Anything already marked cleared from the ledger was somebody saying "this is
-- dealt with", so it carries the tick now. It stays cleared as well: the money
-- has been accounted for one way or another, and quietly putting rows back on
-- the timeline would change balances that have been read and relied on.
UPDATE "occurrence"
   SET "paidAt" = "clearedAt", "paidById" = "clearedById"
 WHERE "clearedAt" IS NOT NULL;
