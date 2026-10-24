import { describe, expect, it } from 'vitest';
import { constant, ref, type WorkflowDefinition } from '@forge/contracts';
import { catalog, templates } from '../../connectors/src/catalog.js';
import { frontier, readPath, resolveBinding, sanitizedExport, validateWorkflow } from './index.js';
const graph = (): WorkflowDefinition => ({
  schemaVersion: 1,
  settings: { timezone: 'UTC', maxItems: 1000 },
  nodes: [
    { id: 'start', type: 'trigger.manual', label: 'Start', version: 1, config: {}, inputs: {} },
    {
      id: 'check',
      type: 'logic.condition',
      label: 'Check',
      version: 1,
      config: { operator: 'equals' },
      inputs: { value: ref('$input', 'text'), compare: constant('yes') },
    },
    {
      id: 'yes',
      type: 'data.text',
      label: 'Yes',
      version: 1,
      config: { operation: 'upper' },
      inputs: { text: ref('$input', 'text') },
    },
    {
      id: 'no',
      type: 'data.text',
      label: 'No',
      version: 1,
      config: { operation: 'lower' },
      inputs: { text: ref('$input', 'text') },
    },
    { id: 'join', type: 'logic.join', label: 'Join', version: 1, config: {}, inputs: {} },
  ],
  edges: [
    { id: 'a', source: 'start', target: 'check', sourcePort: 'out', targetPort: 'in' },
    { id: 'b', source: 'check', target: 'yes', sourcePort: 'true', targetPort: 'in' },
    { id: 'c', source: 'check', target: 'no', sourcePort: 'false', targetPort: 'in' },
    { id: 'd', source: 'yes', target: 'join', sourcePort: 'out', targetPort: 'in' },
    { id: 'e', source: 'no', target: 'join', sourcePort: 'out', targetPort: 'in' },
  ],
});
describe('workflow interface', () => {
  it('validates a branching graph and resolves safe references', () => {
    expect(validateWorkflow(graph(), catalog)).toEqual([]);
    expect(
      resolveBinding(
        ref('previous', 'data.0.email'),
        {},
        { previous: { data: [{ email: 'a@example.com' }] } },
      ),
    ).toBe('a@example.com');
  });
  it('starts only the trigger', () =>
    expect(frontier(graph(), [])).toEqual({ ready: ['start'], skipped: [] }));
  it.each(['true', 'false'])(
    'propagates the %s branch and joins after the other branch is skipped',
    (branch) => {
      const chosen = branch === 'true' ? 'yes' : 'no';
      const excluded = chosen === 'yes' ? 'no' : 'yes';
      const states = [
        { nodeId: 'start', status: 'succeeded' as const, output: {} },
        { nodeId: 'check', status: 'succeeded' as const, output: { _branch: branch } },
      ];
      expect(frontier(graph(), states)).toEqual({ ready: [chosen], skipped: [excluded] });
      expect(
        frontier(graph(), [
          ...states,
          { nodeId: chosen, status: 'succeeded', output: {} },
          { nodeId: excluded, status: 'skipped', output: {} },
        ]),
      ).toEqual({ ready: ['join'], skipped: [] });
    },
  );
  it('waits for every parallel predecessor before a join', () => {
    const g = graph();
    g.edges.find((e) => e.id === 'c')!.sourcePort = 'true';
    expect(
      frontier(g, [
        { nodeId: 'start', status: 'succeeded' },
        { nodeId: 'check', status: 'succeeded', output: { _branch: 'true' } },
        { nodeId: 'yes', status: 'succeeded' },
        { nodeId: 'no', status: 'running' },
      ]).ready,
    ).not.toContain('join');
  });
  it('rejects a graph cycle without recursive traversal', () => {
    const g = graph();
    g.edges.push({
      id: 'cycle',
      source: 'join',
      target: 'check',
      sourcePort: 'out',
      targetPort: 'in',
    });
    expect(validateWorkflow(g, catalog).some((i) => i.message.includes('cycle'))).toBe(true);
  });
  it('rejects duplicate ids, missing nodes and downstream bindings', () => {
    const g = graph();
    g.nodes[1]!.inputs.value = ref('join', 'text');
    g.edges.push({
      id: 'broken',
      source: 'missing',
      target: 'join',
      sourcePort: 'out',
      targetPort: 'in',
    });
    const issues = validateWorkflow(g, catalog);
    expect(issues.some((i) => i.message.includes('missing'))).toBe(true);
    expect(issues.some((i) => i.message.includes('earlier'))).toBe(true);
  });
  it('rejects forbidden object paths and absent fields', () => {
    expect(() => readPath({}, '__proto__')).toThrow('not allowed');
    expect(() => readPath({}, 'missing.text')).toThrow('missing');
  });
  it('does not resolve inactive-branch outputs silently', () =>
    expect(() => resolveBinding(ref('no', 'text'), {}, {})).toThrow('unavailable'));
  it('keeps incomplete templates editable but reports required setup', () => {
    for (const t of templates) {
      const structural = validateWorkflow(t.definition, catalog).filter(
        (i) => !i.message.startsWith('Set “'),
      );
      expect(structural, t.name).toEqual([]);
    }
  });
  it('exports connection placeholders without mutating the draft', () => {
    const g = structuredClone(templates.find((t) => t.id === 'daily-notes')!.definition);
    g.nodes.at(-1)!.config.connectionId = 'private-account-id';
    const output = sanitizedExport(g);
    expect(JSON.stringify(output)).not.toContain('private-account-id');
    expect(g.nodes.at(-1)!.config.connectionId).toBe('private-account-id');
  });
  it('replaces account references inside list bodies too', () => {
    const g = structuredClone(templates.find((t) => t.id === 'csv-classify')!.definition);
    const body = g.nodes.find((n) => n.type === 'logic.foreach')!.config
      .body as unknown as WorkflowDefinition;
    body.nodes.push({
      id: 'send',
      type: 'telegram.send',
      version: 1,
      label: 'Send',
      config: { connectionId: 'private-nested-account', chatId: '123' },
      inputs: { text: ref('classify', 'label') },
    });
    const exported = sanitizedExport(g);
    expect(JSON.stringify(exported)).not.toContain('private-nested-account');
    expect(JSON.stringify(exported.definition)).toContain('connect-1');
  });
  it('rejects nested lists and excess graph size', () => {
    const g = structuredClone(templates.find((t) => t.id === 'csv-classify')!.definition);
    const loop = g.nodes.find((n) => n.type === 'logic.foreach')!;
    const body = structuredClone(g);
    loop.config.body = body as any;
    expect(validateWorkflow(g, catalog).some((i) => i.message.includes('Nested'))).toBe(true);
  });
});
