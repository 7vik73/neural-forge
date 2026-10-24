import { it, expect } from 'vitest';
import { config as dotenv } from 'dotenv';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { mkdtemp, writeFile, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { templates } from '@forge/connectors';
dotenv({ path: '.env', quiet: true });
it('upgrades the legacy owner, preserves data and verified files, and invalidates sessions', async () => {
  const { PrismaClient } = await import('../apps/backend/node_modules/@prisma/client/default.js');
  const { Database } = await import('../apps/backend/dist/database.js');
  const { config } = await import('../apps/backend/dist/config.js');
  const { passwordHash, verifyPassword, encrypt } = await import(
    '../apps/backend/dist/security.js'
  );
  const { migrateLegacyFiles } = await import('../apps/backend/dist/storage.js');
  const root = new PrismaClient(),
    name = `forge_migration_${randomUUID().slice(0, 8)}_test`;
  const url = new URL(process.env.DATABASE_URL!);
  url.pathname = `/${name}`;
  const folder = await mkdtemp(join(tmpdir(), 'forge-legacy-'));
  const storage = await mkdtemp(join(tmpdir(), 'forge-managed-'));
  const oldFolder = config.localFolder,
    oldStorage = config.workspaceStorage;
  let migrated: any;
  try {
    await root.$executeRawUnsafe(`CREATE DATABASE "${name}"`);
    const apply = (file: string) => {
      const result = spawnSync(
        process.execPath,
        [
          'apps/backend/node_modules/prisma/build/index.js',
          'db',
          'execute',
          '--schema',
          'apps/backend/prisma/schema.prisma',
          '--file',
          file,
        ],
        { encoding: 'utf8', env: { ...process.env, DATABASE_URL: url.toString() } },
      );
      if (result.status) throw new Error(`Migration fixture SQL failed: ${result.stderr}`);
    };
    apply('apps/backend/prisma/migrations/202610220001_initial/migration.sql');
    apply('apps/backend/prisma/migrations/202610220002_shared_inbox/migration.sql');
    const legacy = new PrismaClient({ datasources: { db: { url: url.toString() } } });
    // Raw inserts describe the old schema; the new generated client cannot model it.
    const hash = passwordHash('legacy fixture password');
    await legacy.$executeRawUnsafe(
      'INSERT INTO "Installation" (id,"passwordHash",settings) VALUES ($1,$2,$3::jsonb)',
      'owner',
      hash,
      JSON.stringify({
        timezone: 'Asia/Kolkata',
        model: 'qwen3:4b',
        retentionDays: 90,
        retainAIDetails: true,
      }),
    );
    await legacy.$executeRawUnsafe(
      'INSERT INTO "Workflow" (id,name,draft,"updatedAt") VALUES ($1,$2,$3::jsonb,CURRENT_TIMESTAMP)',
      'legacy-flow',
      'Existing flow',
      JSON.stringify(templates[0]!.definition),
    );
    await legacy.$executeRawUnsafe(
      'INSERT INTO "WorkflowVersion" (id,"workflowId",number,definition) VALUES ($1,$2,1,$3::jsonb)',
      'legacy-version',
      'legacy-flow',
      JSON.stringify(templates[0]!.definition),
    );
    await legacy.$executeRawUnsafe(
      'UPDATE "Workflow" SET "publishedId"=$1, enabled=true WHERE id=$2',
      'legacy-version',
      'legacy-flow',
    );
    await legacy.$executeRawUnsafe(
      'INSERT INTO "Note" (id,title,text,"updatedAt") VALUES ($1,$2,$3,CURRENT_TIMESTAMP)',
      'legacy-note',
      'Existing note',
      'Preserve my text',
    );
    await legacy.$executeRawUnsafe(
      'INSERT INTO "Connection" (id,name,kind,secret,"updatedAt") VALUES ($1,$2,$3,$4,CURRENT_TIMESTAMP)',
      'legacy-connection',
      'Existing bearer',
      'http',
      encrypt({ token: 'synthetic-token' }),
    );
    await legacy.$executeRawUnsafe(
      'INSERT INTO "Session" (id,"expiresAt") VALUES ($1,CURRENT_TIMESTAMP + interval \'1 day\')',
      'legacy-session',
    );
    await legacy.$disconnect();
    await writeFile(join(folder, 'original.md'), 'Preserved original file');
    apply('apps/backend/prisma/migrations/202610220003_workspaces/migration.sql');
    apply('apps/backend/prisma/migrations/202610220004_restored_history/migration.sql');
    apply('apps/backend/prisma/migrations/202610220005_shared_apps/migration.sql');
    migrated = new Database({ datasources: { db: { url: url.toString() } } });
    const user = await migrated.user.findUniqueOrThrow({ where: { username: 'owner' } });
    expect(user.isAdmin).toBe(true);
    expect(user.mustCompleteProfile).toBe(true);
    expect(verifyPassword('legacy fixture password', user.passwordHash)).toBe(true);
    expect(await migrated.session.count()).toBe(0);
    const workspace = await migrated.workspace.findUniqueOrThrow({
      where: { id: 'legacy-personal' },
    });
    expect(workspace.ownerId).toBe(user.id);
    expect(workspace.settings.timezone).toBe('Asia/Kolkata');
    await migrated.withWorkspace(workspace.id, async () => {
      const flow = await migrated.workflow.findUniqueOrThrow({ where: { id: 'legacy-flow' } });
      expect(flow.publishedId).toBe('legacy-version');
      expect(flow.enabled).toBe(true);
      expect((await migrated.note.findUniqueOrThrow({ where: { id: 'legacy-note' } })).text).toBe(
        'Preserve my text',
      );
    });
    config.localFolder = folder;
    config.workspaceStorage = storage;
    await migrateLegacyFiles(migrated);
    await migrateLegacyFiles(migrated);
    expect(
      await readFile(join(storage, workspace.storageKey, 'files', 'original.md'), 'utf8'),
    ).toBe('Preserved original file');
    expect(await readFile(join(folder, 'original.md'), 'utf8')).toBe('Preserved original file');
    expect(
      (await migrated.fileMigration.findUniqueOrThrow({ where: { workspaceId: workspace.id } }))
        .completedAt,
    ).toBeTruthy();
    // The same isolated database also verifies atomic first-registration promotion.
    await migrated.user.deleteMany();
    const {Workspaces}=await import('../apps/backend/dist/workspaces.js');
    const {Accounts,AuthController}=await import('../apps/backend/dist/accounts.js');
    const service=new Workspaces(migrated,{} as any),accounts=new Accounts(migrated,service),auth=new AuthController(migrated,accounts,service);
    const req={ip:'fresh-install-fixture',headers:{origin:config.appUrl,'x-forge-request':'1'}} as any;
    const response={cookie:()=>{}} as any;
    await Promise.all(['first_fixture','second_fixture'].map(username=>auth.register({username,password:'a fresh fixture password',timezone:'UTC'},req,response)));
    expect(await migrated.user.count()).toBe(2);
    expect(await migrated.user.count({where:{isAdmin:true}})).toBe(1);
    expect(await migrated.workspace.count()).toBe(2);
    expect((await migrated.user.findMany()).every((u:any)=>u.displayName===u.username)).toBe(true);
  } finally {
    config.localFolder = oldFolder;
    config.workspaceStorage = oldStorage;
    await migrated?.$disconnect();
    await root.$executeRawUnsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await root.$disconnect();
    await rm(folder, { recursive: true, force: true });
    await rm(storage, { recursive: true, force: true });
  }
}, 60_000);
