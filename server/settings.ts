import './config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';

export const providerIds = ['openai', 'gemini', 'anthropic'] as const;
export type Provider = typeof providerIds[number];
export const isProvider = (value: unknown): value is Provider => providerIds.includes(value as Provider);
const editable = !process.env.VERCEL && process.env.NODE_ENV !== 'production';
const directory = path.resolve(process.env.LOCAL_SETTINGS_DIR || '.data/settings');
const settingsFile = path.join(directory, 'connections.enc');
const masterFile = path.join(directory, 'master.key');
type Saved = { companyName: string; provider: Provider; models: Partial<Record<Provider, string>>; keys: Partial<Record<Provider, string>> };
const envKeys = () => ({ openai: process.env.OPENAI_API_KEY, gemini: process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY, anthropic: process.env.ANTHROPIC_API_KEY });
const defaults = () => ({ openai: process.env.OPENAI_MODEL || 'gpt-4o-mini', gemini: process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview', anthropic: process.env.ANTHROPIC_MODEL || 'claude-sonnet-4-6' });
function readSaved(): Saved {
  if (editable && existsSync(settingsFile)) {
    const [iv, tag, payload] = readFileSync(settingsFile, 'utf8').split('.').map(v => Buffer.from(v, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', readFileSync(masterFile), iv);
    decipher.setAuthTag(tag);
    return JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8'));
  }
  const keys = envKeys();
  return { companyName: process.env.COMPANY_NAME || 'Doc.AI', provider: isProvider(process.env.AI_PROVIDER) ? process.env.AI_PROVIDER : providerIds.find(p => keys[p]) || 'gemini', models: {}, keys: {} };
}
let saved = readSaved();
export function connection(provider: Provider = saved.provider) {
  return { provider, model: saved.models[provider] || defaults()[provider], key: envKeys()[provider] || saved.keys[provider] || '' };
}
export function publicSettings() {
  return { companyName: saved.companyName, provider: saved.provider, editable, providers: providerIds.map(id => ({ id, model: connection(id).model, configured: !!connection(id).key, source: envKeys()[id] ? 'environment' : saved.keys[id] ? 'local' : 'none' })) };
}
export function canEditSettings(req: Request) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
  const host = req.headers.host || '';
  const localHost = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
  const origin = req.get('origin');
  return editable && local && localHost && (!origin || origin === `${req.protocol}://${host}`);
}
export function updateSettings(input: any) {
  if (!editable) throw new Error('Налаштування сервера доступні лише адміністратору розгортання.');
  const next: Saved = structuredClone(saved);
  if (input.provider !== undefined) {
    if (!isProvider(input.provider)) throw new Error('Невідомий AI-провайдер');
    next.provider = input.provider;
  }
  if (input.companyName !== undefined) {
    if (typeof input.companyName !== 'string' || !input.companyName.trim() || input.companyName.length > 80) throw new Error('Назва компанії: від 1 до 80 символів');
    next.companyName = input.companyName.trim();
  }
  if (input.connection !== undefined) {
    const { provider, key, model, removeKey } = input.connection;
    if (!isProvider(provider)) throw new Error('Невідомий AI-провайдер');
    if (model !== undefined) {
      if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,119}$/.test(model)) throw new Error('Вкажіть коректний ідентифікатор моделі');
      next.models[provider] = model;
    }
    if ((key || removeKey) && envKeys()[provider]) throw new Error('Цей ключ задано на сервері. Змініть змінну середовища.');
    if (key !== undefined && key !== '') {
      if (typeof key !== 'string' || key.trim().length < 12 || key.length > 4096 || /\s/.test(key.trim())) throw new Error('Перевірте API-ключ: він не має містити пробілів');
      next.keys[provider] = key.trim();
    }
    if (removeKey === true) delete next.keys[provider];
  }
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  if (!existsSync(masterFile)) writeFileSync(masterFile, randomBytes(32), { mode: 0o600, flag: 'wx' });
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', readFileSync(masterFile), iv);
  const payload = Buffer.concat([cipher.update(JSON.stringify(next), 'utf8'), cipher.final()]);
  writeFileSync(settingsFile + '.tmp', [iv, cipher.getAuthTag(), payload].map(v => v.toString('base64')).join('.'), { mode: 0o600 });
  renameSync(settingsFile + '.tmp', settingsFile);
  saved = next;
  return publicSettings();
}
