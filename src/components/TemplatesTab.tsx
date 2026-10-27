import React, { useState } from 'react';
import { CheckCircle2, Loader2, Plus, TerminalSquare, Trash2 } from 'lucide-react';
import PromptGuide from './PromptGuide';
import SchemaBuilder, { type SchemaValue, type TemplateSchema } from './SchemaBuilder';

export type DocumentType = { id: number; name: string; slug: string; prompt: string; schema?: SchemaValue };

const API_BASE = '';

export default function TemplatesTab({ documentTypes, builtinSchemas, isAdmin, fetchTypes, onDeleted, setError, setNotice }: {
  documentTypes: DocumentType[];
  builtinSchemas: Record<string, TemplateSchema>;
  isAdmin: boolean;
  fetchTypes: () => Promise<void>;
  onDeleted: (slug?: string) => void;
  setError: (message: string | null) => void;
  setNotice: (message: string) => void;
}) {
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeSlug, setNewTypeSlug] = useState('');
  const [newTypePrompt, setNewTypePrompt] = useState('');
  const [newTypeSchema, setNewTypeSchema] = useState<SchemaValue>(null);
  const [isCreatingType, setIsCreatingType] = useState(false);
  const [editingTypeId, setEditingTypeId] = useState<number | null>(null);

  const handleCreateType = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingType(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/types`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTypeName, slug: newTypeSlug, prompt: newTypePrompt, schema: newTypeSchema ?? null }),
      });

      if (!res.ok) {
        let errorMessage = 'Не вдалося створити тип';
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errData = await res.json();
          errorMessage = errData.error || errorMessage;
        } else {
          errorMessage = `Помилка сервера: ${res.status} ${res.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const saved = await res.json().catch(() => ({}));
      if (saved?.warning) setError(saved.warning); else setNotice('Шаблон створено');
      await fetchTypes();
      setNewTypeName('');
      setNewTypeSlug('');
      setNewTypePrompt('');
      setNewTypeSchema(null);

    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsCreatingType(false);
    }
  };

  const handleUpdateType = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!editingTypeId) return;

    setIsCreatingType(true);
    setError(null);

    try {
      const res = await fetch(`${API_BASE}/api/types/${editingTypeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTypeName, slug: newTypeSlug, prompt: newTypePrompt, schema: newTypeSchema ?? null }),
      });

      if (!res.ok) {
        let errorMessage = 'Не вдалося оновити тип';
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const errData = await res.json();
          errorMessage = errData.error || errorMessage;
        } else {
          errorMessage = `Помилка сервера: ${res.status} ${res.statusText}`;
        }
        throw new Error(errorMessage);
      }

      const saved = await res.json().catch(() => ({}));
      await fetchTypes();
      handleCancelEdit();
      if (saved?.warning) setError(saved.warning); else setNotice('Шаблон збережено');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setIsCreatingType(false);
    }
  };

  const handleEditClick = (type: DocumentType) => {
    setEditingTypeId(type.id);
    setNewTypeName(type.name);
    setNewTypeSlug(type.slug);
    setNewTypePrompt(type.prompt);
    setNewTypeSchema(type.schema ?? null);
    setError(null);
    // Scroll to top where the form is
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setEditingTypeId(null);
    setNewTypeName('');
    setNewTypeSlug('');
    setNewTypePrompt('');
    setNewTypeSchema(null);
    setError(null);
  };

  const handleDeleteType = async (id: number) => {
    if (!confirm('Ви впевнені, що хочете видалити цей шаблон?')) return;
    try {
      const res = await fetch(`${API_BASE}/api/types/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Не вдалося видалити шаблон');
      await fetchTypes();
      onDeleted(documentTypes.find(t => t.id === id)?.slug);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося видалити шаблон');
    }
  };

  return (
    <div className="space-y-8">
      <div>
        <h2 className="text-2xl font-semibold mb-1">Типи документів (Шаблони)</h2>
        <p className="text-gray-500 text-sm">Створюйте шаблони для різних типів документів з інструкціями та API-адресою для кожного шаблону.</p>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
        {/* Create/Edit Form */}
        {!isAdmin ? <div className="corporate-panel h-fit"><p className="role-note">Шаблони змінює лише адміністратор. Ви можете переглядати їх і використовувати для обробки.</p></div> : <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 h-fit">
          <h3 className="text-lg font-medium mb-4">
            {editingTypeId ? 'Редагувати шаблон' : 'Створити новий шаблон'}
          </h3>
          <form onSubmit={editingTypeId ? handleUpdateType : handleCreateType} className="space-y-4">
            <div>
              <label htmlFor="tpl-name" className="block text-sm font-medium text-gray-700 mb-1">Назва (напр. Інвойс)</label>
              <input
                id="tpl-name"
                type="text"
                required
                value={newTypeName}
                onChange={(e) => {
                  setNewTypeName(e.target.value);
                  if (!editingTypeId && (!newTypeSlug || newTypeSlug === newTypeName.toLowerCase().replace(/[^a-z0-9-]/g, '-'))) {
                    const candidate = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
                    setNewTypeSlug(candidate);
                  }
                }}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
              />
            </div>
            <div>
              <label htmlFor="tpl-slug" className="block text-sm font-medium text-gray-700 mb-1">Ідентифікатор (Slug)</label>
              <input
                id="tpl-slug"
                type="text"
                required
                value={newTypeSlug}
                onChange={(e) => setNewTypeSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                placeholder="invoice"
              />
              <p className="text-xs text-gray-500 mt-1">Використовується в URL API: /api/v1/parse/<strong>{newTypeSlug || 'slug'}</strong></p>
            </div>
            <div>
              <label htmlFor="tpl-prompt" className="block text-sm font-medium text-gray-700 mb-1">Промпт для AI</label>
              <textarea
                id="tpl-prompt"
                required
                value={newTypePrompt}
                onChange={(e) => setNewTypePrompt(e.target.value)}
                rows={4}
                className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                placeholder="Витягни наступні поля..."
              />
            <PromptGuide onApply={setNewTypePrompt} disabled={isCreatingType}/>
            </div>
            <SchemaBuilder value={newTypeSchema} onChange={setNewTypeSchema} prompt={newTypePrompt} builtins={builtinSchemas} disabled={isCreatingType}/>

            <div className="flex gap-2">
              <button
                type="submit"
                disabled={isCreatingType}
                className="flex-1 bg-gray-900 text-white font-medium py-2 px-4 rounded-md hover:bg-gray-800 disabled:opacity-50 flex items-center justify-center gap-2"
              >
                {isCreatingType ? <Loader2 className="w-4 h-4 animate-spin" /> : (editingTypeId ? <CheckCircle2 className="w-4 h-4" /> : <Plus className="w-4 h-4" />)}
                {editingTypeId ? 'Зберегти зміни' : 'Створити шаблон'}
              </button>
              {editingTypeId && (
                <button
                  type="button"
                  onClick={handleCancelEdit}
                  className="px-4 py-2 bg-gray-100 text-gray-700 font-medium rounded-md hover:bg-gray-200 transition-colors"
                >
                  Скасувати
                </button>
              )}
            </div>
          </form>
        </div>}

        {/* List */}
        <div className="space-y-4">
          {documentTypes.map(type => (
            <div key={type.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
              <div className="flex justify-between items-start mb-2">
                <div>
                  <h4 className="font-semibold text-lg">{type.name}</h4>
                  <div className="flex items-center gap-1 text-xs font-mono text-indigo-600 bg-indigo-50 px-2 py-1 rounded mt-1 w-fit">
                    <TerminalSquare className="w-3 h-3" />
                    POST /api/v1/parse/{type.slug}
                  </div>
                  {type.schema && <span className="schema-badge">{typeof type.schema === 'string' ? `Схема: ${builtinSchemas[type.schema]?.title || type.schema}` : `Схема: ${type.schema.fields.length} пол.`}</span>}
                </div>
                {isAdmin && <div className="flex gap-1">
                  <button
                    onClick={() => handleEditClick(type)}
                    className="text-gray-400 hover:text-indigo-600 transition-colors p-1"
                    title="Редагувати"
                  >
                    <svg xmlns="http://www.w3.org/2000/svg" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5Z"/><path d="m15 5 4 4"/></svg>
                  </button>
                  <button
                    onClick={() => handleDeleteType(type.id)}
                    className="text-gray-400 hover:text-red-500 transition-colors p-1"
                    title="Видалити"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>}
              </div>
              <p className="template-prompt text-sm text-gray-600 mt-3 bg-gray-50 p-3 rounded border border-gray-100">
                {type.prompt}
              </p>
            </div>
          ))}
          {documentTypes.length === 0 && (
            <div className="text-center p-8 text-gray-500 border-2 border-dashed border-gray-200 rounded-xl">
              Немає створених шаблонів
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
