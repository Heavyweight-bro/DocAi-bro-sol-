import './config';
import { createHash, createHmac, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import type { NextFunction, Request, Response } from 'express';
import { logIntegrationAccess, rateLimitOk, verifyIntegrationKey, extractBearer } from './integration';

/**
 * Users, sessions and roles.
 * - Users: DOCAI_USERS (JSON, production) and/or LOCAL_SETTINGS_DIR/users.json (development, managed from UI/CLI).
 * - Sessions: stateless HMAC-signed HttpOnly cookie; role is re-read from the user record on every request.
 * - Integrations: Bearer key → operator-level principal.
 * - Local open mode: development without any users, loopback socket only → local admin (keeps first-run simple).
 */

export const roles = ['viewer', 'operator', 'admin'] as const;
export type Role = typeof roles[number];
export const isRole = (value: unknown): value is Role => roles.includes(value as Role);
const rank: Record<Role, number> = { viewer: 1, operator: 2, admin: 3 };

export type UserRecord = { email: string; role: Role; passwordHash: string; name?: string; createdAt?: string };
export type Principal = {
  kind: 'user' | 'integration' | 'local';
  email: string;
  role: Role;
  name?: string;
};

const settingsDir = () => path.resolve(process.env.LOCAL_SETTINGS_DIR || '.data/settings');
const usersFile = () => path.join(settingsDir(), 'users.json');
const secretFile = () => path.join(settingsDir(), 'session.key');
export const sessionCookie = 'docai_session';
const sessionTtlMs = Math.max(15, Number(process.env.DOCAI_SESSION_TTL_MIN || 720)) * 60_000;

export const isProductionLike = () => process.env.NODE_ENV === 'production' || !!process.env.VERCEL;
/** Users can be managed from the UI only where the users file is durable and private. */
export const usersEditable = () => !isProductionLike();

// ---------- password hashing ----------

export function hashPassword(password: string) {
  if (typeof password !== 'string' || password.length < 10) throw new Error('Пароль: щонайменше 10 символів');
  const salt = randomBytes(16);
  const key = scryptSync(password, salt, 64, { N: 16384, r: 8, p: 1 });
  return `scrypt$${salt.toString('base64')}$${key.toString('base64')}`;
}

const dummyHash = `scrypt$${Buffer.alloc(16).toString('base64')}$${Buffer.alloc(64).toString('base64')}`;

export function verifyPassword(password: string, stored: string) {
  const [scheme, saltB64, keyB64] = (stored || dummyHash).split('$');
  if (scheme !== 'scrypt' || !saltB64 || !keyB64) return false;
  const expected = Buffer.from(keyB64, 'base64');
  const actual = scryptSync(String(password || ''), Buffer.from(saltB64, 'base64'), expected.length, { N: 16384, r: 8, p: 1 });
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

// ---------- user store ----------

function normalizeEmail(email: unknown) {
  return typeof email === 'string' ? email.trim().toLowerCase() : '';
}

function envUsers(): UserRecord[] {
  const raw = (process.env.DOCAI_USERS || '').trim();
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) throw new Error('not an array');
    return parsed
      .filter((u) => u && normalizeEmail(u.email) && isRole(u.role) && typeof u.passwordHash === 'string')
      .map((u) => ({ email: normalizeEmail(u.email), role: u.role, passwordHash: u.passwordHash, name: u.name }));
  } catch (e) {
    console.error('[auth] DOCAI_USERS is not valid JSON array:', e instanceof Error ? e.message : e);
    return [];
  }
}

/**
 * Test login "admin" / "admin" for local demos: DOCAI_DEMO_ADMIN=true.
 * Refused in production-like environments (NODE_ENV=production or Vercel) no matter what the variable says.
 */
