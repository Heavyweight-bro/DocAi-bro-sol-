import './config';
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';
import { defaultModels, needsEndpoint, providerIds, recommendedModels, recommendedModelOptions, type Provider } from './models';

export { providerIds, type Provider };
export const isProvider = (value: unknown): value is Provider => providerIds.includes(value as Provider);
const editable = !process.env.VERCEL && process.env.NODE_ENV !== 'production';
const directory = path.resolve(process.env.LOCAL_SETTINGS_DIR || '.data/settings');
const settingsFile = path.join(directory, 'connections.enc');
const masterFile = path.join(directory, 'master.key');
type Saved = {
  companyName: string;
  provider: Provider;
  models: Partial<Record<Provider, string>>;
  keys: Partial<Record<Provider, string>>;
  endpoints: Partial<Record<Provider, string>>;
  apiVersions: Partial<Record<Provider, string>>;
};
const envKeys = (): Partial<Record<Provider, string | undefined>> => ({
  openai: process.env.OPENAI_API_KEY,
  gemini: process.env.GEMINI_API_KEY1 || process.env.GEMINI_API_KEY,
  anthropic: process.env.ANTHROPIC_API_KEY,
  azure_openai: process.env.AZURE_OPENAI_API_KEY,
  azure_claude: process.env.AZURE_CLAUDE_API_KEY || process.env.AZURE_ANTHROPIC_API_KEY,
});
const envEndpoints = (): Partial<Record<Provider, string | undefined>> => ({
  azure_openai: process.env.AZURE_OPENAI_ENDPOINT,
  azure_claude: process.env.AZURE_CLAUDE_ENDPOINT || process.env.AZURE_ANTHROPIC_ENDPOINT,
});
const envApiVersions = (): Partial<Record<Provider, string | undefined>> => ({
  azure_openai: process.env.AZURE_OPENAI_API_VERSION,
});
const defaults = () => ({
  openai: process.env.OPENAI_MODEL || defaultModels.openai,
  gemini: process.env.GEMINI_MODEL || defaultModels.gemini,
  anthropic: process.env.ANTHROPIC_MODEL || defaultModels.anthropic,
  azure_openai: process.env.AZURE_OPENAI_DEPLOYMENT || process.env.AZURE_OPENAI_MODEL || defaultModels.azure_openai,
  azure_claude: process.env.AZURE_CLAUDE_MODEL || process.env.AZURE_ANTHROPIC_MODEL || defaultModels.azure_claude,
});

export function normalizeEndpoint(raw: string) {
  return raw.trim().replace(/\/+$/, '');
}

export function isValidHttpsEndpoint(value: string) {
  try {
    const u = new URL(value);
    return u.protocol === 'https:' && !!u.hostname;
  } catch {
    return false;
  }
}

function readSaved(): Saved {
  if (editable && existsSync(settingsFile)) {
    const [iv, tag, payload] = readFileSync(settingsFile, 'utf8').split('.').map(v => Buffer.from(v, 'base64'));
    const decipher = createDecipheriv('aes-256-gcm', readFileSync(masterFile), iv);
    decipher.setAuthTag(tag);
    const parsed = JSON.parse(Buffer.concat([decipher.update(payload), decipher.final()]).toString('utf8'));
    return {
      companyName: parsed.companyName || 'Doc.AI',
      provider: isProvider(parsed.provider) ? parsed.provider : 'gemini',
      models: parsed.models || {},
      keys: parsed.keys || {},
      endpoints: parsed.endpoints || {},
      apiVersions: parsed.apiVersions || {},
    };
  }
  const keys = envKeys();
  return {
    companyName: process.env.COMPANY_NAME || 'Doc.AI',
    provider: isProvider(process.env.AI_PROVIDER) ? process.env.AI_PROVIDER : providerIds.find(p => keys[p]) || 'gemini',
    models: {},
    keys: {},
    endpoints: {},
    apiVersions: {},
  };
}
let saved = readSaved();

export function connection(provider: Provider = saved.provider) {
  const key = envKeys()[provider] || saved.keys[provider] || '';
  const endpoint = normalizeEndpoint(envEndpoints()[provider] || saved.endpoints[provider] || '');
  const apiVersion = (envApiVersions()[provider] || saved.apiVersions[provider] || (provider === 'azure_openai' ? '2024-08-01-preview' : '')).trim();
  const configured = needsEndpoint(provider) ? !!(key && endpoint) : !!key;
  return {
    provider,
    model: saved.models[provider] || defaults()[provider],
    key,
    endpoint,
    apiVersion,
    configured,
  };
}

