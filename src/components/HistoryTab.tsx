import React, { useState } from 'react';
import { Download, FileSpreadsheet, RotateCcw, Search } from 'lucide-react';
import { cn } from '../lib/utils';
import { fileIcon, statusLabel } from '../lib/ui';
import { exportRegisterCsv, exportRegisterXlsx } from '../lib/export';
import ReviewPanel, { type ReviewDoc, type SchemaField } from './ReviewPanel';
import type { TemplateSchema } from './SchemaBuilder';
import type { DocumentType } from './TemplatesTab';

export type DocumentRecord = ReviewDoc & { filename?: string };

const API_BASE = '';

/** Legacy records have no status: an AI error payload means failed, anything else was a finished result. */
export function normalizedStatus(doc: DocumentRecord) {
  return doc.status || (doc.extractedData?.status === 'failed' ? 'failed' : 'completed');
}

export default function HistoryTab({ documents, setDocuments, fetchDocuments, documentTypes, builtinSchemas, canOperate, guard, setError, setNotice }: {
  documents: DocumentRecord[];
  setDocuments: React.Dispatch<React.SetStateAction<DocumentRecord[]>>;
  fetchDocuments: () => Promise<void>;
  documentTypes: DocumentType[];
  builtinSchemas: Record<string, TemplateSchema>;
  canOperate: boolean;
  guard: (res: Response) => Promise<Response>;
  setError: (message: string | null) => void;
  setNotice: (message: string) => void;
}) {
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [search, setSearch] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const filteredDocuments = documents.filter(doc =>
    `${doc.originalName} ${doc.typeSlug} ${doc.id}`.toLowerCase().includes(search.toLowerCase()) &&
    (!statusFilter || normalizedStatus(doc) === statusFilter));
  const schemaFieldsFor = (doc: DocumentRecord): SchemaField[] | null => {
    const schema = documentTypes.find(t => t.slug === doc.typeSlug)?.schema;
    if (schema && typeof schema === 'object') return schema.fields;
    const builtin = builtinSchemas[typeof schema === 'string' ? schema : doc.typeSlug];
    return builtin ? builtin.fields : null;
  };

  const reviewDocument = async (doc: ReviewDoc, action: 'approve' | 'reject') => {
    try {
      const res = await guard(await fetch(`${API_BASE}/api/documents/${doc.id}/review`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      }));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не вдалося оновити статус');
      setSelectedDoc(data);
      setDocuments(prev => prev.map(d => (d.id === data.id ? data : d)));
      setNotice(action === 'approve' ? 'Документ підтверджено' : 'Документ відхилено');
      
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Помилка підтвердження');
    }
  };

  return (
    <div className="history-page">
      <div className="mb-4">
        <h2 className="text-2xl font-semibold mb-1">Історія та перевірка</h2>
        <p className="text-gray-500 text-sm">Звірте поля з оригіналом, виправте помилки й підтвердьте перед передачею в облік чи CRM.</p>
      </div>

      <div className="history-toolbar">
        <label><Search size={18}/><input aria-label="Пошук документів" placeholder="Пошук за назвою, шаблоном або ID…" value={search} onChange={e => setSearch(e.target.value)}/></label>
        <select aria-label="Фільтр за статусом" className="status-filter" value={statusFilter} onChange={e => setStatusFilter(e.target.value)}>
          <option value="">Усі статуси</option>
          {['pending_review', 'invalid', 'approved', 'rejected', 'completed', 'failed'].map(st => <option key={st} value={st}>{statusLabel(st).text}</option>)}
        </select>
        <button onClick={fetchDocuments}><RotateCcw size={16}/> Оновити</button>
        <button disabled={!filteredDocuments.length} onClick={() => exportRegisterXlsx(filteredDocuments).catch(() => setError('Не вдалося сформувати Excel'))} title="Реєстр відфільтрованих документів: аркуші «Документи» і «Рядки»"><FileSpreadsheet size={16}/> Excel</button>
        <button disabled={!filteredDocuments.length} onClick={() => exportRegisterCsv(filteredDocuments)} title="CSV з роздільником «;» для імпорту в 1С / BAS / M.E.Doc"><Download size={16}/> CSV</button>
      </div>
      <div className="history-panel">
        <div className="history-list">
          {filteredDocuments.length === 0 ? (
            <div className="p-6 text-center text-sm text-gray-500">
              {search || statusFilter ? "Нічого не знайдено" : "Оброблені документи з’являться тут."}
            </div>
          ) : (
            <ul className="divide-y divide-gray-100">
              {filteredDocuments.map((doc) => (
                <li key={doc.id}>
                  <button
                    onClick={() => setSelectedDoc(doc)}
                    aria-current={selectedDoc?.id === doc.id}
                    className={cn(
                      "w-full text-left p-4 hover:bg-gray-50 transition-colors flex flex-col gap-1",
                      selectedDoc?.id === doc.id ? "bg-indigo-50/50 border-l-2 border-indigo-500" : "border-l-2 border-transparent"
                    )}
                  >
                    <div className="flex items-center gap-2">
                      {fileIcon(doc.mimeType)}
                      <span className="font-medium text-sm text-gray-900 truncate">{doc.originalName}</span>
                    </div>
                    <div className="flex items-center justify-between pl-7 mt-1 gap-2">
                      <span className="text-xs text-gray-500">
                        {new Date(doc.createdAt).toLocaleString('uk-UA')}
                      </span>
                      <span className={cn('text-[10px] font-medium px-1.5 py-0.5 rounded', statusLabel(normalizedStatus(doc)).className)}>
                        {statusLabel(normalizedStatus(doc)).text}
                      </span>
                    </div>
                    <div className="pl-7 mt-1 flex gap-2 items-center">
                      <span className="text-[10px] font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                        {doc.typeSlug}
                      </span>
                      {doc.editedBy && <span className="text-[10px] text-gray-500">виправлено</span>}
                    </div>
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>

        <div className="history-detail">
          {selectedDoc ? (
            <ReviewPanel
              doc={{ ...selectedDoc, status: normalizedStatus(selectedDoc) }}
              schemaFields={schemaFieldsFor(selectedDoc)}
              canOperate={canOperate}
              statusLabel={statusLabel}
              guard={guard}
              onSaved={(updated) => { setSelectedDoc(updated as DocumentRecord); setDocuments(prev => prev.map(d => (d.id === updated.id ? updated as DocumentRecord : d))); }}
              onReview={reviewDocument}
              onError={setError}
              onNotice={setNotice}
            />
          ) : (
            <div className="h-full flex items-center justify-center text-gray-500 text-sm p-8 text-center">
              Виберіть документ зліва, щоб звірити поля з оригіналом.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
