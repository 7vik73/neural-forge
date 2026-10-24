import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  ForbiddenException,
  HttpException,
  SetMetadata,
} from '@nestjs/common';
import type { Request } from 'express';
import { Database } from './database.js';
import { config } from './config.js';
import { digest } from './security.js';
import { accessScope, authorizedWorkspace, type WorkspaceRole } from './scope.js';
@Injectable()
export class AuthGuard implements CanActivate {
  constructor(@Inject(Database) private readonly db: Database) {}
  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<Request>();
    const hostname = request.hostname;
    if (
      ![
        'localhost',
        '127.0.0.1',
        '[::1]',
        '::1',
        ...(process.env.FORGE_CONTAINER === '1' ? ['api'] : []),
      ].includes(hostname)
    )
      throw new ForbiddenException('Use the local application URL.');
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method)) {
      const origin = request.headers.origin;
      if (
        !origin ||
        origin !== new URL(config.appUrl).origin ||
        request.headers['x-forge-request'] !== '1'
      )
        throw new ForbiddenException('Open this action in the local application.');
    }
    const token = request.cookies?.forge_session as string | undefined;
    if (!token) throw new UnauthorizedException('Sign in to continue.');
    const session = await this.db.session.findUnique({ where: { id: digest(token) } });
    const user = session ? await this.db.user.findUnique({ where: { id: session.userId } }) : null;
    if (!session || session.expiresAt < new Date() || user?.status !== 'active')
      throw new UnauthorizedException('Your session expired. Sign in again.');
    const scope = accessScope.getStore();
    if (!scope) throw new UnauthorizedException('Request context is unavailable.');
    scope.userId = session.userId;
    scope.sessionId = session.id;
    return true;
  }
}
@Injectable()
export class WorkspaceGuard extends AuthGuard {
  constructor(@Inject(Database) private readonly workspaceDb: Database) {
    super(workspaceDb);
  }
  async canActivate(context: ExecutionContext) {
    await super.canActivate(context);
    const request = context.switchToHttp().getRequest<Request>();
    const scope = accessScope.getStore()!;
    const minimum: WorkspaceRole =
      Reflect.getMetadata('workspaceRole', context.getHandler()) ??
      Reflect.getMetadata('workspaceRole', context.getClass()) ??
      (['GET', 'HEAD', 'OPTIONS'].includes(request.method) ? 'viewer' : 'editor');
    const workspace = await authorizedWorkspace(
      this.workspaceDb.system,
      String(request.params.workspaceId),
      minimum,
    );
    scope.workspaceId = workspace.id;
    return true;
  }
}
@Injectable()
export class AdminGuard extends AuthGuard {
  constructor(@Inject(Database) private readonly adminDb: Database) {
    super(adminDb);
  }
  async canActivate(context: ExecutionContext) {
    await super.canActivate(context);
    const user = await this.adminDb.user.findUnique({
      where: { id: accessScope.getStore()!.userId! },
    });
    if (!user?.isAdmin) throw new ForbiddenException('Administrator access is required.');
    return true;
  }
}
const attempts = new Map<string, { count: number; since: number }>();
export function limitLogin(ip: string) {
  const now = Date.now();
  const state = attempts.get(ip);
  if (!state || now - state.since > 900_000) attempts.set(ip, { count: 1, since: now });
  else {
    state.count++;
    if (state.count > 15)
      throw new ForbiddenException('Too many sign-in attempts. Try again in 15 minutes.');
  }
}
export const WorkspacePermission = (role: WorkspaceRole) => SetMetadata('workspaceRole', role);
