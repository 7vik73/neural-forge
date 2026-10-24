import {
  WorkflowSchema,
  type Binding,
  type ExecutionState,
  type Json,
  type JsonObject,
  type NodeDefinition,
  type ValidationIssue,
  type WorkflowDefinition,
  type WorkflowNode,
} from '@forge/contracts';

const forbidden = new Set(['__proto__', 'prototype', 'constructor']);
export function readPath(value: Json, path: string): Json {
  if (!path) return value;
  let current: Json | undefined = value;
  for (const part of path.split('.')) {
    if (forbidden.has(part)) throw new Error('This data path is not allowed.');
    if (current == null || typeof current !== 'object')
      throw new Error(`The field “${path}” is missing. Choose an available output field.`);
    current = Object.hasOwn(current, part) ? (current as Record<string, Json>)[part] : undefined;
  }
  if (current === undefined)
    throw new Error(`The field “${path}” is missing. Choose an available output field.`);
  return current;
}
export function resolveBinding(
  binding: Binding,
  input: JsonObject,
  outputs: Record<string, JsonObject>,
): Json {
  if (binding.kind === 'constant') return binding.value;
  const source = binding.nodeId === '$input' ? input : outputs[binding.nodeId];
  if (!source)
    throw new Error(`The output from “${binding.nodeId}” is unavailable on this branch.`);
  const value = readPath(source, binding.path);
  switch (binding.format) {
    case 'text':
      return typeof value === 'string' ? value : JSON.stringify(value);
    case 'upper':
      return String(value).toUpperCase();
    case 'lower':
      return String(value).toLowerCase();
    case 'json':
      return JSON.stringify(value);
    case 'date': {
      const date = new Date(String(value));
      if (Number.isNaN(date.valueOf())) throw new Error('Choose a valid date field.');
      return date.toISOString();
    }
    default:
      return value;
  }
}
export function resolveInputs(
  node: WorkflowNode,
  input: JsonObject,
  outputs: Record<string, JsonObject>,
): JsonObject {
  return Object.fromEntries(
    Object.entries(node.inputs).map(([key, binding]) => [
      key,
      resolveBinding(binding, input, outputs),
    ]),
  );
}
export function ancestors(graph: WorkflowDefinition, id: string): Set<string> {
  const result = new Set<string>();
  const visit = (target: string) => {
    for (const edge of graph.edges.filter((e) => e.target === target))
      if (!result.has(edge.source)) {
        result.add(edge.source);
        visit(edge.source);
      }
  };
  visit(id);
  return result;
}
export function validateWorkflow(
  value: unknown,
  catalog: NodeDefinition[],
  depth = 0,
): ValidationIssue[] {
  const parsed = WorkflowSchema.safeParse(value);
  if (!parsed.success)
    return parsed.error.issues.map((issue) => ({
      message: `${issue.path.join('.')}: ${issue.message}`,
    }));
  const graph = parsed.data;
  const issues: ValidationIssue[] = [];
  const ids = new Set<string>();
  const triggers = graph.nodes.filter((n) => n.type.startsWith('trigger.'));
  if (triggers.length !== 1) issues.push({ message: 'Add exactly one starting trigger.' });
  try {
    new Intl.DateTimeFormat('en', { timeZone: graph.settings.timezone });
  } catch {
    issues.push({ message: 'Choose a valid timezone.' });
  }
  for (const node of graph.nodes) {
    if (ids.has(node.id)) issues.push({ nodeId: node.id, message: 'Step IDs must be unique.' });
    ids.add(node.id);
    const definition = catalog.find((d) => d.type === node.type && d.version === node.version);
    if (!definition) {
      issues.push({
        nodeId: node.id,
        message: 'This step type is unavailable. Choose a supported step.',
      });
      continue;
    }
    for (const key of Object.keys(node.config))
      if (!definition.fields.some((f) => f.target === 'config' && f.key === key))
        issues.push({
          nodeId: node.id,
          field: key,
          message: `Remove the unsupported setting “${key}”.`,
        });
    for (const key of Object.keys(node.inputs))
      if (!definition.fields.some((f) => f.target === 'inputs' && f.key === key))
        issues.push({
          nodeId: node.id,
          field: key,
          message: `Remove the unsupported input “${key}”.`,
        });
    for (const field of definition.fields) {
      const v = field.target === 'config' ? node.config[field.key] : node.inputs[field.key];
      if (
        field.required &&
        (v === undefined ||
          v === '' ||
          v === null ||
          (typeof v === 'object' &&
            'kind' in v &&
            v.kind === 'constant' &&
            (v.value === '' || v.value === null)))
      )
        issues.push({
          nodeId: node.id,
          field: field.key,
          message: `Set “${field.label}” to continue.`,
        });
      if (v !== undefined && field.target === 'config') {
        if (field.kind === 'number' && (typeof v !== 'number' || !Number.isFinite(v)))
          issues.push({
            nodeId: node.id,
            field: field.key,
            message: `${field.label} must be a number.`,
          });
        if (field.options && !field.options.includes(String(v)))
          issues.push({
            nodeId: node.id,
            field: field.key,
            message: `Choose a supported ${field.label.toLowerCase()}.`,
          });
        if (
          ['text', 'textarea', 'select', 'connection', 'sheet', 'note'].includes(field.kind) &&
          typeof v !== 'string'
        )
          issues.push({
            nodeId: node.id,
            field: field.key,
            message: `${field.label} must be text.`,
          });
        if (field.kind === 'boolean' && typeof v !== 'boolean')
          issues.push({
            nodeId: node.id,
            field: field.key,
            message: `${field.label} must be enabled or disabled.`,
          });
      }
      if (
        field.target === 'inputs' &&
        typeof v === 'object' &&
        v !== null &&
        'kind' in v &&
        v.kind === 'constant' &&
        field.key === 'items' &&
        !Array.isArray(v.value)
      )
        issues.push({
          nodeId: node.id,
          field: field.key,
          message: `Choose a list for ${field.label.toLowerCase()}.`,
        });
    }
    if (
      node.type === 'logic.delay' &&
      (!(Number(node.config.seconds) >= 0) || Number(node.config.seconds) > 2_592_000)
    )
      issues.push({ nodeId: node.id, message: 'Choose a delay between 0 seconds and 30 days.' });
    if (node.type === 'logic.foreach') {
      if (depth)
        issues.push({
          nodeId: node.id,
          message: 'Nested lists are not supported in this release.',
        });
      else
        for (const issue of validateWorkflow(node.config.body, catalog, depth + 1))
          issues.push({ ...issue, nodeId: node.id, message: `List body: ${issue.message}` });
    }
  }
  const edgeIds = new Set<string>();
  for (const edge of graph.edges) {
    if (edgeIds.has(edge.id)) issues.push({ message: 'Connection IDs must be unique.' });
    edgeIds.add(edge.id);
    if (!ids.has(edge.source) || !ids.has(edge.target))
      issues.push({ message: 'A connection points to a missing step.' });
    const source = graph.nodes.find((n) => n.id === edge.source);
    if (edge.sourcePort !== 'out' && source?.type !== 'logic.condition')
      issues.push({
        nodeId: edge.source,
        message: 'Only conditions have true and false branches.',
      });
    if (edge.sourcePort === 'out' && source?.type === 'logic.condition')
      issues.push({
        nodeId: edge.source,
        message: 'Connect a condition using its true or false output.',
      });
  }
  const indegree = new Map(
    graph.nodes.map((n) => [
      n.id,
      graph.edges.filter((e) => e.target === n.id && ids.has(e.source)).length,
    ]),
  );
  const queue = graph.nodes.filter((n) => !indegree.get(n.id)).map((n) => n.id);
  let visited = 0;
  while (queue.length) {
    const id = queue.shift()!;
    visited++;
    for (const edge of graph.edges.filter((e) => e.source === id && ids.has(e.target))) {
      indegree.set(edge.target, (indegree.get(edge.target) ?? 0) - 1);
      if (!indegree.get(edge.target)) queue.push(edge.target);
    }
  }
  const cyclic = visited !== graph.nodes.length;
  if (cyclic)
    issues.push({ message: 'Remove the cycle. Use “For each item” to process a bounded list.' });
  if (!cyclic)
    for (const node of graph.nodes) {
      const prior = ancestors(graph, node.id);
      if (!node.type.startsWith('trigger.') && !prior.has(triggers[0]?.id ?? ''))
        issues.push({ nodeId: node.id, message: 'Connect this step to the starting trigger.' });
      if (node.type.startsWith('trigger.') && graph.edges.some((e) => e.target === node.id))
        issues.push({
          nodeId: node.id,
          message: 'The starting trigger cannot have an incoming connection.',
        });
      for (const [field, binding] of Object.entries(node.inputs))
        if (binding.kind === 'reference' && binding.nodeId !== '$input') {
          if (!prior.has(binding.nodeId))
            issues.push({
              nodeId: node.id,
              field,
              message: 'Choose an output from an earlier connected step.',
            });
          else {
            const source = graph.nodes.find((n) => n.id === binding.nodeId);
            const meta = catalog.find((d) => d.type === source?.type);
            const key = binding.path.split('.')[0];
            if (key && meta && !meta.outputs.includes(key) && !source?.type.startsWith('trigger.'))
              issues.push({
                nodeId: node.id,
                field,
                message: 'Choose an available output field from the earlier step.',
              });
            if (field === 'items' && key === 'text' && binding.format !== 'json')
              issues.push({
                nodeId: node.id,
                field,
                message: 'This step needs a list. Choose an items output instead of text.',
              });
          }
        }
    }
  return issues;
}
const terminal = new Set(['succeeded', 'skipped']);
export function frontier(
  graph: WorkflowDefinition,
  states: ExecutionState[],
): { ready: string[]; skipped: string[] } {
  const byId = new Map(states.map((s) => [s.nodeId, s]));
  const ready: string[] = [];
  const skipped: string[] = [];
  for (const node of graph.nodes) {
    if (byId.has(node.id)) continue;
    const incoming = graph.edges.filter((e) => e.target === node.id);
    if (!incoming.length) {
      ready.push(node.id);
      continue;
    }
    if (!incoming.every((e) => terminal.has(byId.get(e.source)?.status ?? ''))) continue;
    const active = incoming.some((e) => {
      const state = byId.get(e.source)!;
      return (
        state.status === 'succeeded' &&
        (e.sourcePort === 'out' || state.output?._branch === e.sourcePort)
      );
    });
    (active ? ready : skipped).push(node.id);
  }
  return { ready, skipped };
}
export function sanitizedExport(graph: WorkflowDefinition): {
  definition: WorkflowDefinition;
  connections: { placeholder: string; kind: string }[];
} {
  const copy = structuredClone(graph);
  const placeholders = new Map<string, string>();
  const walk = (g: WorkflowDefinition) => {
    if (g.settings.ai?.connectionId) {
      const key = g.settings.ai.connectionId;
      if (!placeholders.has(key)) placeholders.set(key, `connect-${placeholders.size + 1}`);
      g.settings.ai.connectionId = placeholders.get(key)!;
    }
    for (const node of g.nodes) {
      if (typeof node.config.connectionId === 'string' && node.config.connectionId) {
        const key = node.config.connectionId;
        if (!placeholders.has(key)) placeholders.set(key, `connect-${placeholders.size + 1}`);
        node.config.connectionId = placeholders.get(key)!;
      }
      if (node.type === 'logic.foreach' && node.config.body) {
        const body = WorkflowSchema.parse(node.config.body);
        walk(body);
        node.config.body = body as unknown as Json;
      }
    }
  };
  walk(copy);
  return {
    definition: copy,
    connections: [...placeholders.values()].map((placeholder) => ({
      placeholder,
      kind: 'reconnect',
    })),
  };
}
