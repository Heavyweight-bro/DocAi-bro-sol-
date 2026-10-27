/** Accounting schemas: built-in (invoice/act) and custom per-template field lists, plus cross-field checks. */

export type ValidationIssue = { path: string; message: string; severity?: 'error' | 'warning' };

export const fieldTypes = ['string', 'number', 'boolean', 'object', 'array'] as const;
export const fieldFormats = ['date', 'money', 'currency', 'edrpou', 'iban'] as const;
export type FieldSpec = {
  path: string;
  required?: boolean;
  type?: typeof fieldTypes[number];
  format?: typeof fieldFormats[number];
  label?: string;
};
export type TemplateSchema = { title?: string; fields: FieldSpec[]; checks?: ('invoice-totals' | 'act-totals')[] };

const invoiceFields: FieldSpec[] = [
  { path: 'invoice_number', required: true, type: 'string', label: 'Номер рахунку' },
  { path: 'date', required: true, type: 'string', format: 'date', label: 'Дата' },
  { path: 'supplier', required: true, type: 'object', label: 'Постачальник' },
  { path: 'supplier.edrpou', type: 'string', format: 'edrpou', label: 'ЄДРПОУ постачальника' },
  { path: 'supplier.iban', type: 'string', format: 'iban', label: 'IBAN постачальника' },
  { path: 'customer', required: true, type: 'object', label: 'Покупець' },
  { path: 'customer.edrpou', type: 'string', format: 'edrpou', label: 'ЄДРПОУ покупця' },
  { path: 'currency', required: true, type: 'string', format: 'currency', label: 'Валюта' },
  { path: 'total', required: true, type: 'number', format: 'money', label: 'Сума' },
  { path: 'items', required: true, type: 'array', label: 'Позиції' },
];

const actFields: FieldSpec[] = [
  { path: 'act_number', required: true, type: 'string', label: 'Номер акта' },
  { path: 'date', required: true, type: 'string', format: 'date', label: 'Дата' },
  { path: 'contractor', required: true, type: 'string', label: 'Виконавець' },
  { path: 'customer', required: true, type: 'string', label: 'Замовник' },
  { path: 'currency', required: true, type: 'string', format: 'currency', label: 'Валюта' },
  { path: 'total', required: true, type: 'number', format: 'money', label: 'Сума' },
  { path: 'services', required: true, type: 'array', label: 'Послуги' },
];

export const accountingSchemas: Record<string, TemplateSchema> = {
  invoice: { title: 'Рахунок / Invoice', fields: invoiceFields, checks: ['invoice-totals'] },
  act: { title: 'Акт виконаних робіт', fields: actFields, checks: ['act-totals'] },
};

/**
 * Resolve the schema for a document.
 * - template.schema as object → custom fields defined in the template editor
 * - template.schema as string ('invoice' | 'act') → built-in
 * - otherwise built-in by slug (invoice / act / act-of-works)
 */
export function schemaForSlug(slug?: string, templateSchema?: unknown): TemplateSchema | null {
  if (templateSchema && typeof templateSchema === 'object' && Array.isArray((templateSchema as any).fields) && (templateSchema as any).fields.length) {
    return templateSchema as TemplateSchema;
  }
  if (typeof templateSchema === 'string' && accountingSchemas[templateSchema]) return accountingSchemas[templateSchema];
  if (!slug || slug === 'custom') return null;
  if (accountingSchemas[slug]) return accountingSchemas[slug];
  if (slug === 'act-of-works' || slug === 'act-works') return accountingSchemas.act;
  return null;
}

/** Validate a user-submitted template schema (from the template editor). Returns a normalized copy. */
export function normalizeTemplateSchema(input: unknown): TemplateSchema | string | null {
  if (input == null || input === '') return null;
  if (typeof input === 'string') {
    // Keep the reference so the template follows future improvements of the built-in schema.
    if (accountingSchemas[input]) return input;
    throw Object.assign(new Error('Невідома вбудована схема'), { status: 400 });
  }
  const fields = (input as any)?.fields;
  if (!Array.isArray(fields)) throw Object.assign(new Error('Схема: очікується список полів'), { status: 400 });
  if (fields.length > 80) throw Object.assign(new Error('Схема: не більше 80 полів'), { status: 400 });
  const seen = new Set<string>();
  const normalized: FieldSpec[] = fields.map((f: any, i: number) => {
    const path = typeof f?.path === 'string' ? f.path.trim() : '';
    if (!/^[A-Za-z_][\w]*(\.[A-Za-z_][\w]*){0,4}$/.test(path)) throw Object.assign(new Error(`Поле №${i + 1}: шлях латиницею, напр. total або supplier.name`), { status: 400 });
    if (seen.has(path)) throw Object.assign(new Error(`Поле «${path}» повторюється`), { status: 400 });
    seen.add(path);
    const type = fieldTypes.includes(f.type) ? f.type : 'string';
    const format = fieldFormats.includes(f.format) ? f.format : undefined;
    return { path, type, format, required: !!f.required, label: typeof f.label === 'string' ? f.label.slice(0, 80) : undefined };
  });
  if (!normalized.length) return null;
  const checks = Array.isArray((input as any).checks) ? (input as any).checks.filter((c: string) => c === 'invoice-totals' || c === 'act-totals') : undefined;
  return { fields: normalized, checks: checks?.length ? checks : undefined };
}

