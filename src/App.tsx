import React, { useState, useEffect, useRef } from 'react';
import { Upload, FileText, Loader2, CheckCircle2, AlertCircle, LayoutTemplate, History, Plus, TerminalSquare, Eye, X, Download, RotateCcw, Settings as SettingsIcon, Building2, LogOut, BarChart3 } from 'lucide-react';
import Settings, { type SettingsData, names } from './components/Settings';
import PromptGuide from './components/PromptGuide';
import Login, { type AuthState } from './components/Login';
import Users, { roleNames } from './components/Users';
import Analytics from './components/Analytics';
import type { TemplateSchema } from './components/SchemaBuilder';
import TemplatesTab, { type DocumentType } from './components/TemplatesTab';
import HistoryTab, { type DocumentRecord } from './components/HistoryTab';
import PreviewModal, { type QueueItem } from './components/PreviewModal';
import ApiDocs from './components/ApiDocs';
import { fileIcon } from './lib/ui';
import { exportJson } from './lib/export';
import { cn } from './lib/utils';


const API_BASE = '';

export default function App() {
  const [auth, setAuth] = useState<AuthState | null>(null);
  const refreshAuth = async () => {
    try {
      const res = await fetch('/api/auth/me', { cache: 'no-store' });
      setAuth(await res.json());
    } catch {
      setAuth({ authenticated: false, user: null, loginRequired: true, usersConfigured: true, usersEditable: false, sessionReady: true });
    }
  };
  useEffect(() => { void refreshAuth(); }, []);
  const authenticated = !!auth?.authenticated;
  const role = auth?.user?.role;
  const canOperate = role === 'operator' || role === 'admin';
  const isAdmin = role === 'admin';
  const logout = async () => {
    await fetch('/api/auth/logout', { method: 'POST' }).catch(() => undefined);
    setDocuments([]); setDocumentTypes([]); setQueue([]); setActiveTab('parse'); setSettings(null); setHealth(null);
    await refreshAuth();
  };
  /** Any 401 means the session expired: go back to the login screen instead of showing a raw error. */
  const guard = async (res: Response) => {
    if (res.status === 401) { await refreshAuth(); throw new Error('Сесія завершилась. Увійдіть знову.'); }
    return res;
  };

  const [activeTab, setActiveTab] = useState<'parse' | 'types' | 'history' | 'api' | 'settings' | 'analytics'>('parse');

  // Parse State
  const [queue, setQueue] = useState<QueueItem[]>([]);
  const [selectedTypeSlug, setSelectedTypeSlug] = useState<string>('custom');
  const [customPrompt, setCustomPrompt] = useState<string>('Витягни всю ключову інформацію з цього документа та структуруй її у JSON об\'єкт. Поверни тільки JSON.');
  const [isParsing, setIsParsing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Data State
  const [documents, setDocuments] = useState<DocumentRecord[]>([]);
  const [documentTypes, setDocumentTypes] = useState<DocumentType[]>([]);

  const [builtinSchemas, setBuiltinSchemas] = useState<Record<string, TemplateSchema>>({});
  const [isQueueActive, setIsQueueActive] = useState(false);

  // Preview State
  const [previewId, setPreviewId] = useState<string | null>(null);
  const previewItem = queue.find(item => item.id === previewId) || null;
  const [health, setHealth] = useState<{ aiConfigured: boolean; storage: string } | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const [notice, setNotice] = useState('');
  const [dragging, setDragging] = useState(false);
  const busyRef = useRef(false);
  useEffect(() => {
    if (!authenticated) return;
    fetch('/api/settings').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setSettings).catch(() => setError('Не вдалося завантажити налаштування'));
    fetch('/api/health').then(r => { if (!r.ok) throw new Error(); return r.json(); }).then(setHealth).catch(() => setError('Сервер недоступний. Перевірте підключення.'));
  }, [authenticated]);
  useEffect(() => { if (notice) { const timer = setTimeout(() => setNotice(''), 3000); return () => clearTimeout(timer); } }, [notice]);
  const applySettings = (value: SettingsData) => {
    setSettings(value);
    const ready = value.providers.some(p => p.id === value.provider && p.configured);
    setHealth(prev => prev ? { ...prev, aiConfigured: ready } : prev);
  };
  const activeProvider = settings?.providers.find(p => p.id === settings.provider);
  const otherConfigured = settings?.providers.find(p => p.configured && p.id !== settings.provider);
  const fileInputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!authenticated) return;
    fetchTypes();
    fetchDocuments();
    fetch('/api/schemas').then(r => (r.ok ? r.json() : {})).then(setBuiltinSchemas).catch(() => undefined);
  }, [authenticated]);

  const fetchTypes = async () => {
    try {
      const res = await guard(await fetch(`${API_BASE}/api/types`));
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
      const res = await guard(await fetch(`${API_BASE}/api/documents`));
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
        const res = await guard(await fetch(`${API_BASE}/api/v1/parse`, {
          method: 'POST',
          body: formData,
        }));

        const contentType = res.headers.get('content-type');
        const enqueued = contentType && contentType.includes('application/json') ? await res.json() : null;
        if (!res.ok && res.status !== 202) {
          throw new Error(enqueued?.error || `Помилка сервера: ${res.status} ${res.statusText}`);
        }
        if (!enqueued?.jobId) throw new Error(enqueued?.error || 'Не вдалося поставити завдання в чергу');

        // Poll server job — processing continues even if the tab is closed later.
        let job = enqueued;
        const deadline = Date.now() + 180_000;
        while (job.status === 'queued' || job.status === 'processing') {
          if (Date.now() > deadline) throw new Error('Час очікування завдання вичерпано');
          await new Promise((r) => setTimeout(r, 1200));
          const jobRes = await fetch(`${API_BASE}/api/v1/jobs/${enqueued.jobId}`);
          job = await jobRes.json();
          if (!jobRes.ok) throw new Error(job.error || 'Не вдалося отримати статус завдання');
        }

        if (job.status === 'failed') {
          if (job.documentId) void fetchDocuments();
          throw new Error(job.error || 'Обробка не вдалася');
        }

        let data: any = null;
        if (job.documentId) {
          const docRes = await fetch(`${API_BASE}/api/v1/documents/${job.documentId}`);
          data = await docRes.json();
          if (!docRes.ok && job.status === 'failed') {
            throw new Error(data?.error || job.error || 'Обробка не вдалася');
          }
          if (!docRes.ok) throw new Error(data?.error || 'Документ не знайдено');
        }

        if (!data?.id) throw new Error(job.error || 'Не вдалося обробити документ');

        const newDoc: DocumentRecord = {
          id: data.id,
          filename: '',
          originalName: nextItem.file.name,
          mimeType: nextItem.file.type,
          extractedData: data.extractedData,
          typeSlug: data.typeSlug,
          createdAt: data.createdAt || new Date().toISOString(),
          status: data.status || job.documentStatus,
          validationErrors: data.validationErrors,
          errorMessage: data.error || data.errorMessage || job.error,
          storagePath: data.storagePath,
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

  if (!auth) {
    return <div className="login-shell"><Loader2 className="animate-spin" aria-label="Завантаження" /></div>;
  }
  if (!auth.authenticated) {
    return <Login auth={auth} onLoggedIn={refreshAuth} />;
  }

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
          {isAdmin && <button
            onClick={() => setActiveTab('analytics')}
            className={cn(
              "w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium transition-colors",
              activeTab === 'analytics' ? "bg-indigo-50 text-indigo-700" : "text-gray-700 hover:bg-gray-100"
            )}
          >
            <BarChart3 className="w-5 h-5" />
            Аналітика
          </button>}
          <div className="nav-divider"/>
          <button disabled={isParsing || isQueueActive} onClick={() => setActiveTab('settings')} className={cn('w-full flex items-center gap-3 px-3 py-2 rounded-md text-sm font-medium', activeTab === 'settings' ? 'bg-indigo-50 text-indigo-700' : 'text-gray-700 hover:bg-gray-100')}><SettingsIcon size={18}/>Налаштування</button>
        </nav>
        <div className="sidebar-profile"><span className="avatar"><Building2 size={16}/></span><div className="min-w-0"><strong className="block truncate">{auth.user?.name || auth.user?.email}</strong><small>{role ? roleNames[role] : ''}{auth.user?.kind === 'local' ? ' · локальний режим' : ''}</small></div>{auth.user?.kind === 'user' && <button className="logout" title="Вийти" aria-label="Вийти" onClick={logout}><LogOut size={16}/></button>}</div>
      </aside>

      {/* Main Content */}
      <main className="main-content flex-1 overflow-y-auto">
        <header className="topbar"><span>Документи <span className="breadcrumb">/ {({ parse: 'Обробка документів', types: 'Шаблони', history: 'Історія', api: 'API', settings: 'Налаштування', analytics: 'Аналітика' })[activeTab]}</span></span><span className="connection"><i className={health ? 'online' : ''}/>{health ? health.storage === 'local' ? 'Локальний простір' : 'Сервер підключено' : 'Підключення…'}</span></header>
        <div className="workspace max-w-5xl mx-auto p-8">

          {error && <div role="alert" className="error-banner"><AlertCircle size={18}/><span>{error}</span><button aria-label="Закрити помилку" onClick={() => setError(null)}><X size={16}/></button></div>}
          {notice && <div role="status" className="toast">{notice}</div>}
          {activeTab === 'analytics' && isAdmin && <Analytics />}
          {activeTab === 'settings' && (settings ? <><Settings data={settings} onChange={applySettings}/>{isAdmin && <Users editable={auth.usersEditable} currentEmail={auth.user?.email}/>}</> : <p>Завантаження налаштувань…</p>)}
          {/* PARSE TAB */}
          {activeTab === 'parse' && (
            <div className="parse-workspace space-y-6">
              <div className="page-heading"><div><div className="eyebrow">ДОКУМЕНТООБІГ</div><h2>Обробка документів</h2><p>Завантажте файли та виберіть правила витягування даних.</p></div><button className="secondary-button" disabled={isParsing || isQueueActive} onClick={()=>setActiveTab('settings')}><SettingsIcon size={16}/>Підключення AI</button></div>
              <div className="stats-grid">
                <div><span className="stat-icon"><FileText/></span><div><small>В історії</small><strong>{documents.length}<em>документів</em></strong></div></div>
                <div><span className="stat-icon"><LayoutTemplate/></span><div><small>Готові до роботи</small><strong>{documentTypes.length}<em>шаблони</em></strong></div></div>
                <div><span className="stat-icon"><CheckCircle2/></span><div><small>У поточній сесії</small><strong>{queue.filter(i => i.status === 'done').length}<em>оброблено</em></strong></div></div>
              </div>
              {health && !health.aiConfigured && <div className="setup-banner"><AlertCircle size={18}/><div><strong>{otherConfigured ? 'Обраний провайдер без ключа' : 'AI-провайдер не підключений'}</strong><p>{otherConfigured ? `${names[otherConfigured.id]} уже підключено, але за замовчуванням стоїть ${settings ? names[settings.provider] : 'інший'} без ключа. У налаштуваннях виберіть підключеного провайдера та натисніть «Зберегти простір».` : 'Додайте API-ключ OpenAI, Gemini, Anthropic або Azure (OpenAI / Claude) у налаштуваннях. Після збереження цей провайдер стане основним автоматично.'}</p></div><button className="secondary-button" onClick={()=>setActiveTab('settings')}>Налаштувати</button></div>}
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
                          {fileIcon(item.file.type)}
                          <div className="truncate">
                            <p className="text-sm font-medium text-gray-900 truncate">{item.file.name}</p>
                            <p className="text-xs text-gray-500">{(item.file.size / 1024 / 1024).toFixed(2)} MB</p>
                          </div>
                        </div>
                        <div className="queue-actions flex-shrink-0 ml-4 flex items-center gap-2">
                          {item.result && <button title="Завантажити результат" onClick={() => exportJson(item.result!.extractedData, item.file.name)}><Download size={16}/></button>}
                          {item.status === 'error' && <button title="Повторити" disabled={isParsing || isQueueActive} onClick={() => setQueue(prev => prev.map(q => q.id === item.id ? { ...q, status: 'pending', error: undefined } : q))}><RotateCcw size={16}/></button>}
                          {!isParsing && !isQueueActive && <button title="Прибрати файл" onClick={() => setQueue(prev => prev.filter(q => q.id !== item.id))}><X size={16}/></button>}
                          <button
                            onClick={() => setPreviewId(item.id)}
                            className="p-1.5 text-gray-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-md transition-colors"
                            title="Попередній перегляд"
                          >
                            <Eye className="w-4 h-4" />
                          </button>
                          {item.status === 'pending' && <span className="text-xs font-medium text-gray-500 bg-gray-200 px-2 py-1 rounded-full">В черзі</span>}
                          {item.status === 'processing' && <span className="flex items-center gap-1 text-xs font-medium text-indigo-600 bg-indigo-100 px-2 py-1 rounded-full"><Loader2 className="w-3 h-3 animate-spin"/> Обробка</span>}
                          {item.status === 'done' && item.result?.status === 'invalid' && <span className="flex items-center gap-1 text-xs font-medium text-red-700 bg-red-100 px-2 py-1 rounded-full"><AlertCircle className="w-3 h-3"/> Схема</span>}
                          {item.status === 'done' && item.result?.status === 'pending_review' && <span className="text-xs font-medium text-amber-800 bg-amber-100 px-2 py-1 rounded-full">На перевірці</span>}
                          {item.status === 'done' && item.result?.status !== 'invalid' && item.result?.status !== 'pending_review' && <span className="flex items-center gap-1 text-xs font-medium text-green-600 bg-green-100 px-2 py-1 rounded-full"><CheckCircle2 className="w-3 h-3"/> Готово</span>}
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
                  <div className="mt-6 flex justify-end items-center gap-3">
                    {!canOperate && <span className="role-note">Роль «Перегляд» не може запускати обробку.</span>}
                    <button
                      onClick={() => setIsQueueActive(true)}
                      disabled={!canOperate || isQueueActive || isParsing || !health?.aiConfigured || (selectedTypeSlug === 'custom' && !customPrompt.trim())}
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
              <aside className="execution-panel corporate-panel"><h3>Параметри обробки</h3><dl><dt>AI-провайдер</dt><dd>{settings ? names[settings.provider] : 'Завантаження…'}</dd><dt>Модель</dt><dd className="mono">{activeProvider?.model || '—'}</dd><dt>Режим</dt><dd>Послідовно, у цій вкладці</dd><dt>Формат результату</dt><dd>За шаблоном (JSON або текст)</dd><dt>Зберігання</dt><dd>{health?.storage === 'local' ? 'Локальний файл' : health?.storage === 'supabase' ? 'Supabase' : 'Не підключено'}</dd></dl><p>Шаблон визначає задачу: витяг у JSON, переклад або summary. Перевірте результат перед передачею в облік.</p></aside>
              </div>
            </div>
          )}

          {activeTab === 'types' && (
            <TemplatesTab documentTypes={documentTypes} builtinSchemas={builtinSchemas} isAdmin={isAdmin} fetchTypes={fetchTypes}
              onDeleted={(slug) => { if (slug && slug === selectedTypeSlug) setSelectedTypeSlug('custom'); }} setError={setError} setNotice={setNotice} />
          )}

          {activeTab === 'history' && (
            <HistoryTab documents={documents} setDocuments={setDocuments} fetchDocuments={fetchDocuments} documentTypes={documentTypes}
              builtinSchemas={builtinSchemas} canOperate={canOperate} guard={guard} setError={setError} setNotice={setNotice} />
          )}

          {activeTab === 'api' && <ApiDocs />}

        </div>
      </main>

      {previewItem && <PreviewModal item={previewItem} onClose={() => setPreviewId(null)} />}
    </div>
  );
}