export function publicSettings() {
  return {
    companyName: saved.companyName,
    provider: saved.provider,
    editable,
    recommendedModels,
    recommendedModelOptions,
    providers: providerIds.map(id => {
      const c = connection(id);
      return {
        id,
        model: c.model,
        endpoint: c.endpoint || undefined,
        apiVersion: id === 'azure_openai' ? c.apiVersion : undefined,
        needsEndpoint: needsEndpoint(id),
        configured: c.configured,
        source: envKeys()[id] ? 'environment' : saved.keys[id] ? 'local' : 'none',
        endpointSource: envEndpoints()[id] ? 'environment' : saved.endpoints[id] ? 'local' : 'none',
        recommendedModels: recommendedModels[id],
        recommendedModelOptions: recommendedModelOptions[id],
      };
    }),
  };
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
  if (!next.endpoints) next.endpoints = {};
  if (!next.apiVersions) next.apiVersions = {};
  if (input.provider !== undefined) {
    if (!isProvider(input.provider)) throw new Error('Невідомий AI-провайдер');
    next.provider = input.provider;
  }
  if (input.companyName !== undefined) {
    if (typeof input.companyName !== 'string' || !input.companyName.trim() || input.companyName.length > 80) throw new Error('Назва компанії: від 1 до 80 символів');
    next.companyName = input.companyName.trim();
  }
  if (input.connection !== undefined) {
    const { provider, key, model, endpoint, apiVersion, removeKey } = input.connection;
    if (!isProvider(provider)) throw new Error('Невідомий AI-провайдер');
    if (model !== undefined) {
      if (typeof model !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{1,119}$/.test(model)) throw new Error('Вкажіть коректний ідентифікатор моделі / deployment');
      next.models[provider] = model;
    }
    if (endpoint !== undefined) {
      if (!needsEndpoint(provider)) throw new Error('Endpoint потрібен лише для Azure-провайдерів');
      if (envEndpoints()[provider]) throw new Error('Endpoint задано на сервері. Змініть змінну середовища.');
      if (endpoint === '') {
        delete next.endpoints[provider];
      } else {
        if (typeof endpoint !== 'string' || !isValidHttpsEndpoint(normalizeEndpoint(endpoint))) {
          throw new Error('Endpoint: HTTPS URL ресурсу Azure, наприклад https://my-resource.openai.azure.com');
        }
        next.endpoints[provider] = normalizeEndpoint(endpoint);
      }
    }
    if (apiVersion !== undefined && provider === 'azure_openai') {
      if (envApiVersions()[provider]) throw new Error('API version задано на сервері.');
      if (typeof apiVersion !== 'string' || !/^[a-z0-9][a-z0-9._-]{2,40}$/i.test(apiVersion.trim())) {
        throw new Error('Некоректна Azure OpenAI API version');
      }
      next.apiVersions[provider] = apiVersion.trim();
    }
    if ((key || removeKey) && envKeys()[provider]) throw new Error('Цей ключ задано на сервері. Змініть змінну середовища.');
    if (key !== undefined && key !== '') {
      if (typeof key !== 'string' || key.trim().length < 12 || key.length > 4096 || /\s/.test(key.trim())) throw new Error('Перевірте API-ключ: він не має містити пробілів');
      next.keys[provider] = key.trim();
      const defaultConn = {
        key: envKeys()[next.provider] || next.keys[next.provider],
        endpoint: envEndpoints()[next.provider] || next.endpoints[next.provider],
      };
      const defaultOk = needsEndpoint(next.provider) ? !!(defaultConn.key && defaultConn.endpoint) : !!defaultConn.key;
      if (!defaultOk) next.provider = provider;
    }
    if (removeKey === true) {
      delete next.keys[provider];
      delete next.endpoints[provider];
      delete next.apiVersions[provider];
      if (next.provider === provider && !(envKeys()[provider])) {
        const fallback = providerIds.find(id => {
          const k = envKeys()[id] || next.keys[id];
          if (needsEndpoint(id)) return !!(k && (envEndpoints()[id] || next.endpoints[id]));
          return !!k;
        });
        if (fallback) next.provider = fallback;
      }
    }
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