let demoHash = '';
let demoWarned = false;
function demoUsers(): UserRecord[] {
  if (process.env.DOCAI_DEMO_ADMIN !== 'true') return [];
  if (isProductionLike()) {
    if (!demoWarned) { demoWarned = true; console.error('[auth] DOCAI_DEMO_ADMIN ignored: the admin/admin test login is never enabled in production.'); }
    return [];
  }
  if (!demoHash) {
    const salt = randomBytes(16);
    demoHash = `scrypt$${salt.toString('base64')}$${scryptSync('admin', salt, 64, { N: 16384, r: 8, p: 1 }).toString('base64')}`;
  }
  return [{ email: 'admin', role: 'admin', name: 'Тестовий адміністратор', passwordHash: demoHash }];
}

function fileUsers(): UserRecord[] {
  if (!usersEditable() || !existsSync(usersFile())) return [];
  try {
    const data = JSON.parse(readFileSync(usersFile(), 'utf8'));
    return Array.isArray(data.users) ? data.users.filter((u: any) => u && normalizeEmail(u.email) && isRole(u.role)) : [];
  } catch {
    return [];
  }
}

function writeFileUsers(users: UserRecord[]) {
  mkdirSync(settingsDir(), { recursive: true, mode: 0o700 });
  writeFileSync(usersFile() + '.tmp', JSON.stringify({ users }, null, 2), { mode: 0o600 });
  renameSync(usersFile() + '.tmp', usersFile());
}

export function listUsers(): (UserRecord & { source: 'environment' | 'local' | 'demo' })[] {
  const byEmail = new Map<string, UserRecord & { source: 'environment' | 'local' | 'demo' }>();
  for (const u of demoUsers()) byEmail.set(u.email, { ...u, source: 'demo' });
  for (const u of fileUsers()) byEmail.set(u.email, { ...u, source: 'local' });
  for (const u of envUsers()) byEmail.set(u.email, { ...u, source: 'environment' }); // env wins
  return [...byEmail.values()];
}

export function findUser(email: string) {
  const key = normalizeEmail(email);
  return listUsers().find((u) => u.email === key) || null;
}

export const usersConfigured = () => listUsers().length > 0;

export function publicUser(u: UserRecord & { source?: string }) {
  return { email: u.email, role: u.role, name: u.name, source: u.source, createdAt: u.createdAt };
}

export function upsertLocalUser(input: { email: unknown; role: unknown; password?: unknown; name?: unknown }) {
  if (!usersEditable()) throw Object.assign(new Error('Користувачі на сервері задаються змінною DOCAI_USERS.'), { status: 403 });
  const email = normalizeEmail(input.email);
  if (!/^[^\s@]+@[^\s@]+$/.test(email) || email.length > 160) throw Object.assign(new Error('Вкажіть коректний email'), { status: 400 });
  if (!isRole(input.role)) throw Object.assign(new Error('Роль: viewer, operator або admin'), { status: 400 });
  if (envUsers().some((u) => u.email === email)) throw Object.assign(new Error('Цього користувача задано в DOCAI_USERS'), { status: 409 });
  if (demoUsers().some((u) => u.email === email)) throw Object.assign(new Error('Це тестовий вхід admin/admin — його не редагують'), { status: 409 });
  const users = fileUsers();
  const existing = users.find((u) => u.email === email);
  const name = typeof input.name === 'string' ? input.name.trim().slice(0, 80) || undefined : existing?.name;
  if (!existing && typeof input.password !== 'string') throw Object.assign(new Error('Для нового користувача потрібен пароль'), { status: 400 });
  let passwordHash = existing?.passwordHash || '';
  if (typeof input.password === 'string' && input.password) {
    try { passwordHash = hashPassword(input.password); } catch (e: any) { throw Object.assign(e, { status: 400 }); }
  }
  const record: UserRecord = { email, role: input.role, passwordHash, name, createdAt: existing?.createdAt || new Date().toISOString() };
  const next = existing ? users.map((u) => (u.email === email ? record : u)) : [...users, record];
  if (!next.some((u) => u.role === 'admin') && !envUsers().some((u) => u.role === 'admin') && !demoUsers().length) {
    throw Object.assign(new Error('Має залишитися хоча б один адміністратор'), { status: 400 });
  }
  writeFileUsers(next);
  return publicUser({ ...record, source: 'local' });
}

