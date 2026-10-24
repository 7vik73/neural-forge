import type {
  WorkflowDefinition,
  WorkflowTemplate,
  JsonObject,
  NodeDefinition,
} from '@forge/contracts';
export type { WorkflowDefinition, WorkflowTemplate, JsonObject, NodeDefinition };
export type Account = {
  id: string;
  username: string;
  displayName: string;
  isAdmin: boolean;
  status: string;
  mustCompleteProfile: boolean;
};
export type Workspace = {
  id: string;
  name: string;
  deletedAt: string | null;
  createdAt: string;
  role: 'owner' | 'editor' | 'viewer';
  shared: boolean;
};
const pendingSaves = new Set<() => Promise<void>>();
export function registerPendingSave(save: () => Promise<void>) {
  pendingSaves.add(save);
  return () => {
    pendingSaves.delete(save);
  };
}
export async function flushPendingSaves() {
  for (const save of pendingSaves) await save();
}
export function apiUrl(path: string) {
  if (
    /^(workflows|runs|connections|notes|files|ai|settings|backup|apps)(\/|\?|$)/.test(path) ||
    /^templates\/[^/]+\/instantiate$/.test(path)
  ) {
    const workspaceId = window.location.pathname.match(/^\/w\/([^/]+)/)?.[1];
    if (!workspaceId) throw new Error('Choose a workspace first.');
    return `/api/v1/workspaces/${encodeURIComponent(workspaceId)}/${path}`;
  }
  return `/api/v1/${path}`;
}
export async function openWorkspace(id: string) {
  await flushPendingSaves();
  window.location.assign(`/w/${encodeURIComponent(id)}`);
}
export type Workflow = {
  id: string;
  name: string;
  description: string;
  draft: WorkflowDefinition;
  revision: number;
  enabled: boolean;
  publishedId?: string;
  updatedAt: string;
  nextRun?: string;
  runs?: { id: string; status: string; createdAt: string }[];
  checkpoints?: { value: { error?: string } }[];
};
export type Connection = {
  id: string;
  name: string;
  kind: string;
  status: string;
  apps?: string[];
  disabledApps?: string[];
};
export type Note = { id: string; title: string; text: string; updatedAt: string };
export type Run = {
  restoredAt?: string | null;
  id: string;
  status: string;
  preview: boolean;
  error?: string;
  createdAt: string;
  finishedAt?: string;
  workflow: { name: string };
  scopes?: { key: string; definition: WorkflowDefinition }[];
  nodes?: {
    id: string;
    scope: string;
    nodeId: string;
    status: string;
    reason?: string;
    error?: string;
    input: JsonObject;
    output: JsonObject;
    attempt: number;
    attempts: { number: number; status: string; error?: string }[];
  }[];
};
export async function api<T = any>(
  path: string,
  options?: { method?: string; body?: unknown },
): Promise<T> {
  const response = await fetch(apiUrl(path), {
    method: options?.method ?? 'GET',
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json', 'X-Forge-Request': '1' },
    ...(options?.body !== undefined ? { body: JSON.stringify(options.body) } : {}),
  });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && !path.startsWith('auth/'))
      window.dispatchEvent(new Event('forge-session-ended'));
    throw new Error(result.message ?? 'Something went wrong. Try again.');
  }
  return result;
}
export const post = <T = any>(path: string, body: unknown = {}) =>
  api<T>(path, { method: 'POST', body });
export const shortDate = (value: string) =>
  new Date(value).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
export const pretty = (value: unknown) => JSON.stringify(value, null, 2);
export const emptyGraph = (): WorkflowDefinition => ({
  schemaVersion: 1,
  nodes: [
    {
      id: 'start',
      type: 'trigger.manual',
      version: 1,
      label: 'Start when I click Run',
      config: {},
      inputs: {},
      position: { x: 80, y: 120 },
    },
  ],
  edges: [],
  settings: {
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    maxItems: 1000,
    ai: { provider: 'gemini', dataPolicy: 'private' },
  },
});
export function download(name: string, data: unknown) {
  const url = URL.createObjectURL(
    new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }),
  );
  const link = document.createElement('a');
  link.href = url;
  link.download = name;
  link.click();
  URL.revokeObjectURL(url);
}
