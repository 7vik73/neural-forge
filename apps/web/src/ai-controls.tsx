'use client';
import { useEffect, useState } from 'react';
import type { AISettings } from '@forge/contracts';
import { api, type Connection } from './lib';
import { ErrorMessage } from './ui';
export function AIControls({
  value,
  onChange,
  readOnly = false,
}: {
  value?: AISettings;
  onChange: (next: AISettings) => void;
  readOnly?: boolean;
}) {
  const [connections, setConnections] = useState<Connection[]>([]),
    [models, setModels] = useState<{ name: string }[]>([]),
    [error, setError] = useState('');
  const selected = value ?? { provider: 'ollama' as const, dataPolicy: 'private' as const };
  useEffect(() => {
    void api<Connection[]>('connections')
      .then(setConnections)
      .catch((e) => setError(e.message));
  }, []);
  const update = (patch: Partial<AISettings>) => {
    setModels([]);
    onChange({ ...selected, ...patch });
  };
  return (
    <fieldset className="ai-controls" disabled={readOnly}>
      <legend>AI for this workflow</legend>
      <div className="ai-control-grid">
        <label>
          AI provider
          <select
            aria-label="AI provider"
            value={selected.provider}
            onChange={(e) =>
              update({
                provider: e.target.value as AISettings['provider'],
                model: undefined,
                connectionId: undefined,
              })
            }
          >
            <option value="gemini">Google Gemini</option>
            <option value="ollama">Ollama · local</option>
            <option value="openai">OpenAI</option>
          </select>
        </label>
        {selected.provider !== 'ollama' && (
          <label>
            AI connection
            <select
              aria-label="AI connection"
              value={selected.connectionId ?? ''}
              onChange={(e) => update({ connectionId: e.target.value })}
            >
              <option value="">Choose a connected account</option>
              {connections
                .filter((c) => c.kind === selected.provider)
                .map((c) => (
                  <option value={c.id} key={c.id}>
                    {c.name} · {c.status}
                  </option>
                ))}
            </select>
          </label>
        )}
        <label>
          Model
          <input
            list="workflow-ai-models"
            value={
              selected.model ??
              (selected.provider === 'gemini'
                ? 'gemini-3.5-flash-lite'
                : selected.provider === 'openai'
                  ? 'gpt-4.1-mini'
                  : 'qwen3:4b')
            }
            onChange={(e) => update({ model: e.target.value })}
          />
          <datalist id="workflow-ai-models">
            {models.map((m) => (
              <option key={m.name} value={m.name} />
            ))}
          </datalist>
        </label>
        <button
          type="button"
          className="button secondary compact"
          onClick={() =>
            void api<{ name: string }[]>(
              `ai/models?provider=${selected.provider}${selected.connectionId ? `&connectionId=${encodeURIComponent(selected.connectionId)}` : ''}`,
            )
              .then(setModels)
              .then(() => setError(''))
              .catch((e) => setError(e.message))
          }
        >
          Load available models
        </button>
      </div>
      <label>
        Data handling
        <select
          aria-label="Data handling"
          value={selected.dataPolicy}
          onChange={(e) => update({ dataPolicy: e.target.value as AISettings['dataPolicy'] })}
        >
          <option value="private">Private · use local AI</option>
          <option value="public-demo">Public / synthetic demo data</option>
        </select>
      </label>
      {selected.provider !== 'ollama' && (
        <p className="field-note">
          Input is sent to {selected.provider === 'gemini' ? 'Google' : 'OpenAI'}. Free Gemini is
          for public or synthetic data. No automatic provider fallback or billing changes.{' '}
          <a
            href="https://aistudio.google.com/usage?timeRange=last-28-days&tab=rate-limit"
            target="_blank"
            rel="noreferrer"
          >
            View Gemini project limits
          </a>
        </p>
      )}
      <ErrorMessage message={error} />
    </fieldset>
  );
}
