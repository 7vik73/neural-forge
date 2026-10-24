import {
  Body,
  Controller,
  Delete,
  Get,
  HttpException,
  Inject,
  Injectable,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Request, Response } from 'express';
import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import { Database, json } from './database.js';
import { AdminGuard, AuthGuard, WorkspaceGuard, WorkspacePermission, limitLogin } from './auth.js';
import { digest, passwordHash, verifyPassword } from './security.js';
import { accessScope, currentWorkspace, authorizedWorkspace } from './scope.js';
import { config } from './config.js';
import { Workspaces } from './workspaces.js';
import { defaultSettings, trashDeadline, storagePath } from './storage.js';
import { LocalAI } from './ai.js';

const username = z
  .string()
  .trim()
  .toLowerCase()
  .regex(/^[a-z0-9][a-z0-9_.-]{2,31}$/, 'Use 3–32 letters, numbers, dots, dashes or underscores.');
const password = z.string().min(12).max(200);
const actor = () => accessScope.getStore()!.userId!;
const safeUser = {
  id: true,
  username: true,
  displayName: true,
  isAdmin: true,
  status: true,
  mustCompleteProfile: true,
  deletedAt: true,
} as const;
function origin(req: Request) {
  if (
    req.headers.origin !== new URL(config.appUrl).origin ||
    req.headers['x-forge-request'] !== '1'
  )
    throw new HttpException('Open this action in the local application.', 403);
}
@Injectable()
export class Accounts {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Workspaces) private readonly workspaces: Workspaces,
  ) {}
  async lockedUser(tx: any, userId: string) {
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    return tx.user.findUniqueOrThrow({ where: { id: userId } });
  }
  async createSession(tx: any, userId: string) {
    const token = randomBytes(32).toString('hex'),
      expiresAt = new Date(Date.now() + 7 * 86400_000);
    await tx.session.create({ data: { id: digest(token), userId, expiresAt } });
    return { token, expiresAt };
  }
  setSession(response: Response, { token, expiresAt }: { token: string; expiresAt: Date }) {
    response.cookie('forge_session', token, {
      httpOnly: true,
      sameSite: 'lax',
      secure: new URL(config.appUrl).protocol === 'https:',
      expires: expiresAt,
      path: '/',
    });
    return { ok: true };
  }
  async session(userId: string, response: Response, value: string) {
    const session = await this.db.$transaction(async (tx) => {
      const user = await this.lockedUser(tx, userId);
      if (user.status !== 'active' || !verifyPassword(value, user.passwordHash))
        throw new HttpException('The username or password is incorrect.', 401);
      return this.createSession(tx, userId);
    });
    return this.setSession(response, session);
  }
  async confirm(userId: string, value: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id: userId } });
    if (!verifyPassword(value, user.passwordHash))
      throw new HttpException('The password is incorrect.', 401);
    return user;
  }
  async token(
    purpose: string,
    values: { userId?: string; username?: string; createdById?: string },
  ) {
    const raw = randomBytes(32).toString('hex');
    const expiresAt = new Date(Date.now() + (purpose === 'invite' ? 7 * 86400_000 : 30 * 60_000));
    await this.db.accountToken.create({ data: { id: digest(raw), purpose, ...values, expiresAt } });
    return { url: `${config.appUrl}/#${purpose}=${raw}`, expiresAt };
  }
  async activeAdmin(tx: any, userId: string, nextStatus: string, isAdmin?: boolean) {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('account-administrators'))`;
    const user = await this.lockedUser(tx, userId);
    if (
      user.status === 'active' &&
      user.isAdmin &&
      (nextStatus !== 'active' || isAdmin === false)
    ) {
      if ((await tx.user.count({ where: { status: 'active', isAdmin: true } })) <= 1)
        throw new HttpException('Keep at least one active administrator.', 409);
    }
    return user;
  }
  async status(
    userId: string,
    status: 'active' | 'suspended' | 'deleted',
    isAdmin?: boolean,
    currentPassword?: string,
  ) {
    await this.db.$transaction(async (tx) => {
      const old = await this.activeAdmin(tx, userId, status, isAdmin);
      if (currentPassword !== undefined && !verifyPassword(currentPassword, old.passwordHash))
        throw new HttpException('The password is incorrect.', 401);
      if (old.deletedAt && old.deletedAt <= trashDeadline())
        throw new HttpException('The recovery period has ended.', 410);
      await tx.user.update({
        where: { id: userId },
        data: {
          status,
          ...(isAdmin !== undefined ? { isAdmin } : {}),
          deletedAt: status === 'deleted' ? new Date() : null,
        },
      });
      if (status !== 'active') {
        await tx.session.deleteMany({ where: { userId } });
        await tx.accountToken.deleteMany({
          where: { OR: [{ userId }, { createdById: userId, purpose: 'invite' }] },
        });
        if (status === 'deleted')
          await tx.workspace.updateMany({
            where: { ownerId: userId, deletedAt: null },
            data: { deletedAt: new Date() },
          });
      }
    });
    if (status !== 'active')
      for (const workspace of await this.db.workspace.findMany({ where: { ownerId: userId } }))
        await this.workspaces.stop(workspace.id);
    return { ok: true };
  }
}

@Controller('api/v1/auth')
export class AuthController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Accounts) private readonly accounts: Accounts,
    @Inject(Workspaces) private readonly workspaces: Workspaces,
  ) {}
  @Post('register') async register(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    origin(req);
    limitLogin(`${req.ip}:register`);
    const data = z.object({ username, password, timezone: z.string().default('UTC') }).parse(body);
    new Intl.DateTimeFormat('en', { timeZone: data.timezone });
    const user = await this.db.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('account-administrators'))`;
      const first = (await tx.user.count()) === 0;
      await tx.installation.upsert({
        where: { id: 'owner' },
        create: { id: 'owner', settings: defaultSettings(data.timezone) },
        update: {},
      });
      const user = await tx.user.create({
        data: {
          username: data.username,
          displayName: data.username,
          passwordHash: passwordHash(data.password),
          isAdmin: first,
        },
      });
      await this.workspaces.create(user.id, 'Personal', defaultSettings(data.timezone), tx);
      return user;
    });
    return this.accounts.session(user.id, response, data.password);
  }
  @Post('setup') setup() {
    throw new HttpException('Create an account on the Sign up page.', 410);
  }
  @Post('login') async login(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    origin(req);
    limitLogin(`${req.ip}:login`);
    const data = z.object({ username, password: z.string().max(200) }).parse(body);
    const user = await this.db.user.findUnique({ where: { username: data.username } });
    if (!user) throw new HttpException('The username or password is incorrect.', 401);
    return this.accounts.session(user.id, response, data.password);
  }
  @Get('me') @UseGuards(AuthGuard) me() {
    return this.db.user.findUniqueOrThrow({ where: { id: actor() }, select: safeUser });
  }
  @Post('logout') @UseGuards(AuthGuard) async logout(
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    await this.db.session.deleteMany({ where: { id: digest(req.cookies.forge_session) } });
    response.clearCookie('forge_session', { path: '/' });
    return { ok: true };
  }
  @Post('invitation') accept() {
    throw new HttpException(
      'Invitations are no longer required. Create an account on the Sign up page.',
      410,
    );
  }
  @Post('recover') async recover(
    @Body() body: unknown,
    @Req() req: Request,
    @Res({ passthrough: true }) response: Response,
  ) {
    origin(req);
    limitLogin(`${req.ip}:recover`);
    const data = z.object({ token: z.string(), password }).parse(body);
    await this.db.$transaction(async (tx) => {
      const record = await tx.accountToken.findUnique({ where: { id: digest(data.token) } });
      if (!record?.userId || record.purpose !== 'reset')
        throw new HttpException('This recovery link expired or was already used.', 410);
      const user = await this.accounts.lockedUser(tx, record.userId);
      const claim = await tx.accountToken.updateMany({
        where: {
          id: digest(data.token),
          purpose: 'reset',
          consumedAt: null,
          expiresAt: { gt: new Date() },
        },
        data: { consumedAt: new Date() },
      });
      if (!claim.count)
        throw new HttpException('This recovery link expired or was already used.', 410);
      if (user.status !== 'active')
        throw new HttpException('Ask an administrator to reactivate this account.', 403);
      await tx.user.update({
        where: { id: user.id },
        data: { passwordHash: passwordHash(data.password) },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await tx.accountToken.deleteMany({ where: { userId: user.id } });
    });
    response.clearCookie('forge_session', { path: '/' });
    return { ok: true, message: 'Password changed. Sign in with your username and new password.' };
  }
}

@Controller('api/v1/account')
@UseGuards(AuthGuard)
export class AccountController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Accounts) private readonly accounts: Accounts,
  ) {}
  @Patch() async profile(@Body() body: unknown) {
    const data = z
      .object({
        displayName: z.string().trim().min(1).max(80),
        username: username.optional(),
        currentPassword: z.string().optional(),
      })
      .parse(body);
    return this.db.$transaction(async (tx) => {
      const user = await this.accounts.lockedUser(tx, actor());
      if (user.status !== 'active') throw new HttpException('Sign in again.', 401);
      if (
        data.username &&
        data.username !== user.username &&
        !verifyPassword(data.currentPassword ?? '', user.passwordHash)
      )
        throw new HttpException('The password is incorrect.', 401);
      return tx.user.update({
        where: { id: actor() },
        data: {
          displayName: data.displayName,
          ...(data.username ? { username: data.username, mustCompleteProfile: false } : {}),
        },
        select: safeUser,
      });
    });
  }
  @Post('password') async changePassword(
    @Body() body: unknown,
    @Res({ passthrough: true }) response: Response,
  ) {
    const data = z.object({ currentPassword: z.string(), password }).parse(body);
    const session = await this.db.$transaction(async (tx) => {
      const user = await this.accounts.lockedUser(tx, actor());
      if (user.status !== 'active' || !verifyPassword(data.currentPassword, user.passwordHash))
        throw new HttpException('The password is incorrect.', 401);
      await tx.user.update({
        where: { id: actor() },
        data: { passwordHash: passwordHash(data.password) },
      });
      await tx.session.deleteMany({ where: { userId: actor() } });
      await tx.accountToken.deleteMany({ where: { userId: actor() } });
      return this.accounts.createSession(tx, actor());
    });
    return this.accounts.setSession(response, session);
  }
  @Delete() async remove(@Body() body: unknown, @Res({ passthrough: true }) response: Response) {
    const data = z.object({ password: z.string() }).parse(body);
    await this.accounts.status(actor(), 'deleted', undefined, data.password);
    response.clearCookie('forge_session', { path: '/' });
    return { ok: true };
  }
}

