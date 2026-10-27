// Postgres-mode integration test against PostgreSQL + PostgREST (see scripts/pg-test-env.sh).
// Env: POSTGREST_URL, JWT_SECRET. Skips (exit 0) when they are not set.
import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { startServer, startWorkerProcess } from './lib/harness.mjs';
import { startMockOpenAI } from './lib/mock-openai.mjs';

const { POSTGREST_URL, JWT_SECRET } = process.env;
if (!POSTGREST_URL || !JWT_SECRET) { console.log('SKIP: Postgres test (set POSTGREST_URL and JWT_SECRET, see scripts/pg-test-env.sh)'); process.exit(0); }

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
const header = b64({ alg: 'HS256', typ: 'JWT' });
const payload = b64({ role: 'service_role', iss: 'docai-test', exp: Math.floor(Date.now() / 1000) + 3600 });
const serviceKey = `${header}.${payload}.${createHmac('sha256', JWT_SECRET).update(`${header}.${payload}`).digest('base64url')}`;

// Supabase URL layout: /rest/v1 → PostgREST; storage is absent here (the app must fall back to local files).
const proxy = http.createServer((req, res) => {
  if (!req.url.startsWith('/rest/v1/')) { res.writeHead(404, { 'content-type': 'application/json' }); return res.end('{"error":"not_found","message":"storage not available in test"}'); }
  const target = new URL(req.url.slice('/rest/v1'.length), POSTGREST_URL);
  const upstream = http.request(target, { method: req.method, headers: { ...req.headers, host: target.host } }, (r) => { res.writeHead(r.statusCode, r.headers); r.pipe(res); });
  upstream.on('error', (e) => { res.writeHead(502); res.end(String(e)); });
  req.pipe(upstream);
});
await new Promise((r) => proxy.listen(0, '127.0.0.1', r));
const supabaseUrl = `http://127.0.0.1:${proxy.address().port}`;
const rest = (path, init = {}) => fetch(`${POSTGREST_URL}${path}`, { ...init, headers: { Authorization: `Bearer ${serviceKey}`, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(init.headers || {}) } });

// Clean slate (the schema is idempotent; test rows are removed).
for (const table of ['docai_job_files', 'docai_jobs', 'docai_webhook_deliveries', 'docai_audit', 'documents']) await rest(`/${table}?id=not.is.null`.replace('docai_job_files?id', 'docai_job_files?job_id'), { method: 'DELETE' });
await rest(`/document_types?slug=neq.invoice`, { method: 'DELETE' });

const valid = { invoice_number: 'PG-1', date: '2026-09-03', supplier: { name: 'A', edrpou: '14360570' }, customer: { name: 'B', edrpou: '40075815' }, currency: 'UAH', items: [{ description: 'x', quantity: 1, unit_price: 50, amount: 50 }], total: 50 };
const ai = await startMockOpenAI(() => ({ text: JSON.stringify(valid) }));
const hooks = [];
const receiver = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { hooks.push({ event: req.headers['x-docai-event'], body: b }); res.writeHead(200).end(); }); });
await new Promise((r) => receiver.listen(0, '127.0.0.1', r));

