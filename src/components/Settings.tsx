import React, { useEffect, useState } from 'react';
import { CheckCircle2, AlertCircle, Loader2, ExternalLink } from 'lucide-react';
export type Provider = 'openai' | 'gemini' | 'anthropic';
export type SettingsData = { companyName: string; provider: Provider; editable: boolean; providers: { id: Provider; model: string; configured: boolean; source: string }[] };
export const names = { openai: 'OpenAI · ChatGPT', gemini: 'Google · Gemini', anthropic: 'Anthropic · Claude' };
const links = { openai: 'https://platform.openai.com/api-keys', gemini: 'https://aistudio.google.com/apikey', anthropic: 'https://console.anthropic.com/settings/keys' };
export default function Settings({ data, onChange }: { data: SettingsData; onChange: (data: SettingsData) => void }) {
  const [company, setCompany] = useState(data.companyName);
  const [primary, setPrimary] = useState(data.provider);
  const [keys, setKeys] = useState<Partial<Record<Provider, string>>>({});
  const [models, setModels] = useState(Object.fromEntries(data.providers.map(p => [p.id, p.model])));
  const [available, setAvailable] = useState<Record<string, string[]>>({});
  const [feedback, setFeedback] = useState<Record<string, { ok: boolean; text: string }>>({});
  const [busy, setBusy] = useState('');
  useEffect(() => { setCompany(data.companyName); setPrimary(data.provider); setModels(Object.fromEntries(data.providers.map(p => [p.id,p.model]))); }, [data]);
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
      const res=await fetch('/api/settings/test',{method:'POST',headers:{'Content-Type':'application/json','X-DocAI-Settings':'1'},body:JSON.stringify({provider})});
      const result=await res.json(); if(!res.ok)throw new Error(result.error);
      setAvailable(prev=>({...prev,[provider]:result.models})); setFeedback(prev=>({...prev,[provider]:{ok:true,text:result.message}}));
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
    <div className="connections-intro"><h3>Підключення AI</h3><p>Збережіть ключ, перевірте доступ і виберіть модель. Порожнє поле ключа зберігає наявне підключення.</p></div>
    {data.providers.map(p=><form key={p.id} className="corporate-panel provider-panel" onSubmit={e=>{e.preventDefault();save(p.id,{connection:{provider:p.id,key:keys[p.id] || '',model:models[p.id]}});}}>
      <div className="panel-title"><h3>{names[p.id]}</h3><span className={`status-label ${p.configured?'configured':''}`}>{p.configured?'Ключ збережено':'Не налаштовано'}</span></div>
      <div className="form-columns"><label>API-ключ {p.source==='environment' && <small>· задано на сервері</small>}<input aria-label={`API-ключ ${p.id}`} type="password" autoComplete="new-password" spellCheck={false} disabled={!data.editable || !!busy || p.source==='environment'} value={keys[p.id] || ''} onChange={e=>setKeys(prev=>({...prev,[p.id]:e.target.value}))} placeholder={p.configured?'Збережений ключ не відображається':'Вставте API-ключ'}/></label>
      <label>Модель<input aria-label={`Модель ${p.id}`} list={`models-${p.id}`} required disabled={!data.editable || !!busy} value={models[p.id] || ''} onChange={e=>setModels(prev=>({...prev,[p.id]:e.target.value}))}/><datalist id={`models-${p.id}`}>{(available[p.id] || []).map(m=><option key={m} value={m}/>)}</datalist></label></div>
      <div className="panel-actions"><a href={links[p.id]} target="_blank" rel="noreferrer">Отримати API-ключ <ExternalLink size={13}/></a><div className="button-group">
        {p.source==='local' && <button type="button" className="text-button danger" disabled={!!busy || !data.editable} onClick={()=>{if(window.confirm('Видалити збережений ключ цього провайдера?'))save(p.id,{connection:{provider:p.id,removeKey:true}});}}>Видалити ключ</button>}
        <button type="button" className="secondary-button" disabled={!data.editable || !p.configured || !!busy || !!keys[p.id]} onClick={()=>test(p.id)}>Перевірити</button>
        <button className="primary-button" disabled={!data.editable || !!busy}>{busy===p.id?<Loader2 size={15} className="animate-spin"/>:null}Зберегти</button></div></div>{message(p.id)}
    </form>)}
    <div className="settings-note"><strong>Як зберігаються ключі</strong><p>У локальному режимі — у зашифрованому файлі на цьому комп’ютері. Вони не повертаються в браузер і не потрапляють у Git. Доступ до комп’ютера та файлу шифрування все одно потрібно захищати. Для сервера компанії використовуйте сховище секретів; ця сторінка ще не замінює авторизацію адміністратора.</p><p>«Перевірити» запитує список моделей без надсилання документів. Успішна перевірка ключа не гарантує доступності конкретної моделі чи достатнього балансу.</p></div>
  </div>;
}
