import {
  Body,
  Catch,
  Controller,
  Delete,
  ExceptionFilter,
  Get,
  HttpException,
  Inject,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  ArgumentsHost,
} from '@nestjs/common';
import { ApiOperation, ApiTags } from '@nestjs/swagger';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { Redis } from 'ioredis';
import { z } from 'zod';
import { CronExpressionParser } from 'cron-parser';
import {
  ConnectionKindSchema,
  AISettingsSchema,
  JsonSchema,
  WorkflowSchema,
  type JsonObject,
} from '@forge/contracts';
import { catalog, templates, apps } from '@forge/connectors';
import { sanitizedExport } from '@forge/workflow';
import { Database, json } from './database.js';
import { AuthGuard, WorkspaceGuard, WorkspacePermission, AdminGuard, limitLogin } from './auth.js';
import { digest, equal, passwordHash, redact, verifyPassword, encrypt } from './security.js';
import { config } from './config.js';
import { currentWorkspace, accessScope } from './scope.js';
import { Connections } from './connections.js';
import { ConnectionLifecycle } from './connection-lifecycle.js';
import { LocalAI } from './ai.js';
import { ExecutionEngine } from './engine.js';
import { Operations } from './operations.js';

const object = z.record(z.string(), JsonSchema);
const idSchema = z.string().min(1).max(100);
const settingsSchema = z.object({
  timezone: z.string(),
  model: z.string().min(1),
  retentionDays: z.number().int().min(1).max(3650),
  retainAIDetails: z.boolean().default(false),
});
function checkOrigin(req: Request) {
  if (
    req.headers.origin !== new URL(config.appUrl).origin ||
    req.headers['x-forge-request'] !== '1'
  )
    throw new Error('Open this action in the local application.');
}

@Catch()
export class Errors implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const response = host.switchToHttp().getResponse<Response>();
    const e = exception as Error & { code?: string };
    const status =
      exception instanceof HttpException
        ? exception.getStatus()
        : e.code === 'P2025'
          ? 404
          : e.code === 'P2002'
            ? 409
            : 400;
    const message = e.code?.startsWith('P')
      ? e.code === 'P2025'
        ? 'This item was not found.'
        : e.code === 'P2002'
          ? 'This item already exists or changed. Reload and try again.'
          : 'The database operation could not be completed.'
      : exception instanceof z.ZodError
        ? exception.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')
        : redact(e.message ?? 'The request could not be completed.');
    response.status(status).json({ message });
  }
}

