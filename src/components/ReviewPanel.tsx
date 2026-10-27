import React, { useEffect, useMemo, useState } from 'react';
import { AlertCircle, AlertTriangle, CheckCircle2, Copy, Download, FileSpreadsheet, FileText, Loader2, PanelLeftClose, PanelLeftOpen, Plus, Save, Trash2, Undo2, XCircle } from 'lucide-react';
import { cn } from '../lib/utils';
import { coerceInput, formatPath, getIn, isPlainObject, isScalar, setIn, type FieldHint, type PathPart } from '../lib/fields';
import { exportDocumentXlsx, exportJson } from '../lib/export';

export type Issue = { path: string; message: string; severity?: 'error' | 'warning' };
export type ReviewDoc = {
  id: number;
  originalName: string;
  mimeType: string;
  typeSlug: string;
  createdAt: string;
  extractedData: any;
  status?: string;
  validationErrors?: Issue[];
  errorMessage?: string;
  storagePath?: string;
  editedBy?: string;
  editedAt?: string;
  reviewedBy?: string;
  reviewedAt?: string;
  createdBy?: string;
};
export type SchemaField = { path: string; type?: string; format?: string; label?: string; required?: boolean };

type Props = {
  doc: ReviewDoc;
  schemaFields: SchemaField[] | null;
  canOperate: boolean;
  statusLabel: (status?: string) => { text: string; className: string };
  guard: (res: Response) => Promise<Response>;
  onSaved: (doc: ReviewDoc) => void;
  onReview: (doc: ReviewDoc, action: 'approve' | 'reject') => Promise<void>;
  onError: (message: string) => void;
  onNotice: (message: string) => void;
};

const isText = (v: any): v is { format: 'text'; content: string } => isPlainObject(v) && v.format === 'text' && typeof v.content === 'string';

/** Keeps raw text while typing (so "12," is not eaten) and commits a typed value on blur / Enter. */
function ScalarInput({ value, hint, readOnly, label, onCommit }: { value: unknown; hint?: FieldHint; readOnly: boolean; label: string; onCommit: (v: unknown) => void }) {
  const shown = value == null ? '' : String(value);
  const [text, setText] = useState(shown);
  useEffect(() => setText(shown), [shown]);
  if (typeof value === 'boolean' || hint?.type === 'boolean') {
    return (
      <select aria-label={label} disabled={readOnly} value={value == null ? '' : String(value)} onChange={e => onCommit(e.target.value === '' ? null : e.target.value === 'true')}>
        <option value="">—</option><option value="true">Так</option><option value="false">Ні</option>
      </select>
    );
  }
  const numeric = typeof value === 'number' || hint?.type === 'number' || hint?.format === 'money';
  const commit = () => { if (text !== shown) onCommit(coerceInput(text, value, hint)); };
  return (
    <input
      aria-label={label}
      readOnly={readOnly}
      inputMode={numeric ? 'decimal' : undefined}
      className={cn(numeric && 'numeric')}
      placeholder={hint?.format === 'date' ? 'YYYY-MM-DD' : hint?.format === 'currency' ? 'UAH' : '—'}
      value={text}
      onChange={e => setText(e.target.value)}
      onBlur={commit}
      onKeyDown={e => { if (e.key === 'Enter') { (e.target as HTMLInputElement).blur(); } }}
    />
  );
}

