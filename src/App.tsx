import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, FileSpreadsheet, Image as ImageIcon, File, Loader2, CheckCircle2, AlertCircle, Database, Code, LayoutTemplate, History, Plus, Trash2, TerminalSquare, Eye, X } from 'lucide-react';
import { cn } from './lib/utils';
import * as xlsx from 'xlsx';

type DocumentRecord = {
  id: number;
  filename: string;
  originalName: string;
  mimeType: string;
  extractedData: any;
  typeSlug: string;
  createdAt: string;
};

type DocumentType = {
  id: number;
  name: string;
  slug: string;
  prompt: string;
};

type QueueItem = {
  id: string;
  file: File;
  status: 'pending' | 'processing' | 'done' | 'error';
  error?: string;
  result?: DocumentRecord;
};

export default function App() {
  const [activeTab, setActiveTab] = useState<'parse' | 'types' | 'history' | 'api'>('parse');
  
  // Parse State
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedTypeSlug, setSelectedTypeSlug] = useState<string>('custom');
  const [customPrompt, setCustomPrompt] = useState<string>('Витягни всю ключову інформацію з цього документа та структуруй її у JSON об\'єкт.');
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  
  // Data State
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [selectedDoc, setSelectedDoc] = useState<DocumentRecord | null>(null);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);
  
  // New Type State
  const [newTypeName, setNewTypeName] = useState('');
  const [newTypeSlug, setNewTypeSlug] = useState('');
  const [newTypePrompt, setNewTypePrompt] = useState('');
  const [isCreatingType, setIsCreatingType] = useState(false);
  const [editingTypeId, setEditingTypeId] = useState<number | null>(null);
  const [isQueueActive, setIsQueueActive] = useState(false);
  
  // Preview State
  const [previewItem, setPreviewItem] = useState<QueueItem | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (previewItem?.file) {
      const url = URL.createObjectURL(previewItem.file);
      setPreviewUrl(url);
      return () => URL.revokeObjectURL(url);
    } else {
      setPreviewUrl(null);
    }
  }, [previewItem]);

  useEffect(() => {
    fetchTypes();
    fetchDocuments();
  }, []);

  const fetchTypes = async () => {
    try {
      const res = await fetch('https://doc-ai-gamma.vercel.app/api/types');
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          setDocumentTypes(await res.json());
        }
      }
    } catch (err) {
      console.error('Failed to fetch types', err);
    }
  };

  const fetchDocuments = async () => {
    try {
      const res = await fetch('https://doc-ai-gamma.vercel.app/api/documents');
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          setDocuments(data);
        }
      }
    } catch (err) {
      console.error('Failed to fetch documents', err);
    }
  };

  const addFilesToQueue = (files: FileList | File[]) => {
    const newItems: QueueItem[] = Array.from(files).map(file => ({
      id: Math.random().toString(36).substring(7),
      file,
      status: 'pending'
    }));
    setQueue(prev => [...prev, ...newItems]);
    setError(null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  useEffect(() => {
    const processQueue = async () => {
      const nextItem = queue.find(item => item.status === 'pending');
      if (!nextItem || isParsing || !isQueueActive) {
        if (!nextItem && isQueueActive) setIsQueueActive(false);
        return;
      }

      setIsParsing(true);
      
      setQueue(prev => prev.map(item => 
        item.id === nextItem.id ? { ...item, status: 'processing' } : item
      ));

      let fileToSend = nextItem.file;
      
      // Parse Excel files on the client side to bypass Vercel's 4.5MB payload limit
      if (fileToSend.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" || 
          fileToSend.type === "application/vnd.ms-excel" || 
          fileToSend.name.endsWith('.xlsx') || 
          fileToSend.name.endsWith('.xls') ||
          fileToSend.name.endsWith('.csv')) {
        try {
          const arrayBuffer = await fileToSend.arrayBuffer();
          const workbook = xlsx.read(arrayBuffer, { type: "array" });
          const sheetName = workbook.SheetNames[0];
          const sheet = workbook.Sheets[sheetName];
          
          // Convert to JSON to automatically strip empty rows and columns
          const jsonData = xlsx.utils.sheet_to_json(sheet);
          const jsonString = JSON.stringify(jsonData);
          
          // Create a new File object with the JSON content (using window.File to avoid conflict with lucide-react File icon)
          fileToSend = new window.File([jsonString], fileToSend.name + '.json', { type: 'application/json' });
        } catch (e) {
          console.error("Failed to parse Excel on client", e);
        }
      }

      const formData = new FormData();
      formData.append('document', fileToSend);
      formData.append('slug', selectedTypeSlug);
      if (selectedTypeSlug === 'custom') {
        formData.append('prompt', customPrompt);
      }

      try {
        const res = await fetch('https://doc-ai-gamma.vercel.app/api/parse', {
          method: 'POST',
          body: formData,
        });

        if (!res.ok) {
          let errorMessage = 'Не вдалося обробити документ';
          const contentType = res.headers.get('content-type');
          if (contentType && contentType.includes('application/json')) {
            const errData = await res.json();
            errorMessage = errData.error || errorMessage;
          } else {
            errorMessage = `Помилка сервера: ${res.status} ${res.statusText}`;
          }
          throw new Error(errorMessage);
        }

        const data = await res.json();
        
        const newDoc = {
          id: data.id,
          filename: '', 
          originalName: data.originalName,
          mimeType: nextItem.file.type,
          extractedData: data.extractedData,
          typeSlug: data.typeSlug,
          createdAt: new Date().toISOString(),
        };

        setQueue(prev => prev.map(item => 
          item.id === nextItem.id ? { ...item, status: 'done', result: newDoc } : item
        ));
        
        await fetchDocuments();
      } catch (err: any) {
        setQueue(prev => prev.map(item => 
          item.id === nextItem.id ? { ...item, status: 'error', error: err.message } : item
        ));
      } finally {
        setIsParsing(false);
      }
    };

    processQueue();
  }, [queue, isParsing, selectedTypeSlug, customPrompt, isQueueActive]);

  const clearQueue = () => {
    setQueue([]);
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
  };

  const handleCreateType = async (e: React.FormEvent) => {
    e.preventDefault();
    setIsCreatingType(true);
    setError(null);

    try {
      const res = await fetch('https://doc-ai-gamma.vercel.app/api/types', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTypeName, slug: newTypeSlug, prompt: newTypePrompt }),
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

      await fetchTypes();
      setNewTypeName('');
      setNewTypeSlug('');
      setNewTypePrompt('');
      
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
      const res = await fetch(`https://doc-ai-gamma.vercel.app/api/types/${editingTypeId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: newTypeName, slug: newTypeSlug, prompt: newTypePrompt }),
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

      await fetchTypes();
      handleCancelEdit();
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
    setError(null);
    // Scroll to top where the form is
    window.scrollTo({ top: 0, behavior: 'smooth' });
  };

  const handleCancelEdit = () => {
    setEditingTypeId(null);
    setNewTypeName('');
    setNewTypeSlug('');
    setNewTypePrompt('');
    setError(null);
  };

  const handleDeleteType = async (id: number) => {
    if (!confirm('Ви впевнені, що хочете видалити цей шаблон?')) return;
    try {
      await fetch(`https://doc-ai-gamma.vercel.app/api/types/${id}`, { method: 'DELETE' });
      await fetchTypes();
      if (selectedTypeSlug === documentTypes.find(t => t.id === id)?.slug) {
        setSelectedTypeSlug('custom');
      }
    } catch (err) {
      console.error('Failed to delete type', err);
    }
  };

  const getFileIcon = (mimeType: string) => {
    if (mimeType.includes('pdf')) return <FileText className="w-5 h-5 text-red-500" />;
    if (mimeType.includes('word') || mimeType.includes('document')) return <FileText className="w-5 h-5 text-blue-500" />;
    if (mimeType.includes('excel') || mimeType.includes('spreadsheet')) return <FileSpreadsheet className="w-5 h-5 text-green-500" />;
    if (mimeType.includes('image')) return <ImageIcon className="w-5 h-5 text-purple-500" />;
    return <File className="w-5 h-5 text-gray-500" />;
  };

  return (
    <div className="min-h-screen flex bg-gray-50 text-gray-900 font-sans">
      {/* Sidebar */}
      <aside className="w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-gray-200">
          <Database className="w-6 h-6 text-indigo-600 mr-2" />
          <h1 className="text-xl font-semibold tracking-tight">DocuParse AI</h1>
        </div>
        <nav className="flex-1 p-4 space-y-1">
          <button
            onClick={() => setActiveTab('parse')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              activeTab === 'parse' ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-100"
            )}
          >
            <Upload className="w-5 h-5" />
            Парсинг файлів
          </button>
          <button
            onClick={() => setActiveTab('types')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              activeTab === 'types' ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-100"
            )}
          >
            <LayoutTemplate className="w-5 h-5" />
            Шаблони (Типи)
          </button>
          <button
            onClick={() => setActiveTab('history')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              activeTab === 'history' ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-100"
            )}
          >
            <History className="w-5 h-5" />
            Історія
          </button>
          <button
            onClick={() => setActiveTab('api')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              activeTab === 'api' ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-100"
            )}
          >
            <TerminalSquare className="w-5 h-5" />
            API Документація
          </button>
        </nav>
      </aside>

      {/* Main Content */}
      <main className="flex-1 overflow-y-auto">
        <div className="max-w-5xl mx-auto p-8">
          
          {/* PARSE TAB */}
          {activeTab === 'parse' && (
            <div className="space-y-6 max-w-2xl">
              <div>
                <h2 className="text-2xl font-semibold mb-1">Завантаження та Парсинг</h2>
                <p className="text-gray-500 text-sm">Виберіть файл та шаблон для автоматичного витягування даних.</p>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <div 
                  className={cn(
                    "border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
                    queue.length > 0 ? "border-indigo-500 bg-indigo-50" : "border-gray-300 hover:border-indigo-400 hover:bg-gray-50"
                  )}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input 
                    type="file" 
                    ref={fileInputRef} 
                    className="hidden" 
                    onChange={handleFileChange}
                    accept=".pdf,.doc,.docx,.xls,.xlsx,.png,.jpg,.jpeg"
                    multiple
                  />
                  
                  <div className="flex flex-col items-center gap-2 text-gray-500">
                    <Upload className="w-8 h-8 text-gray-400 mb-2" />
                    <p className="text-sm font-medium text-gray-900">Натисніть або перетягніть файли сюди</p>
                    <p className="text-xs">PDF, Word, Excel, або Зображення (Скани). Можна вибрати декілька.</p>
                  </div>
                </div>

                {queue.length > 0 && (
                  <div className="mt-6 space-y-3">
                    <div className="flex justify-between items-center mb-2">
                      <h3 className="text-sm font-medium text-gray-700">Черга обробки ({queue.length})</h3>
                      <button onClick={clearQueue} className="text-xs text-red-600 hover:text-red-800">Очистити</button>
                    </div>
                    {queue.map((item) => (
                      <div key={item.id} className="flex items-center justify-between p-3 bg-gray-50 rounded-md border border-gray-100">
                        <div className="flex items-center gap-3 overflow-hidden">
                          {getFileIcon(item.file.type)}
                          <div className="truncate">
                            <p className="text-sm font-medium text-gray-900 truncate">{item.file.name}</p>
                            <p className="text-xs text-gray-500">{(item.file.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <div className="flex-shrink-0 ml-4 flex items-center gap-2">
                          <button 
                            onClick={() => setPreviewItem(item)}
                            className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                            title="Попередній перегляд"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {item.status === 'pending' && <span className="text-xs font-medium text-gray-500 bg-gray-200 px-2 py-1 rounded-full">В черзі</span>}
                          {item.status === 'processing' && <span className="flex items-center gap-1 text-xs font-medium text-indigo-600 bg-indigo-100 px-2 py-1 rounded-full"><Loader2 className="w-3 h-3 animate-spin"/> Обробка</span>}
                          {item.status === 'done' && <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-100 px-2 py-1 rounded-full"><CheckCircle2 className="w-3 h-3"/> Готово</span>}
                          {item.status === 'error' && <span className="flex items-center gap-1 text-xs font-medium text-red-600 bg-red-100 px-2 py-1 rounded-full" title={item.error}><AlertCircle className="w-3 h-3"/> Помилка</span>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}

                <div className="mt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Тип документа (Шаблон)
                  </label>
                  <select
                    value={selectedTypeSlug}
                    onChange={(e) => setSelectedTypeSlug(e.target.value)}
                    className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent bg-white"
                  >
                    <option value="custom">-- Власний промпт (Без шаблону) --</option>
                    {documentTypes.map(type => (
                      <option key={type.id} value={type.slug}>{type.name}</option>
                    ))}
                  </select>
                </div>

                {selectedTypeSlug === 'custom' && (
                  <div className="mt-4">
                    <label className="block text-sm font-medium text-gray-700 mb-2">
                      Власний Промпт
                    </label>
                    <textarea
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                      placeholder="Опишіть, які дані потрібно витягнути..."
                    />
                  </div>
                )}

                {queue.some(item => item.status === 'pending') && (
                  <div className="mt-6 flex justify-end">
                    <button
                      onClick={() => setIsQueueActive(true)}
                      disabled={isQueueActive || isParsing}
                      className="px-6 py-2.5 bg-indigo-600 text-white font-medium text-sm rounded-md hover:bg-indigo-700 focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:ring-offset-2 disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-2"
                    >
                      {isQueueActive ? (
                        <>
                          <Loader2 className="w-4 h-4 animate-spin" />
                          Обробка...
                        </>
                      ) : (
                        <>
                          <CheckCircle2 className="w-4 h-4" />
                          Почати обробку
                        </>
                      )}
                    </button>
                  </div>
                )}

                {error && (
                  <div className="mt-4 p-3 bg-red-50 border border-red-200 rounded-md flex items-start gap-2 text-red-700 text-sm">
                    <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
                    <p>{error}</p>
                  </div>
                )}
              </div>
            </div>
          )}

          {/* TYPES TAB */}
          {activeTab === 'types' && (
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-semibold mb-1">Типи документів (Шаблони)</h2>
                <p className="text-gray-500 text-sm">Створюйте шаблони для різних типів документів з попередньо налаштованими промптами та окремими API ендпоінтами.</p>
              </div>

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-8">
                {/* Create/Edit Form */}
                <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 h-fit">
                  <h3 className="text-lg font-medium mb-4">
                    {editingTypeId ? 'Редагувати шаблон' : 'Створити новий шаблон'}
                  </h3>
                  <form onSubmit={editingTypeId ? handleUpdateType : handleCreateType} className="space-y-4">
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Назва (напр. Інвойс)</label>
                      <input
                        type="text"
                        required
                        value={newTypeName}
                        onChange={(e) => {
                          setNewTypeName(e.target.value);
                          if (!editingTypeId && (!newTypeSlug || newTypeSlug === newTypeName.toLowerCase().replace(/[^a-z0-9-]/g, '-'))) {
                            setNewTypeSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'));
                          }
                        }}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500"
                      />
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Ідентифікатор (Slug)</label>
                      <input
                        type="text"
                        required
                        value={newTypeSlug}
                        onChange={(e) => setNewTypeSlug(e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-'))}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 font-mono"
                        placeholder="invoice"
                      />
                      <p className="text-xs text-gray-500 mt-1">Використовується в URL API: /api/parse/<strong>{newTypeSlug || 'slug'}</strong></p>
                    </div>
                    <div>
                      <label className="block text-sm font-medium text-gray-700 mb-1">Промпт для AI</label>
                      <textarea
                        required
                        value={newTypePrompt}
                        onChange={(e) => setNewTypePrompt(e.target.value)}
                        rows={4}
                        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 resize-none"
                        placeholder="Витягни наступні поля..."
                      />
                    </div>
                    {error && (
                      <div className="p-3 bg-red-50 border border-red-200 rounded-md text-red-700 text-sm">
                        {error}
                      </div>
                    )}
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
                </div>

                {/* List */}
                <div className="space-y-4">
                  {documentTypes.map(type => (
                    <div key={type.id} className="bg-white rounded-xl shadow-sm border border-gray-200 p-5">
                      <div className="flex justify-between items-start mb-2">
                        <div>
                          <h4 className="font-semibold text-lg">{type.name}</h4>
                          <div className="flex items-center gap-1 text-xs font-mono text-indigo-600 bg-indigo-50 px-2 py-1 rounded mt-1 w-fit">
                            <TerminalSquare className="w-3 h-3" />
                            POST /api/parse/{type.slug}
                          </div>
                        </div>
                        <div className="flex gap-1">
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
                        </div>
                      </div>
                      <p className="text-sm text-gray-600 mt-3 bg-gray-50 p-3 rounded border border-gray-100">
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
          )}

          {/* HISTORY TAB */}
          {activeTab === 'history' && (
            <div className="h-[calc(100vh-6rem)] flex flex-col">
              <div className="mb-4">
                <h2 className="text-2xl font-semibold mb-1">Історія обробок</h2>
                <p className="text-gray-500 text-sm">Перегляд раніше витягнутих даних з документів.</p>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 flex flex-1 overflow-hidden">
                {/* Document List Sidebar */}
                <div className="w-1/3 border-r border-gray-200 overflow-y-auto bg-gray-50/30">
                  {documents.length === 0 ? (
                    <div className="p-6 text-center text-sm text-gray-500">
                      Історія порожня.
                    </div>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {documents.map((doc) => (
                        <li key={doc.id}>
                          <button
                            onClick={() => setSelectedDoc(doc)}
                            className={cn(
                              "w-full text-left p-4 hover:bg-gray-50 transition-colors flex flex-col gap-1",
                              selectedDoc?.id === doc.id ? "bg-indigo-50/50 border-l-2 border-indigo-500" : "border-l-2 border-transparent"
                            )}
                          >
                            <div className="flex items-center gap-2">
                              {getFileIcon(doc.mimeType)}
                              <span className="font-medium text-sm text-gray-900 truncate">{doc.originalName}</span>
                            </div>
                            <div className="flex items-center justify-between pl-7 mt-1">
                              <span className="text-xs text-gray-500">
                                {new Date(doc.createdAt).toLocaleString('uk-UA')}
                              </span>
                              <span className="text-[10px] font-mono bg-gray-100 text-gray-600 px-1.5 py-0.5 rounded">
                                {doc.typeSlug}
                              </span>
                            </div>
                          </button>
                        </li>
                      ))}
                    </ul>
                  )}
                </div>
                
                {/* JSON Viewer */}
                <div className="w-2/3 bg-[#1e1e1e] overflow-y-auto p-4 relative">
                  {selectedDoc ? (
                    <pre className="text-sm font-mono text-[#d4d4d4] whitespace-pre-wrap">
                      {JSON.stringify(selectedDoc.extractedData, null, 2)}
                    </pre>
                  ) : (
                    <div className="h-full flex items-center justify-center text-gray-500 text-sm">
                      Виберіть документ для перегляду даних
                    </div>
                  )}
                </div>
              </div>
            </div>
          )}

          {/* API TAB */}
          {activeTab === 'api' && (
            <div className="space-y-6 max-w-4xl">
              <div>
                <h2 className="text-2xl font-semibold mb-1">API Документація</h2>
                <p className="text-gray-500 text-sm">Інструкція для інтеграції сторонніх сервісів з вашим додатком.</p>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-6">
                <div>
                  <h3 className="text-lg font-medium mb-2">Базовий URL</h3>
                  <code className="block bg-gray-50 p-3 rounded-md border border-gray-100 text-sm font-mono text-gray-800">
                    https://doc-ai-gamma.vercel.app
                  </code>
                </div>

                <div>
                  <h3 className="text-lg font-medium mb-2">Ендпоінт для парсингу</h3>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-bold font-mono">POST</span>
                    <code className="text-sm font-mono text-gray-800">/api/parse/:slug</code>
                  </div>
                  <p className="text-sm text-gray-600 mb-4">
                    Відправте файл через <code>multipart/form-data</code> на цей ендпоінт. 
                    Замість <code>:slug</code> підставте ідентифікатор вашого шаблону (наприклад, <code>invoice</code>).
                  </p>

                  <h4 className="font-medium text-sm text-gray-700 mb-2">Приклад запиту (cURL):</h4>
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-md text-sm font-mono overflow-x-auto">
{`curl -X POST https://doc-ai-gamma.vercel.app/api/parse/invoice \\
  -H "Accept: application/json" \\
  -F "document=@/path/to/your/file.pdf"`}
                  </pre>
                </div>

                <div>
                  <h3 className="text-lg font-medium mb-2">Парсинг без шаблону (Custom Prompt)</h3>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-bold font-mono">POST</span>
                    <code className="text-sm font-mono text-gray-800">/api/parse</code>
                  </div>
                  <p className="text-sm text-gray-600 mb-4">
                    Якщо ви не хочете використовувати заздалегідь створений шаблон, ви можете передати власний промпт безпосередньо в запиті.
                  </p>

                  <h4 className="font-medium text-sm text-gray-700 mb-2">Приклад запиту (cURL):</h4>
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-md text-sm font-mono overflow-x-auto">
{`curl -X POST https://doc-ai-gamma.vercel.app/api/parse \\
  -H "Accept: application/json" \\
  -F "document=@/path/to/your/file.pdf" \\
  -F "prompt=Витягни ім'я та суму у форматі JSON"`}
                  </pre>
                </div>

                <div>
                  <h3 className="text-lg font-medium mb-2">Формат відповіді</h3>
                  <p className="text-sm text-gray-600 mb-2">У разі успіху ви отримаєте JSON об'єкт з витягнутими даними та ID запису в базі:</p>
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-md text-sm font-mono overflow-x-auto">
{`{
  "id": 123,
  "originalName": "file.pdf",
  "typeSlug": "invoice",
  "extractedData": {
    "amount": 1000,
    "name": "John Doe"
  }
}`}
                  </pre>
                </div>
              </div>
            </div>
          )}

        </div>
      </main>

      {/* Preview Modal */}
      {previewItem && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-6xl h-[85vh] flex flex-col overflow-hidden border border-gray-200">
            <div className="flex justify-between items-center px-6 py-4 border-b border-gray-200 bg-gray-50">
              <div className="flex items-center gap-3 overflow-hidden">
                {getFileIcon(previewItem.file.type)}
                <h3 className="font-semibold text-lg text-gray-900 truncate">{previewItem.file.name}</h3>
                <div className="flex-shrink-0 ml-2">
                  {previewItem.status === 'pending' && <span className="text-xs font-medium text-gray-500 bg-gray-200 px-2 py-1 rounded-full">В черзі</span>}
                  {previewItem.status === 'processing' && <span className="flex items-center gap-1 text-xs font-medium text-indigo-600 bg-indigo-100 px-2 py-1 rounded-full"><Loader2 className="w-3 h-3 animate-spin"/> Обробка</span>}
                  {previewItem.status === 'done' && <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-100 px-2 py-1 rounded-full"><CheckCircle2 className="w-3 h-3"/> Готово</span>}
                  {previewItem.status === 'error' && <span className="flex items-center gap-1 text-xs font-medium text-red-600 bg-red-100 px-2 py-1 rounded-full"><AlertCircle className="w-3 h-3"/> Помилка</span>}
                </div>
              </div>
              <button 
                onClick={() => setPreviewItem(null)} 
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
                  {previewItem.file.type.startsWith('image/') && previewUrl ? (
                    <img src={previewUrl} alt="Preview" className="max-w-full max-h-full object-contain" />
                  ) : previewItem.file.type === 'application/pdf' && previewUrl ? (
                    <iframe src={`${previewUrl}#toolbar=0`} className="w-full h-full border-0" title="PDF Preview" />
                  ) : (
                    <div className="text-gray-400 flex flex-col items-center p-8 text-center">
                      <File className="w-16 h-16 mb-4 text-gray-300" />
                      <p className="font-medium text-gray-600">Попередній перегляд недоступний</p>
                      <p className="text-sm mt-2">Для цього типу файлу ({previewItem.file.type || 'невідомий'}) візуальний перегляд не підтримується браузером.</p>
                    </div>
                  )}
                </div>
              </div>
              
              {/* Right: Extracted Data */}
              <div className="w-1/2 p-4 flex flex-col bg-gray-900 text-gray-100">
                <h4 className="font-medium text-sm text-gray-400 mb-3 uppercase tracking-wider">Результат парсингу (JSON)</h4>
                <div className="flex-1 overflow-auto bg-gray-950 rounded-lg border border-gray-800 p-4">
                  {previewItem.status === 'pending' && (
                    <div className="h-full flex flex-col items-center justify-center text-gray-500">
                      <History className="w-10 h-10 mb-3 opacity-50" />
                      <p>Очікує в черзі на обробку...</p>
                    </div>
                  )}
                  {previewItem.status === 'processing' && (
                    <div className="h-full flex flex-col items-center justify-center text-indigo-400">
                      <Loader2 className="w-10 h-10 mb-3 animate-spin" />
                      <p>ШІ аналізує документ...</p>
                    </div>
                  )}
                  {previewItem.status === 'error' && (
                    <div className="h-full flex flex-col items-center justify-center text-red-400 text-center p-6">
                      <AlertCircle className="w-10 h-10 mb-3" />
                      <p className="font-medium mb-2">Помилка обробки</p>
                      <p className="text-sm opacity-80">{previewItem.error}</p>
                    </div>
                  )}
                  {previewItem.status === 'done' && previewItem.result && (
                    <pre className="text-sm font-mono whitespace-pre-wrap text-green-400">
                      {JSON.stringify(previewItem.result.extractedData, null, 2)}
                    </pre>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
