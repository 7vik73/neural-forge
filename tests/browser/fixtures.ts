import { randomBytes, randomUUID } from 'node:crypto';
import { mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { config as dotenv } from 'dotenv';
import type { APIRequestContext } from '@playwright/test';
export const headers = {
  Origin: process.env.TEST_APP_URL ?? 'http://localhost:4300',
  'X-Forge-Request': '1',
};
export async function seedBrowserAccount() {
  dotenv({ path: '.env', quiet: true });
  const { Database } = await import('../../apps/backend/dist/database.js');
  const { Workspaces } = await import('../../apps/backend/dist/workspaces.js');
  const { passwordHash } = await import('../../apps/backend/dist/security.js');
  const { config } = await import('../../apps/backend/dist/config.js');
  const db = new Database();
  const prefix = `e2e_${randomUUID().slice(0, 8)}`,
    password = randomBytes(20).toString('hex');
  const user = await db.user.create({
    data: {
      username: `${prefix}_admin`,
      displayName: 'Browser fixture administrator',
      passwordHash: passwordHash(password),
      isAdmin: true,
    },
  });
  const service = new Workspaces(db, null as any);
  const workspace = await service.create(user.id, 'Personal');
  await mkdir('.local', { recursive: true });
  return {
    db,
    user,
    workspace,
    prefix,
    password,
    async login(request: APIRequestContext) {
      const result = await request.post('/api/v1/auth/login', {
        headers,
        data: { username: user.username, password },
      });
      if (!result.ok()) throw new Error(`Fixture login failed: ${result.status()}`);
      return request.storageState();
    },
    async cleanup() {
      const users = await db.user.findMany({
        where: { username: { startsWith: prefix } },
        select: { id: true },
      });
      const ids = users.map((u) => u.id);
      const spaces = await db.workspace.findMany({ where: { ownerId: { in: ids } } });
      await db.user.updateMany({ where: { id: { in: ids } }, data: { status: 'suspended' } });
      for (const space of spaces) {
        await db.workspace.delete({ where: { id: space.id } });
        await rm(join(config.workspaceStorage, space.storageKey), { recursive: true, force: true });
      }
      await db.accountToken.deleteMany({
        where: { OR: [{ username: { startsWith: prefix } }, { createdById: { in: ids } }] },
      });
      await db.user.deleteMany({ where: { id: { in: ids } } });
      await db.$disconnect();
    },
  };
}
