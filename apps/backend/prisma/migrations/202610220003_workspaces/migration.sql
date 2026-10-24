-- DropForeignKey
ALTER TABLE "WorkflowVersion" DROP CONSTRAINT "WorkflowVersion_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "Run" DROP CONSTRAINT "Run_workflowId_fkey";

-- DropForeignKey
ALTER TABLE "RunScope" DROP CONSTRAINT "RunScope_runId_fkey";

-- DropForeignKey
ALTER TABLE "NodeExecution" DROP CONSTRAINT "NodeExecution_runId_fkey";

-- DropForeignKey
ALTER TABLE "NodeAttempt" DROP CONSTRAINT "NodeAttempt_taskId_fkey";

-- DropForeignKey
ALTER TABLE "ExecutionEvent" DROP CONSTRAINT "ExecutionEvent_runId_fkey";

-- DropForeignKey
ALTER TABLE "Checkpoint" DROP CONSTRAINT "Checkpoint_workflowId_fkey";

-- AlterTable
-- Legacy password removed only after creating the administrator.

-- AlterTable
DELETE FROM "Session";
ALTER TABLE "Session" ADD COLUMN     "userId" TEXT NOT NULL;

-- AlterTable
ALTER TABLE "Workflow" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "WorkflowVersion" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Run" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "RunScope" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "NodeExecution" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "NodeAttempt" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "ExecutionEvent" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Outbox" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Connection" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Checkpoint" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "SourceCheckpoint" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Note" ADD COLUMN     "workspaceId" TEXT;

