CREATE TABLE "SourceCheckpoint" (
    "id" TEXT NOT NULL,
    "value" JSONB NOT NULL,
    "revision" INTEGER NOT NULL DEFAULT 0,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "SourceCheckpoint_pkey" PRIMARY KEY ("id")
);
ALTER TABLE "Note" ADD COLUMN "lastRunId" TEXT;
