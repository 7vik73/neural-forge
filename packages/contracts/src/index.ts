import { z } from 'zod';

export const JsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([
    z.string(),
    z.number().finite(),
    z.boolean(),
    z.null(),
    z.array(JsonSchema),
    z.record(z.string(), JsonSchema),
  ]),
);
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };
export type JsonObject = { [key: string]: Json };
export const BindingSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('constant'), value: JsonSchema }),
  z.object({
    kind: z.literal('reference'),
    nodeId: z.string(),
    path: z.string().default(''),
    format: z.enum(['none', 'text', 'upper', 'lower', 'json', 'date']).default('none'),
  }),
]);
export type Binding = z.infer<typeof BindingSchema>;
export const NodeSchema = z.object({
  id: z.string().regex(/^[a-zA-Z0-9_-]{1,80}$/),
  type: z.string(),
  version: z.literal(1),
  label: z.string().min(1).max(120),
  config: z.record(z.string(), JsonSchema).default({}),
  inputs: z.record(z.string(), BindingSchema).default({}),
  position: z.object({ x: z.number(), y: z.number() }).optional(),
});
export const EdgeSchema = z.object({
  id: z.string(),
  source: z.string(),
  sourcePort: z.enum(['out', 'true', 'false']).default('out'),
  target: z.string(),
  targetPort: z.string().default('in'),
});
export const AISettingsSchema = z.object({
  provider: z.enum(['gemini', 'ollama', 'openai']),
  model: z.string().max(120).optional(),
  connectionId: z.string().max(100).optional(),
  dataPolicy: z.enum(['private', 'public-demo']).default('private'),
});
export type AISettings = z.infer<typeof AISettingsSchema>;
export const WorkflowSchema = z.object({
  schemaVersion: z.literal(1),
  nodes: z.array(NodeSchema).max(100),
  edges: z.array(EdgeSchema).max(500),
  settings: z
    .object({
      timezone: z.string().default('UTC'),
      ai: AISettingsSchema.optional(),
      maxItems: z.number().int().min(1).max(1000).default(1000),
    })
    .default({ timezone: 'UTC', maxItems: 1000 }),
});
export type WorkflowDefinition = z.infer<typeof WorkflowSchema>;
export type WorkflowNode = z.infer<typeof NodeSchema>;
export type WorkflowEdge = z.infer<typeof EdgeSchema>;
export type Field = {
  key: string;
  label: string;
  target: 'config' | 'inputs';
  kind:
    | 'text'
    | 'textarea'
    | 'number'
    | 'select'
    | 'connection'
    | 'boolean'
    | 'json'
    | 'note'
    | 'sheet'
    | 'resource';
  resourceKind?: string;
  resourceParent?: string;
  required?: boolean;
  default?: Json;
  options?: string[];
  help?: string;
  advanced?: boolean;
};
export type NodeDefinition = {
  type: string;
  version: 1;
  label: string;
  description: string;
  category:
    | 'trigger'
    | 'logic'
    | 'notes'
    | 'files'
    | 'data'
    | 'http'
    | 'telegram'
    | 'gmail'
    | 'sheets'
    | 'email'
    | 'ai'
    | 'drive'
    | 'calendar'
    | 'slack'
    | 'discord'
    | 'notion'
    | 'outlook'
    | 'excel'
    | 'database';
  fields: Field[];
  outputs: string[];
  effect: 'read' | 'write' | 'control';
  retrySafe: boolean;
  connectionKind?: ConnectionKind;
};
export const ConnectionKinds = [
  'telegram',
  'google',
  'smtp',
  'imap',
  'http',
  'gemini',
  'openai',
  'microsoft',
  'slack',
  'discord',
  'notion',
  'mysql',
  'postgres',
] as const;
export const ConnectionKindSchema = z.enum(ConnectionKinds);
export type ConnectionKind = z.infer<typeof ConnectionKindSchema>;
export type NodeStatus =
  | 'pending'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'skipped'
  | 'failed'
  | 'unknown'
  | 'cancelled';
export type RunStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'succeeded'
  | 'failed'
  | 'unknown'
  | 'cancelled';
export type ExecutionState = { nodeId: string; status: NodeStatus; output?: JsonObject | null };
export type ValidationIssue = { nodeId?: string; field?: string; message: string };
export type WorkflowTemplate = {
  id: string;
  name: string;
  description: string;
  category: string;
  apps: string[];
  sample: JsonObject;
  definition: WorkflowDefinition;
};
export class OperationError extends Error {
  constructor(
    message: string,
    public readonly transient = false,
    public readonly outcomeUnknown = false,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = 'OperationError';
  }
}
export const ref = (nodeId: string, path = ''): Binding => ({
  kind: 'reference',
  nodeId,
  path,
  format: 'none',
});
export const constant = (value: Json): Binding => ({ kind: 'constant', value });
export const Limits = {
  nodes: 100,
  items: 1000,
  tasks: 4,
  ai: 1,
  textBytes: 1_048_576,
  fileBytes: 20_971_520,
  httpBytes: 2_097_152,
  timeoutMs: 30_000,
  aiTimeoutMs: 300_000,
} as const;