function getPath(data: any, path: string) {
  return path.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), data);
}

function isDate(value: unknown) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function isMoney(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value);
}

function isCurrency(value: unknown) {
  return typeof value === 'string' && /^[A-Z]{3}$/.test(value);
}

/** ЄДРПОУ (8 digits, legal entities) — official two-pass weighted checksum. */
export function isValidEdrpou(code: string) {
  if (!/^\d{8}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const inRange = Number(code) < 30_000_000 || Number(code) > 60_000_000;
  const w1 = inRange ? [1, 2, 3, 4, 5, 6, 7] : [7, 1, 2, 3, 4, 5, 6];
  let sum = w1.reduce((acc, w, i) => acc + w * d[i], 0);
  let check = sum % 11;
  if (check >= 10) {
    const w2 = w1.map((w) => w + 2);
    sum = w2.reduce((acc, w, i) => acc + w * d[i], 0);
    check = sum % 11;
    if (check >= 10) check = 0;
  }
  return check === d[7];
}

/** РНОКПП / ІПН (10 digits, individuals incl. ФОП). */
export function isValidRnokpp(code: string) {
  if (!/^\d{10}$/.test(code)) return false;
  const d = code.split('').map(Number);
  const w = [-1, 5, 7, 9, 4, 6, 10, 5, 7];
  const sum = w.reduce((acc, k, i) => acc + k * d[i], 0);
  return ((sum % 11) % 10) === d[9];
}

/** IBAN mod-97 (ISO 13616); Ukrainian IBANs are UA + 27 characters. */
export function isValidIban(raw: string) {
  const iban = raw.replace(/\s+/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{10,30}$/.test(iban)) return false;
  if (iban.startsWith('UA') && iban.length !== 29) return false;
  const rearranged = iban.slice(4) + iban.slice(0, 4);
  let remainder = 0;
  for (const ch of rearranged) {
    const n = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const digit of n) remainder = (remainder * 10 + Number(digit)) % 97;
  }
  return remainder === 1;
}

const num = (v: unknown) => (typeof v === 'number' && Number.isFinite(v) ? v : typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v.replace(',', '.'))) ? Number(v.replace(',', '.')) : null);
const close = (a: number, b: number, tolerance = 0.02) => Math.abs(a - b) <= Math.max(tolerance, Math.abs(b) * 0.0005);
const round2 = (n: number) => Math.round(n * 100) / 100;

/** Cross-field accounting checks: line math, sum of lines vs total, VAT consistency. */
function totalsChecks(data: any, linesKey: 'items' | 'services', priceKeys: string[]): ValidationIssue[] {
  const issues: ValidationIssue[] = [];
  const lines = Array.isArray(data?.[linesKey]) ? data[linesKey] : [];
  let sum = 0;
  let counted = 0;
  lines.forEach((line: any, i: number) => {
    const qty = num(line?.quantity);
    const price = priceKeys.map((k) => num(line?.[k])).find((v) => v != null) ?? null;
    const amount = num(line?.amount);
    if (qty != null && price != null && amount != null && !close(qty * price, amount)) {
      issues.push({ path: `${linesKey}[${i}].amount`, severity: 'warning', message: `Рядок ${i + 1}: ${qty} × ${price} = ${round2(qty * price)}, а вказано ${amount}` });
    }
    const effective = amount ?? (qty != null && price != null ? qty * price : null);
    if (effective != null) { sum += effective; counted += 1; }
  });
  const total = num(data?.total);
  const vat = num(data?.vat ?? data?.vat_amount);
  const subtotal = num(data?.subtotal ?? data?.total_without_vat);
  if (total != null && counted && counted === lines.length) {
    const matches = close(sum, total) || (vat != null && close(sum + vat, total));
    if (!matches) {
      issues.push({ path: 'total', severity: 'error', message: `Сума рядків ${round2(sum)}${vat != null ? ` (+ ПДВ ${vat})` : ''} не дорівнює підсумку ${total}` });
    }
  }
  if (total != null && subtotal != null && vat != null && !close(subtotal + vat, total)) {
    issues.push({ path: 'total', severity: 'error', message: `Без ПДВ ${subtotal} + ПДВ ${vat} ≠ підсумок ${total}` });
  }
  if (subtotal != null && vat != null && vat > 0) {
    const rate = vat / subtotal;
    if (![0.2, 0.14, 0.07].some((r) => Math.abs(rate - r) < 0.002)) {
      issues.push({ path: 'vat', severity: 'warning', message: `ПДВ ${vat} становить ${round2(rate * 100)}% — не 20%, 14% чи 7%. Перевірте ставку` });
    }
  }
  return issues;
}

