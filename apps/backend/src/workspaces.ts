import { Inject, Injectable, HttpException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Database, json } from './database.js';
import { config } from './config.js';
import { ExecutionEngine } from './engine.js';
import { defaultSettings, trashDeadline, storagePath } from './storage.js';
@Injectable()
export class Workspaces {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ExecutionEngine) private readonly engine: ExecutionEngine,
  ) {}
  async create(ownerId: string, name: string, settings = defaultSettings(), client: any = this.db) {
    const id = randomUUID(),
      storageKey = randomUUID();
    const folder = join(config.workspaceStorage, storageKey, 'files');
    await mkdir(folder, { recursive: true, mode: 0o700 });
    try {
      return await client.workspace.create({
        data: { id, ownerId, name, storageKey, settings: json(settings) },
      });
    } catch (error) {
      await rm(join(config.workspaceStorage, storageKey), { recursive: true, force: true });
      throw error;
    }
  }
  async owned(id: string, ownerId: string, trashed = false) {
    const workspace = await this.db.workspace.findFirst({
      where: { id, ownerId, ...(trashed ? { deletedAt: { not: null } } : { deletedAt: null }) },
    });
    if (!workspace) throw new HttpException('This workspace was not found.', 404);
    return workspace;
  }
  async stop(id: string) {
    return this.db.withWorkspace(
      id,
      async () => {
        await this.db.workflow.updateMany({ data: { enabled: false, webhookHash: null } });
        await this.db.outbox.deleteMany();
        const runs = await this.db.run.findMany({
          where: { status: { in: ['queued', 'running', 'waiting'] } },
        });
        for (const run of runs) await this.engine.cancel(run.id);
        await this.db.accountToken.deleteMany({ where: { workspaceId: id } });
      },
      { allowInactive: true },
    );
  }
  async trash(id: string, ownerId: string) {
    await this.owned(id, ownerId);
    await this.db.workspace.update({ where: { id }, data: { deletedAt: new Date() } });
    await this.stop(id);
    return { ok: true };
  }
  async restore(id: string, ownerId: string) {
    const workspace = await this.owned(id, ownerId, true);
    if (workspace.deletedAt! <= trashDeadline())
      throw new HttpException('The recovery period has ended.', 410);
    await this.stop(id);
    return this.db.workspace.update({ where: { id }, data: { deletedAt: null } });
  }
  async purge(id: string) {
    const workspace = await this.db.workspace.findUniqueOrThrow({ where: { id } });
    if (!workspace.deletedAt) throw new Error('Move this workspace to trash first.');
    await this.stop(id);
    const running = await this.db.system.nodeExecution.count({
      where: { workspaceId: id, leaseUntil: { gt: new Date() } },
    });
    if (running)
      throw new HttpException(
        'Cancellation is still settling. Try permanent deletion in a minute.',
        409,
      );
    const path = await this.db.withWorkspace(id, () => storagePath(this.db), {
      allowInactive: true,
    });
    await rm(join(path, '..'), { recursive: true, force: true });
    await this.db.workspace.delete({ where: { id } });
    await this.db.fileMigration.deleteMany({ where: { workspaceId: id } });
  }
  async maintenance() {
    const inactive = await this.db.workspace.findMany({
      where: { OR: [{ deletedAt: { not: null } }, { owner: { status: { not: 'active' } } }] },
    });
    for (const workspace of inactive) {
      await this.stop(workspace.id);
      if (workspace.deletedAt && workspace.deletedAt <= trashDeadline())
        await this.purge(workspace.id).catch(() => {});
    }
    const expiredUsers = await this.db.user.findMany({
      where: { status: 'deleted', deletedAt: { lte: trashDeadline() } },
      include: { workspaces: true },
    });
    for (const user of expiredUsers)
      if (!user.workspaces.length) await this.db.user.delete({ where: { id: user.id } });
    await this.db.accountToken.deleteMany({ where: { expiresAt: { lt: new Date() } } });
  }
}
