import './config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { accountingPrompt } from './schemas';

const filePath = path.resolve(process.env.LOCAL_DATA_PATH || '.data/docai.json');
const initial = {
  types: [
    { id: 1, name: 'Рахунок / Invoice', slug: 'invoice', prompt: accountingPrompt('invoice'), schema: 'invoice' },
    { id: 2, name: 'Акт виконаних робіт', slug: 'act', prompt: accountingPrompt('act'), schema: 'act' },
    { id: 3, name: 'Договір', slug: 'contract', prompt: 'Витягни сторони договору, предмет, дати, суму, валюту та ключові зобов’язання у JSON. Не вигадуй відсутні дані. Поверни тільки JSON.' },
  ],
  documents: [] as any[],
};

function load() {
  if (!existsSync(filePath)) return initial;
  try {
    const data = JSON.parse(readFileSync(filePath, 'utf8'));
    if (!Array.isArray(data.types)) data.types = initial.types;
    if (!Array.isArray(data.documents)) data.documents = [];
    // Ensure accounting templates exist for P0 demos.
    for (const seed of initial.types) {
      if (!data.types.some((t: any) => t.slug === seed.slug)) data.types.push({ ...seed, id: Math.max(Date.now(), ...data.types.map((t: any) => Number(t.id) || 0)) + 1 });
    }
    return data;
  } catch {
    return initial;
  }
}

export const localStore: { types: any[]; documents: any[] } = load();

let lastId = 0;
/** Monotonic numeric id: unique within the process, ordered like the legacy Date.now() ids. */
export function nextLocalId() {
  if (!lastId) {
    for (const row of [...localStore.types, ...localStore.documents]) {
      const n = Number(row?.id);
      if (Number.isFinite(n) && n > lastId) lastId = n;
    }
  }
  lastId = Math.max(Date.now(), lastId + 1);
  return lastId;
}
export function persistLocal() {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath + '.tmp', JSON.stringify(localStore, null, 2), { mode: 0o600 });
  renameSync(filePath + '.tmp', filePath);
}
