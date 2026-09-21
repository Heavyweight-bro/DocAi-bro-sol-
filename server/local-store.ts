import './config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const filePath = path.resolve(process.env.LOCAL_DATA_PATH || '.data/docai.json');
const initial = { types: [
  { id: 1, name: 'Рахунок / Invoice', slug: 'invoice', prompt: 'Витягни номер рахунку, дату, постачальника, покупця, валюту, позиції та загальну суму. Поверни JSON. Відсутні значення познач null.' },
  { id: 2, name: 'Договір', slug: 'contract', prompt: 'Витягни сторони договору, предмет, дати, суму, валюту та ключові зобов’язання у JSON. Не вигадуй відсутні дані.' }
], documents: [] as any[] };
export const localStore: { types: any[]; documents: any[] } = existsSync(filePath)
  ? JSON.parse(readFileSync(filePath, 'utf8')) : initial;
export function persistLocal() {
  mkdirSync(path.dirname(filePath), { recursive: true });
  writeFileSync(filePath + '.tmp', JSON.stringify(localStore, null, 2), { mode: 0o600 });
  renameSync(filePath + '.tmp', filePath);
}
