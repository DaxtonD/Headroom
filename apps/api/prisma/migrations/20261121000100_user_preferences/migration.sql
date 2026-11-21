-- How the app looks for one person, kept where a cleared browser cannot take it.
--
-- The theme, the text size and the ledger's row density have lived in
-- `localStorage` since they were built, on the reasoning that they are
-- per-eye and per-screen rather than household facts. That reasoning still
-- holds for which device they apply to; what it got wrong is durability. One
-- of the two clears their browser every day, which took all three with it, so
-- the app greeted them every morning in a theme and a size they had not
-- chosen. Asked for on 2026-11-21: store them on the server and load them at
-- sign-in.
--
-- Per user, not per household: neither person may change how the app looks
-- for the other.
--
-- Not versioned, not logged, and no `deletedAt`, which is the exception in
-- this schema and is deliberate. The versioning rules exist so two people
-- editing the same money fact cannot silently overwrite each other. This row
-- has one writer by construction, holds no money, and a 409 on a theme is a
-- question nobody could answer. `push_subscription` is the existing precedent
-- for a per-person device fact written the plain way.
--
-- No row is created here. An absent row means "this person has never chosen",
-- which is what lets a device that already has a choice in `localStorage` seed
-- the server with it rather than being reset to the defaults below.
CREATE TABLE "user_preference" (
  "userId"        UUID           NOT NULL,
  "theme"         VARCHAR(16)    NOT NULL DEFAULT 'daylight',
  "textSize"      VARCHAR(16)    NOT NULL DEFAULT 'largest',
  "ledgerDensity" VARCHAR(16)    NOT NULL DEFAULT 'comfortable',
  "updatedAt"     TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "user_preference_pkey" PRIMARY KEY ("userId")
);

-- Deleting a person takes their preferences with them. There is nothing here
-- anybody would want to keep, and no other table points at this one.
ALTER TABLE "user_preference"
  ADD CONSTRAINT "user_preference_userId_fkey" FOREIGN KEY ("userId")
  REFERENCES "user"("id") ON DELETE CASCADE ON UPDATE CASCADE;
