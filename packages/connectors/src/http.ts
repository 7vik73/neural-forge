import { lookup } from 'node:dns/promises';
import ipaddr from 'ipaddr.js';
import { Agent, fetch as request } from 'undici';
import { Limits, OperationError } from '@forge/contracts';

export async function safeHttp(
  url: string,
  options: {
    method: string;
    body?: unknown;
    headers?: Record<string, string>;
    allowPrivate?: boolean;
    signal?: AbortSignal;
  },
) {
  let target = new URL(url);
  for (let redirect = 0; redirect <= 3; redirect++) {
    if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password)
      throw new Error('Use an HTTP or HTTPS URL without embedded credentials.');
    const hostname = target.hostname.replace(/^\[|\]$/g, '');
    const addresses = await lookup(hostname, { all: true });
    if (
      !addresses.length ||
      (!options.allowPrivate &&
        addresses.some((a) => ipaddr.process(a.address).range() !== 'unicast'))
    )
      throw new Error(
        'This URL uses a private or reserved network. Enable private-network access explicitly if you trust the destination.',
      );
    const address = addresses[0]!;
    const agent = new Agent({
      connect: {
        lookup: (_hostname, opts, callback) => {
          // Node's auto-family selection requests the `all` lookup contract.
          if (opts.all) callback(null, [address] as any);
          else callback(null, address.address, address.family);
        },
      },
    });
    try {
      const response = await request(target, {
        dispatcher: agent,
        method: options.method,
        headers: { 'Content-Type': 'application/json', ...options.headers },
        body:
          ['GET', 'HEAD'].includes(options.method) || options.body === undefined
            ? undefined
            : JSON.stringify(options.body),
        redirect: 'manual',
        signal: options.signal ?? AbortSignal.timeout(Limits.timeoutMs),
      });
      if ([301, 302, 303, 307, 308].includes(response.status)) {
        if (!['GET', 'HEAD'].includes(options.method))
          throw new Error('Write-request redirects must be configured with the final URL.');
        const location = response.headers.get('location');
        if (!location) throw new Error('The server returned a redirect without a destination.');
        const next = new URL(location, target);
        if (next.origin !== target.origin) options = { ...options, headers: {} };
        target = next;
        await response.body?.cancel();
        continue;
      }
      if (!response.ok) {
        await response.body?.cancel();
        throw new OperationError(
          `HTTP request returned ${response.status}.`,
          response.status === 429 || response.status >= 500,
          false,
          Number(response.headers.get('retry-after') || 0) * 1000,
        );
      }
      const reader = response.body?.getReader();
      let total = 0;
      const chunks: Uint8Array[] = [];
      if (reader)
        while (true) {
          const part = await reader.read();
          if (part.done) break;
          total += part.value.byteLength;
          if (total > Limits.httpBytes) {
            await reader.cancel();
            throw new Error('HTTP response exceeds 2 MB.');
          }
          chunks.push(part.value);
        }
      const text = Buffer.concat(chunks).toString('utf8');
      let data: unknown = text;
      try {
        data = JSON.parse(text);
      } catch {
        /* Plain text is a supported result. */
      }
      return { status: response.status, text, data };
    } finally {
      await agent.close();
    }
  }
  throw new Error('Too many HTTP redirects. Configure the final destination URL.');
}
