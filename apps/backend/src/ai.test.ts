import { afterEach, expect, it, vi } from 'vitest';
import { LocalAI, ollamaAnswer } from './ai.js';
import { templates } from '@forge/connectors';
const clients: LocalAI[] = [];
it('keeps only the completed answer when a model emits legacy thinking tags', () => {
  expect(ollamaAnswer('<think>Private model trace</think>\nA concise summary.')).toBe(
    'A concise summary.',
  );
  expect(ollamaAnswer('Legacy trace without an opening tag.</think>\n{"ready":true}')).toBe(
    '{"ready":true}',
  );
  expect(() => ollamaAnswer('<think>An unfinished trace')).toThrow('did not finish');
});
function client(responses: unknown[]) {
  const ai = new LocalAI({} as any);
  clients.push(ai);
  vi.spyOn(ai, 'settings').mockResolvedValue({ timezone: 'UTC' });
  const chat = vi.spyOn(ai, 'chat');
  for (const response of responses)
    chat.mockResolvedValueOnce({ text: JSON.stringify(response), model: 'fixture', durationMs: 0 });
  return { ai, chat };
}
afterEach(async () => {
  for (const ai of clients.splice(0)) await ai.onModuleDestroy();
  vi.restoreAllMocks();
});
const start = { type: 'trigger.manual', label: 'Start', config: [], inputs: [] };
const format = {
  type: 'data.text',
  label: 'Format',
  config: [{ key: 'operation', value: 'upper' }],
  inputs: [{ key: 'text', source: 'input', step: 0, path: 'text', value: '' }],
};
const proposal = (steps: unknown[]) => ({
  name: 'Example',
  explanation: 'A workflow proposal.',
  questions: [],
  supported: true,
  steps,
  connections: [],
});
it('allocates unique IDs before compiling references in a revision', async () => {
  const existing = structuredClone(templates[0]!.definition);
  existing.nodes = [
    existing.nodes[0]!,
    { ...existing.nodes[1]!, id: 'step_2', type: 'data.text', config: { operation: 'upper' } },
  ];
  existing.nodes[0]!.id = 'step_0';
  existing.edges = [
    { id: 'old', source: 'step_0', target: 'step_2', sourcePort: 'out', targetPort: 'in' },
  ];
  const { ai } = client([
    proposal([
      start,
      format,
      { ...format, inputs: [{ key: 'text', source: 'step', step: 1, path: 'text', value: '' }] },
    ]),
  ]);
  const result = await ai.generate('Add another formatting step.', existing);
  expect(new Set(result.definition!.nodes.map((n) => n.id)).size).toBe(3);
  expect(result.definition!.nodes[2]!.inputs.text).toMatchObject({ nodeId: 'step_2' });
});
it('repairs invalid constant JSON instead of silently dropping list work', async () => {
  const body = templates
    .find((t) => t.id === 'csv-classify')!
    .definition.nodes.find((n) => n.type === 'logic.foreach')!.config.body;
  const loop = {
    type: 'logic.foreach',
    label: 'Each',
    config: [{ key: 'body', value: JSON.stringify(body) }],
    inputs: [{ key: 'items', source: 'constant', step: 0, path: '', value: '[broken' }],
  };
  const fixed = { ...loop, inputs: [{ ...loop.inputs[0], value: '["a"]' }] };
  const { ai, chat } = client([proposal([start, loop]), proposal([start, fixed])]);
  const result = await ai.generate('Classify each item.');
  expect(chat).toHaveBeenCalledTimes(2);
  expect(result.definition!.nodes[1]!.inputs.items).toMatchObject({
    kind: 'constant',
    value: ['a'],
  });
});
it('ignores proposed trigger input plumbing because the trigger uses the run input', async () => {
  const { ai } = client([
    proposal([
      { ...start, inputs: [{ key: 'text', source: 'input', step: 0, path: 'text', value: '' }] },
      format,
    ]),
  ]);
  const result = await ai.generate('Format my text.');
  expect(result.definition!.nodes[0]!.inputs).toEqual({});
});
it('never accepts a hallucinated node type', async () => {
  const invalid = proposal([{ ...start, type: 'shell.run' }]);
  const { ai } = client([invalid, invalid]);
  await expect(ai.generate('Run a command.')).rejects.toThrow('could not produce a valid workflow');
});
it('uses the workspace timezone for an AI-generated schedule', async () => {
  const { ai } = client([
    proposal([
      {
        type: 'trigger.schedule',
        label: 'Every evening',
        config: [{ key: 'cron', value: '0 20 * * *' }],
        inputs: [],
      },
      format,
    ]),
  ]);
  vi.mocked(ai.settings).mockResolvedValue({ timezone: 'Asia/Kolkata' });
  const result = await ai.generate('Every evening at eight, format the supplied text.');
  expect(result.definition!.settings.timezone).toBe('Asia/Kolkata');
  expect(result.definition!.nodes[0]!.config.timezone).toBe('Asia/Kolkata');
});
it('resolves node overrides consistently without inheriting another provider’s model or key', async () => {
  const { resolveAIChoice } = await import('./operations.js');
  const root = {
    provider: 'gemini',
    model: 'gemini-2.5-flash',
    connectionId: 'gemini-key',
    dataPolicy: 'public-demo',
  } as const;
  expect(resolveAIChoice(root, { provider: 'ollama' })).toEqual({
    provider: 'ollama',
    model: undefined,
    connectionId: undefined,
    dataPolicy: 'public-demo',
  });
  expect(resolveAIChoice(root, { model: 'another-model' })).toMatchObject({
    provider: 'gemini',
    model: 'another-model',
    connectionId: 'gemini-key',
  });
  expect(resolveAIChoice(root, { provider: 'gemini' })).toMatchObject({
    model: 'gemini-2.5-flash',
    connectionId: 'gemini-key',
  });
  expect(resolveAIChoice(undefined, { model: 'local-model' })).toMatchObject({
    provider: 'ollama',
    model: 'local-model',
    dataPolicy: 'private',
  });
});