export default function ReviewPanel({ doc, schemaFields, canOperate, statusLabel, guard, onSaved, onReview, onError, onNotice }: Props) {
  const [draft, setDraft] = useState<any>(doc.extractedData);
  const [view, setView] = useState<'fields' | 'json'>('fields');
  const [jsonText, setJsonText] = useState('');
  const [showOriginal, setShowOriginal] = useState(() => typeof window === 'undefined' || window.innerWidth > 1100);
  const [original, setOriginal] = useState<'loading' | 'ok' | 'missing'>('loading');
  const [busy, setBusy] = useState<'' | 'save' | 'approve' | 'reject'>('');

  useEffect(() => { setDraft(doc.extractedData); setJsonText(JSON.stringify(doc.extractedData, null, 2)); }, [doc.id, doc.extractedData]);
  const fileUrl = `/api/documents/${doc.id}/file`;
  useEffect(() => {
    let alive = true;
    setOriginal('loading');
    fetch(fileUrl, { method: 'HEAD' }).then(r => alive && setOriginal(r.ok ? 'ok' : 'missing')).catch(() => alive && setOriginal('missing'));
    return () => { alive = false; };
  }, [fileUrl]);

  const dirty = useMemo(() => JSON.stringify(draft) !== JSON.stringify(doc.extractedData), [draft, doc.extractedData]);
  const readOnly = !canOperate || doc.status === 'approved' || doc.status === 'failed';
  const issues = doc.validationErrors || [];
  const errors = issues.filter(i => i.severity !== 'warning');
  const warnings = issues.filter(i => i.severity === 'warning');
  const hints = useMemo(() => new Map((schemaFields || []).map(f => [f.path, f])), [schemaFields]);
  const issuesAt = (path: string) => issues.filter(i => i.path === path);
  const hintFor = (parts: PathPart[]) => hints.get(parts.filter(p => typeof p === 'string').join('.'));
  const labelFor = (parts: PathPart[]) => hintFor(parts)?.label || String(parts[parts.length - 1]);
  const update = (parts: PathPart[], value: unknown) => setDraft((prev: any) => setIn(prev, parts, value));

  const missing = (schemaFields || []).filter(f => f.required && getIn(draft, f.path.split('.')) === undefined && f.type !== 'object' && f.type !== 'array');

  const save = async () => {
    setBusy('save');
    try {
      const res = await guard(await fetch(`/api/documents/${doc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extractedData: draft }) }));
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Не вдалося зберегти');
      onSaved(data);
      onNotice(data.status === 'invalid' ? 'Збережено. Схема ще не пройдена — перевірте позначені поля' : 'Збережено й перевірено повторно');
    } catch (e) {
      onError(e instanceof Error ? e.message : 'Не вдалося зберегти');
    } finally { setBusy(''); }
  };

  const review = async (action: 'approve' | 'reject') => {
    setBusy(action);
    try { await onReview(doc, action); } finally { setBusy(''); }
  };

  const applyJson = () => {
    try {
      const parsed = JSON.parse(jsonText);
      if (!isPlainObject(parsed)) throw new Error('Очікується JSON-об’єкт');
      setDraft(parsed);
      setView('fields');
    } catch (e) {
      onError(`JSON не розпізнано: ${e instanceof Error ? e.message : e}`);
    }
  };

  const issueNote = (path: string) => issuesAt(path).map((i, k) => (
    <small key={k} className={i.severity === 'warning' ? 'field-warning' : 'field-error'}>{i.message}</small>
  ));
  const rowClass = (path: string) => cn('field-row', issuesAt(path).some(i => i.severity !== 'warning') && 'has-error', issuesAt(path).some(i => i.severity === 'warning') && 'has-warning');

  const renderNode = (value: any, parts: PathPart[], depth: number): React.ReactNode => {
    const path = formatPath(parts);
    const key = String(parts[parts.length - 1]);
    if (isScalar(value)) {
      return (
        <div className={rowClass(path)} key={path}>
          <label title={path}>{labelFor(parts)}{hintFor(parts)?.required && <b aria-hidden> *</b>}<code>{path}</code></label>
          <div><ScalarInput value={value} hint={hintFor(parts)} readOnly={readOnly} label={path} onCommit={v => update(parts, v)} />{issueNote(path)}</div>
        </div>
      );
    }
    if (Array.isArray(value)) {
      if (value.length && value.every(isPlainObject)) {
        const columns = [...new Set(value.flatMap((r: any) => Object.keys(r)))];
        return (
          <div className={cn('field-group', issuesAt(path).length && 'has-error')} key={path}>
            <div className="field-group-title"><span>{labelFor(parts)} <code>{path}</code></span><em>{value.length} рядк.</em></div>
            {issueNote(path)}
            <div className="field-table-wrap">
              <table className="field-table">
                <thead><tr><th>№</th>{columns.map(c => <th key={c}>{c}</th>)}{!readOnly && <th />}</tr></thead>
                <tbody>
                  {value.map((row: any, i: number) => (
                    <tr key={i}>
                      <td className="idx">{i + 1}</td>
                      {columns.map(c => {
                        const cellPath = formatPath([...parts, i, c]);
                        const cellIssues = issuesAt(cellPath);
                        return (
                          <td key={c} className={cn(cellIssues.some(x => x.severity !== 'warning') && 'has-error', cellIssues.some(x => x.severity === 'warning') && 'has-warning')} title={cellIssues.map(x => x.message).join('\n') || undefined}>
                            {isScalar(row[c])
                              ? <ScalarInput value={row[c]} readOnly={readOnly} label={cellPath} onCommit={v => update([...parts, i, c], v)} />
                              : <span className="nested">{JSON.stringify(row[c])}</span>}
                          </td>
                        );
                      })}
                      {!readOnly && <td><button className="icon-button" aria-label={`Видалити рядок ${i + 1}`} onClick={() => update(parts, value.filter((_: any, k: number) => k !== i))}><Trash2 size={13} /></button></td>}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            {value.some((_: any, i: number) => columns.some(c => issuesAt(formatPath([...parts, i, c])).length)) && (
              <ul className="cell-issues">{value.flatMap((_: any, i: number) => columns.flatMap(c => issuesAt(formatPath([...parts, i, c])).map((x, k) => <li key={`${i}-${c}-${k}`} className={x.severity === 'warning' ? 'field-warning' : 'field-error'}>{x.message}</li>)))}</ul>
            )}
            {!readOnly && <button className="text-button add-row" onClick={() => update(parts, [...value, Object.fromEntries(columns.map(c => [c, null]))])}><Plus size={13} /> Додати рядок</button>}
          </div>
        );
      }
      return (
        <div className={cn('field-group', issuesAt(path).length && 'has-error')} key={path}>
          <div className="field-group-title"><span>{labelFor(parts)} <code>{path}</code></span><em>{value.length ? `${value.length} ел.` : 'порожньо'}</em></div>
          {issueNote(path)}
          {value.map((item: any, i: number) => renderNode(item, [...parts, i], depth + 1))}
        </div>
      );
    }
    if (isPlainObject(value)) {
      const entries = Object.entries(value).filter(([k]) => !k.startsWith('_'));
      if (depth === 0) return entries.map(([k, v]) => renderNode(v, [...parts, k], depth + 1));
      return (
        <fieldset className={cn('field-group', issuesAt(path).length && 'has-error')} key={path}>
          <div className="field-group-title"><span>{labelFor(parts)} <code>{path}</code></span></div>
          {issueNote(path)}
          {entries.map(([k, v]) => renderNode(v, [...parts, k], depth + 1))}
        </fieldset>
      );
    }
    return <div key={key}>{String(value)}</div>;
  };

  const status = statusLabel(doc.status);
  const mime = doc.mimeType || '';
  const canApprove = canOperate && !dirty && (doc.status === 'pending_review' || doc.status === 'completed');
  const canReject = canOperate && !dirty && !!doc.status && !['rejected', 'failed'].includes(doc.status);

  return (
    <div className="review-panel">
      <div className="review-toolbar">
        <div className="review-title">
          <strong title={doc.originalName}>{doc.originalName}</strong>
          <span className={cn('status-pill', status.className)}>{status.text}</span>
          <small>#{doc.id} · {doc.typeSlug} · {new Date(doc.createdAt).toLocaleString('uk-UA')}</small>
        </div>
        <div className="review-tools">
          <button className="icon-button" onClick={() => setShowOriginal(v => !v)} title={showOriginal ? 'Сховати оригінал' : 'Показати оригінал'} aria-label={showOriginal ? 'Сховати оригінал' : 'Показати оригінал'}>{showOriginal ? <PanelLeftClose size={16} /> : <PanelLeftOpen size={16} />}</button>
          <button className="icon-button" title="Копіювати JSON" aria-label="Копіювати JSON" onClick={async () => { try { await navigator.clipboard.writeText(isText(draft) ? draft.content : JSON.stringify(draft, null, 2)); onNotice('Скопійовано'); } catch { onError('Не вдалося скопіювати'); } }}><Copy size={16} /></button>
          <button className="icon-button" title="Завантажити JSON / TXT" aria-label="Завантажити JSON" onClick={() => exportJson(draft, doc.originalName)}><Download size={16} /></button>
          <button className="icon-button" title="Завантажити Excel" aria-label="Завантажити Excel" onClick={() => exportDocumentXlsx({ ...doc, extractedData: draft }).catch(() => onError('Не вдалося сформувати Excel'))}><FileSpreadsheet size={16} /></button>
        </div>
      </div>

      {(doc.editedBy || doc.reviewedBy) && (
        <p className="review-meta">
          {doc.editedBy && <>Виправлено вручну: {doc.editedBy}{doc.editedAt ? `, ${new Date(doc.editedAt).toLocaleString('uk-UA')}` : ''}. </>}
          {doc.reviewedBy && <>Рішення: {doc.reviewedBy}{doc.reviewedAt ? `, ${new Date(doc.reviewedAt).toLocaleString('uk-UA')}` : ''}.</>}
        </p>
      )}

      {(errors.length > 0 || warnings.length > 0 || (doc.status === 'failed' && doc.errorMessage)) && (
        <div className={cn('review-issues', errors.length || doc.status === 'failed' ? 'is-error' : 'is-warning')}>
          {doc.status === 'failed' && <p><AlertCircle size={14} /> {doc.errorMessage}</p>}
          {errors.length > 0 && <p><AlertCircle size={14} /> <strong>Схема не пройдена — у CRM не відправляти.</strong> Виправте поля, позначені червоним{dirty ? ', і збережіть' : ''}.</p>}
          {warnings.length > 0 && <p><AlertTriangle size={14} /> Попередження ({warnings.length}): перевірте позначені жовтим значення.</p>}
          {dirty && issues.length > 0 && <p className="muted">Позначки показують стан останнього збереження.</p>}
        </div>
      )}

      <div className={cn('review-body', showOriginal && 'with-original')}>
        {showOriginal && (
          <div className="review-original">
            {original === 'loading' && <div className="original-empty"><Loader2 className="animate-spin" size={18} /></div>}
            {original === 'missing' && <div className="original-empty"><FileText size={28} /><p>Оригінал недоступний</p><small>Старий запис, файл видалено за терміном зберігання або архів вимкнено.</small></div>}
            {original === 'ok' && (mime.startsWith('image/')
              ? <img src={fileUrl} alt={`Оригінал: ${doc.originalName}`} />
              : /pdf|text|json|csv/.test(mime)
                ? <iframe src={fileUrl} title={`Оригінал: ${doc.originalName}`} />
                : <div className="original-empty"><FileText size={28} /><p>Попередній перегляд для цього формату недоступний</p><a className="secondary-button" href={`${fileUrl}?download=1`}>Завантажити оригінал</a></div>)}
          </div>
        )}
        <div className="review-fields">
          <div className="segmented" role="tablist">
            <button role="tab" aria-selected={view === 'fields'} className={cn(view === 'fields' && 'active')} onClick={() => setView('fields')}>Поля</button>
            <button role="tab" aria-selected={view === 'json'} className={cn(view === 'json' && 'active')} onClick={() => { setJsonText(JSON.stringify(draft, null, 2)); setView('json'); }}>JSON</button>
          </div>
          {view === 'json' ? (
            <div className="json-editor">
              <textarea aria-label="JSON документа" readOnly={readOnly} spellCheck={false} value={jsonText} onChange={e => setJsonText(e.target.value)} />
              {!readOnly && <button className="secondary-button" onClick={applyJson}>Застосувати JSON</button>}
            </div>
          ) : isText(draft) ? (
            <textarea className="text-result" aria-label="Текст результату" readOnly={readOnly} value={draft.content} onChange={e => setDraft({ ...draft, content: e.target.value })} />
          ) : (
            <div className="field-list">
              {missing.length > 0 && (
                <div className="field-group has-error">
                  <div className="field-group-title"><span>Відсутні обов’язкові поля</span></div>
                  {missing.map(f => (
                    <div className="field-row has-error" key={f.path}>
                      <label>{f.label || f.path}<b aria-hidden> *</b><code>{f.path}</code></label>
                      <div><ScalarInput value={null} hint={f} readOnly={readOnly} label={f.path} onCommit={v => update(f.path.split('.'), v)} /></div>
                    </div>
                  ))}
                </div>
              )}
              {isPlainObject(draft) ? renderNode(draft, [], 0) : <pre>{JSON.stringify(draft, null, 2)}</pre>}
            </div>
          )}
        </div>
      </div>

      {canOperate && (
        <div className="review-actions">
          {dirty && <button className="secondary-button" onClick={() => setDraft(doc.extractedData)} disabled={!!busy}><Undo2 size={15} /> Скасувати зміни</button>}
          {!readOnly && <button className="secondary-button" onClick={save} disabled={!dirty || !!busy}>{busy === 'save' ? <Loader2 size={15} className="animate-spin" /> : <Save size={15} />} Зберегти й перевірити</button>}
          <span className="spacer" />
          {canReject && <button className="secondary-button" onClick={() => review('reject')} disabled={!!busy}><XCircle size={15} /> Відхилити</button>}
          <button className="primary-button" onClick={() => review('approve')} disabled={!canApprove || !!busy} title={dirty ? 'Спочатку збережіть зміни' : doc.status === 'invalid' ? 'Спочатку виправте поля' : undefined}>
            {busy === 'approve' ? <Loader2 size={15} className="animate-spin" /> : <CheckCircle2 size={15} />} Підтвердити
          </button>
        </div>
      )}
    </div>
  );
}
