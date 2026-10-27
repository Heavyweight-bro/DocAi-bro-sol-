/** Path helpers for editing extracted JSON: "items[0].amount" ⇄ ['items', 0, 'amount']. */
export type PathPart = string | number;

export function parsePath(path: string): PathPart[] {
  const parts: PathPart[] = [];
  for (const m of path.matchAll(/([^.[\]]+)|\[(\d+)\]/g)) parts.push(m[2] !== undefined ? Number(m[2]) : m[1]);
  return parts;
}

export function formatPath(parts: PathPart[]) {
  return parts.reduce<string>((acc, p) => (typeof p === 'number' ? `${acc}[${p}]` : acc ? `${acc}.${p}` : p), '');
}

export function getIn(data: any, parts: PathPart[]) {
  return parts.reduce((acc, key) => (acc == null ? undefined : acc[key as any]), data);
}

/** Returns a new root with the value set (creates intermediate objects/arrays). */
export function setIn(root: any, parts: PathPart[], value: unknown) {
  const next = structuredClone(root ?? {});
  let cur = next;
  parts.forEach((key, i) => {
    if (i === parts.length - 1) { cur[key as any] = value; return; }
    if (cur[key as any] == null || typeof cur[key as any] !== 'object') cur[key as any] = typeof parts[i + 1] === 'number' ? [] : {};
    cur = cur[key as any];
  });
  return next;
}

export type FieldHint = { type?: string; format?: string; label?: string; required?: boolean };

/** Convert text typed by a person into the JSON type the field expects. */
export function coerceInput(raw: string, previous: unknown, hint?: FieldHint): unknown {
  const text = raw.trim();
  if (text === '') return null;
  const wantsNumber = typeof previous === 'number' || hint?.type === 'number' || hint?.format === 'money';
  if (wantsNumber) {
    const normalized = text.replace(/\s+/g, '').replace(',', '.');
    const n = Number(normalized);
    return Number.isFinite(n) && normalized !== '' ? n : raw;
  }
  if (typeof previous === 'boolean' || hint?.type === 'boolean') return text === 'true' ? true : text === 'false' ? false : raw;
  return raw;
}

export const isPlainObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
export const isScalar = (v: unknown) => v == null || ['string', 'number', 'boolean'].includes(typeof v);

/** Flatten nested objects into dotted keys; arrays of objects are returned separately as tables. */
export function flattenForExport(data: unknown, prefix = '', out: Record<string, unknown> = {}, tables: Record<string, Record<string, unknown>[]> = {}) {
  if (isPlainObject(data)) {
    for (const [k, v] of Object.entries(data)) {
      if (k.startsWith('_')) continue; // internal metadata
      const key = prefix ? `${prefix}.${k}` : k;
      if (Array.isArray(v)) {
        if (v.every(isPlainObject)) tables[key] = v.map((row) => flattenForExport(row).row);
        else out[key] = v.map((x) => (isScalar(x) ? x : JSON.stringify(x))).join('; ');
      } else if (isPlainObject(v)) flattenForExport(v, key, out, tables);
      else out[key] = v;
    }
  } else if (prefix) out[prefix] = data;
  return { row: out, tables };
}