const common = {
  SUPABASE_URL: supabaseUrl, SUPABASE_KEY: serviceKey,
  OPENAI_API_KEY: 'sk-test-only-pg-000000', OPENAI_BASE_URL: ai.url, AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-4o-mini',
  DOCAI_WEBHOOK_URL: `http://127.0.0.1:${receiver.address().port}/hook`, DOCAI_WEBHOOK_SECRET: 'whsec_pg_test',
  DOCAI_WORKER_INTERVAL_MS: '500', DOCAI_INTEGRATION_KEY: 'dok_pg_integration_key_0001',
};
const web = await startServer({ ...common, DOCAI_WORKER: '0' });
const workerEnv = { ...web.env };
delete workerEnv.PORT;
const workers = [await startWorkerProcess(workerEnv), await startWorkerProcess(workerEnv)];
const auth = { Authorization: 'Bearer dok_pg_integration_key_0001' };
const api = (path, init = {}) => fetch(web.base + path, { ...init, headers: { ...auth, ...(init.headers || {}) } });
try {
  assert.match(workers[0].logs(), /queue=postgres/);
  const health = await (await api('/api/health')).json();
  assert.equal(health.storage, 'supabase');

  // templates: seeded built-in reference + custom schema persisted as jsonb
  const types = await (await api('/api/types')).json();
  assert.equal(types.find((t) => t.slug === 'invoice').schema, 'invoice');

  // 6 jobs, 2 workers → each processed exactly once
  const ids = [];
  for (let i = 0; i < 6; i++) {
    const form = new FormData();
    form.append('document', new Blob([`invoice ${i}`], { type: 'text/plain' }), `pg-${i}.txt`);
    const r = await api('/api/v1/parse/invoice', { method: 'POST', body: form });
    assert.equal(r.status, 202);
    ids.push((await r.json()).jobId);
  }
  const deadline = Date.now() + 60000;
  let jobs;
  while (Date.now() < deadline) {
    jobs = await Promise.all(ids.map(async (id) => (await api(`/api/v1/jobs/${id}`)).json()));
    if (jobs.every((j) => j.status === 'completed' || j.status === 'failed')) break;
    await new Promise((r) => setTimeout(r, 400));
  }
  assert.ok(jobs.every((j) => j.status === 'completed' && j.documentStatus === 'pending_review'), JSON.stringify(jobs.map((j) => [j.status, j.error])));
  assert.equal(ai.calls(), 6, 'no job processed twice');
  assert.ok(jobs.every((j) => j.attempts === 1));
  const docs = await (await api('/api/documents')).json();
  assert.equal(docs.length, 6);
  const files = await (await rest('/docai_job_files?select=job_id')).json();
  assert.equal(files.length, 0, 'staged files removed from the DB');

  // idempotency (DB unique key)
  const send = async () => { const f = new FormData(); f.append('document', new Blob(['same'], { type: 'text/plain' }), 'same.txt'); return api('/api/v1/parse/invoice', { method: 'POST', body: f, headers: { 'Idempotency-Key': 'pg-42' } }); };
  const a = await (await send()).json(); const b = await send();
  assert.equal(b.status, 200); assert.equal((await b.json()).jobId, a.jobId);

  // lease recovery: a job stuck in processing with an expired lease is taken over
  await rest('/docai_jobs', { method: 'POST', body: JSON.stringify({ id: 'job_stuck', status: 'processing', attempts: 1, max_attempts: 3, lease_until: new Date(Date.now() - 60000).toISOString(), payload: { originalName: 'stuck.txt', mimeType: 'text/plain', slug: 'invoice', provider: 'openai' } }) });
  await rest('/docai_job_files', { method: 'POST', body: JSON.stringify({ job_id: 'job_stuck', content_base64: Buffer.from('stuck invoice').toString('base64') }) });
  let stuck;
  for (let i = 0; i < 60; i++) { stuck = await (await api('/api/v1/jobs/job_stuck')).json(); if (stuck.status === 'completed') break; await new Promise((r) => setTimeout(r, 400)); }
  assert.equal(stuck.status, 'completed');
  assert.equal(stuck.attempts, 2);

  // edit + review columns, original AI output kept
  const doc = docs[0];
  const patched = await api(`/api/documents/${doc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json', 'X-DocAI-Actor': 'crm-bot' }, body: JSON.stringify({ extractedData: { ...doc.extractedData, total: 50, invoice_number: 'PG-1-FIX' } }) });
  assert.equal(patched.status, 200, await patched.clone().text());
  assert.equal((await api(`/api/documents/${doc.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"approve"}' })).status, 200);
  const row = (await (await rest(`/documents?id=eq.${doc.id}&select=status,edited_by,original_extracted_data,reviewed_by,extracted_data`)).json())[0];
  assert.equal(row.status, 'approved');
  assert.equal(row.edited_by, 'integration:crm-bot');
  assert.equal(row.reviewed_by, 'integration');
  assert.equal(row.original_extracted_data.invoice_number, 'PG-1');
  assert.equal(row.extracted_data.invoice_number, 'PG-1-FIX');

  // original file: Storage unavailable here → local archive fallback still serves it
  assert.equal((await api(`/api/documents/${doc.id}/file`)).status, 200);

  // audit + stats + webhooks come from the shared DB
  await new Promise((r) => setTimeout(r, 1500));
  const audit = await (await rest('/docai_audit?select=action&action=eq.job.completed')).json();
  assert.equal(audit.length, 8, '6 batch + idempotent job + recovered job');
  // stats (admin): no key from loopback = local admin in development
  const stats = await (await fetch(`${web.base}/api/v1/stats?days=3`)).json();
  assert.equal(stats.totals.documentsProcessed, 8);
  assert.equal(stats.quality.reviewed, 1);
  assert.equal(stats.quality.firstPassAccuracy, 0, 'the only reviewed document was corrected by hand');
  assert.equal(stats.statuses.approved, 1);
  const deliveries = await (await rest('/docai_webhook_deliveries?select=type,status')).json();
  assert.ok(deliveries.length >= 16 && deliveries.every((d) => d.status === 'delivered'), JSON.stringify(deliveries.slice(0, 3)));
  assert.ok(hooks.some((h) => h.event === 'document.approved'));
  console.log('PASS: Postgres mode — 2 workers/SKIP LOCKED exactly-once, DB staging cleanup, idempotency, lease recovery, edit/review columns, audit + webhook outbox in DB.');
} finally {
  for (const w of workers) await w.stop();
  await web.stop();
  await ai.close();
  await new Promise((r) => receiver.close(r));
  await new Promise((r) => proxy.close(r));
}
