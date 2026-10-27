import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { startServer } from './lib/harness.mjs';
import { startMockOpenAI } from './lib/mock-openai.mjs';

const aiEnv = (url, extra = {}) => ({
  OPENAI_API_KEY: 'sk-test-only-worker-0000', OPENAI_BASE_URL: url, AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-4o-mini',
  DOCAI_WORKER: '1', DOCAI_WORKER_INTERVAL_MS: '500', ...extra,
});

async function enqueue(base, name = 'note.txt', text = 'Invoice INV-7 total 120 UAH') {
  const form = new FormData();
  form.append('document', new Blob([text], { type: 'text/plain' }), name);
  form.append('prompt', 'Поверни JSON з полем total');
  const r = await fetch(`${base}/api/v1/parse`, { method: 'POST', body: form });
  assert.equal(r.status, 202, await r.clone().text());
  return (await r.json()).jobId;
}

async function waitJob(base, jobId, timeoutMs = 30000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const job = await (await fetch(`${base}/api/v1/jobs/${jobId}`)).json();
    if (job.status === 'completed' || job.status === 'failed') return job;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('job timeout');
}

const docsFor = async (base, name) => (await (await fetch(`${base}/api/documents`)).json()).filter((d) => d.originalName === name);
const stagingFiles = (srv) => { const dir = path.join(srv.temp, 'files', 'jobs'); return existsSync(dir) ? readdirSync(dir) : []; };

// 1. First AI call fails, retry succeeds → exactly ONE document, staging cleaned.
{
  const ai = await startMockOpenAI((n) => (n === 1 ? { fail: true } : { text: '{"total":120}' }));
  const srv = await startServer(aiEnv(ai.url));
  try {
    const jobId = await enqueue(srv.base, 'retry.txt');
    const job = await waitJob(srv.base, jobId);
    assert.equal(job.status, 'completed');
    assert.equal(job.attempts, 2);
    assert.equal(ai.calls(), 2);
    const docs = await docsFor(srv.base, 'retry.txt');
    assert.equal(docs.length, 1, `expected 1 document, got ${docs.length} (${docs.map((d) => d.status)})`);
    assert.equal(docs[0].status, 'completed');
    assert.deepEqual(stagingFiles(srv), [], 'staging file removed after completion');
    console.log('PASS: retry after AI failure keeps a single document and cleans staging.');
  } finally { await srv.stop(); await ai.close(); }
}

// 2. Always failing → job failed after max attempts, exactly ONE failed document.
{
  const ai = await startMockOpenAI(() => ({ fail: true }));
  const srv = await startServer(aiEnv(ai.url, { DOCAI_JOB_MAX_ATTEMPTS: '2' }));
  try {
    const jobId = await enqueue(srv.base, 'broken.txt');
    const job = await waitJob(srv.base, jobId);
    assert.equal(job.status, 'failed');
    assert.equal(job.attempts, 2);
    const docs = await docsFor(srv.base, 'broken.txt');
    assert.equal(docs.length, 1);
    assert.equal(docs[0].status, 'failed');
    assert.deepEqual(stagingFiles(srv), []);
    console.log('PASS: exhausted retries → one failed document, staging cleaned.');
  } finally { await srv.stop(); await ai.close(); }
}

// 3. A job left in "processing" by a crashed server is recovered on startup; FIFO order.
{
  const ai = await startMockOpenAI(() => ({ text: '{"total":1}' }));
  const temp = await mkdtemp(path.join(tmpdir(), 'docai-orphan-'));
  const filesDir = path.join(temp, 'files', 'jobs');
  mkdirSync(filesDir, { recursive: true });
  const staged = path.join(filesDir, 'job_orphan_note.txt');
  writeFileSync(staged, 'orphaned invoice');
  const now = new Date(Date.now() - 60_000).toISOString();
  const jobsPath = path.join(temp, 'jobs.json');
  writeFileSync(jobsPath, JSON.stringify({ jobs: [{
    id: 'job_orphan', status: 'processing', createdAt: now, updatedAt: now, prompt: 'Поверни JSON', provider: 'openai',
    originalName: 'orphan.txt', mimeType: 'text/plain', filePath: staged, attempts: 1, maxAttempts: 3,
    leaseUntil: new Date(Date.now() + 3_600_000).toISOString(), workspaceId: 'default',
  }] }));
  const srv = await startServer(aiEnv(ai.url, { LOCAL_JOBS_PATH: jobsPath, LOCAL_FILES_DIR: path.join(temp, 'files') }));
  try {
    assert.match(srv.logs(), /recovered 1 interrupted job/);
    const job = await waitJob(srv.base, 'job_orphan');
    assert.equal(job.status, 'completed');
    assert.equal(job.attempts, 2);
    assert.equal((await docsFor(srv.base, 'orphan.txt')).length, 1);
    console.log('PASS: orphaned processing job recovered after restart.');
  } finally { await srv.stop(); await ai.close(); await rm(temp, { recursive: true, force: true }); }
}

// 4. Idempotency: same key → same job, one AI call; different callers do not collide.
{
  const ai = await startMockOpenAI(() => ({ text: '{"total":5}' }));
  const srv = await startServer(aiEnv(ai.url));
  try {
    const send = async () => {
      const form = new FormData();
      form.append('document', new Blob(['x'], { type: 'text/plain' }), 'idem.txt');
      form.append('prompt', 'Поверни JSON');
      return fetch(`${srv.base}/api/v1/parse`, { method: 'POST', body: form, headers: { 'Idempotency-Key': 'order-42' } });
    };
    const a = await (await send()).json();
    const second = await send();
    assert.equal(second.status, 200);
    const b = await second.json();
    assert.equal(a.jobId, b.jobId);
    assert.equal(b.created, false);
    await waitJob(srv.base, a.jobId);
    assert.equal(ai.calls(), 1);
    console.log('PASS: idempotent enqueue.');
  } finally { await srv.stop(); await ai.close(); }
}
