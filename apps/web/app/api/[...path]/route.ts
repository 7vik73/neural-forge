import type { NextRequest } from 'next/server';
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';
async function proxy(request: NextRequest, context: { params: Promise<{ path: string[] }> }) {
  const { path } = await context.params;
  const target = new URL(
    `/api/${path.map(encodeURIComponent).join('/')}`,
    process.env.API_URL ?? 'http://127.0.0.1:4301',
  );
  target.search = request.nextUrl.search;
  const headers = new Headers(request.headers);
  for (const key of ['host', 'connection', 'content-length', 'transfer-encoding'])
    headers.delete(key);
  try {
    const init: RequestInit & { duplex?: 'half' } = {
      method: request.method,
      headers,
      cache: 'no-store',
      redirect: 'manual',
      signal: request.signal,
    };
    if (!['GET', 'HEAD'].includes(request.method)) {
      init.body = request.body;
      init.duplex = 'half';
    }
    const upstream = await fetch(target, init);
    const output = new Headers(upstream.headers);
    for (const key of ['content-encoding', 'content-length', 'transfer-encoding', 'connection'])
      output.delete(key);
    output.set('Cache-Control', 'no-store');
    return new Response(upstream.body, { status: upstream.status, headers: output });
  } catch {
    return Response.json(
      { message: 'The workflow backend is unavailable. Check that the API is running.' },
      { status: 502 },
    );
  }
}
export {
  proxy as GET,
  proxy as POST,
  proxy as PATCH,
  proxy as DELETE,
  proxy as PUT,
  proxy as OPTIONS,
  proxy as HEAD,
};