@ApiTags('System and owner session')
@Controller('api/v1/system')
export class SystemController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LocalAI) private readonly ai: LocalAI,
  ) {}
  @Get('bootstrap') async bootstrap() {
    return {
      initialized: (await this.db.user.count()) > 0,
      appUrl: config.appUrl,
    };
  }
  @Get('health') async health() {
    let database = false;
    let redis = false;
    let ollama = false;
    let worker = false;
    await this.db.$queryRaw`SELECT 1`
      .then(() => {
        database = true;
      })
      .catch(() => {});
    const client = new Redis(config.redisUrl, {
      lazyConnect: true,
      connectTimeout: 2000,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    client.on('error', () => {});
    try {
      await client.ping();
      redis = true;
      worker = !!(await client.get('forge:worker-heartbeat'));
    } catch {
    } finally {
      client.disconnect();
    }
    await this.ai
      .models()
      .then(() => {
        ollama = true;
      })
      .catch(() => {});
    return { database, redis, ollama, worker, schemaVersion: config.schemaVersion };
  }
  @Get('integrations') @UseGuards(AuthGuard) async integrations() {
    return this.db.appCredential.findMany({ select: { provider: true, updatedAt: true } });
  }
  @Post('integrations/:provider') @UseGuards(AdminGuard) async integration(
    @Param('provider') provider: string,
    @Body() body: unknown,
  ) {
    z.enum(['google', 'microsoft']).parse(provider);
    const data = z
      .object({
        clientId: z.string().min(1),
        clientSecret: z.string().min(1),
        tenant: z.string().optional(),
      })
      .parse(body);
    const saved = await this.db.appCredential.upsert({
      where: { provider },
      create: { provider, secret: encrypt(data as Record<string, string>) },
      update: { secret: encrypt(data as Record<string, string>) },
      select: { provider: true, updatedAt: true },
    });
    return { ok: true, ...saved };
  }
  @Get('settings') @UseGuards(AdminGuard) async settings() {
    return (await this.db.installation.findUniqueOrThrow({ where: { id: 'owner' } })).settings;
  }
  @Patch('settings') @UseGuards(AdminGuard) async updateSettings(@Body() body: unknown) {
    const settings = settingsSchema.parse(body);
    new Intl.DateTimeFormat('en', { timeZone: settings.timezone });

    await this.db.installation.update({
      where: { id: 'owner' },
      data: { settings: json(settings) },
    });
    return settings;
  }
}

@ApiTags('Workflows')
@UseGuards(WorkspaceGuard)
@Controller('api/v1/workspaces/:workspaceId/workflows')
export class WorkflowsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ExecutionEngine) private readonly engine: ExecutionEngine,
  ) {}
  @Get() async list() {
    const workflows = await this.db.workflow.findMany({
      orderBy: { updatedAt: 'desc' },
      include: {
        runs: {
          orderBy: { createdAt: 'desc' },
          take: 1,
          select: { id: true, status: true, createdAt: true },
        },
        checkpoints: true,
      },
    });
    return workflows.map(({ webhookHash, ...w }) => w);
  }
  @Post() async create(@Body() body: unknown) {
    const data = z
      .object({
        name: z.string().min(1).max(120),
        description: z.string().max(500).default(''),
        definition: WorkflowSchema,
      })
      .parse(body);
    return this.db.workflow.create({
      data: { name: data.name, description: data.description, draft: json(data.definition) },
      select: { id: true, name: true },
    });
  }
  @Post('import') async import(@Body() body: unknown) {
    const data = z
      .object({ name: z.string().min(1).max(120), definition: WorkflowSchema })
      .parse(body);
    const sanitized = sanitizedExport(data.definition);
    return this.db.workflow.create({
      data: { name: data.name, draft: json(sanitized.definition), enabled: false },
      select: { id: true, name: true },
    });
  }
  @Get(':id/export') async export(@Param('id') id: string) {
    const workflow = await this.db.workflow.findUniqueOrThrow({ where: { id } });
    return { name: workflow.name, ...sanitizedExport(WorkflowSchema.parse(workflow.draft)) };
  }
  @Get(':id') async get(@Param('id') id: string) {
    const { webhookHash, ...workflow } = await this.db.workflow.findUniqueOrThrow({
      where: { id },
    });
    const definition = WorkflowSchema.parse(workflow.draft);
    const trigger = definition.nodes.find((n) => n.type === 'trigger.schedule');
    let nextRun: string | null = null;
    if (trigger)
      try {
        nextRun = CronExpressionParser.parse(String(trigger.config.cron), {
          tz: String(trigger.config.timezone ?? definition.settings.timezone),
        })
          .next()
          .toISOString();
      } catch {}
    return { ...workflow, nextRun };
  }
  @Patch(':id') async update(@Param('id') id: string, @Body() body: unknown) {
    const data = z
      .object({
        name: z.string().min(1).max(120),
        definition: WorkflowSchema,
        revision: z.number().int().min(0),
      })
      .parse(body);
    const changed = await this.db.workflow.updateMany({
      where: { id, revision: data.revision },
      data: { name: data.name, draft: json(data.definition), revision: { increment: 1 } },
    });
    if (!changed.count)
      throw new HttpException('This workflow changed in another tab. Reload before saving.', 409);
    return { revision: data.revision + 1 };
  }
  @Post(':id/validate') async validate(@Param('id') id: string, @Body() body: unknown) {
    const data = z.object({ definition: WorkflowSchema.optional() }).parse(body);
    const workflow = await this.db.workflow.findUniqueOrThrow({ where: { id } });
    return { issues: await this.engine.validate(data.definition ?? workflow.draft) };
  }
  @Post(':id/enable') async enable(@Param('id') id: string, @Body() body: unknown) {
    const data = z.object({ revision: z.number().int() }).parse(body);
    return this.engine.publish(id, data.revision);
  }
  @Post(':id/disable') async disable(@Param('id') id: string) {
    await this.db.workflow.update({ where: { id }, data: { enabled: false } });
    return { ok: true };
  }
  @ApiOperation({ summary: 'Run a saved draft or preview with simulated writes' })
  @Post(':id/runs')
  async run(@Param('id') id: string, @Body() body: unknown) {
    const data = z
      .object({ input: object.default({}), preview: z.boolean().default(false) })
      .parse(body);
    const workflow = await this.db.workflow.findUniqueOrThrow({ where: { id } });
    const issues = await this.engine.validate(workflow.draft, data.preview);
    if (issues.length) return { issues };
    return this.engine.createRun(id, data.input, data.preview);
  }
}

