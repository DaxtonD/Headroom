-- A picture beside a name, for expenses, accounts and budget-only categories.
--
-- Additive and reversible by hand: one new table, three nullable columns with
-- no default, and nothing rewritten. Every existing row keeps a NULL imageId,
-- which is what "no picture" has always meant.
--
-- `ON DELETE SET NULL` on the three references is a safety net rather than a
-- route anybody takes: the API deletes an image only once nothing points at
-- it. If one ever went anyway, the name stays and the square falls back to its
-- placeholder, which is a visible nothing rather than a broken row.
--
-- The bytes are in the database on purpose. The household's backup is a
-- Duplicati job pointed at a folder of database dumps, so anything on a
-- filesystem volume would be outside it and nobody would find out until they
-- needed it.

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "imageId" UUID;

-- AlterTable
ALTER TABLE "template" ADD COLUMN     "imageId" UUID;

-- AlterTable
ALTER TABLE "budget_line" ADD COLUMN     "imageId" UUID;

-- CreateTable
CREATE TABLE "image" (
    "id" UUID NOT NULL,
    "householdId" UUID NOT NULL,
    "sha256" CHAR(64) NOT NULL,
    "bytes" BYTEA NOT NULL,
    "contentType" TEXT NOT NULL,
    "width" INTEGER NOT NULL,
    "height" INTEGER NOT NULL,
    "byteSize" INTEGER NOT NULL,
    "createdAt" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "createdById" UUID,

    CONSTRAINT "image_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "image_householdId_idx" ON "image"("householdId");

-- CreateIndex
CREATE UNIQUE INDEX "image_householdId_sha256_key" ON "image"("householdId", "sha256");

-- CreateIndex
CREATE INDEX "account_imageId_idx" ON "account"("imageId");

-- CreateIndex
CREATE INDEX "template_imageId_idx" ON "template"("imageId");

-- CreateIndex
CREATE INDEX "budget_line_imageId_idx" ON "budget_line"("imageId");

-- AddForeignKey
ALTER TABLE "image" ADD CONSTRAINT "image_householdId_fkey" FOREIGN KEY ("householdId") REFERENCES "household"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "account" ADD CONSTRAINT "account_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "template" ADD CONSTRAINT "template_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "budget_line" ADD CONSTRAINT "budget_line_imageId_fkey" FOREIGN KEY ("imageId") REFERENCES "image"("id") ON DELETE SET NULL ON UPDATE CASCADE;

