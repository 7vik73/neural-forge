import { AsyncLocalStorage } from 'node:async_hooks';
import { NotFoundException, UnauthorizedException, ForbiddenException } from '@nestjs/common';

export type AccessContext = {
  userId?: string;
  workspaceId?: string;
  sessionId?: string;
  allowInactive?: boolean;
};
export const accessScope = new AsyncLocalStorage<AccessContext>();
export function currentWorkspace() {
  const id = accessScope.getStore()?.workspaceId;
  if (!id) throw new NotFoundException('Choose an accessible workspace.');
  return id;
}
export type WorkspaceRole = 'owner' | 'editor' | 'viewer';
const rank = { owner: 3, editor: 2, viewer: 1 };
export async function authorizedWorkspace(db: any, id: string, minimum: WorkspaceRole = 'viewer') {
  const context = accessScope.getStore();
  if (
    context?.sessionId &&
    !(await db.session.findFirst({
      where: { id: context.sessionId, userId: context.userId, expiresAt: { gt: new Date() } },
    }))
  )
    throw new UnauthorizedException('Your session expired. Sign in again.');
  const workspace = await db.workspace.findFirst({
    where: {
      id,
      ...(!context?.allowInactive ? { deletedAt: null, owner: { status: 'active' } } : {}),
    },
    include: { members: true },
  });
  if (!workspace) throw new NotFoundException('This workspace is unavailable.');
  let role: WorkspaceRole = 'owner';
  if (context?.userId) {
    const user = await db.user.findFirst({ where: { id: context.userId, status: 'active' } });
    if (!user) throw new UnauthorizedException('Your account is unavailable.');
    role =
      workspace.ownerId === user.id
        ? 'owner'
        : workspace.members.find((m: any) => m.userId === user.id)?.role;
    if (!role) throw new NotFoundException('This workspace is unavailable.');
  }
  if (rank[role] < rank[minimum])
    throw new ForbiddenException(`This action requires ${minimum} access.`);
  return { ...workspace, role };
}
export async function requireWorkspaceRole(db: any, minimum: WorkspaceRole) {
  return authorizedWorkspace(db.system ?? db, currentWorkspace(), minimum);
}
export const ownedModels = new Set([
  'workflow',
  'workflowVersion',
  'run',
  'runScope',
  'nodeExecution',
  'nodeAttempt',
  'executionEvent',
  'outbox',
  'connection',
  'checkpoint',
  'sourceCheckpoint',
  'note',
  'artifact',
  'aIUsage',
]);

// Mandatory context fences every persisted automation operation, including transactions.
export function scopedClient<T extends object>(client: T, root: any): T {
  return new Proxy(client, {
    get(target: any, name: string, receiver) {
      if (name === 'system') return root;
      if (name === '$transaction')
        return (callback: any, options: any) => {
          if (typeof callback !== 'function')
            throw new Error('Use a callback transaction with workspace context.');
          return root.$transaction((tx: any) => callback(scopedClient(tx, root)), options);
        };
      if (!ownedModels.has(name)) {
        const value = Reflect.get(target, name, receiver);
        return typeof value === 'function' && name.startsWith('$') ? value.bind(target) : value;
      }
      return new Proxy(target[name], {
        get(delegate, operation: string) {
          if (typeof delegate[operation] !== 'function') return delegate[operation];
          return async (input: any = {}) => {
            const context = accessScope.getStore();
            const workspaceId = currentWorkspace();
            const read = /^(find|count|aggregate|groupBy)/.test(operation);
            await authorizedWorkspace(root, workspaceId, read ? 'viewer' : 'editor');
            const args = { ...input };
            const stamp = (value: any) => {
              if (value.workspaceId !== undefined && value.workspaceId !== workspaceId)
                throw new NotFoundException('This item was not found.');
              if (value.workspace || value.workflow || value.run || value.task)
                throw new Error('Nested relation writes are not supported; use scoped IDs.');
              return { ...value, workspaceId };
            };
            if (['create', 'createMany', 'createManyAndReturn'].includes(operation))
              args.data = Array.isArray(args.data) ? args.data.map(stamp) : stamp(args.data);
            else {
              args.where = { ...args.where, workspaceId };
              if (operation === 'upsert') {
                args.create = stamp(args.create);
                if (args.update?.workspaceId || args.update?.workspace)
                  throw new Error('Ownership cannot be changed.');
              } else if (args.data && (args.data.workspaceId || args.data.workspace))
                throw new Error('Ownership cannot be changed.');
            }
            return delegate[operation](args);
          };
        },
      });
    },
  });
}