@ApiTags('Runs')
@UseGuards(WorkspaceGuard)
@Controller('api/v1/workspaces/:workspaceId/runs')
export class RunsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ExecutionEngine) private readonly engine: ExecutionEngine,
  ) {}
  @Get() list() {
    return this.db.run.findMany({
      orderBy: { createdAt: 'desc' },
      take: 100,
      include: { workflow: { select: { name: true } } },
    });
  }
  @Get(':id') async get(@Param('id') id: string) {
    const run = await this.db.run.findUniqueOrThrow({
      where: { id },
      include: {
        workflow: { select: { name: true } },
        scopes: true,
        nodes: { include: { attempts: true }, orderBy: [{ scope: 'asc' }, { startedAt: 'asc' }] },
      },
    });
    const settings = (await this.db.workspace.findUnique({ where: { id: currentWorkspace() } }))
      ?.settings as JsonObject | undefined;
    if (settings?.retainAIDetails !== true)
      for (const node of run.nodes) {
        const scope = run.scopes.find((s) => s.key === node.scope);
        const definition = WorkflowSchema.parse(scope?.definition);
        if (definition.nodes.find((n) => n.id === node.nodeId)?.type.startsWith('ai.'))
          node.input = { notice: 'AI input details are hidden by your retention setting.' };
      }
    return run;
  }
  @Get(':id/events') async events(
    @Param('id') id: string,
    @Query('after') after: string | undefined,
    @Req() req: Request,
    @Res() response: Response,
  ) {
    await this.db.run.findUniqueOrThrow({ where: { id } });
    let cursor = BigInt(after ?? String(req.headers['last-event-id'] ?? '0'));
    response.status(200).set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    response.flushHeaders();
    let busy = false;
    const send = async () => {
      if (busy) return;
      busy = true;
      try {
        const events = await this.db.executionEvent.findMany({
          where: { runId: id, id: { gt: cursor } },
          orderBy: { id: 'asc' },
          take: 200,
        });
        for (const e of events) {
          cursor = e.id;
          response.write(
            `id: ${e.id}\ndata: ${JSON.stringify({ type: e.type, data: e.data, createdAt: e.createdAt })}\n\n`,
          );
        }
        if (!events.length) response.write(': heartbeat\n\n');
      } catch {
        response.end();
      } finally {
        busy = false;
      }
    };
    const timer = setInterval(() => {
      void send();
    }, 1000);
    req.on('close', () => clearInterval(timer));
    await send();
  }
  @Post(':id/cancel') cancel(@Param('id') id: string) {
    return this.engine.cancel(id).then(() => ({ ok: true }));
  }
  @Post(':id/approval') approval(@Param('id') id: string, @Body() body: unknown) {
    const data = z.object({ taskId: idSchema, approve: z.boolean() }).parse(body);
    return this.engine.approve(id, data.taskId, data.approve).then(() => ({ ok: true }));
  }
  @Post(':id/retry') retry(@Param('id') id: string, @Body() body: unknown) {
    const data = z
      .object({ taskId: idSchema, inspectedDestination: z.boolean().default(false) })
      .parse(body);
    return this.engine.retry(id, data.taskId, data.inspectedDestination).then(() => ({ ok: true }));
  }
}

