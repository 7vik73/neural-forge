import { config as dotenv } from 'dotenv';
import { resolve } from 'node:path';
dotenv({ path: resolve(process.cwd(), '../../.env'), quiet: true });
dotenv({ quiet: true });
export const config = {
  port: Number(process.env.API_PORT ?? 4301),
  bindAddress: process.env.FORGE_CONTAINER === '1' ? '0.0.0.0' : '127.0.0.1',
  appUrl: process.env.APP_URL ?? 'http://localhost:4300',
  ollamaUrl: process.env.OLLAMA_URL ?? 'http://127.0.0.1:11434',
  model: process.env.OLLAMA_MODEL ?? 'qwen3:4b',
  redisUrl: process.env.REDIS_URL ?? 'redis://127.0.0.1:46379',
  localFolder: process.env.LOCAL_FOLDER ?? resolve(process.cwd(), '../../.local/files'),
  workspaceStorage:
    process.env.WORKSPACE_STORAGE_ROOT ?? resolve(process.cwd(), '.local/workspaces'),
  encryptionKey: process.env.ENCRYPTION_KEY ?? '',
  schemaVersion: 4,
};
export function requireConfig() {
  if (!/^[a-f0-9]{64}$/.test(config.encryptionKey))
    throw new Error('Run the setup command to generate ENCRYPTION_KEY before starting.');
  const ollama = new URL(config.ollamaUrl);
  const localHosts = [
    'localhost',
    '127.0.0.1',
    '[::1]',
    ...(process.env.FORGE_CONTAINER === '1' ? ['host.docker.internal'] : []),
  ];
  if (!localHosts.includes(ollama.hostname) || ollama.protocol !== 'http:')
    throw new Error(
      'Ollama must use local loopback or the private Docker host gateway. Use Gemini or OpenAI connections for cloud AI.',
    );
}
