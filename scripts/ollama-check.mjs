import { readFileSync } from 'node:fs';
const content = readFileSync('.env', 'utf8');
const target = new URL(content.match(/^OLLAMA_URL=(.+)$/m)?.[1] ?? 'http://127.0.0.1:11434');
if (process.env.FORGE_NETWORK === 'bridge') target.hostname = 'host.docker.internal';
const url = target.toString().replace(/\/$/, '');
try {
  if (
    ![
      'localhost',
      '127.0.0.1',
      '[::1]',
      ...(process.env.FORGE_NETWORK === 'bridge' ? ['host.docker.internal'] : []),
    ].includes(new URL(url).hostname)
  )
    throw new Error('Ollama must use a local address.');
  const response = await fetch(`${url}/api/tags`, { signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error('Ollama returned an error.');
  console.log('Native Ollama is reachable from the application network.');
} catch {
  console.error(
    'Cannot reach native Ollama from Docker. Start Ollama, then enable Docker Desktop → Settings → Resources → Network → Enable host networking and restart Docker. Linux Docker Engine supports host networking directly.',
  );
  process.exitCode = 1;
}
