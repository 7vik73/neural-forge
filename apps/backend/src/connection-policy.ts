import { WorkflowSchema, type WorkflowDefinition, type WorkflowNode } from '@forge/contracts';

export const groupedApps: Record<string, readonly string[]> = {
  google: ['gmail', 'sheets', 'drive', 'calendar'],
  microsoft: ['outlook', 'excel'],
};
export const googleAppScopes: Record<string, string[]> = {
  gmail: ['https://www.googleapis.com/auth/gmail.modify'],
  sheets: ['https://www.googleapis.com/auth/spreadsheets'],
  drive: ['https://www.googleapis.com/auth/drive'],
  calendar: [
    'https://www.googleapis.com/auth/calendar.events',
    'https://www.googleapis.com/auth/calendar.calendarlist.readonly',
  ],
};
const csv = (value: string) => [
  ...new Set(
    value
      .split(',')
      .map((v) => v.trim())
      .filter(Boolean),
  ),
];
export function configuredApps(kind: string, credentials: Record<string, string>) {
  return csv(credentials.apps ?? (kind === 'google' ? 'gmail,sheets' : 'outlook')).filter((app) =>
    groupedApps[kind]?.includes(app),
  );
}
export function disabledApps(kind: string, credentials: Record<string, string>) {
  return csv(credentials.disabledApps ?? '').filter((app) =>
    configuredApps(kind, credentials).includes(app),
  );
}
export function activeApps(kind: string, credentials: Record<string, string>) {
  const disabled = disabledApps(kind, credentials);
  return configuredApps(kind, credentials).filter((app) => !disabled.includes(app));
}
export function assertAppEnabled(kind: string, credentials: Record<string, string>, app: string) {
  if (!groupedApps[kind]?.includes(app) || !activeApps(kind, credentials).includes(app))
    throw new Error(
      `${app} is disconnected in this workspace. Connect it in Apps & connections before using it.`,
    );
}
export function nodeApp(node: WorkflowNode) {
  const [group, action] = node.type.split('.');
  return group === 'trigger' ? action! : group!;
}
export function usesConnection(graph: WorkflowDefinition, id: string, appId?: string): boolean {
  return graph.nodes.some((node) => {
    if (String(node.config.connectionId ?? '') === id && (!appId || nodeApp(node) === appId))
      return true;
    if (
      !appId &&
      node.type.startsWith('ai.') &&
      !node.config.connectionId &&
      graph.settings.ai?.connectionId === id &&
      (!node.config.provider || node.config.provider === graph.settings.ai.provider)
    )
      return true;
    if (node.type !== 'logic.foreach') return false;
    const body = WorkflowSchema.parse(node.config.body);
    return usesConnection(
      { ...body, settings: { ...body.settings, ai: body.settings.ai ?? graph.settings.ai } },
      id,
      appId,
    );
  });
}
