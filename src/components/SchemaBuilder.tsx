import React from 'react';
import { Plus, Trash2, Wand2 } from 'lucide-react';
import type { SchemaField } from './ReviewPanel';

export type TemplateSchema = { title?: string; fields: SchemaField[]; checks?: string[] };
export type SchemaValue = TemplateSchema | string | null | undefined;

const typeOptions = [
  { value: 'string', label: 'Текст' },
  { value: 'number', label: 'Число' },
  { value: 'boolean', label: 'Так/ні' },
  { value: 'object', label: 'Об’єкт' },
  { value: 'array', label: 'Список' },
];
const formatOptions = [
  { value: '', label: '—' },
  { value: 'date', label: 'Дата YYYY-MM-DD' },
  { value: 'money', label: 'Сума' },
  { value: 'currency', label: 'Валюта ISO' },
  { value: 'edrpou', label: 'ЄДРПОУ / РНОКПП' },
  { value: 'iban', label: 'IBAN' },
];

/** Guess field specs from the first JSON example inside a prompt ({"invoice_number":null,…}). */
export function fieldsFromPrompt(prompt: string): SchemaField[] {
  const start = prompt.indexOf('{');
  if (start < 0) return [];
  let depth = 0;
  for (let i = start; i < prompt.length; i++) {
    if (prompt[i] === '{') depth++;
    if (prompt[i] === '}' && --depth === 0) {
      try {
        const example = JSON.parse(prompt.slice(start, i + 1));
        return Object.entries(example).map(([path, v]) => guess(path, v));
      } catch { return []; }
    }
  }
  return [];
}

function guess(path: string, v: unknown): SchemaField {
  const p = path.toLowerCase();
  if (Array.isArray(v)) return { path, type: 'array', required: false };
  if (v && typeof v === 'object') return { path, type: 'object', required: false };
  if (/(^|_)(date|signed_at|due_date)$|_date$|^date/.test(p)) return { path, type: 'string', format: 'date', required: p === 'date' };
  if (/currency/.test(p)) return { path, type: 'string', format: 'currency', required: false };
  if (/edrpou|ipn|rnokpp|tax_id/.test(p)) return { path, type: 'string', format: 'edrpou', required: false };
  if (/iban/.test(p)) return { path, type: 'string', format: 'iban', required: false };
  if (/(total|amount|sum|price|vat|subtotal|balance)/.test(p)) return { path, type: 'number', format: 'money', required: p === 'total' };
  if (typeof v === 'number') return { path, type: 'number', required: false };
  if (typeof v === 'boolean') return { path, type: 'boolean', required: false };
  return { path, type: 'string', required: false };
}

export default function SchemaBuilder({ value, onChange, prompt, builtins, disabled }: {
  value: SchemaValue;
  onChange: (v: SchemaValue) => void;
  prompt: string;
  builtins: Record<string, TemplateSchema>;
  disabled?: boolean;
}) {
  const builtinName = typeof value === 'string' ? value : null;
  const schema = typeof value === 'object' && value ? value : null;
  const fields = schema?.fields || [];
  const setFields = (next: SchemaField[]) => onChange(next.length ? { ...(schema || {}), fields: next } : null);
  const patch = (i: number, p: Partial<SchemaField>) => setFields(fields.map((f, k) => (k === i ? { ...f, ...p } : f)));

  return (
    <div className="schema-builder">
      <div className="schema-head">
        <div>
          <strong>Схема перевірки</strong>
          <p>Обов’язкові поля й формати. Документ зі схемою проходить перевірку і чекає підтвердження людиною.</p>
        </div>
        <select aria-label="Тип схеми" disabled={disabled} value={builtinName ? `builtin:${builtinName}` : schema ? 'custom' : 'none'} onChange={e => {
          const v = e.target.value;
          if (v === 'none') onChange(null);
          else if (v === 'custom') onChange({ fields: fields.length ? fields : fieldsFromPrompt(prompt) });
          else onChange(v.slice('builtin:'.length));
        }}>
          <option value="none">Без схеми (лише результат)</option>
          {Object.entries(builtins).map(([k, s]) => <option key={k} value={`builtin:${k}`}>Вбудована: {s.title || k}</option>)}
          <option value="custom">Власні поля</option>
        </select>
      </div>
      {builtinName && builtins[builtinName] && (
        <p className="schema-note">
          Поля: {builtins[builtinName].fields.map(f => f.path).join(', ')}. Також перевіряються сума рядків, ПДВ, ЄДРПОУ та IBAN.{' '}
          <button type="button" className="text-button" disabled={disabled} onClick={() => onChange({ fields: builtins[builtinName].fields, checks: builtins[builtinName].checks })}>Налаштувати вручну</button>
        </p>
      )}
      {schema && (
        <>
          <div className="schema-rows">
            {fields.map((f, i) => (
              <div className="schema-row" key={i}>
                <input aria-label={`Шлях поля ${i + 1}`} placeholder="total або supplier.name" value={f.path} disabled={disabled} onChange={e => patch(i, { path: e.target.value.replace(/[^\w.]/g, '') })} />
                <input aria-label={`Назва поля ${i + 1}`} placeholder="Назва для людини" value={f.label || ''} disabled={disabled} onChange={e => patch(i, { label: e.target.value })} />
                <select aria-label={`Тип поля ${i + 1}`} value={f.type || 'string'} disabled={disabled} onChange={e => patch(i, { type: e.target.value })}>{typeOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                <select aria-label={`Формат поля ${i + 1}`} value={f.format || ''} disabled={disabled} onChange={e => patch(i, { format: e.target.value || undefined })}>{formatOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}</select>
                <label className="schema-required"><input type="checkbox" checked={!!f.required} disabled={disabled} onChange={e => patch(i, { required: e.target.checked })} /> Обов’язкове</label>
                <button type="button" className="icon-button" aria-label={`Видалити поле ${i + 1}`} disabled={disabled} onClick={() => setFields(fields.filter((_, k) => k !== i))}><Trash2 size={14} /></button>
              </div>
            ))}
          </div>
          <div className="button-group">
            <button type="button" className="secondary-button" disabled={disabled} onClick={() => setFields([...fields, { path: '', type: 'string', required: false }])}><Plus size={14} /> Поле</button>
            <button type="button" className="secondary-button" disabled={disabled || !prompt.includes('{')} onClick={() => {
              const guessed = fieldsFromPrompt(prompt).filter(g => !fields.some(f => f.path === g.path));
              setFields([...fields, ...guessed]);
            }}><Wand2 size={14} /> Поля з прикладу JSON у промпті</button>
            <label className="schema-required"><input type="checkbox" disabled={disabled} checked={!!schema.checks?.includes('invoice-totals')} onChange={e => onChange({ ...schema, checks: e.target.checked ? ['invoice-totals'] : undefined })} /> Звіряти суму рядків items з total</label>
          </div>
        </>
      )}
    </div>
  );
}
