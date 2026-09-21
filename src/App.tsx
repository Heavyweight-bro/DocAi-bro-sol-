import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, FileSpreadsheet, Image as ImageIcon, File, Loader2, CheckCircle2, AlertCircle, Database, Code, LayoutTemplate, History, Plus, Trash2, TerminalSquare, Eye, X, Search, Download, Copy, Sparkles, ArrowUpRight, RotateCcw, Settings as SettingsIcon, Building2 } from 'lucide-react';
import Settings, { type SettingsData, names } from './components/Settings';
import PromptGuide from './components/PromptGuide';
import DeploymentGuide from './components/DeploymentGuide';
import { cn } from './lib/utils';


const API_BASE = '';

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
  const [activeTab, setActiveTab] = useState<'parse' | 'types' | 'history' | 'api' | 'settings' | 'deployment'>('parse');

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
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewItem = queue.find(item => item.id === previewId) || null;
  const setPreviewItem = (item: QueueItem | null) => setPreviewId(item?.id || null);
  const [health, setHealth] = useState<{ aiConfigured: boolean; storage: string } | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [search, setSearch] = useState('');
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const busyRef = useRef(false);
  const filteredDocuments = documents.filter(doc => `${doc.originalName} ${doc.typeSlug}`.toLowerCase().includes(search.toLowerCase()));
  const exportJson = (value: unknown, name: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a'); link.href = url; link.download = name.replace(/\.[^.]+$/, '') + '.json'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const copyJson = async (value: unknown) => {
    try { await navigator.clipboard.writeText(JSON.stringify(value, null, 2)); setNotice('JSON скопійовано'); }
    catch { setError('Не вдалося скопіювати. Скористайтеся завантаженням JSON.'); }
  };
  useEffect(() => {
    fetch('/api/settings').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setSettings).catch(() => setError('Не вдалося завантажити налаштування'));
    fetch('/api/health').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setHealth).catch(() => setError('Сервер недоступний. Перевірте підключення.'));
  }, []);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 3000); return () => clearTimeout(timer); } }, [notice]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setPreviewId(null); };
    window.addEventListener('keydown', onKey); return () => window.removeEventListener('keydown', onKey);
  }, []);
  const applySettings = (value: SettingsData) => { setSettings(value); setHealth(prev => prev ? {...prev, aiConfigured: value.providers.some(p => p.id === value.provider && p.configured)} : prev); };
  const activeProvider = settings?.providers.find(p => p.id === settings.provider);
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
  }, [previewItem?.id]);

  useEffect(() => {
    fetchTypes();
    fetchDocuments();
  }, []);

  const fetchTypes = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/types`);
      if (!res.ok) throw new Error((await res.json()).error || 'Не вдалося завантажити дані');
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          setDocumentTypes(await res.json());
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося завантажити шаблони');
    }
  };

  const fetchDocuments = async () => {
    try {
      const res = await fetch(`${API_BASE}/api/documents`);
      if (!res.ok) throw new Error((await res.json()).error || 'Не вдалося завантажити дані');
      if (res.ok) {
        const contentType = res.headers.get('content-type');
        if (contentType && contentType.includes('application/json')) {
          const data = await res.json();
          setDocuments(data);
        }
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося завантажити історію');
    }
  };

  const addFilesToQueue = (files: FileList | File[]) => {
    const rejected: string[] = [];
    const valid = Array.from(files).filter(file => {
      if (!/\.(pdf|docx|xlsx|xls|csv|json|txt|png|jpe?g|webp)$/i.test(file.name) || file.size > 10 * 1024 * 1024 || file.size === 0) {
        rejected.push(file.name); return false;
      }
      return true;
    });
    setQueue(prev => {
      const seen = new Set(prev.map(i => `${i.file.name}:${i.file.size}:${i.file.lastModified}`));
      const added: QueueItem[] = [];
      for (const file of valid) {
        const key = `${file.name}:${file.size}:${file.lastModified}`;
        if (!seen.has(key)) { seen.add(key); added.push({ id: crypto.randomUUID(), file, status: 'pending' }); }
      }
      return [...prev, ...added];
    });
    setError(rejected.length ? `Не додано: ${rejected.join(', ')}. Перевірте формат і розмір (1 байт – 10 MB).` : null);
  };

  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      addFilesToQueue(e.target.files);
      e.target.value = "";
    }
  };

  const handleDrop = (e: React.DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragging(false);
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      addFilesToQueue(e.dataTransfer.files);
    }
  };

  useEffect(() => {
    const processQueue = async () => {
      const nextItem = queue.find(item => item.status === 'pending');
      if (!nextItem || isParsing || busyRef.current || !isQueueActive) {
        if (!nextItem && isQueueActive) setIsQueueActive(false);
        return;
      }

      busyRef.current = true;
      setIsParsing(true);

      setQueue(prev => prev.map(item =>
        item.id === nextItem.id ? { ...item, status: 'processing' } : item
      ));

      let fileToSend = nextItem.file;

      // Parse Excel files on the client side to bypass Vercel's 4.5MB payload limit
      if (fileToSend.type === "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet" ||
          fileToSend.type === "application/vnd.ms-excel" ||
          fileToSend.name.toLowerCase().endsWith('.xlsx') ||
          fileToSend.name.toLowerCase().endsWith('.xls') ||
          fileToSend.name.toLowerCase().endsWith('.csv')) {
        try {
          const xlsx = await import('xlsx');
          const arrayBuffer = await fileToSend.arrayBuffer();
          const workbook = xlsx.read(arrayBuffer, { type: "array" });


          // Convert to JSON to automatically strip empty rows and columns
          const jsonData = Object.fromEntries(workbook.SheetNames.map(name => [name, xlsx.utils.sheet_to_json(workbook.Sheets[name])]));
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
      if (settings) formData.append('provider', settings.provider);
      if (selectedTypeSlug === 'custom') {
        formData.append('prompt', customPrompt);
      }

      try {
        const res = await fetch(`${API_BASE}/api/parse`, {
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
          originalName: nextItem.file.name,
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
        busyRef.current = false;
        setIsParsing(false);
      }
    };

    processQueue();
  }, [queue, isParsing, selectedTypeSlug, customPrompt, isQueueActive, settings]);

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
      const res = await fetch(`${API_BASE}/api/types`, {
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
      const res = await fetch(`${API_BASE}/api/types/${editingTypeId}`, {
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
      const res = await fetch(`${API_BASE}/api/types/${id}`, { method: 'DELETE' });
      if (!res.ok) throw new Error((await res.json()).error || 'Не вдалося видалити шаблон');
      await fetchTypes();
      if (selectedTypeSlug === documentTypes.find(t => t.id === id)?.slug) {
        setSelectedTypeSlug('custom');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося видалити шаблон');
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
    <div className="app-shell min-h-screen flex bg-gray-50 text-gray-900 font-sans">
      {/* Sidebar */}
      <aside className="sidebar w-64 bg-white border-r border-gray-200 flex flex-col">
        <div className="h-16 flex items-center px-6 border-b border-gray-200">
          <span className="brand-icon"><FileText size={21} /></span>
          <h1 className="text-xl font-semibold tracking-tight">{settings?.companyName || "Doc.AI"}</h1>
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
            Робочий простір
          </button>
          <button
            onClick={() => setActiveTab('types')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              activeTab === 'types' ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-100"
            )}
          >
            <LayoutTemplate className="w-5 h-5" />
            Шаблони
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
            API та інтеграції
          </button>
          <div className="nav-divider"/>
          <button disabled={isParsing || isQueueActive} onClick={() => setActiveTab('settings')} className={cn('w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium', activeTab === 'settings' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-100')}><SettingsIcon size={18}/>Налаштування</button>
          <button onClick={() => setActiveTab('deployment')} className={cn('w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium', activeTab === 'deployment' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-100')}><Building2 size={18}/>Впровадження</button>
        </nav>
        <div className="sidebar-profile"><span className="avatar"><Building2 size={16}/></span><div><strong>{settings?.companyName || 'Doc.AI'}</strong><small>{health?.storage === 'local' ? 'Локальна інсталяція' : 'Робочий простір'}</small></div></div>
      </aside>

      {/* Main Content */}
      <main className="main-content flex-1 overflow-y-auto">
        <header className="topbar"><span>Документи <span className="breadcrumb">/ {({ parse: 'Обробка документів', types: 'Шаблони', history: 'Історія', api: 'API', settings: 'Налаштування', deployment: 'Впровадження' })[activeTab]}</span></span><span className="connection"><i className={health ? 'online' : ''}/>{health ? health.storage === 'local' ? 'Локальний простір' : 'Сервер підключено' : 'Підключення…'}</span></header>
        <div className="workspace max-w-5xl mx-auto p-8">

          {error && <div role="alert" className="error-banner"><AlertCircle size={18}/><span>{error}</span><button aria-label="Закрити помилку" onClick={() => setError(null)}><X size={16}/></button></div>}
          {notice && <div role="status" className="toast">{notice}</div>}
          {activeTab === 'settings' && (settings ? <Settings data={settings} onChange={applySettings}/> : <p>Завантаження налаштувань…</p>)}
          {activeTab === 'deployment' && <DeploymentGuide/>}
          {/* PARSE TAB */}
          {activeTab === 'parse' && (
            <div className="parse-workspace space-y-6">
              <div className="page-heading"><div><div className="eyebrow">ДОКУМЕНТООБІГ</div><h2>Обробка документів</h2><p>Завантажте файли та виберіть правила витягування даних.</p></div><button className="secondary-button" disabled={isParsing || isQueueActive} onClick={()=>setActiveTab('settings')}><SettingsIcon size={16}/>Підключення AI</button></div>
              <div className="stats-grid">
                <div><span className="stat-icon"><FileText/></span><div><small>В історії</small><strong>{documents.length}<em>документів</em></strong></div></div>
                <div><span className="stat-icon"><LayoutTemplate/></span><div><small>Готові до роботи</small><strong>{documentTypes.length}<em>шаблони</em></strong></div></div>
                <div><span className="stat-icon"><CheckCircle2/></span><div><small>У поточній сесії</small><strong>{queue.filter(i => i.status === 'done').length}<em>оброблено</em></strong></div></div>
              </div>
              {health && !health.aiConfigured && <div className="setup-banner"><AlertCircle size={18}/><div><strong>AI-провайдер не підключений</strong><p>Додайте API-ключ OpenAI, Gemini або Anthropic у налаштуваннях.</p></div><button className="secondary-button" onClick={()=>setActiveTab('settings')}>Налаштувати</button></div>}
              <div className="parse-grid"><div>

              <div className="upload-card bg-white rounded-xl shadow-sm border border-gray-200 p-6">
                <div className="section-heading"><h3><span>01</span> Додайте документи</h3><span>До 10 MB / файл</span></div>
                <div
                  className={cn(
                    "dropzone border-2 border-dashed rounded-lg p-8 text-center transition-colors cursor-pointer",
                    dragging && "is-dragging",
                    queue.length > 0 ? "border-indigo-500 bg-indigo-50" : "border-gray-300 hover:border-indigo-400 hover:bg-gray-50"
                  )}
                  role="button" tabIndex={0} aria-label="Додати документи"
                  onKeyDown={e => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); fileInputRef.current?.click(); } }}
                  onDragOver={(e) => { e.preventDefault(); setDragging(true); }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={handleDrop}
                  onClick={() => fileInputRef.current?.click()}
                >
                  <input
                    type="file"
                    ref={fileInputRef}
                    className="hidden"
                    onChange={handleFileChange}
                    accept=".pdf,.docx,.xls,.xlsx,.csv,.json,.txt,.png,.jpg,.jpeg,.webp"
                    multiple
                  />

                  <div className="flex flex-col items-center gap-2 text-gray-500">
                    <span className="upload-icon"><Upload size={28}/></span>
                    <p className="text-sm font-medium text-gray-900">Перетягніть документи сюди</p>
                    <span className="choose-files">Вибрати файли <Plus size={15}/></span><p className="text-xs">PDF, DOCX, Excel, CSV, JSON, TXT, PNG, JPG, WebP</p>
                  </div>
                </div>

                {queue.length > 0 && (
                  <div className="mt-6 space-y-3">
                    <div className="flex justify-between items-center mb-2">
                      <h3 className="text-sm font-medium text-gray-700">Черга обробки ({queue.length})</h3>
                      <button disabled={isParsing || isQueueActive} onClick={clearQueue} className="text-xs text-red-600 hover:text-red-800">Очистити</button>
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
                        <div className="queue-actions flex-shrink-0 ml-4 flex items-center gap-2">
                          {item.result && <button title="Завантажити JSON" onClick={() => exportJson(item.result!.extractedData, item.file.name)}><Download size={16}/></button>}
                          {item.status === 'error' && <button title="Повторити" disabled={isParsing || isQueueActive} onClick={() => setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'pending', error: undefined } : q))}><RotateCcw size={16}/></button>}
                          {!isParsing && !isQueueActive && <button title="Прибрати файл" onClick={() => setQueue(prev => prev.filter(q => q.id !== item.id))}><X size={16}/></button>}
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

                <div className="section-heading config-heading"><h3><span>02</span> Налаштуйте витягування</h3></div>
                <div className="mt-6">
                  <label className="block text-sm font-medium text-gray-700 mb-2">
                    Тип документа (Шаблон)
                  </label>
                  <select
                    disabled={isParsing || isQueueActive}
                    aria-label="Шаблон документа"
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
                      disabled={isParsing || isQueueActive}
                      aria-label="Інструкція для AI"
                      value={customPrompt}
                      onChange={(e) => setCustomPrompt(e.target.value)}
                      rows={4}
                      className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-indigo-500 focus:border-transparent resize-none"
                      placeholder="Опишіть, які дані потрібно витягнути..."
                    />
                    <PromptGuide onApply={setCustomPrompt} disabled={isParsing || isQueueActive}/>
                  </div>
                )}

                {queue.some(item => item.status === 'pending') && (
                  <div className="mt-6 flex justify-end">
                    <button
                      onClick={() => setIsQueueActive(true)}
                      disabled={isQueueActive || isParsing || !health?.aiConfigured || (selectedTypeSlug === 'custom' && !customPrompt.trim())}
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


              </div></div>
              <aside className="execution-panel corporate-panel"><h3>Параметри обробки</h3><dl><dt>AI-провайдер</dt><dd>{settings ? names[settings.provider] : 'Завантаження…'}</dd><dt>Модель</dt><dd className="mono">{activeProvider?.model || '—'}</dd><dt>Режим</dt><dd>Послідовно, у цій вкладці</dd><dt>Формат результату</dt><dd>JSON</dd><dt>Зберігання</dt><dd>{health?.storage === 'local' ? 'Локальний файл' : health?.storage === 'supabase' ? 'Supabase' : 'Не підключено'}</dd></dl><p>Перевірте витягнуті дані перед передачею в облік або оплату.</p><button className="text-button" onClick={()=>setActiveTab('deployment')}>Як підготувати до роботи в компанії →</button></aside>
              </div>
            </div>
          )}

          {/* TYPES TAB */}
          {activeTab === 'types' && (
            <div className="space-y-8">
              <div>
                <h2 className="text-2xl font-semibold mb-1">Типи документів (Шаблони)</h2>
                <p className="text-gray-500 text-sm">Створюйте шаблони для різних типів документів з інструкціями та API-адресою для кожного шаблону.</p>
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
                            const candidate = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-').replace(/^-+|-+$/g, '');
                            setNewTypeSlug(candidate);
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
                    <PromptGuide onApply={setNewTypePrompt} disabled={isCreatingType}/>
                    </div>

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

              <div className="history-toolbar"><label><Search size={18}/><input aria-label="Пошук документів" placeholder="Пошук за назвою або шаблоном…" value={search} onChange={e => setSearch(e.target.value)}/></label><button onClick={fetchDocuments}><RotateCcw size={16}/> Оновити</button></div>
              <div className="history-panel bg-white rounded-xl shadow-sm border border-gray-200 flex flex-1 overflow-hidden">
                {/* Document List Sidebar */}
                <div className="w-1/3 border-r border-gray-200 overflow-y-auto bg-gray-50/30">
                  {filteredDocuments.length === 0 ? (
                    <div className="p-6 text-center text-sm text-gray-500">
                      {search ? "Нічого не знайдено" : "Оброблені документи з’являться тут."}
                    </div>
                  ) : (
                    <ul className="divide-y divide-gray-100">
                      {filteredDocuments.map((doc) => (
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
                    <><div className="result-toolbar"><span>{selectedDoc.originalName}</span><button onClick={() => copyJson(selectedDoc.extractedData)} title="Копіювати JSON"><Copy size={16}/></button><button onClick={() => exportJson(selectedDoc.extractedData, selectedDoc.originalName)} title="Завантажити JSON"><Download size={16}/></button></div><pre className="text-sm font-mono text-[#d4d4d4] whitespace-pre-wrap">{JSON.stringify(selectedDoc.extractedData, null, 2)}</pre></>
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
                <h2 className="text-2xl font-semibold mb-1">API та інтеграції</h2>
                <p className="text-gray-500 text-sm">Інструкція для інтеграції сторонніх сервісів з вашим додатком.</p>
              </div>

              <div className="bg-white rounded-xl shadow-sm border border-gray-200 p-6 space-y-6">
                <div>
                  <h3 className="text-lg font-medium mb-2">Базовий URL</h3>
                  <code className="block bg-gray-50 p-3 rounded-md border border-gray-100 text-sm font-mono text-gray-800">
                    {window.location.origin}
                  </code>
                </div>

                <div>
                  <h3 className="text-lg font-medium mb-2">Ендпоінт для парсингу</h3>
                  <div className="flex items-center gap-2 mb-3">
                    <span className="bg-green-100 text-green-800 px-2 py-1 rounded text-xs font-bold font-mono">POST</span>
                    <code className="text-sm font-mono text-gray-800">/api/parse/:slug</code>
                  </div>
                  <p className="text-sm text-gray-600 mb-4">
                    Одна адреса обслуговує всі файли цього шаблону. Кожен результат має окремий ID. Відправте файл через <code>multipart/form-data</code> на цей ендпоінт.
                    Замість <code>:slug</code> підставте ідентифікатор вашого шаблону (наприклад, <code>invoice</code>).
                  </p>

                  <h4 className="font-medium text-sm text-gray-700 mb-2">Приклад запиту (cURL):</h4>
                  <pre className="bg-gray-900 text-gray-100 p-4 rounded-md text-sm font-mono overflow-x-auto">
{`curl -X POST ${window.location.origin}/api/parse/invoice \\
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
{`curl -X POST ${window.location.origin}/api/parse \\
  -H "Accept: application/json" \\
  -F "document=@/path/to/your/file.pdf" \\
  -F "prompt=Витягни ім'я та суму у форматі JSON"`}
                  </pre>
                </div>

                <div><h3 className="text-lg font-medium mb-2">Отримати збережений результат</h3><code className="text-sm">GET /api/documents/:id</code><p className="text-sm text-gray-600 mt-2">Підставте ID із відповіді на обробку. Ця адреса повертає запис із БД, а не запускає AI повторно.</p><p className="text-sm text-gray-600 mt-2">За замовчуванням використовується провайдер із налаштувань. Поле provider у multipart-запиті дозволяє явно вибрати openai, gemini або anthropic. Ключі залишаються на сервері.</p></div>
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
        <div role="dialog" aria-modal="true" aria-label="Попередній перегляд документа" className="preview-modal fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4 backdrop-blur-sm">
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
                autoFocus aria-label="Закрити перегляд" onClick={() => setPreviewItem(null)}
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
