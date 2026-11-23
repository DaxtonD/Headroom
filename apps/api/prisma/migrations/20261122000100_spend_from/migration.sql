-- Where purchases come from, for now.
--
-- Asked for on 2026-11-22. It replaces a conversation the household was
-- already having by hand: when chequing runs low, one of them tells the other
-- in the morning that necessary purchases go on the Visa until payday, and
-- that a variable bill has been pushed to a later pay period.
--
-- The message was never the hard part. What failed was somebody forgetting and
-- recording a purchase against chequing anyway - at which point every figure
-- on the ledger is wrong in the direction that matters, because chequing looks
-- emptier than it is and the card looks healthier. So this is not a note
-- pinned to the screen. It is the DEFAULT SOURCE ACCOUNT for a new one-off,
-- and the banner is a consequence of the setting rather than the point of it.
--
-- On `household` rather than in a table of its own: there is exactly one of
-- these in force at a time, and putting it here means it inherits the
-- versioning, idempotency and activity machinery that every household fact
-- already goes through. Two people can set this at once and they must not
-- silently overwrite each other, so a 409 on the same field is the correct
-- answer - which is the opposite of the reasoning behind `user_preference`,
-- where there is one writer by construction.
--
-- Nothing here is derived and stored. Whether the posture is still in force is
-- computed from `spendFromUntil` and today, every time it is asked, like every
-- other figure in this app. A boolean would be a second source of truth that
-- goes stale at midnight.
ALTER TABLE "household"
  -- Null is the ordinary state: purchases come out of chequing.
  ADD COLUMN "spendFromAccountId" UUID,
  -- The last day it applies, inclusive. Set to the next payday by default,
  -- because a posture nobody turns off becomes permanently on and therefore
  -- stops being read.
  ADD COLUMN "spendFromUntil"     DATE,
  -- Why, in their words. Never an amount - it reaches a lock screen.
  ADD COLUMN "spendFromNote"      TEXT,
  -- Who said so, and when. The other person seeing who it was without having
  -- to ask is most of what this is for.
  ADD COLUMN "spendFromSetById"   UUID,
  ADD COLUMN "spendFromSetAt"     TIMESTAMPTZ(6);

-- No cascade and no `ON DELETE SET NULL` needed on the account: accounts are
-- soft-deleted in this schema, never removed, so the reference cannot dangle.
-- Validated in the route against the household's own accounts, which is also
-- what stops another household's id being pointed at.
