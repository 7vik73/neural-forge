import { afterEach, expect, it, vi } from 'vitest';

const transport = vi.hoisted(() => ({ configurations: [] as any[] }));
vi.mock('node:dns/promises', () => ({
  lookup: vi.fn().mockResolvedValue([{ address: '93.184.216.34', family: 4 }]),
}));
vi.mock('undici', () => ({
  Agent: class {
    constructor(config: any) {
      transport.configurations.push(config);
    }
    async close() {}
  },
  fetch: vi.fn().mockImplementation(async () => new Response('Public fixture page')),
}));
import { safeHttp } from './http.js';
afterEach(() => {
  transport.configurations.length = 0;
});

it('pins the approved address using both Node lookup callback contracts', async () => {
  expect(await safeHttp('https://example.com', { method: 'GET' })).toMatchObject({
    status: 200,
    text: 'Public fixture page',
  });
  const lookup = transport.configurations[0].connect.lookup;
  const all = vi.fn();
  lookup('example.com', { all: true }, all);
  expect(all).toHaveBeenCalledWith(null, [{ address: '93.184.216.34', family: 4 }]);
  const single = vi.fn();
  lookup('example.com', { all: false }, single);
  expect(single).toHaveBeenCalledWith(null, '93.184.216.34', 4);
});
