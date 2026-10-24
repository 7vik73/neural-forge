import { OperationError } from '@forge/contracts';
import { config } from './config.js';

export type AIRequest = {
  model: string;
  system: string;
  prompt: string;
  schema?: object;
  credentials: Record<string, string>;
  signal?: AbortSignal;
};
export type AIResult = { text: string; inputTokens?: number; outputTokens?: number };
export interface AIAdapter {
  models(credentials: Record<string, string>): Promise<{ name: string }[]>;
  chat(request: AIRequest): Promise<AIResult>;
}
async function request(url: string, init: RequestInit, provider: string) {
  let response: Response;
  try {
    response = await fetch(url, {
      ...init,
      redirect: 'error',
      signal: init.signal ?? AbortSignal.timeout(300_000),
    });
  } catch (error) {
    if (init.signal?.aborted) throw new Error('AI request cancelled.');
    throw new OperationError(
      `${provider} could not be reached. Check the connection and try again.`,
      true,
    );
  }
  if (!response.ok) {
    await response.body?.cancel();
    const delay = response.headers.get('retry-after');
    const retryAfterMs = delay
      ? /^\d+(\.\d+)?$/.test(delay)
        ? Number(delay) * 1000
        : Math.max(0, Date.parse(delay) - Date.now())
      : undefined;
    throw new OperationError(
      response.status === 429
        ? `${provider} quota or rate limit reached. Check your project limits; no other provider was used.`
        : response.status === 401 || response.status === 403
          ? `${provider} rejected this connection. Check its API key and permissions.`
          : `${provider} returned HTTP ${response.status}. Check the selected model.`,
      response.status === 429 || response.status >= 500,
      false,
      retryAfterMs,
    );
  }
  return response.json();
}
export function ollamaAnswer(content: string) {
  const end = content.toLowerCase().lastIndexOf('</think>');
  const answer = (end >= 0 ? content.slice(end + '</think>'.length) : content).trim();
  if (!answer || /<think>/i.test(answer))
    throw new Error(
      'The model did not finish its answer. Try a smaller input or another local model.',
    );
  return answer;
}
export const ollamaAdapter: AIAdapter = {
  async models() {
    const body = await request(
      `${config.ollamaUrl}/api/tags`,
      { signal: AbortSignal.timeout(5000) },
      'Ollama',
    );
    return body.models.filter((m: any) => !m.name.includes('cloud'));
  },
  async chat(r) {
    const details = await request(
      `${config.ollamaUrl}/api/show`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ model: r.model }),
        signal: AbortSignal.timeout(5000),
      },
      'Ollama',
    );
    if (details.remote_host || details.remote_model)
      throw new Error('Choose a downloaded local model.');
    const body = await request(
      `${config.ollamaUrl}/api/chat`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        signal: r.signal,
        body: JSON.stringify({
          model: r.model,
          stream: false,
          think: false,
          messages: [
            { role: 'system', content: r.system },
            { role: 'user', content: r.prompt },
          ],
          ...(r.schema ? { format: r.schema } : {}),
          options: { temperature: 0, num_ctx: 8192, num_predict: 4096 },
        }),
      },
      'Ollama',
    );
    return {
      text: ollamaAnswer(body.message?.content ?? ''),
      inputTokens: body.prompt_eval_count,
      outputTokens: body.eval_count,
    };
  },
};
export const geminiAdapter: AIAdapter = {
  async models(c) {
    const body = await request(
      'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
      { headers: { 'x-goog-api-key': c.apiKey! } },
      'Gemini',
    );
    return body.models
      .filter(
        (m: any) =>
          m.supportedGenerationMethods?.includes('generateContent') &&
          !/image|audio|tts|live/.test(m.name),
      )
      .map((m: any) => ({ name: m.name.replace(/^models\//, '') }));
  },
  async chat(r) {
    const { $schema, ...schema } = (r.schema ?? {}) as any;
    const body = await request(
      `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(r.model)}:generateContent`,
      {
        method: 'POST',
        signal: r.signal,
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': r.credentials.apiKey! },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: r.system }] },
          contents: [{ role: 'user', parts: [{ text: r.prompt }] }],
          generationConfig: {
            temperature: 0,
            maxOutputTokens: 4096,
            ...(r.schema
              ? { responseMimeType: 'application/json', responseJsonSchema: schema }
              : {}),
          },
        }),
      },
      'Gemini',
    );
    const text = body.candidates?.[0]?.content?.parts
      ?.filter((p: any) => !p.thought)
      .map((p: any) => p.text ?? '')
      .join('')
      .trim();
    if (!text)
      throw new Error(
        'Gemini did not return a usable answer. Check safety feedback or shorten the input.',
      );
    return {
      text,
      inputTokens: body.usageMetadata?.promptTokenCount,
      outputTokens: body.usageMetadata?.candidatesTokenCount,
    };
  },
};
export const openaiAdapter: AIAdapter = {
  async models(c) {
    const body = await request(
      'https://api.openai.com/v1/models',
      { headers: { Authorization: `Bearer ${c.apiKey}` } },
      'OpenAI',
    );
    return body.data
      .filter(
        (m: any) =>
          /^(gpt-4\.1|gpt-4o|gpt-5|gpt-6)/.test(m.id) &&
          !/audio|image|realtime|transcrib|tts/.test(m.id),
      )
      .map((m: any) => ({ name: m.id }));
  },
  async chat(r) {
    const { $schema, ...schema } = (r.schema ?? {}) as any;
    const body = await request(
      'https://api.openai.com/v1/responses',
      {
        method: 'POST',
        signal: r.signal,
        headers: {
          Authorization: `Bearer ${r.credentials.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          model: r.model,
          instructions: r.system,
          input: r.prompt,
          max_output_tokens: 4096,
          store: false,
          ...(r.schema
            ? {
                text: {
                  format: { type: 'json_schema', name: 'workflow_result', strict: true, schema },
                },
              }
            : {}),
        }),
      },
      'OpenAI',
    );
    if (body.status !== 'completed')
      throw new Error(
        'OpenAI did not complete this answer. Shorten the input or choose another model.',
      );
    const text = body.output
      ?.flatMap((o: any) => o.content ?? [])
      .filter((p: any) => p.type === 'output_text')
      .map((p: any) => p.text)
      .join('')
      .trim();
    if (!text) throw new Error('OpenAI returned no usable text.');
    return { text, inputTokens: body.usage?.input_tokens, outputTokens: body.usage?.output_tokens };
  },
};
export const aiAdapters: Record<string, AIAdapter> = {
  ollama: ollamaAdapter,
  gemini: geminiAdapter,
  openai: openaiAdapter,
};
