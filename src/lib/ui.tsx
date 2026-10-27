import React from 'react';
import { File, FileSpreadsheet, FileText, Image as ImageIcon } from 'lucide-react';

export function statusLabel(status?: string) {
  switch (status) {
    case 'pending_review': return { text: 'На перевірці', className: 'bg-amber-100 text-amber-800' };
    case 'invalid': return { text: 'Схема не пройдена', className: 'bg-red-100 text-red-700' };
    case 'approved': return { text: 'Підтверджено', className: 'bg-emerald-100 text-emerald-800' };
    case 'rejected': return { text: 'Відхилено', className: 'bg-slate-200 text-slate-700' };
    case 'failed': return { text: 'Помилка AI', className: 'bg-red-100 text-red-700' };
    case 'completed': return { text: 'Готово', className: 'bg-indigo-100 text-indigo-800' };
    default: return { text: status || '—', className: 'bg-gray-100 text-gray-600' };
  }
}

export function fileIcon(mimeType: string) {
  if (mimeType.includes('pdf')) return <FileText className="w-5 h-5 text-red-500" />;
  if (mimeType.includes('word') || mimeType.includes('document')) return <FileText className="w-5 h-5 text-blue-500" />;
  if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return <FileSpreadsheet className="w-5 h-5 text-green-500" />;
  if (mimeType.includes('image')) return <ImageIcon className="w-5 h-5 text-purple-500" />;
  return <File className="w-5 h-5 text-gray-500" />;
}

export const isTextResult = (value: unknown): value is { format: 'text'; content: string } =>
  !!value && typeof value === 'object' && (value as any).format === 'text' && typeof (value as any).content === 'string';

export const resultBody = (value: unknown) => (isTextResult(value) ? value.content : JSON.stringify(value, null, 2));