export function validateAgainstSchema(data: unknown, slug?: string, templateSchema?: unknown): { ok: boolean; errors: ValidationIssue[] } {
  const schema = schemaForSlug(slug, templateSchema);
  if (!schema) return { ok: true, errors: [] };
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    return { ok: false, errors: [{ path: '', message: 'Очікується JSON-об’єкт із полями шаблону', severity: 'error' }] };
  }
  if ((data as any).format === 'text') {
    return { ok: false, errors: [{ path: 'format', message: 'Шаблон обліку вимагає JSON, а не текст', severity: 'error' }] };
  }

  const errors: ValidationIssue[] = [];
  const err = (path: string, message: string) => errors.push({ path, message, severity: 'error' });
  for (const field of schema.fields) {
    const value = getPath(data, field.path);
    const name = field.label ? `${field.label} (${field.path})` : field.path;
    if (value == null || value === '') {
      if (field.required) err(field.path, `Обов’язкове поле «${name}» відсутнє або порожнє`);
      continue;
    }
    if (field.type === 'string' && typeof value !== 'string') err(field.path, `«${name}» має бути рядком`);
    if (field.type === 'number' && typeof value !== 'number') err(field.path, `«${name}» має бути числом`);
    if (field.type === 'boolean' && typeof value !== 'boolean') err(field.path, `«${name}» має бути так/ні`);
    if (field.type === 'object' && (typeof value !== 'object' || Array.isArray(value))) err(field.path, `«${name}» має бути об’єктом`);
    if (field.type === 'array' && !Array.isArray(value)) err(field.path, `«${name}» має бути списком`);
    if (field.type === 'array' && Array.isArray(value) && value.length === 0 && field.required) err(field.path, `«${name}» не може бути порожнім`);
    if (field.format === 'date' && !isDate(value)) err(field.path, `«${name}» очікує дату YYYY-MM-DD`);
    if (field.format === 'money' && !isMoney(value) && !(field.type === 'number' && typeof value !== 'number')) err(field.path, `«${name}» очікує число (суму)`);
    if (field.format === 'currency' && !isCurrency(value)) err(field.path, `«${name}» очікує код валюти ISO (UAH, EUR, USD)`);
    if (field.format === 'edrpou') {
      const code = String(value).replace(/\s+/g, '');
      if (!(isValidEdrpou(code) || isValidRnokpp(code))) err(field.path, `«${name}»: ${code} — некоректний ЄДРПОУ/РНОКПП (контрольна сума)`);
    }
    if (field.format === 'iban' && !isValidIban(String(value))) err(field.path, `«${name}»: некоректний IBAN (контрольна сума або довжина)`);
  }
  for (const check of schema.checks || []) {
    if (check === 'invoice-totals') errors.push(...totalsChecks(data, 'items', ['unit_price', 'price']));
    if (check === 'act-totals') errors.push(...totalsChecks(data, 'services', ['price', 'unit_price']));
  }
  return { ok: !errors.some((e) => e.severity !== 'warning'), errors };
}

export function accountingPrompt(slug: 'invoice' | 'act') {
  if (slug === 'invoice') {
    return `Оброби рахунок (invoice) та поверни один JSON-об’єкт за структурою:
{"invoice_number":null,"date":null,"due_date":null,"supplier":{"name":null,"edrpou":null,"iban":null},"customer":{"name":null,"edrpou":null},"currency":null,"items":[{"description":null,"quantity":null,"unit_price":null,"amount":null}],"subtotal":null,"vat":null,"total":null}
Дати — YYYY-MM-DD. Суми — числа. Валюта — ISO (UAH/EUR/USD). ЄДРПОУ та IBAN — лише цифри/символи без пробілів. Відсутнє — null. Поверни тільки JSON.`;
  }
  return `Оброби акт виконаних робіт і поверни JSON:
{"act_number":null,"date":null,"contractor":null,"customer":null,"currency":null,"services":[{"description":null,"quantity":null,"price":null,"amount":null}],"subtotal":null,"vat":null,"total":null}
Дати — YYYY-MM-DD, суми — числа, валюта ISO. Поверни тільки JSON.`;
}
