import { expect, it } from 'vitest';
import { safeHttp } from './http.js';
it('blocks loopback and metadata endpoints before issuing an HTTP request', async () => {
  await expect(safeHttp('http://127.0.0.1:4301', { method: 'GET' })).rejects.toThrow('private');
  await expect(safeHttp('http://169.254.169.254/latest', { method: 'GET' })).rejects.toThrow(
    'private',
  );
});
it('rejects embedded credentials and other protocols', async () => {
  await expect(safeHttp('http://user:pass@example.com', { method: 'GET' })).rejects.toThrow(
    'without embedded',
  );
  await expect(safeHttp('file:///etc/passwd', { method: 'GET' })).rejects.toThrow('HTTP');
});