-- AlterTable
ALTER TABLE "Artifact" ADD COLUMN     "workspaceId" TEXT;

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "username" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "isAdmin" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "mustCompleteProfile" BOOLEAN NOT NULL DEFAULT false,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Workspace" (
    "id" TEXT NOT NULL,
    "ownerId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "settings" JSONB NOT NULL,
    "storageKey" TEXT NOT NULL,
    "deletedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Workspace_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AccountToken" (
    "id" TEXT NOT NULL,
    "purpose" TEXT NOT NULL,
    "username" TEXT,
    "userId" TEXT,
    "workspaceId" TEXT,
    "connectionId" TEXT,
    "createdById" TEXT,
    "expiresAt" TIMESTAMP(3) NOT NULL,
    "consumedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AccountToken_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FileMigration" (
    "workspaceId" TEXT NOT NULL,
    "completedAt" TIMESTAMP(3),
    "manifest" JSONB NOT NULL,

    CONSTRAINT "FileMigration_pkey" PRIMARY KEY ("workspaceId")
);

-- Preserve the old owner and all existing IDs in one private workspace.
INSERT INTO "User" (id, username, "displayName", "passwordHash", "isAdmin", "mustCompleteProfile", "createdAt")
SELECT 'legacy-owner', 'owner', 'Owner', "passwordHash", true, true, "createdAt" FROM "Installation" WHERE id='owner';
INSERT INTO "Workspace" (id, "ownerId", name, settings, "storageKey", "updatedAt")
SELECT 'legacy-personal', 'legacy-owner', 'Personal', settings, 'legacy-personal', CURRENT_TIMESTAMP FROM "Installation" WHERE id='owner';
UPDATE "Workflow" SET "workspaceId"='legacy-personal';
ALTER TABLE "Workflow" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "WorkflowVersion" SET "workspaceId"='legacy-personal';
ALTER TABLE "WorkflowVersion" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "Run" SET "workspaceId"='legacy-personal';
ALTER TABLE "Run" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "RunScope" SET "workspaceId"='legacy-personal';
ALTER TABLE "RunScope" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "NodeExecution" SET "workspaceId"='legacy-personal';
ALTER TABLE "NodeExecution" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "NodeAttempt" SET "workspaceId"='legacy-personal';
ALTER TABLE "NodeAttempt" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "ExecutionEvent" SET "workspaceId"='legacy-personal';
ALTER TABLE "ExecutionEvent" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "Outbox" SET "workspaceId"='legacy-personal';
ALTER TABLE "Outbox" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "Connection" SET "workspaceId"='legacy-personal';
ALTER TABLE "Connection" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "Checkpoint" SET "workspaceId"='legacy-personal';
ALTER TABLE "Checkpoint" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "SourceCheckpoint" SET "workspaceId"='legacy-personal';
ALTER TABLE "SourceCheckpoint" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "Note" SET "workspaceId"='legacy-personal';
ALTER TABLE "Note" ALTER COLUMN "workspaceId" SET NOT NULL;
UPDATE "Artifact" SET "workspaceId"='legacy-personal';
ALTER TABLE "Artifact" ALTER COLUMN "workspaceId" SET NOT NULL;
INSERT INTO "FileMigration" ("workspaceId", manifest) SELECT 'legacy-personal', '{}'::jsonb FROM "User" WHERE id='legacy-owner';
ALTER TABLE "Installation" DROP COLUMN "passwordHash";
UPDATE "Installation" SET settings = settings - 'retainAIDetails' - 'retentionDays';

-- CreateIndex
CREATE UNIQUE INDEX "User_username_key" ON "User"("username");

-- CreateIndex
CREATE UNIQUE INDEX "Workspace_storageKey_key" ON "Workspace"("storageKey");

-- CreateIndex
CREATE INDEX "Workspace_ownerId_deletedAt_idx" ON "Workspace"("ownerId", "deletedAt");

-- CreateIndex
CREATE INDEX "AccountToken_purpose_expiresAt_idx" ON "AccountToken"("purpose", "expiresAt");

-- CreateIndex
CREATE INDEX "Workflow_workspaceId_idx" ON "Workflow"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Workflow_workspaceId_id_key" ON "Workflow"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "WorkflowVersion_workspaceId_idx" ON "WorkflowVersion"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "WorkflowVersion_workspaceId_id_key" ON "WorkflowVersion"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Run_workspaceId_idx" ON "Run"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Run_workspaceId_id_key" ON "Run"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "RunScope_workspaceId_idx" ON "RunScope"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "RunScope_workspaceId_id_key" ON "RunScope"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "NodeExecution_workspaceId_idx" ON "NodeExecution"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeExecution_workspaceId_id_key" ON "NodeExecution"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "NodeAttempt_workspaceId_idx" ON "NodeAttempt"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "NodeAttempt_workspaceId_id_key" ON "NodeAttempt"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "ExecutionEvent_workspaceId_idx" ON "ExecutionEvent"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "ExecutionEvent_workspaceId_id_key" ON "ExecutionEvent"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Outbox_workspaceId_idx" ON "Outbox"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Outbox_workspaceId_id_key" ON "Outbox"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Connection_workspaceId_idx" ON "Connection"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Connection_workspaceId_id_key" ON "Connection"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Checkpoint_workspaceId_idx" ON "Checkpoint"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Checkpoint_workspaceId_id_key" ON "Checkpoint"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "SourceCheckpoint_workspaceId_idx" ON "SourceCheckpoint"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "SourceCheckpoint_workspaceId_id_key" ON "SourceCheckpoint"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Note_workspaceId_idx" ON "Note"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Note_workspaceId_id_key" ON "Note"("workspaceId", "id");

-- CreateIndex
CREATE INDEX "Artifact_workspaceId_idx" ON "Artifact"("workspaceId");

-- CreateIndex
CREATE UNIQUE INDEX "Artifact_workspaceId_id_key" ON "Artifact"("workspaceId", "id");

-- AddForeignKey
ALTER TABLE "Session" ADD CONSTRAINT "Session_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WorkflowVersion" ADD CONSTRAINT "WorkflowVersion_workspaceId_workflowId_fkey" FOREIGN KEY ("workspaceId", "workflowId") REFERENCES "Workflow"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Run" ADD CONSTRAINT "Run_workspaceId_workflowId_fkey" FOREIGN KEY ("workspaceId", "workflowId") REFERENCES "Workflow"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunScope" ADD CONSTRAINT "RunScope_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RunScope" ADD CONSTRAINT "RunScope_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "Run"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeExecution" ADD CONSTRAINT "NodeExecution_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeExecution" ADD CONSTRAINT "NodeExecution_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "Run"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeAttempt" ADD CONSTRAINT "NodeAttempt_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "NodeAttempt" ADD CONSTRAINT "NodeAttempt_workspaceId_taskId_fkey" FOREIGN KEY ("workspaceId", "taskId") REFERENCES "NodeExecution"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ExecutionEvent" ADD CONSTRAINT "ExecutionEvent_workspaceId_runId_fkey" FOREIGN KEY ("workspaceId", "runId") REFERENCES "Run"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Outbox" ADD CONSTRAINT "Outbox_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Connection" ADD CONSTRAINT "Connection_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Checkpoint" ADD CONSTRAINT "Checkpoint_workspaceId_workflowId_fkey" FOREIGN KEY ("workspaceId", "workflowId") REFERENCES "Workflow"("workspaceId", "id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SourceCheckpoint" ADD CONSTRAINT "SourceCheckpoint_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Note" ADD CONSTRAINT "Note_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_workspaceId_fkey" FOREIGN KEY ("workspaceId") REFERENCES "Workspace"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Workspace" ADD CONSTRAINT "Workspace_ownerId_fkey" FOREIGN KEY ("ownerId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AccountToken" ADD CONSTRAINT "AccountToken_userId_fkey" FOREIGN KEY ("userId") REFERENCES "User"("id") ON DELETE CASCADE ON UPDATE CASCADE;


-- Published versions and run versions cannot point outside their workflow/workspace.
CREATE UNIQUE INDEX "WorkflowVersion_workspace_workflow_id" ON "WorkflowVersion"("workspaceId","workflowId",id);
ALTER TABLE "Run" ADD CONSTRAINT "Run_version_workspace_fkey" FOREIGN KEY ("workspaceId","workflowId","versionId") REFERENCES "WorkflowVersion"("workspaceId","workflowId",id) ON DELETE CASCADE;
ALTER TABLE "Workflow" ADD CONSTRAINT "Workflow_published_workspace_fkey" FOREIGN KEY ("workspaceId",id,"publishedId") REFERENCES "WorkflowVersion"("workspaceId","workflowId",id) DEFERRABLE INITIALLY DEFERRED;
ALTER TABLE "Artifact" ADD CONSTRAINT "Artifact_run_workspace_fkey" FOREIGN KEY ("workspaceId","runId") REFERENCES "Run"("workspaceId",id) ON DELETE CASCADE;
