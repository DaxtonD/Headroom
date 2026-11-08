-- Who verified an amount, and who marked it paid (HANDOFF section 5 rule 5).
--
-- These were stored as plain ids from the start; this adds the foreign keys so
-- the names can be read back in one query and a deleted user cannot leave a
-- dangling reference. ON DELETE SET NULL, because the verification still
-- happened even if the account is later removed.

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_verifiedById_fkey" FOREIGN KEY ("verifiedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "occurrence" ADD CONSTRAINT "occurrence_clearedById_fkey" FOREIGN KEY ("clearedById") REFERENCES "user"("id") ON DELETE SET NULL ON UPDATE CASCADE;

