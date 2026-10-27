import React, { useState } from 'react';
import { AlertCircle, FileText, Loader2, LogIn } from 'lucide-react';

export type AuthState = {
  authenticated: boolean;
  user: { email: string; role: 'viewer' | 'operator' | 'admin'; name?: string; kind: 'user' | 'integration' | 'local' } | null;
  loginRequired: boolean;
  usersConfigured: boolean;
  usersEditable: boolean;
  sessionReady: boolean;
  demoLogin?: boolean;
  companyName?: string;
};

export default function Login({ auth, onLoggedIn }: { auth: AuthState; onLoggedIn: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true); setError('');
    try {
      const res = await fetch('/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email, password }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Не вдалося увійти');
      setPassword('');
      onLoggedIn();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Не вдалося увійти');
    } finally {
      setBusy(false);
    }
  };

  const setupHint = !auth.usersConfigured
    ? auth.usersEditable
      ? 'Користувачів ще немає. Створіть адміністратора командою: npm run user -- add you@company.ua admin'
      : 'Користувачів не налаштовано. Адміністратор має задати DOCAI_USERS і DOCAI_SESSION_SECRET у середовищі сервера.'
    : !auth.sessionReady
      ? 'Вхід вимкнено: на сервері не задано DOCAI_SESSION_SECRET (щонайменше 32 символи).'
      : '';

  return (
    <div className="login-shell">
      <form className="login-card" onSubmit={submit} aria-label="Вхід">
        <div className="login-brand"><span className="brand-icon"><FileText size={22} /></span><strong>{auth.companyName || 'Doc.AI'}</strong></div>
        <h2>Вхід у робочий простір</h2>
        <p>Документи й шаблони доступні лише співробітникам компанії.</p>
        {auth.demoLogin && <p className="demo-hint">Тестовий вхід: <b>admin</b> / <b>admin</b> (лише локально)</p>}
        {setupHint && <div className="setup-banner"><AlertCircle size={16} /><span>{setupHint}</span></div>}
        <label>Email або логін<input type="text" autoComplete="username" autoCapitalize="none" spellCheck={false} required value={email} onChange={e => setEmail(e.target.value)} /></label>
        <label>Пароль<input type="password" autoComplete="current-password" required value={password} onChange={e => setPassword(e.target.value)} /></label>
        {error && <p role="alert" className="form-feedback failure"><AlertCircle size={14} />{error}</p>}
        <button className="primary-button" type="submit" disabled={busy || !auth.usersConfigured || !auth.sessionReady}>
          {busy ? <Loader2 size={15} className="animate-spin" /> : <LogIn size={15} />} Увійти
        </button>
      </form>
    </div>
  );
}
