import { afterEach, expect, it, vi } from 'vitest';
import { geminiAdapter, openaiAdapter, ollamaAdapter } from './ai-providers.js';
import { OperationError } from '@forge/contracts';
afterEach(() => vi.unstubAllGlobals());
const request = {
  model: 'gemini-2.5-flash',
  system: 'Classify public demo data.',
  prompt: 'A synthetic example.',
  schema: {
    type: 'object',
    properties: { label: { type: 'string' } },
    required: ['label'],
    additionalProperties: false,
  },
  credentials: { apiKey: 'fixture-key' },
};
it('sends Gemini schema and key separately and returns usage metadata', async () => {
  const transport = vi.fn().mockResolvedValue(
    Response.json({
      candidates: [
        { content: { parts: [{ thought: true, text: 'hidden' }, { text: '{"label":"demo"}' }] } },
      ],
      usageMetadata: { promptTokenCount: 15, candidatesTokenCount: 7 },
    }),
  );
  vi.stubGlobal('fetch', transport);
  expect(await geminiAdapter.chat(request)).toEqual({
    text: '{"label":"demo"}',
    inputTokens: 15,
    outputTokens: 7,
  });
  const [url, init] = transport.mock.calls[0]!;
  expect(url).not.toContain('fixture-key');
  expect(init.headers['x-goog-api-key']).toBe('fixture-key');
  const body = JSON.parse(init.body);
  expect(body.generationConfig.responseJsonSchema).toMatchObject({ required: ['label'] });
  expect(init.body).not.toContain('fixture-key');
});
it('reports Gemini quota limits with retry timing and no secret body disclosure', async () => {
  vi.stubGlobal(
    'fetch',
    vi
      .fn()
      .mockResolvedValue(
        Response.json(
          { error: { message: 'fixture-key should never leak' } },
          { status: 429, headers: { 'retry-after': '30' } },
        ),
      ),
  );
  const error = await geminiAdapter.chat(request).catch((e) => e);
  expect(error).toBeInstanceOf(OperationError);
  expect(error).toMatchObject({ transient: true, retryAfterMs: 30000 });
  expect(error.message).toContain('quota');
  expect(error.message).not.toContain('fixture-key');
});
it('rejects malformed and blocked Gemini answers', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ candidates: [{ finishReason: 'SAFETY' }] })),
  );
  await expect(geminiAdapter.chat(request)).rejects.toThrow('usable answer');
});
it('lists only Gemini text-generation models', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(
      Response.json({
        models: [
          { name: 'models/gemini-2.5-flash', supportedGenerationMethods: ['generateContent'] },
          { name: 'models/embedding', supportedGenerationMethods: ['embedContent'] },
          { name: 'models/image', supportedGenerationMethods: ['generateContent'] },
        ],
      }),
    ),
  );
  expect(await geminiAdapter.models(request.credentials)).toEqual([{ name: 'gemini-2.5-flash' }]);
});
it('uses the OpenAI Responses structured-output contract and disables storage', async () => {
  const transport = vi.fn().mockResolvedValue(
    Response.json({
      status: 'completed',
      output: [{ content: [{ type: 'output_text', text: '{"label":"demo"}' }] }],
      usage: { input_tokens: 10, output_tokens: 4 },
    }),
  );
  vi.stubGlobal('fetch', transport);
  expect(await openaiAdapter.chat({ ...request, model: 'gpt-4.1-mini' })).toMatchObject({
    text: '{"label":"demo"}',
    inputTokens: 10,
    outputTokens: 4,
  });
  const body = JSON.parse(transport.mock.calls[0]![1].body);
  expect(body.store).toBe(false);
  expect(body.text.format).toMatchObject({ type: 'json_schema', strict: true });
});
it('rejects incomplete OpenAI responses instead of treating partial JSON as success', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ status: 'incomplete', output: [] })),
  );
  await expect(openaiAdapter.chat({ ...request, model: 'gpt-4.1-mini' })).rejects.toThrow(
    'did not complete',
  );
});
it('keeps Ollama local and rejects cloud-backed models', async () => {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue(Response.json({ remote_host: 'https://cloud.example' })),
  );
  await expect(
    ollamaAdapter.chat({ ...request, model: 'qwen3:4b', credentials: {} }),
  ).rejects.toThrow('downloaded local');
});
