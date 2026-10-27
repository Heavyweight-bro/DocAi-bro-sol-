import React, { useEffect, useState } from 'react';
import { AlertCircle, CheckCircle2, Trash2, UserPlus } from 'lucide-react';

type UserRow = { email: string; role: 'viewer' | 'operator' | 'admin'; name?: string; source?: 'environment' | 'local' | 'demo' };
export const roleNames: Record<UserRow['role'], string> = { viewer: 'Перегляд', operator: 'Оператор', admin: 'Адміністратор' };

export default function Users({ editable, currentEmail }: { editable: boolean; currentEmail?: string }) {
  const [users, setUsers] = useState<UserRow[]>([]);
  const [form, setForm] = useState({ email: '', name: '', role: 'operator' as UserRow['role'], password: '' });
  const [feedback, setFeedback] = useState<{ ok: boolean; text: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const res = await fetch('/api/users');
    const data = await res.json().catch(() => ({}));
    if (res.ok) setUsers(data.users || []);
    else setFeedback({ ok: false, text: data.error || 'Не вдалося завантажити користувачів' });
  };
  useEffect(() => { void load(); }, []);

  const save = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setFeedback(null);
    try {
      const res = await fetch('/api/users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...form, password: form.password || undefined }) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setFeedback({ ok: true, text: `Збережено: ${data.email} (${roleNames[data.role as UserRow['role']]})` });
      setForm({ email: '', name: '', role: 'operator', password: '' });
      await load();
    } catch (err) {
      setFeedback({ ok: false, text: err instanceof Error ? err.message : 'Помилка збереження' });
    } finally { setBusy(false); }
  };

  const remove = async (email: string) => {
    if (!confirm(`Видалити доступ для ${email}?`)) return;
    const res = await fetch(`/api/users/${encodeURIComponent(email)}`, { method: 'DELETE' });
    const data = await res.json().catch(() => ({}));
    setFeedback(res.ok ? { ok: true, text: `Видалено: ${email}` } : { ok: false, text: data.error || 'Не вдалося видалити' });
    await load();
  };

  return (
    <section className="corporate-panel users-panel">
      <div className="panel-title"><h3>Користувачі та ролі</h3><span>{editable ? 'Локальний файл користувачів' : 'Керуються через DOCAI_USERS на сервері'}</span></div>
      <p className="settings-note"><strong>Перегляд</strong> — читає документи й шаблони. <strong>Оператор</strong> — обробляє, редагує й підтверджує документи. <strong>Адміністратор</strong> — шаблони, налаштування, користувачі, аудит.</p>
      <table className="users-table">
        <thead><tr><th>Email</th><th>Ім’я</th><th>Роль</th><th>Джерело</th><th /></tr></thead>
        <tbody>
          {users.map(u => (
            <tr key={u.email}>
              <td>{u.email}{u.email === currentEmail && <em> (ви)</em>}</td>
              <td>{u.name || '—'}</td>
              <td>{roleNames[u.role]}</td>
              <td>{u.source === 'environment' ? 'Середовище' : u.source === 'demo' ? 'Тестовий вхід' : 'Локально'}</td>
              <td>{editable && u.source === 'local' && u.email !== currentEmail && <button aria-label={`Видалити ${u.email}`} className="text-button danger" onClick={() => remove(u.email)}><Trash2 size={14} /></button>}</td>
            </tr>
          ))}
          {!users.length && <tr><td colSpan={5}>Користувачів ще немає — зараз працює локальний режим без входу.</td></tr>}
        </tbody>
      </table>
      {editable && (
        <form className="form-columns users-form" onSubmit={save}>
          <label>Email<input type="email" required value={form.email} onChange={e => setForm({ ...form, email: e.target.value })} /></label>
          <label>Ім’я<input value={form.name} onChange={e => setForm({ ...form, name: e.target.value })} /></label>
          <label>Роль<select value={form.role} onChange={e => setForm({ ...form, role: e.target.value as UserRow['role'] })}>
            <option value="viewer">Перегляд</option><option value="operator">Оператор</option><option value="admin">Адміністратор</option>
          </select></label>
          <label>Пароль<input type="password" autoComplete="new-password" minLength={10} placeholder="Мін. 10 символів; порожнє — не змінювати" value={form.password} onChange={e => setForm({ ...form, password: e.target.value })} /></label>
          <div className="panel-actions"><p>Перший створений користувач вмикає обов’язковий вхід для всіх.</p><button className="primary-button" disabled={busy}><UserPlus size={15} />Зберегти користувача</button></div>
        </form>
      )}
      {feedback && <p className={`form-feedback ${feedback.ok ? 'success' : 'failure'}`}>{feedback.ok ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}{feedback.text}</p>}
    </section>
  );
}
