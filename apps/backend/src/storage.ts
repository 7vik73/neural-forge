import { HttpException } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { mkdir, readdir, copyFile } from 'node:fs/promises';
import { join, resolve, relative, isAbsolute } from 'node:path';
import { createReadStream } from 'node:fs';
import { LocalFiles } from '@forge/connectors';
import { Database, json } from './database.js';
import { config } from './config.js';
import {
  currentWorkspace,
  accessScope,
  authorizedWorkspace,
  requireWorkspaceRole,
} from './scope.js';

export const defaultSettings = (timezone = 'UTC') => ({
  timezone,
  model: config.model,
  retentionDays: 30,
  retainAIDetails: false,
});
export const trashDeadline = () => new Date(Date.now() - 30 * 86400_000);
export async function storagePath(db: Database, workspaceId = currentWorkspace()) {
  const workspace = await authorizedWorkspace(db.system, workspaceId);
  if (!workspace || !/^[a-zA-Z0-9-]+$/.test(workspace.storageKey))
    throw new HttpException('This workspace was not found.', 404);
  return join(config.workspaceStorage, workspace.storageKey, 'files');
}
export class WorkspaceFiles {
  constructor(private readonly db: Database) {}
  async path(name: string, create = false) {
    return new LocalFiles(await storagePath(this.db)).path(name, create);
  }
  async list(name = '') {
    return new LocalFiles(await storagePath(this.db)).list(name);
  }
  async read(name: string) {
    return new LocalFiles(await storagePath(this.db)).read(name);
  }
  async write(name: string, text: string, create: boolean) {
    await requireWorkspaceRole(this.db, 'editor');
    return new LocalFiles(await storagePath(this.db)).write(name, text, create);
  }
}
// The original folder is read only. Verified copies make retries safe after interruption.
export async function migrateLegacyFiles(db: Database) {
  return db.system.$transaction(
    async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('legacy-file-migration'))`;
      const hashFile = async (path: string) => {
        const hash = createHash('sha256');
        for await (const chunk of createReadStream(path)) hash.update(chunk);
        return hash.digest('hex');
      };
      for (const migration of await db.fileMigration.findMany({ where: { completedAt: null } })) {
        await db.withWorkspace(
          migration.workspaceId,
          async () => {
            const destination = await storagePath(db);
            const inside = relative(resolve(config.localFolder), resolve(destination));
            if (!inside || (!inside.startsWith('..') && !isAbsolute(inside)))
              throw new Error('WORKSPACE_STORAGE_ROOT must be separate from the legacy folder.');
            await mkdir(destination, { recursive: true, mode: 0o700 });
            const manifest: Record<string, string> = {
              ...(migration.manifest as Record<string, string>),
            };
            const visit = async (relative: string) => {
              for (const entry of await readdir(join(config.localFolder, relative), {
                withFileTypes: true,
              })) {
                if (entry.isSymbolicLink())
                  throw new Error(
                    'Legacy file migration found a symlink. Remove it from the migration source and retry.',
                  );
                const name = join(relative, entry.name);
                if (entry.isDirectory()) {
                  await mkdir(join(destination, name), { recursive: true });
                  await visit(name);
                } else if (entry.isFile()) {
                  const before = await hashFile(join(config.localFolder, name));
                  if (
                    manifest[name] === before &&
                    (await hashFile(join(destination, name)).catch(() => '')) === before
                  )
                    continue;
                  await copyFile(join(config.localFolder, name), join(destination, name));
                  const after = await hashFile(join(destination, name));
                  if (before !== after)
                    throw new Error(
                      'A legacy file changed during migration. Stop editing that folder and retry.',
                    );
                  manifest[name] = after;
                  await db.fileMigration.update({
                    where: { workspaceId: migration.workspaceId },
                    data: { manifest: json(manifest) },
                  });
                }
              }
            };
            await visit('');
            await db.fileMigration.update({
              where: { workspaceId: migration.workspaceId },
              data: { completedAt: new Date(), manifest: json(manifest) },
            });
          },
          { allowInactive: true },
        );
      }
    },
    { maxWait: 600_000, timeout: 600_000 },
  );
}
