-- AlterTable
ALTER TABLE "mortgage" ADD COLUMN     "anchorDate" DATE,
ALTER COLUMN "payScheduleId" DROP NOT NULL;
