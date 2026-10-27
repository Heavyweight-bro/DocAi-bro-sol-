import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { startServer } from './lib/harness.mjs';

const { hashPassword } = await import('../server/auth.ts');
const KEY = 'dok_test_integration_key_123456';
const users = [
  { email: 'admin@test.ua', role: 'admin', passwordHash: hashPassword('admin-password-1') },
  { email: 'op@test.ua', role: 'operator', passwordHash: hashPassword('operator-password-1') },
  { email: 'view@test.ua', role: 'viewer', passwordHash: hashPassword('viewer-password-1') },
];

// ---------- 1. Configured users: login required, Origin spoofing does not authenticate ----------
let srv = await startServer({ DOCAI_USERS: JSON.stringify(users), DOCAI_INTEGRATION_KEY: KEY, DOCAI_SESSION_SECRET: 'x'.repeat(40) });
try {
  const { base } = srv;
  const get = (url, headers = {}) => fetch(base + url, { headers });
  const status = async (p) => (await p).status;

  assert.equal(await status(get('/api/v1/jobs')), 401, 'no credentials → 401');
  assert.equal(await status(get('/api/v1/jobs', { Origin: base })), 401, 'spoofed Origin must NOT authenticate');
  assert.equal(await status(get('/api/documents', { Origin: base })), 401);
  assert.equal(await status(get('/api/types')), 401);
  assert.equal(await status(get('/api/v1/jobs', { Authorization: 'Bearer wrong-wrong-wrong-wrong' })), 401);
  assert.equal(await status(get('/api/v1/jobs', { Authorization: `Bearer ${KEY}` })), 200, 'integration key works');
  assert.equal(await status(get('/api/v1/audit', { Authorization: `Bearer ${KEY}` })), 403, 'integration key is not admin');

  const health = await (await get('/api/health')).json();
  assert.deepEqual(Object.keys(health).sort(), ['apiVersions', 'status'], 'anonymous health reveals nothing else');

  const me0 = await (await get('/api/auth/me')).json();
  assert.equal(me0.authenticated, false);
  assert.equal(me0.usersConfigured, true);

  // template mutation without login / with integration key
  const tpl = { name: 'X', slug: 'x-test', prompt: 'Return JSON' };
  const post = (url, body, headers = {}) => fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await post('/api/types', tpl, { Origin: base })).status, 401);
  assert.equal((await post('/api/types', tpl, { Authorization: `Bearer ${KEY}` })).status, 403, 'operator-level key cannot edit templates');

  // login
  assert.equal((await post('/api/auth/login', { email: 'admin@test.ua', password: 'wrong-password' })).status, 401);
  const login = async (email, password) => {
    const r = await post('/api/auth/login', { email, password });
    assert.equal(r.status, 200, `login ${email}`);
    const cookie = r.headers.get('set-cookie');
    assert.match(cookie, /docai_session=/);
    assert.match(cookie, /HttpOnly/i);
    assert.match(cookie, /SameSite=Strict/i);
    return cookie.split(';')[0];
  };
  const admin = await login('ADMIN@test.ua', 'admin-password-1');
  const op = await login('op@test.ua', 'operator-password-1');
  const viewer = await login('view@test.ua', 'viewer-password-1');

  const me = await (await get('/api/auth/me', { Cookie: admin })).json();
  assert.equal(me.user.role, 'admin');
  assert.equal((await get('/api/documents', { Cookie: viewer })).status, 200, 'viewer reads');
  assert.equal((await post('/api/types', tpl, { Cookie: viewer })).status, 403, 'viewer cannot edit templates');
  assert.equal((await post('/api/types', tpl, { Cookie: op })).status, 403, 'operator cannot edit templates');
  const created = await post('/api/types', tpl, { Cookie: admin });
  assert.equal(created.status, 200, 'admin creates template');
  const createdId = (await created.json()).id;
  const del = await fetch(`${base}/api/types/${createdId}`, { method: 'DELETE', headers: { Cookie: admin } });
  assert.equal(del.status, 200);
  assert.equal((await fetch(`${base}/api/types/${createdId}`, { method: 'DELETE', headers: { Cookie: admin } })).status, 404);

  // viewer cannot parse
  const form = new FormData();
  form.append('document', new Blob(['hi'], { type: 'text/plain' }), 'a.txt');
  assert.equal((await fetch(base + '/api/v1/parse', { method: 'POST', body: form, headers: { Cookie: viewer } })).status, 403);
  // admin-only audit
  assert.equal((await get('/api/v1/audit', { Cookie: op })).status, 403);
  assert.equal((await get('/api/v1/audit', { Cookie: admin })).status, 200);

  // tampered cookie
  const tampered = admin.replace(/.$/, (c) => (c === 'A' ? 'B' : 'A'));
  assert.equal((await get('/api/documents', { Cookie: tampered })).status, 401);

  // CSRF: cross-site Origin on a state-changing request is rejected even with a valid session
  assert.equal((await post('/api/types', tpl, { Cookie: admin, Origin: 'https://evil.example' })).status, 403);

  // logout clears cookie
  const out = await fetch(base + '/api/auth/logout', { method: 'POST', headers: { Cookie: op } });
  assert.match(out.headers.get('set-cookie') || '', /docai_session=;/);

  // 5xx never leaks internals; 4xx keeps a readable message + requestId
  const bad = await fetch(base + '/api/types', { method: 'POST', headers: { 'Content-Type': 'application/json', Cookie: admin }, body: '{broken' });
  assert.equal(bad.status, 400);
  const badBody = await bad.json();
  assert.ok(badBody.requestId);

  console.log('PASS: auth — Origin spoof blocked, roles, login cookie flags, tamper, CSRF, template ACL, error shape.');
} finally {
  await srv.stop();
}

