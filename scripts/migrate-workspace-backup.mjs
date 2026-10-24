import { readFileSync } from 'node:fs';
import { Database } from '../apps/backend/dist/database.js';
import { Workspaces } from '../apps/backend/dist/workspaces.js';
import { WorkspaceBackups, openBackup, sealWorkspaceBackup } from '../apps/backend/dist/backups.js';
const [filename, username] = process.argv.slice(2);
if (!filename || !username || !process.env.BACKUP_PASSPHRASE)
  throw new Error(
    'Usage: node scripts/manage.mjs migrate-workspace-backup <legacy-browser-backup.json> <owner-username>',
  );
const original = JSON.parse(readFileSync(filename, 'utf8'));
if (original.format !== 'neural-forge-backup' || original.version !== 1)
  throw new Error('Choose a legacy browser backup. Full installation archives use migrate-backup.');
const payload = openBackup(original, process.env.BACKUP_PASSPHRASE);
if (payload.schemaVersion !== 2 || !payload.tables?.installation?.[0])
  throw new Error('Unsupported legacy workspace schema.');
const db = new Database();
try {
  const user = await db.user.findUnique({ where: { username: username.trim().toLowerCase() } });
  if (!user || user.status !== 'active') throw new Error('Choose an active destination account.');
  const defaults = {
    timezone: 'UTC',
    model: 'qwen3:4b',
    retentionDays: 30,
    retainAIDetails: false,
  };
  const backup = sealWorkspaceBackup(
    {
      schemaVersion: 3,
      name: 'Imported Personal',
      settings: { ...defaults, ...payload.tables.installation[0].settings },
      tables: payload.tables,
      files: payload.files,
    },
    process.env.BACKUP_PASSPHRASE,
  );
  const service = new WorkspaceBackups(db, new Workspaces(db, null));
  const restored = await service.restore(user.id, {
    passphrase: process.env.BACKUP_PASSPHRASE,
    backup,
  });
  console.log(
    `Imported a new disabled private workspace: ${restored.workspaceId}. Account credentials were not imported.`,
  );
} finally {
  await db.$disconnect();
}
