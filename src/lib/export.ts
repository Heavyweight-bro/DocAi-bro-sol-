import { flattenForExport } from './fields';

export type ExportDoc = {
  id: number | string;
  originalName: string;
  typeSlug: string;
  status?: string;
  createdAt: string;
  extractedData: any;
};

const statusText: Record<string, string> = {
  pending_review: 'На перевірці', invalid: 'Схема не пройдена', approved: 'Підтверджено',
  rejected: 'Відхилено', failed: 'Помилка AI', completed: 'Готово',
};

function download(blob: Blob, name: string) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = name; a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const baseName = (name: string) => name.replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_') || 'document';
const safeSheet = (name: string, used: Set<string>) => {
  let n = name.replace(/[\\/?*[\]:]/g, '_').slice(0, 28) || 'Лист';
  let i = 2;
  while (used.has(n)) n = `${n.slice(0, 25)}_${i++}`;
  used.add(n);
  return n;
};

function meta(doc: ExportDoc) {
  return {
    'ID': doc.id, 'Файл': doc.originalName, 'Шаблон': doc.typeSlug,
    'Статус': statusText[doc.status || ''] || doc.status || '', 'Створено': new Date(doc.createdAt).toLocaleString('uk-UA'),
  };
}

/** One document: sheet "Поля" (field / value) + one sheet per list (items, services…). */
export async function exportDocumentXlsx(doc: ExportDoc) {
  const XLSX = await import('xlsx');
  const wb = XLSX.utils.book_new();
  const used = new Set<string>();
  const data = doc.extractedData;
  if (data?.format === 'text') {
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['Текст'], [data.content]]), safeSheet('Текст', used));
  } else {
    const { row, tables } = flattenForExport(data);
    const fields = [...Object.entries(meta(doc)), ...Object.entries(row)].map(([k, v]) => ({ 'Поле': k, 'Значення': v as any }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(fields), safeSheet('Поля', used));
    for (const [name, rows] of Object.entries(tables)) {
      XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows.map((r, i) => ({ '№': i + 1, ...r }))), safeSheet(name, used));
    }
  }
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${baseName(doc.originalName)}.xlsx`);
}

function registerRows(docs: ExportDoc[]) {
  const rows: Record<string, unknown>[] = [];
  const lines: Record<string, unknown>[] = [];
  for (const doc of docs) {
    const data = doc.extractedData;
    if (data?.format === 'text') { rows.push({ ...meta(doc), 'Текст': String(data.content).slice(0, 32000) }); continue; }
    const { row, tables } = flattenForExport(data);
    rows.push({ ...meta(doc), ...row });
    for (const [table, items] of Object.entries(tables)) {
      items.forEach((item, i) => lines.push({ 'ID документа': doc.id, 'Файл': doc.originalName, 'Список': table, '№': i + 1, ...item }));
    }
  }
  return { rows, lines };
}

/** Register of many documents: "Документи" (one row each) + "Рядки" (all line items). */
export async function exportRegisterXlsx(docs: ExportDoc[], name = 'docai-register') {
  const XLSX = await import('xlsx');
  const { rows, lines } = registerRows(docs);
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(rows), 'Документи');
  if (lines.length) XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(lines), 'Рядки');
  const out = XLSX.write(wb, { type: 'array', bookType: 'xlsx' });
  download(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }), `${name}.xlsx`);
}

/**
 * CSV for 1С / BAS / M.E.Doc imports: UTF-8 with BOM, ";" separator, decimal comma, one row per line item
 * (documents without lines get one row). Column names are the JSON field paths.
 */
export function exportRegisterCsv(docs: ExportDoc[], name = 'docai-register') {
  const { rows, lines } = registerRows(docs);
  const byDoc = new Map<unknown, Record<string, unknown>[]>();
  for (const l of lines) byDoc.set(l['ID документа'], [...(byDoc.get(l['ID документа']) || []), l]);
  const flat: Record<string, unknown>[] = [];
  for (const r of rows) {
    const items = byDoc.get(r['ID']);
    if (!items?.length) { flat.push(r); continue; }
    for (const it of items) {
      const { 'ID документа': _id, 'Файл': _f, ...line } = it;
      flat.push({ ...r, ...Object.fromEntries(Object.entries(line).map(([k, v]) => [`рядок.${k}`, v])) });
    }
  }
  const columns = [...new Set(flat.flatMap((r) => Object.keys(r)))];
  const cell = (v: unknown) => {
    if (v == null) return '';
    const s = typeof v === 'number' ? String(v).replace('.', ',') : String(v);
    return /[";\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  const csv = [columns.map(cell).join(';'), ...flat.map((r) => columns.map((c) => cell(r[c])).join(';'))].join('\r\n');
  download(new Blob(['﻿' + csv], { type: 'text/csv;charset=utf-8' }), `${name}.csv`);
}

export function exportJson(value: unknown, name: string) {
  const text = !!value && typeof value === 'object' && (value as any).format === 'text' && typeof (value as any).content === 'string';
  const blob = text
    ? new Blob([(value as any).content], { type: 'text/plain;charset=utf-8' })
    : new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' });
  download(blob, baseName(name) + (text ? '.txt' : '.json'));
}