export function deleteLocalUser(emailRaw: unknown) {
  if (!usersEditable()) throw Object.assign(new Error('Користувачі на сервері задаються змінною DOCAI_USERS.'), { status: 403 });
  const email = normalizeEmail(emailRaw);
  const users = fileUsers();
  if (!users.some((u) => u.email === email)) throw Object.assign(new Error('Користувача не знайдено'), { status: 404 });
  const next = users.filter((u) => u.email !== email);
  if (next.length && !next.some((u) => u.role === 'admin') && !envUsers().some((u) => u.role === 'admin') && !demoUsers().length) {
    throw Object.assign(new Error('Не можна видалити останнього адміністратора'), { status: 400 });
  }
  writeFileUsers(next);
}

// ---------- sessions ----------

let cachedSecret: Buffer | null = null;
function sessionSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  const fromEnv = (process.env.DOCAI_SESSION_SECRET || '').trim();
  if (fromEnv.length >= 32) return (cachedSecret = Buffer.from(fromEnv, 'utf8'));
  if (isProductionLike()) {
    // No durable secret in production → sessions cannot be issued (login is refused with a clear message).
    throw Object.assign(new Error('Задайте DOCAI_SESSION_SECRET (щонайменше 32 символи) для входу користувачів.'), { status: 503 });
  }
  mkdirSync(settingsDir(), { recursive: true, mode: 0o700 });
  if (!existsSync(secretFile())) writeFileSync(secretFile(), randomBytes(48), { mode: 0o600, flag: 'wx' });
  return (cachedSecret = readFileSync(secretFile()));
}

/** Short fingerprint of the password hash: changing the password invalidates old sessions. */
const passwordVersion = (u: UserRecord) => createHash('sha256').update(u.passwordHash).digest('base64url').slice(0, 10);

function sign(payload: string) {
  return createHmac('sha256', sessionSecret()).update(payload).digest('base64url');
}

export function issueSession(user: UserRecord) {
  const payload = Buffer.from(JSON.stringify({ e: user.email, v: passwordVersion(user), x: Date.now() + sessionTtlMs })).toString('base64url');
  return `${payload}.${sign(payload)}`;
}

function readCookie(req: Request, name: string) {
  const header = req.headers.cookie || '';
  for (const part of header.split(';')) {
    const [k, ...rest] = part.trim().split('=');
    if (k === name) return decodeURIComponent(rest.join('='));
  }
  return '';
}

export function userFromSession(req: Request): (UserRecord & { source: string }) | null {
  const token = readCookie(req, sessionCookie);
  if (!token || !token.includes('.')) return null;
  const [payload, mac] = token.split('.');
  let expected: string;
  try { expected = sign(payload); } catch { return null; }
  const a = Buffer.from(mac);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    const data = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8'));
    if (typeof data.x !== 'number' || data.x < Date.now()) return null;
    const user = findUser(data.e);
    if (!user || passwordVersion(user) !== data.v) return null;
    return user;
  } catch {
    return null;
  }
}

function secureCookie(req: Request) {
  // DOCAI_COOKIE_SECURE=false only for a trusted internal network served over plain http.
  if (process.env.DOCAI_COOKIE_SECURE === 'false') return false;
  return req.secure || (process.env.APP_ORIGIN || '').startsWith('https://') || isProductionLike();
}

export function setSessionCookie(req: Request, res: Response, token: string) {
  res.cookie(sessionCookie, token, { httpOnly: true, sameSite: 'strict', secure: secureCookie(req), maxAge: sessionTtlMs, path: '/' });
}

export function clearSessionCookie(req: Request, res: Response) {
  res.clearCookie(sessionCookie, { httpOnly: true, sameSite: 'strict', secure: secureCookie(req), path: '/' });
}

// ---------- local open mode ----------

/** True only for a request that physically comes from this machine to a localhost Host header. */
export function isLoopbackRequest(req: Request) {
  const local = ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.socket.remoteAddress || '');
  const host = req.headers.host || '';
  return local && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(host);
}

export function localOpenMode(req: Request) {
  return !isProductionLike() && !usersConfigured() && isLoopbackRequest(req);
}

// ---------- principal resolution & middleware ----------