@ApiTags('Connections')
@UseGuards(WorkspaceGuard)
@Controller('api/v1/workspaces/:workspaceId/connections')
export class ConnectionsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Connections) private readonly connections: Connections,
    @Inject(ConnectionLifecycle) private readonly lifecycle: ConnectionLifecycle,
  ) {}
  @Get() list() {
    return this.connections.list();
  }
  @Post() save(@Body() body: unknown) {
    const data = z
      .object({
        name: z.string().min(1).max(120),
        kind: ConnectionKindSchema,
        secret: z.record(z.string(), z.string()),
        id: z.string().optional(),
      })
      .parse(body);
    return this.connections.save(data.name, data.kind, data.secret, data.id);
  }
  @Post(':id/test') test(@Param('id') id: string) {
    return this.connections.test(id);
  }
  @Post(':id/authorize') authorize(@Param('id') id: string) {
    return this.connections.authorize(id);
  }
  @Post(':id/disconnect') disconnect(@Param('id') id: string, @Body() body: unknown) {
    const data = z.object({ appId: z.string().min(1).max(40).optional() }).parse(body);
    return this.lifecycle.disconnect(id, data.appId);
  }
  @Post(':id/apps/:appId/connect') connectApp(
    @Param('id') id: string,
    @Param('appId') appId: string,
  ) {
    return this.lifecycle.reconnectApp(id, appId);
  }
  @Get(':id/resources') @WorkspacePermission('editor') resources(
    @Param('id') id: string,
    @Query('kind') kind: string,
    @Query('value') value?: string,
  ) {
    return this.connections.resources(id, kind, value);
  }
  @Delete(':id') async remove(@Param('id') id: string) {
    return this.lifecycle.disconnect(id);
  }
}

@ApiTags('Catalog, templates and local AI')
@UseGuards(WorkspaceGuard)
@Controller('api/v1/workspaces/:workspaceId')
export class CatalogController {
  constructor(
    @Inject(LocalAI) private readonly ai: LocalAI,
    @Inject(Database) private readonly db: Database,
    @Inject(Connections) private readonly connections: Connections,
  ) {}
  @Get('catalog') catalog() {
    return catalog;
  }
  @Get('templates') templates() {
    return templates;
  }
  @Get('ai/models') @WorkspacePermission('editor') models(
    @Query('provider') provider?: string,
    @Query('connectionId') connectionId?: string,
  ) {
    return this.ai.models(
      provider ? AISettingsSchema.parse({ provider, connectionId }) : undefined,
    );
  }
  @Get('ai/usage') usage() {
    return this.db.aIUsage.findMany({ orderBy: { createdAt: 'desc' }, take: 100 });
  }
  @Get('apps') async apps() {
    const connections = await this.connections.list();
    return apps.map((app) => {
      const matching = connections.filter(
        (c) =>
          c.kind === app.connectionKind &&
          (!('apps' in c) || c.apps?.includes(app.id) || c.disabledApps?.includes(app.id)),
      );
      return {
        ...app,
        connections: matching,
        status:
          app.id === 'ollama'
            ? 'Optional local provider'
            : matching.some(
                  (c) =>
                    ['connected', 'configured'].includes(c.status) &&
                    (!('apps' in c) || c.apps?.includes(app.id)),
                )
              ? 'Connected'
              : matching.some((c) => !('disabledApps' in c) || !c.disabledApps?.includes(app.id))
                ? 'Needs authorization'
                : 'Not connected',
      };
    });
  }
  @Post('ai/test') async test(@Body() body: unknown) {
    const choice = AISettingsSchema.optional().parse((body as any)?.ai);
    return this.ai.chat(
      'Return JSON only.',
      'Return {"ready":true}.',
      {
        type: 'object',
        properties: { ready: { type: 'boolean' } },
        required: ['ready'],
        additionalProperties: false,
      },
      undefined,
      choice,
    );
  }
  @Post('ai/generate') generate(@Body() body: unknown) {
    const data = z
      .object({
        description: z.string().min(5).max(8000),
        existing: WorkflowSchema.optional(),
        ai: AISettingsSchema.optional(),
      })
      .parse(body);
    return this.ai.generate(data.description, data.existing, data.ai);
  }
  @Post('templates/:id/instantiate') async instantiate(@Param('id') id: string) {
    const template = templates.find((t) => t.id === id);
    if (!template) throw new Error('Template not found.');
    const owner = await this.db.workspace.findUniqueOrThrow({ where: { id: currentWorkspace() } });
    const timezone = String((owner.settings as JsonObject).timezone ?? 'UTC');
    const definition = structuredClone(template.definition);
    definition.settings.timezone = timezone;
    for (const node of definition.nodes)
      if (node.type === 'trigger.schedule') node.config.timezone = timezone;
    return this.db.workflow.create({
      data: { name: template.name, description: template.description, draft: json(definition) },
      select: { id: true },
    });
  }
}