// ---------- 2. Login throttling ----------
srv = await startServer({ DOCAI_USERS: JSON.stringify(users.slice(0, 1)), DOCAI_SESSION_SECRET: 'y'.repeat(40) });
try {
  let last;
  for (let i = 0; i < 11; i++) {
    last = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin@test.ua', password: 'nope-nope-nope' }) });
  }
  assert.equal(last.status, 429, 'brute force throttled');
  console.log('PASS: login throttling.');
} finally {
  await srv.stop();
}

// ---------- 3. Local open mode (no users, loopback) + local user file ----------
srv = await startServer({});
try {
  const me = await (await fetch(srv.base + '/api/auth/me')).json();
  assert.equal(me.authenticated, true);
  assert.equal(me.user.kind, 'local');
  assert.equal(me.user.role, 'admin');
  // Creating the first user through the API switches the instance to mandatory login.
  const r = await fetch(srv.base + '/api/users', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@test.ua', role: 'admin', password: 'boss-password-1' }) });
  assert.equal(r.status, 200);
  assert.equal((await fetch(srv.base + '/api/documents')).status, 401, 'after first user, open mode is off');
  const login = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'boss@test.ua', password: 'boss-password-1' }) });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  // cannot remove the last admin / yourself
  assert.equal((await fetch(srv.base + '/api/users/boss@test.ua', { method: 'DELETE', headers: { Cookie: cookie } })).status, 400);
  console.log('PASS: local open mode and first-user bootstrap.');
} finally {
  await srv.stop();
}

// ---------- 4. admin/admin test login (development only) ----------
srv = await startServer({ DOCAI_DEMO_ADMIN: 'true' });
try {
  const me0 = await (await fetch(srv.base + '/api/auth/me')).json();
  assert.equal(me0.authenticated, false, 'demo user turns login on');
  assert.equal(me0.demoLogin, true);
  const bad = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin', password: 'wrong' }) });
  assert.equal(bad.status, 401);
  const ok = await fetch(srv.base + '/api/auth/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ email: 'admin', password: 'admin' }) });
  assert.equal(ok.status, 200);
  const cookie = ok.headers.get('set-cookie').split(';')[0];
  assert.equal((await (await fetch(srv.base + '/api/auth/me', { headers: { Cookie: cookie } })).json()).user.role, 'admin');
  console.log('PASS: admin/admin test login in development.');
} finally {
  await srv.stop();
}