@Controller('api/v1/admin')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Accounts) private readonly accounts: Accounts,
  ) {}
  @Get('users') users() {
    return this.db.user.findMany({
      select: { ...safeUser, createdAt: true },
      orderBy: { createdAt: 'asc' },
    });
  }
  @Patch('users/:id') status(@Param('id') id: string, @Body() body: unknown) {
    const data = z
      .object({
        status: z.enum(['active', 'suspended', 'deleted']),
        isAdmin: z.boolean().optional(),
      })
      .parse(body);
    return this.accounts.status(id, data.status, data.isAdmin);
  }
  @Post('users/:id/recovery') async recovery(@Param('id') id: string) {
    const user = await this.db.user.findUniqueOrThrow({ where: { id } });
    if (user.status !== 'active') throw new Error('Reactivate this account first.');
    await this.db.accountToken.deleteMany({ where: { userId: id, purpose: 'reset' } });
    return this.accounts.token('reset', { userId: id, createdById: actor() });
  }
}

@Controller('api/v1/workspaces')
@UseGuards(AuthGuard)
export class WorkspaceController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(Workspaces) private readonly workspaces: Workspaces,
    @Inject(Accounts) private readonly accounts: Accounts,
  ) {}
  @Get() async list(@Query('trash') trash?: string) {
    const rows = await this.db.workspace.findMany({
      where:
        trash === 'true'
          ? { ownerId: actor(), deletedAt: { gt: trashDeadline() } }
          : {
              deletedAt: null,
              owner: { status: 'active' },
              OR: [{ ownerId: actor() }, { members: { some: { userId: actor() } } }],
            },
      include: { members: true },
      orderBy: { createdAt: 'asc' },
    });
    return rows.map((w) => ({
      id: w.id,
      name: w.name,
      deletedAt: w.deletedAt,
      createdAt: w.createdAt,
      role: w.ownerId === actor() ? 'owner' : w.members.find((m) => m.userId === actor())!.role,
      shared: w.members.length > 0,
    }));
  }
  @Get(':workspaceId/members') async members(@Param('workspaceId') id: string) {
    await authorizedWorkspace(this.db.system, id, 'owner');
    return this.db.workspaceMember.findMany({
      where: { workspaceId: id },
      select: { userId: true, role: true, user: { select: { username: true, displayName: true } } },
    });
  }
  @Post(':workspaceId/members') async addMember(
    @Param('workspaceId') id: string,
    @Body() body: unknown,
  ) {
    const workspace = await authorizedWorkspace(this.db.system, id, 'owner');
    const data = z.object({ username, role: z.enum(['editor', 'viewer']) }).parse(body);
    const user = await this.db.user.findFirst({
      where: { username: data.username, status: 'active' },
    });
    if (!user) throw new HttpException('No active account has that username.', 404);
    if (user.id === workspace.ownerId)
      throw new HttpException('The workspace owner already has access.', 409);
    await this.db.workspaceMember.upsert({
      where: { workspaceId_userId: { workspaceId: id, userId: user.id } },
      create: { workspaceId: id, userId: user.id, role: data.role },
      update: { role: data.role },
    });
    return { ok: true };
  }
  @Patch(':workspaceId/members/:userId') async role(
    @Param('workspaceId') id: string,
    @Param('userId') userId: string,
    @Body() body: unknown,
  ) {
    await authorizedWorkspace(this.db.system, id, 'owner');
    const { role } = z.object({ role: z.enum(['editor', 'viewer']) }).parse(body);
    await this.db.workspaceMember.update({
      where: { workspaceId_userId: { workspaceId: id, userId } },
      data: { role },
    });
    return { ok: true };
  }
  @Delete(':workspaceId/members/:userId') async removeMember(
    @Param('workspaceId') id: string,
    @Param('userId') userId: string,
  ) {
    await authorizedWorkspace(this.db.system, id, 'owner');
    await this.db.workspaceMember.deleteMany({ where: { workspaceId: id, userId } });
    return { ok: true };
  }
  @Post() async create(@Body() body: unknown) {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(body);
    const settings = (await this.db.installation.findUnique({ where: { id: 'owner' } }))
      ?.settings as any;
    const workspace = await this.workspaces.create(actor(), name, {
      ...defaultSettings(),
      ...settings,
    });
    return { id: workspace.id, name: workspace.name };
  }
  @Patch(':workspaceId') async rename(@Param('workspaceId') id: string, @Body() body: unknown) {
    const { name } = z.object({ name: z.string().trim().min(1).max(80) }).parse(body);
    await this.workspaces.owned(id, actor());
    return this.db.workspace.update({
      where: { id },
      data: { name },
      select: { id: true, name: true },
    });
  }
  @Delete(':workspaceId') trash(@Param('workspaceId') id: string) {
    return this.workspaces.trash(id, actor());
  }
  @Post(':workspaceId/restore') async restore(@Param('workspaceId') id: string) {
    await this.workspaces.restore(id, actor());
    return { ok: true };
  }
  @Post(':workspaceId/purge') async purge(@Param('workspaceId') id: string, @Body() body: unknown) {
    const data = z.object({ password: z.string() }).parse(body);
    await this.accounts.confirm(actor(), data.password);
    await this.workspaces.owned(id, actor(), true);
    await this.workspaces.purge(id);
    return { ok: true };
  }
}

@Controller('api/v1/workspaces/:workspaceId/settings')
@UseGuards(WorkspaceGuard)
export class WorkspaceSettingsController {
  constructor(
    @Inject(Database) private readonly db: Database,
    @Inject(LocalAI) private readonly ai: LocalAI,
  ) {}
  @Get() async get() {
    const workspace = await this.db.workspace.findUniqueOrThrow({
      where: { id: currentWorkspace() },
    });
    return { ...(workspace.settings as object), localFolder: await storagePath(this.db) };
  }
  @Patch() @WorkspacePermission('owner') async update(@Body() body: unknown) {
    const data = z
      .object({
        timezone: z.string(),
        model: z.string(),
        retentionDays: z.number().int().min(1).max(3650),
        retainAIDetails: z.boolean(),
      })
      .parse(body);
    new Intl.DateTimeFormat('en', { timeZone: data.timezone });

    await this.db.workspace.update({
      where: { id: currentWorkspace() },
      data: { settings: json(data) },
    });
    return data;
  }
}
