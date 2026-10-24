import { beforeAll, expect, it } from 'vitest';
beforeAll(() => {
  process.env.ENCRYPTION_KEY = 'ab'.repeat(32);
});
it('authenticates passwords with a salted hash', async () => {
  const { passwordHash, verifyPassword } = await import('./security.js');
  const hash = passwordHash('a long owner password');
  expect(verifyPassword('a long owner password', hash)).toBe(true);
  expect(verifyPassword('wrong password', hash)).toBe(false);
  expect(hash).not.toContain('a long owner password');
});
it('encrypts credentials with authenticated encryption', async () => {
  const { encrypt, decrypt } = await import('./security.js');
  const token = encrypt({ token: 'private-token' });
  expect(token).not.toContain('private-token');
  expect(decrypt(token)).toEqual({ token: 'private-token' });
  const parts = token.split('.');
  parts[1] = Buffer.alloc(16).toString('base64');
  expect(() => decrypt(parts.join('.'))).toThrow();
});
it('redacts provider tokens and authorization headers', async () => {
  const { redact } = await import('./security.js');
  expect(redact('Bearer abcdefghi token=secret')).not.toContain('abcdefghi');
  expect(
    redact('https://api.telegram.org/bot123456789:abcdefghijklmnopqrstuvwxyz/sendMessage'),
  ).not.toContain('abcdefghijklmnopqrstuvwxyz');
});
