CREATE TABLE "WorkspaceMember" (
 "workspaceId" TEXT NOT NULL REFERENCES "Workspace"(id) ON DELETE CASCADE,
 "userId" TEXT NOT NULL REFERENCES "User"(id) ON DELETE CASCADE,
 role TEXT NOT NULL CHECK (role IN ('editor','viewer')),
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
 PRIMARY KEY ("workspaceId","userId")
);
CREATE INDEX "WorkspaceMember_userId_idx" ON "WorkspaceMember"("userId");
CREATE TABLE "AppCredential" (provider TEXT PRIMARY KEY, secret TEXT NOT NULL, "updatedAt" TIMESTAMP(3) NOT NULL);
CREATE TABLE "AIUsage" (
 id TEXT PRIMARY KEY, "workspaceId" TEXT NOT NULL REFERENCES "Workspace"(id) ON DELETE CASCADE,
 provider TEXT NOT NULL, model TEXT NOT NULL, "durationMs" INTEGER NOT NULL,
 "inputTokens" INTEGER, "outputTokens" INTEGER, outcome TEXT NOT NULL,
 "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX "AIUsage_workspaceId_createdAt_idx" ON "AIUsage"("workspaceId","createdAt");
DELETE FROM "AccountToken" WHERE purpose='invite';