export function resolvePrincipal(req: Request): Principal | null | 'bad_key' {
  const provided = extractBearer(req);
  if (provided) {
    if (!verifyIntegrationKey(provided)) return 'bad_key';
    const sub = (req.get('x-docai-actor') || '').slice(0, 120);
    return { kind: 'integration', email: sub ? `integration:${sub}` : 'integration', role: 'operator' };
  }
  const user = userFromSession(req);
  if (user) return { kind: 'user', email: user.email, role: user.role, name: user.name };
  if (localOpenMode(req)) return { kind: 'local', email: 'local@localhost', role: 'admin', name: 'Локальний адміністратор' };
  return null;
}

export function principalOf(req: Request): Principal | undefined {
  return (req as any).principal;
}

export function actorOf(req: Request) {
  return principalOf(req)?.email;
}

export function hasRole(principal: Principal | undefined, minimum: Role) {
  return !!principal && rank[principal.role] >= rank[minimum];
}

export function requireAuth(minimum: Role = 'viewer') {
  return (req: Request, res: Response, next: NextFunction) => {
    let principal = principalOf(req) as Principal | null | 'bad_key' | undefined;
    if (!principal) principal = resolvePrincipal(req);
    if (principal === 'bad_key') {
      logIntegrationAccess({ ok: false, reason: 'bad_key', path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Недійсний інтеграційний API-ключ' });
    }
    if (!principal) {
      if (extractBearer(req) === '' && req.get('authorization')) logIntegrationAccess({ ok: false, reason: 'malformed_auth', path: req.path, ip: req.ip });
      return res.status(401).json({ error: 'Потрібен вхід або інтеграційний API-ключ (Authorization: Bearer …).', loginRequired: true });
    }
    const bucket = principal.kind === 'integration'
      ? `key:${createHash('sha256').update(extractBearer(req)).digest('hex').slice(0, 12)}`
      : `user:${principal.email}:${req.ip || 'local'}`;
    if (!rateLimitOk(bucket)) {
      if (principal.kind === 'integration') logIntegrationAccess({ ok: false, reason: 'rate_limit', path: req.path, ip: req.ip });
      return res.status(429).json({ error: 'Перевищено ліміт запитів. Спробуйте за хвилину.' });
    }
    (req as any).principal = principal;
    (req as any).integrationAuth = principal.kind === 'integration';
    if (!hasRole(principal, minimum)) {
      return res.status(403).json({ error: `Недостатньо прав: потрібна роль ${minimum}.` });
    }
    if (principal.kind === 'integration') {
      logIntegrationAccess({ ok: true, via: 'bearer', path: req.path, method: req.method, ip: req.ip });
    }
    next();
  };
}

// ---------- login throttling ----------

const loginAttempts = new Map<string, { count: number; resetAt: number }>();
const loginWindowMs = 15 * 60_000;
const loginMaxAttempts = 10;

export function loginAllowed(key: string) {
  const now = Date.now();
  const row = loginAttempts.get(key);
  if (!row || row.resetAt < now) return true;
  return row.count < loginMaxAttempts;
}

export function recordLoginFailure(key: string) {
  const now = Date.now();
  const row = loginAttempts.get(key);
  if (!row || row.resetAt < now) loginAttempts.set(key, { count: 1, resetAt: now + loginWindowMs });
  else row.count += 1;
  if (loginAttempts.size > 10_000) {
    for (const [k, v] of loginAttempts) if (v.resetAt < now) loginAttempts.delete(k);
  }
}

export function clearLoginFailures(key: string) {
  loginAttempts.delete(key);
}

export function authStatus(req: Request) {
  const principal = resolvePrincipal(req);
  const p = principal === 'bad_key' ? null : principal;
  return {
    authenticated: !!p,
    user: p ? { email: p.email, role: p.role, name: p.name, kind: p.kind } : null,
    loginRequired: !p,
    usersConfigured: usersConfigured(),
    usersEditable: usersEditable(),
    demoLogin: demoUsers().length > 0,
    sessionReady: (() => { try { sessionSecret(); return true; } catch { return false; } })(),
  };
}
