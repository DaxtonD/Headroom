-- CreateEnum
CREATE TYPE "AccountKind" AS ENUM ('chequing', 'savings');

-- AlterTable
ALTER TABLE "account" ADD COLUMN     "kind" "AccountKind" NOT NULL DEFAULT 'chequing';
