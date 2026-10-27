import assert from 'node:assert/strict';
import http from 'node:http';
import { createHmac } from 'node:crypto';
import { startServer } from './lib/harness.mjs';
import { startMockOpenAI } from './lib/mock-openai.mjs';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const valid = { invoice_number: 'INV-9', date: '2026-09-02', supplier: { name: 'A', edrpou: '14360570' }, customer: { name: 'B', edrpou: '40075815' }, currency: 'UAH', items: [{ description: 'x', quantity: 1, unit_price: 100, amount: 100 }], total: 100 };
const cheapWrong = { ...valid, total: 999 }; // cheap model misreads the total → schema invalid

async function startReceiver() {
  const received = [];
  let calls = 0;
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      calls += 1;
      received.push({ headers: req.headers, body });
      res.writeHead(calls === 1 ? 500 : 200).end(); // first delivery fails → must be retried from the outbox
    });
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return { url: `http://127.0.0.1:${server.address().port}/hook`, received, calls: () => calls, close: () => new Promise((r) => server.close(r)) };
}

const waitFor = async (fn, ms = 20000) => {
  const until = Date.now() + ms;
  while (Date.now() < until) { const v = await fn(); if (v) return v; await new Promise((r) => setTimeout(r, 250)); }
  throw new Error('timeout');
};

const ai = await startMockOpenAI((n, body) => ({ text: JSON.stringify(body.model === 'gpt-4.1' ? valid : cheapWrong), model: body.model }));
const hook = await startReceiver();
const SECRET = 'whsec_test_secret_value';
const CRON = 'cron_test_secret_value_1234';
const srv = await startServer({
  OPENAI_API_KEY: 'sk-test-only-p2-000000', OPENAI_BASE_URL: ai.url, AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-4o-mini', OPENAI_ESCALATION_MODEL: 'gpt-4.1',
  DOCAI_WEBHOOK_URL: hook.url, DOCAI_WEBHOOK_SECRET: SECRET, DOCAI_WEBHOOK_RETRY_BASE_MS: '300',
  DOCAI_WORKER: '0', DOCAI_CRON_SECRET: CRON,
});
try {
  const { base } = srv;
  // enqueue with worker disabled — only the cron tick processes it
  const form = new FormData();
  form.append('document', new Blob(['Рахунок INV-9 на 100 грн'], { type: 'text/plain' }), 'inv9.txt');
  const enq = await (await fetch(`${base}/api/v1/parse/invoice`, { method: 'POST', body: form })).json();
  assert.equal((await fetch(`${base}/api/internal/worker-tick`, { method: 'POST' })).status, 401);
  assert.equal((await fetch(`${base}/api/internal/worker-tick`, { method: 'POST', headers: { Authorization: 'Bearer wrong-secret-wrong-sec' } })).status, 401);
  const tick = await (await fetch(`${base}/api/internal/worker-tick`, { method: 'POST', headers: { Authorization: `Bearer ${CRON}` } })).json();
  assert.equal(tick.processed, 1);

  const job = await (await fetch(`${base}/api/v1/jobs/${enq.jobId}`)).json();
  assert.equal(job.status, 'completed');
  assert.equal(job.documentStatus, 'pending_review', 'escalation model fixed the total');
  assert.equal(job.aiModel, 'openai/gpt-4.1');
  assert.equal(ai.calls(), 2);
  // cost = cheap attempt (gpt-4o-mini) + escalation (gpt-4.1), each at its own list price
  const expected = (100 * 0.15 + 20 * 0.6) / 1e6 + (100 * 2 + 20 * 8) / 1e6;
  assert.ok(Math.abs(job.estimatedCostUsd - expected) < 1e-9, `${job.estimatedCostUsd} vs ${expected}`);
  const doc = await (await fetch(`${base}/api/documents/${job.documentId}`)).json();
  assert.equal(doc.escalatedFrom, 'openai/gpt-4o-mini');

  // webhooks: first attempt got 500, the outbox retries on the next tick
  await new Promise((r) => setTimeout(r, 400));
  await fetch(`${base}/api/internal/worker-tick`, { method: 'POST', headers: { Authorization: `Bearer ${CRON}` } });
  await waitFor(async () => hook.received.filter((r) => r.headers['x-docai-event'] === 'document.pending_review').length >= 1 && hook.received.some((r) => r.headers['x-docai-event'] === 'job.completed'));
  const deliveries = (await (await fetch(`${base}/api/v1/webhooks`)).json()).deliveries;
  assert.ok(deliveries.every((d) => d.status === 'delivered'), JSON.stringify(deliveries.map((d) => [d.type, d.status, d.attempts])));
  assert.ok(deliveries.some((d) => d.attempts === 2), 'one delivery needed a retry');
  const sample = hook.received.find((r) => r.headers['x-docai-event'] === 'job.completed');
  const [tPart, vPart] = sample.headers['x-docai-signature-256'].split(',');
  const t = tPart.slice(2);
  assert.equal(vPart.slice(3), createHmac('sha256', SECRET).update(`${t}.${sample.body}`).digest('hex'), 'v2 signature');
  assert.equal(sample.headers['x-docai-signature'], `sha256=${createHmac('sha256', SECRET).update(sample.body).digest('hex')}`, 'legacy signature kept');
  // the same delivery id on retry lets receivers deduplicate
  const retried = hook.received.filter((r) => r.headers['x-docai-delivery'] === hook.received[0].headers['x-docai-delivery']);
  assert.equal(retried.length, 2);

  // approve → stats
  await fetch(`${base}/api/documents/${job.documentId}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"approve"}' });
  const stats = await (await fetch(`${base}/api/v1/stats?days=7`)).json();
  assert.equal(stats.totals.documentsProcessed, 1);
  assert.equal(stats.totals.escalated, 1);
  assert.equal(stats.quality.firstPassAccuracy, 1);
  assert.ok(stats.byModel.some((m) => m.model === 'openai/gpt-4.1' && m.priced));
  assert.equal(stats.byDay.length >= 7, true);
  // analytics UI
  const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
  try {
    const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
    const errs = []; page.on('pageerror', (e) => { if (!/WebSocket/.test(e.message)) errs.push(e.message); });
    await page.goto(base);
    await page.getByRole('button', { name: 'Аналітика', exact: true }).click();
    await page.getByText('Правильно з першого разу').waitFor();
    await page.getByRole('button', { name: '7 днів' }).click();
    const today = page.locator('.column-slot').last();
    await today.hover();
    await page.getByRole('tooltip').first().waitFor();
    if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/analytics.png`, fullPage: true });
    assert.deepEqual(errs, []);
  } finally { await browser.close(); }
  console.log('PASS: P2 file mode — model escalation + summed cost, cron tick auth, webhook outbox retry + v2 signature, stats + analytics UI.');
} finally {
  await srv.stop();
  await ai.close();
  await hook.close();
}
