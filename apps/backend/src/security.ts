import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  scryptSync,
  timingSafeEqual,
} from 'node:crypto';
import { config } from './config.js';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export function equal(a: string, b: string) {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
export function passwordHash(password: string) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${scryptSync(password, salt, 64).toString('hex')}`;
}
export function verifyPassword(password: string, hash: string) {
  const [salt, value] = hash.split(':');
  return !!salt && !!value && equal(scryptSync(password, salt, 64).toString('hex'), value);
}
export function encrypt(value: unknown) {
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
  const ciphertext = Buffer.concat([cipher.update(JSON.stringify(value)), cipher.final()]);
  return [iv, cipher.getAuthTag(), ciphertext].map((b) => b.toString('base64')).join('.');
}
export function decrypt(value: string): Record<string, string> {
  const [iv, tag, ciphertext] = value.split('.').map((s) => Buffer.from(s, 'base64'));
  if (!iv || !tag || !ciphertext) throw new Error('Connection secret is invalid.');
  const decipher = createDecipheriv('aes-256-gcm', Buffer.from(config.encryptionKey, 'hex'), iv);
  decipher.setAuthTag(tag);
  return JSON.parse(Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString());
}
export function redact(message: string) {
  return message
    .replace(/(bearer\s+)[^\s]+/gi, '$1[redacted]')
    .replace(/([?&](?:key|token|access_token|secret)=)[^&\s]+/gi, '$1[redacted]')
    .replace(/(?:bot)?\d{6,}:[A-Za-z0-9_-]{20,}/g, '[redacted]')
    .replace(
      /(password|secret|token|authorization)["']?\s*[:=]\s*["']?[^\s,}"']+/gi,
      '$1=[redacted]',
    )
    .slice(0, 700);
}
