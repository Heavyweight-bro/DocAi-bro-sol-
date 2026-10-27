import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
export type Provider = 'openai' | 'gemini' | 'anthropic' | 'azure_openai' | 'azure_claude';
export type ModelOption = { id: string; label: string };
export type SettingsData = {
  companyName: string;
  provider: Provider;
  editable: boolean;
  recommendedModels?: Record<Provider, string[]>;
  recommendedModelOptions?: Record<Provider, ModelOption[]>;
  providers: {
    id: Provider;
    model: string;
    endpoint?: string;
    apiVersion?: string;
    needsEndpoint?: boolean;
    configured: boolean;
    source: string;
    endpointSource?: string;
    recommendedModels?: string[];
    recommendedModelOptions?: ModelOption[];
  }[];
};
export const names: Record<Provider, string> = {
  openai: 'OpenAI · ChatGPT',
  gemini: 'Google · Gemini',
  anthropic: 'Anthropic · Claude',
  azure_openai: 'Azure · OpenAI',
  azure_claude: 'Azure · Claude',
};
const links: Record<Provider, string> = {
  openai: 'https://platform.openai.com/api-keys',
  gemini: 'https://aistudio.google.com/apikey',
  anthropic: 'https://console.anthropic.com/settings/keys',
  azure_openai: 'https://portal.azure.com/#view/Microsoft_Azure_ProjectOxford/CognitiveServicesHub/~/OpenAI',
  azure_claude: 'https://ai.azure.com/',
};
const endpointPlaceholders: Partial<Record<Provider, string>> = {
  azure_openai: 'https://my-resource.openai.azure.com',
  azure_claude: 'https://my-resource.services.ai.azure.com',
};
const fallbackOptions: Record<Provider, ModelOption[]> = {
  openai: [
    { id: 'gpt-5.6-luna', label: 'GPT-5.6 Luna · швидка / дешева' },
    { id: 'gpt-5.6-terra', label: 'GPT-5.6 Terra · баланс' },
    { id: 'gpt-5.6', label: 'GPT-5.6 Sol · флагман 5.6' },
    { id: 'gpt-6-astra', label: 'GPT-6 Astra · найпотужніша' },
    { id: 'gpt-4o-mini', label: 'GPT-4o mini · сумісність' },
    { id: 'gpt-4o', label: 'GPT-4o' },
  ],
  gemini: [
    { id: 'gemini-3.8-flash', label: 'Gemini 3.8 Flash · актуальна' },
    { id: 'gemini-3.1-pro', label: 'Gemini 3.1 Pro' },
    { id: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash' },
    { id: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro' },
  ],
  anthropic: [
    { id: 'claude-sonnet-5', label: 'Claude Sonnet 5 · рекомендована' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 · швидка' },
    { id: 'claude-opus-5', label: 'Claude Opus 5' },
    { id: 'claude-fable-5-1', label: 'Claude Fable 5.1 · максимум' },
    { id: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 · legacy' },
  ],
  azure_openai: [
    { id: 'gpt-4o-mini', label: 'Deployment: gpt-4o-mini' },
    { id: 'gpt-4o', label: 'Deployment: gpt-4o' },
    { id: 'gpt-4.1', label: 'Deployment: gpt-4.1' },
    { id: 'gpt-4.1-mini', label: 'Deployment: gpt-4.1-mini' },
  ],
  azure_claude: [
    { id: 'claude-sonnet-4-5', label: 'Claude Sonnet 4.5 (Azure)' },
    { id: 'claude-haiku-4-5', label: 'Claude Haiku 4.5 (Azure)' },
    { id: 'claude-opus-4-1', label: 'Claude Opus 4.1 (Azure)' },
  ],
};
export default function Settings({ data, onChange }: { data: SettingsData; onChange: (data: SettingsData) => void }) {
  const [company, setCompany] = useState(data.companyName);
  const [primary, setPrimary] = useState(data.provider);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [endpoints, setEndpoints] = useState(Object.fromEntries(data.providers.map(p => [p.id, p.endpoint || ''])) as Partial<Record<Provider, string>>);
  const [apiVersions, setApiVersions] = useState(Object.fromEntries(data.providers.map(p => [p.id, p.apiVersion || '2024-08-01-preview'])) as Partial<Record<Provider, string>>);
  const [models, setModels] = useState(Object.fromEntries(data.providers.map(p => [p.id, p.model])));
  const [customModel, setCustomModel] = useState<Partial<Record<Provider, boolean>>>({});
  const [available, setAvailable] = useState<Record<string, string[]>>({});
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => {
    setCompany(data.companyName);
    setPrimary(data.provider);
    setModels(Object.fromEntries(data.providers.map(p => [p.id, p.model])));
    setEndpoints(Object.fromEntries(data.providers.map(p => [p.id, p.endpoint || ''])));
    setApiVersions(Object.fromEntries(data.providers.map(p => [p.id, p.apiVersion || '2024-08-01-preview'])));
  }, [data]);
  const optionsFor = (p: SettingsData['providers'][number]): ModelOption[] => {
    const curated = p.recommendedModelOptions || data.recommendedModelOptions?.[p.id] || fallbackOptions[p.id];
    const labels = new Map(curated.map((m) => [m.id, m.label]));
    const fromApi = available[p.id];
    if (fromApi?.length) {
      return fromApi.map((id) => ({ id, label: labels.get(id) || id }));
    }
    const list = [...curated];
    const current = models[p.id];
    if (current && !list.some((o) => o.id === current)) list.unshift({ id: current, label: `${current} · збережена` });
    return list;
  };
  async function save(scope: string, body: unknown) {
    setBusy(scope); setFeedback(prev => ({ ...prev, [scope]: {ok:true,text:''} }));
    try {
      const res = await fetch('/api/settings', {method:'PUT',headers:{'Content-Type':'application/json','X-DocAI-Settings':'1'},body:JSON.stringify(body)});
      const result = await res.json(); if(!res.ok) throw new Error(result.error);
      onChange(result); setKeys(prev => ({...prev,[scope]:''})); setPrimary(result.provider);
      const switched = scope !== 'workspace' && result.provider === scope && data.provider !== result.provider;
      setFeedback(prev => ({...prev,[scope]:{ok:true,text: switched ? `Збережено. ${names[result.provider as Provider]} обрано провайдером за замовчуванням — можна обробляти документи.` : 'Збережено. Зміни діють для наступного запиту.'}}));
    } catch(e) { setFeedback(prev=>({...prev,[scope]:{ok:false,text:e instanceof Error ? e.message : 'Помилка збереження'}})); }
    finally {setBusy('');}
  }
  async function test(provider: Provider) {
    setBusy(provider);
    try {
      const body: { provider: Provider; key?: string; endpoint?: string; apiVersion?: string } = { provider };
      if (keys[provider]?.trim()) body.key = keys[provider]!.trim();
      if (endpoints[provider]?.trim()) body.endpoint = endpoints[provider]!.trim();
      if (provider === 'azure_openai' && apiVersions[provider]?.trim()) body.apiVersion = apiVersions[provider]!.trim();
      const res=await fetch('/api/settings/test',{method:'POST',headers:{'Content-Type':'application/json','X-DocAI-Settings':'1'},body:JSON.stringify(body)});
      const result=await res.json(); if(!res.ok)throw new Error(result.error);
      setAvailable(prev=>({...prev,[provider]:result.models}));
      setCustomModel(prev=>({...prev,[provider]:false}));
      const nextModel = result.models.includes(models[provider]) ? models[provider] : (result.suggested || result.models[0]);
      if (nextModel) setModels(prev=>({...prev,[provider]:nextModel}));
      if (nextModel && nextModel !== models[provider]) {
        const saveRes = await fetch('/api/settings', {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', 'X-DocAI-Settings': '1' },
          body: JSON.stringify({
            connection: {
              provider,
              model: nextModel,
              key: keys[provider] || '',
              endpoint: endpoints[provider] || undefined,
              apiVersion: provider === 'azure_openai' ? apiVersions[provider] : undefined,
            },
          }),
        });
        const saved = await saveRes.json();
        if (!saveRes.ok) throw new Error(saved.error || 'Не вдалося зберегти доступну модель');
        onChange(saved);
        setPrimary(saved.provider);
        setFeedback(prev=>({...prev,[provider]:{ok:true,text:`${result.message} Збережено модель «${nextModel}».`}}));
      } else {
        setFeedback(prev=>({...prev,[provider]:{ok:true,text:result.message}}));
      }
    }catch(e){setFeedback(prev=>({...prev,[provider]:{ok:false,text:e instanceof Error ? e.message : 'Помилка підключення'}}));}finally{setBusy('');}
  }
  const message=(scope:string)=>feedback[scope]?.text && <div role="status" className={`form-feedback ${feedback[scope].ok?'success':'failure'}`}>{feedback[scope].ok?<CheckCircle2 size={15}/>:<AlertCircle size={15}/>}<span>{feedback[scope].text}</span></div>;
  return <div className="settings-page"><div className="page-heading"><div><h2>Налаштування</h2><p>Назва робочого простору, AI-провайдери та параметри обробки.</p></div></div>
    {!data.editable && <div className="setup-banner">Налаштування доступні для перегляду. На сервері ключі й моделі задає адміністратор через змінні середовища.</div>}
    <form className="corporate-panel workspace-settings" onSubmit={e=>{e.preventDefault();save('workspace',{companyName:company,provider:primary});}}>
      <div className="panel-title"><h3>Робочий простір</h3><span>01</span></div>
      <div className="form-columns"><label>Назва компанії<input required maxLength={80} disabled={!data.editable || !!busy} value={company} onChange={e=>setCompany(e.target.value)}/></label>
      <label>Провайдер за замовчуванням<select value={primary} disabled={!data.editable || !!busy} onChange={e=>setPrimary(e.target.value as Provider)}>{data.providers.map(p=><option key={p.id} value={p.id}>{names[p.id]}{!p.configured?' — ключ не додано':''}</option>)}</select></label></div>
      <div className="panel-actions"><p>Кожен документ надсилається лише обраному провайдеру.</p><button className="primary-button" disabled={!data.editable || !!busy}>Зберегти простір</button></div>{message('workspace')}
    </form>
    <div className="connections-intro"><h3>Підключення AI</h3><p>OpenAI, Gemini, Anthropic або Azure (OpenAI / Claude у AI Foundry). Для Azure потрібні ключ, endpoint і ім’я deployment / model.</p></div>
    {data.providers.map(p=>{
      const options = optionsFor(p);
      const optionIds = options.map((o) => o.id);
      const isCustom = customModel[p.id] || (models[p.id] && !optionIds.includes(models[p.id]));
      const needsEp = p.needsEndpoint || p.id === 'azure_openai' || p.id === 'azure_claude';
      const canTest = data.editable && !busy && (p.configured || (!!keys[p.id]?.trim() && (!needsEp || !!endpoints[p.id]?.trim())));
      return <form key={p.id} className="corporate-panel provider-panel" onSubmit={e=>{e.preventDefault();save(p.id,{connection:{provider:p.id,key:keys[p.id] || '',model:models[p.id],endpoint:needsEp ? (endpoints[p.id] || '') : undefined,apiVersion:p.id==='azure_openai' ? apiVersions[p.id] : undefined}});}}>
      <div className="panel-title"><h3>{names[p.id]}</h3><span className={`status-label ${p.configured?'configured':''}`}>{p.configured?'Ключ збережено':'Не налаштовано'}</span></div>
      <div className="form-columns"><label>API-ключ {p.source==='environment' && <small>· задано на сервері</small>}<input aria-label={`API-ключ ${p.id}`} type="password" autoComplete="new-password" spellCheck={false} disabled={!data.editable || !!busy || p.source==='environment'} value={keys[p.id] || ''} onChange={e=>setKeys(prev=>({...prev,[p.id]:e.target.value}))} placeholder={p.configured?'Збережений ключ не відображається':'Вставте API-ключ'}/></label>
      <label>Модель {needsEp && <small>· ім’я deployment</small>}
        {!isCustom ? (
          <select aria-label={`Модель ${p.id}`} required disabled={!data.editable || !!busy} value={models[p.id] || options[0]?.id || ''} onChange={e=>{
            if (e.target.value === '__custom__') { setCustomModel(prev=>({...prev,[p.id]:true})); return; }
            setModels(prev=>({...prev,[p.id]:e.target.value}));
          }}>
            <optgroup label={available[p.id]?.length ? 'Рекомендовані + з вашого ключа' : 'Актуальні моделі'}>
              {options.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}
            </optgroup>
            <option value="__custom__">Інша модель…</option>
          </select>
        ) : (
          <input aria-label={`Модель ${p.id} вручну`} required disabled={!data.editable || !!busy} value={models[p.id] || ''} onChange={e=>setModels(prev=>({...prev,[p.id]:e.target.value}))} placeholder={needsEp ? 'ім’я deployment у Azure' : 'наприклад gpt-5.6-luna'} list={`models-${p.id}`}/>
        )}
        <datalist id={`models-${p.id}`}>{options.map(m=><option key={m.id} value={m.id}>{m.label}</option>)}</datalist>
        {isCustom && <button type="button" className="text-button" disabled={!!busy} onClick={()=>{setCustomModel(prev=>({...prev,[p.id]:false})); setModels(prev=>({...prev,[p.id]:options[0]?.id||''}));}}>Повернутись до списку</button>}
        <small style={{display:'block',marginTop:6}}>ID: <code>{models[p.id] || '—'}</code></small>
      </label></div>
      {needsEp && (
        <div className="form-columns" style={{marginTop:12}}>
          <label>Endpoint {p.endpointSource==='environment' && <small>· задано на сервері</small>}
            <input
              aria-label={`Endpoint ${p.id}`}
              type="url"
              spellCheck={false}
              disabled={!data.editable || !!busy || p.endpointSource==='environment'}
              value={endpoints[p.id] || ''}
              onChange={e=>setEndpoints(prev=>({...prev,[p.id]:e.target.value}))}
              placeholder={endpointPlaceholders[p.id]}
              required
            />
          </label>
          {p.id === 'azure_openai' && (
            <label>API version
              <input
                aria-label="Azure OpenAI API version"
                spellCheck={false}
                disabled={!data.editable || !!busy}
                value={apiVersions[p.id] || '2024-08-01-preview'}
                onChange={e=>setApiVersions(prev=>({...prev,[p.id]:e.target.value}))}
                placeholder="2024-08-01-preview"
              />
            </label>
          )}
        </div>
      )}
      <div className="panel-actions"><a href={links[p.id]} target="_blank" rel="noreferrer">Отримати API-ключ <ExternalLink size={13}/></a><div className="button-group">
        {p.source==='local' && <button type="button" className="text-button danger" disabled={!!busy || !data.editable} onClick={()=>{if(window.confirm('Видалити збережений ключ цього провайдера?'))save(p.id,{connection:{provider:p.id,removeKey:true}});}}>Видалити ключ</button>}
        <button type="button" className="secondary-button" disabled={!canTest} onClick={()=>test(p.id)}>Перевірити</button>
        <button className="primary-button" disabled={!data.editable || !!busy}>{busy===p.id?<Loader2 size={15} className="animate-spin"/>:null}Зберегти</button></div></div>{message(p.id)}
    </form>;})}
    <div className="settings-note"><strong>Як зберігаються ключі</strong><p>У локальному режимі — у зашифрованому файлі на цьому комп’ютері. Вони не повертаються в браузер і не потрапляють у Git.</p><p>Для Azure OpenAI: endpoint ресурсу + API key + ім’я <em>deployment</em>. Для Azure Claude (AI Foundry): endpoint на кшталт <code>https://….services.ai.azure.com</code> + ключ + model id.</p></div>
  </div>;
}
