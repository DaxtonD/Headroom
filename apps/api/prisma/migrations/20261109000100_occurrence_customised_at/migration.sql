-- Which occurrences are a person's own, and which are still just a derivation
-- of their template.
--
-- Generation used to leave every existing occurrence alone, which protected
-- edits perfectly and meant a correction made under Manage reached nothing:
-- the amount, the name and the date on the ledger stayed as first generated,
-- for the whole visible horizon. Changing a bill appeared to do nothing.
--
-- So generation now brings an untouched row into line with its template, and
-- this column is what "untouched" means. It is set by the occurrence PATCH
-- route when a person changes the row's own details, and never by generation.
-- Verifying or clearing a row protects it too, through their own timestamps.
ALTER TABLE "occurrence" ADD COLUMN "customisedAt" TIMESTAMPTZ(6);

-- Every row that exists now predates the column. A row that was edited,
-- verified or cleared has to stay exactly as it is, so the ones that carry
-- evidence of a person are marked here rather than guessed at later.
UPDATE "occurrence"
   SET "customisedAt" = COALESCE("verifiedAt", "clearedAt", "updatedAt")
 WHERE "version" > 1
    OR "verifiedAt" IS NOT NULL
    OR "clearedAt" IS NOT NULL;
