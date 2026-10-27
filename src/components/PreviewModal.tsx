import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, File as FileGlyph, History, Loader2, X } from 'lucide-react';
import { cn } from '../lib/utils';
import { fileIcon, resultBody, statusLabel } from '../lib/ui';
import type { ReviewDoc } from './ReviewPanel';

export type QueueItem = {
  id: string;
  file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
  result?: ReviewDoc;
};

/** Local file (before/after processing) next to the extraction result. */
export default function PreviewModal({ item, onClose }: { item: QueueItem; onClose: () => void }) {
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  useEffect(() => {
    const url = URL.createObjectURL(item.file);
    setPreviewUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [item.id]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  return (
    <div role="dialog" aria-modal="true" aria-label="Попередній перегляд документа" className="preview-modal fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
      <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden border border-gray-200">
        <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 bg-gray-50">
          <div className="flex items-center gap-3 overflow-hidden">
            {fileIcon(item.file.type)}
            <h3 className="font-semibold text-lg text-gray-900 truncate">{item.file.name}</h3>
            <div className="flex-shrink-0 ml-2">
              {item.status === 'pending' && <span className="text-xs font-medium text-gray-500 bg-gray-200 px-2 py-1 rounded-full">В черзі</span>}
              {item.status === 'processing' && <span className="flex items-center gap-1 text-xs font-medium text-indigo-600 bg-indigo-100 px-2 py-1 rounded-full"><Loader2 className="w-3 h-3 animate-spin"/> Обробка</span>}
              {item.status === 'done' && item.result?.status === 'invalid' && <span className="flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-1 rounded-full"><AlertCircle className="w-3 h-3"/> Схема</span>}
              {item.status === 'done' && item.result?.status === 'pending_review' && <span className="text-xs font-medium text-amber-800 bg-amber-100 px-2 py-1 rounded-full">На перевірці</span>}
              {item.status === 'done' && item.result?.status !== 'invalid' && item.result?.status !== 'pending_review' && <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-100 px-2 py-1 rounded-full"><CheckCircle2 className="w-3 h-3"/> Готово</span>}
              {item.status === 'error' && <span className="flex items-center gap-1 text-xs font-medium text-red-600 bg-red-100 px-2 py-1 rounded-full"><AlertCircle className="w-3 h-3"/> Помилка</span>}
            </div>
          </div>
          <button
            autoFocus aria-label="Закрити перегляд" onClick={onClose}
            className="p-2 text-gray-400 hover:text-gray-700 hover:bg-gray-200 rounded-full transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="flex-1 flex overflow-hidden">
          {/* Left: Original File */}
          <div className="w-1/2 border-r border-gray-200 bg-gray-100 p-4 flex flex-col">
            <h4 className="font-medium text-sm text-gray-500 mb-3 uppercase tracking-wider">Оригінал документу</h4>
            <div className="flex-1 bg-white border border-gray-200 rounded-lg overflow-hidden flex items-center justify-center shadow-inner">
              {item.file.type.startsWith('image/') && previewUrl ? (
                <img src={previewUrl} alt="Preview" className="max-w-full max-h-full object-contain" />
              ) : item.file.type === 'application/pdf' && previewUrl ? (
                <iframe src={`${previewUrl}#toolbar=0`} className="w-full h-full border-0" title="PDF Preview" />
              ) : (
                <div className="text-gray-400 flex flex-col items-center p-8 text-center">
                  <FileGlyph className="w-16 h-16 mb-4 text-gray-300" />
                  <p className="font-medium text-gray-600">Попередній перегляд недоступний</p>
                  <p className="text-sm mt-2">Для цього типу файлу ({item.file.type || 'невідомий'}) візуальний перегляд не підтримується браузером.</p>
                </div>
              )}
            </div>
          </div>

          {/* Right: Extracted Data */}
          <div className="w-1/2 p-4 flex flex-col bg-gray-900 text-gray-100">
            <h4 className="font-medium text-sm text-gray-400 mb-3 uppercase tracking-wider">Результат обробки</h4>
            <div className="flex-1 overflow-auto bg-gray-950 rounded-lg border border-gray-800 p-4">
              {item.status === 'pending' && (
                <div className="h-full flex flex-col items-center justify-center text-gray-500">
                  <History className="w-10 h-10 mb-3 opacity-50" />
                  <p>Очікує в черзі на обробку...</p>
                </div>
              )}
              {item.status === 'processing' && (
                <div className="h-full flex flex-col items-center justify-center text-indigo-400">
                  <Loader2 className="w-10 h-10 mb-3 animate-spin" />
                  <p>ШІ аналізує документ...</p>
                </div>
              )}
              {item.status === 'error' && (
                <div className="h-full flex flex-col items-center justify-center text-red-400 text-center p-6">
                  <AlertCircle className="w-10 h-10 mb-3" />
                  <p className="font-medium mb-2">Помилка обробки</p>
                  <p className="text-sm opacity-80">{item.error}</p>
                </div>
              )}
              {item.status === 'done' && item.result && (
                <div className="space-y-3">
                  {item.result.status && (
                    <p className={cn('text-xs font-medium px-2 py-1 rounded inline-block', statusLabel(item.result.status).className)}>
                      {statusLabel(item.result.status).text}
                    </p>
                  )}
                  {item.result.status === 'invalid' && (item.result.validationErrors?.length || item.result.errorMessage) && (
                    <div className="text-sm text-red-300 border border-red-800 rounded p-3 bg-red-950/40">
                      <p className="font-medium mb-1">Помилки схеми</p>
                      <ul className="list-disc pl-4 space-y-0.5">
                        {(item.result.validationErrors || []).map((e, i) => (
                          <li key={i}>{e.path ? `${e.path}: ` : ''}{e.message}</li>
                        ))}
                      </ul>
                      {!item.result.validationErrors?.length && item.result.errorMessage && <p>{item.result.errorMessage}</p>}
                    </div>
                  )}
                  <pre className="text-sm font-mono whitespace-pre-wrap text-green-400">
                    {resultBody(item.result.extractedData)}
                  </pre>
                </div>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}