@ApiTags('Notes and local files')
@UseGuards(WorkspaceGuard)
@Controller('api/v1/workspaces/:workspaceId')
export class LocalController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Operations) private readonly operations: Operations,
  ) {}
  @Get('notes') notes(@Query('q') q = '') {
    return this.db.note.findMany({
      where: q
        ? {
            OR: [
              { title: { contains: q, mode: 'insensitive' } },
              { text: { contains: q, mode: 'insensitive' } },
            ],
          }
        : {},
      orderBy: { updatedAt: 'desc' },
      take: 200,
    });
  }
  @Post('notes') create(@Body() body: unknown) {
    const data = z
      .object({ title: z.string().min(1).max(200), text: z.string().max(1_048_576) })
      .parse(body);
    return this.db.note.create({ data });
  }
  @Patch('notes/:id') update(@Param('id') id: string, @Body() body: unknown) {
    const data = z
      .object({ title: z.string().min(1).max(200), text: z.string().max(1_048_576) })
      .parse(body);
    return this.db.note.update({ where: { id }, data: { ...data, lastRunId: null } });
  }
  @Delete('notes/:id') async remove(@Param('id') id: string) {
    await this.db.note.delete({ where: { id } });
    return { ok: true };
  }
  @Get('files') files(@Query('path') path = '') {
    return this.operations.files.list(path);
  }
  @Get('files/read') read(@Query('path') path: string) {
    return this.operations.files.read(path);
  }
}

@ApiTags('Incoming webhooks')
@Controller('api/v1/hooks')
export class WebhookController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(ExecutionEngine) private readonly engine: ExecutionEngine,
  ) {}
  @Post(':id') async receive(@Param('id') id: string, @Body() body: unknown, @Req() req: Request) {
    const workflow = await this.db.system.workflow.findUniqueOrThrow({ where: { id } });
    const authorization = req.headers.authorization?.replace(/^Bearer /, '') ?? '';
    if (
      !workflow.enabled ||
      !workflow.webhookHash ||
      !equal(digest(authorization), workflow.webhookHash)
    )
      throw new HttpException('Webhook authorization failed.', 401);
    return this.db.withWorkspace(workflow.workspaceId, async () => {
      const version = await this.db.workflowVersion.findUniqueOrThrow({
        where: { id: workflow.publishedId! },
      });
      if (!WorkflowSchema.parse(version.definition).nodes.some((n) => n.type === 'trigger.webhook'))
        throw new Error('This workflow does not use a webhook trigger.');
      const key = req.headers['idempotency-key'];
      const run = await this.engine.createRun(
        id,
        { body: JsonSchema.parse(body) },
        false,
        true,
        typeof key === 'string' ? `hook-${id}-${digest(key)}` : undefined,
      );
      return { id: run.id, status: run.status };
    });
  }
}

@Controller('api/v1/connections')
@UseGuards(AuthGuard)
export class GoogleCallbackController {
  constructor(@Inject(Connections) private readonly connections: Connections) {}
  @Get('microsoft/callback') async microsoftCallback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() response: Response,
  ) {
    const result = await this.connections.microsoftCallback(
      z.string().parse(code),
      z.string().parse(state),
    );
    response.redirect(`${config.appUrl}/w/${result.workspaceId}?view=connections&connected=1`);
  }
  @Get('google/callback') async callback(
    @Query('code') code: string,
    @Query('state') state: string,
    @Res() response: Response,
  ) {
    const result = await this.connections.callback(z.string().parse(code), z.string().parse(state));
    response.redirect(`${config.appUrl}/w/${result.workspaceId}?view=connections&connected=1`);
  }
}
@Controller('api/v1')
@UseGuards(AuthGuard)
export class PublicCatalogController {
  @Get('catalog') catalog() {
    return catalog;
  }
  @Get('templates') templates() {
    return templates;
  }
}
