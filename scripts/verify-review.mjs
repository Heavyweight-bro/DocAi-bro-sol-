import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { startServer } from './lib/harness.mjs';
import { startMockOpenAI } from './lib/mock-openai.mjs';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');
const XLSX = require('xlsx');

// AI "reads" an invoice with a wrong total and a bad ЄДРПОУ checksum.
const aiInvoice = {
  invoice_number: 'INV-77', date: '2026-09-01',
  supplier: { name: 'ТОВ Постачальник', edrpou: '14360571', iban: 'UA213223130000026007233566001' },
  customer: { name: 'ТОВ Покупець', edrpou: '40075815' },
  currency: 'UAH',
  items: [{ description: 'Послуга A', quantity: 2, unit_price: 100, amount: 200 }, { description: 'Послуга B', quantity: 1, unit_price: 50, amount: 50 }],
  subtotal: 250, vat: 50, total: 310,
};
const ai = await startMockOpenAI(() => ({ text: JSON.stringify(aiInvoice) }));
const srv = await startServer({ OPENAI_API_KEY: 'sk-test-only-review-0000', OPENAI_BASE_URL: ai.url, AI_PROVIDER: 'openai', OPENAI_MODEL: 'gpt-4o-mini', DOCAI_WORKER_INTERVAL_MS: '500' });
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
try {
  const { base } = srv;
  const page0 = await browser.newPage();
  await page0.setContent('<h1>Рахунок INV-77</h1><p>Разом: 300 грн</p>');
  const pdf = await page0.pdf({ format: 'A5' });
  await page0.close();

  // enqueue invoice
  const form = new FormData();
  form.append('document', new Blob([pdf], { type: 'application/pdf' }), 'invoice-77.pdf');
  const enq = await (await fetch(`${base}/api/v1/parse/invoice`, { method: 'POST', body: form })).json();
  let job;
  for (let i = 0; i < 60; i++) { job = await (await fetch(`${base}/api/v1/jobs/${enq.jobId}`)).json(); if (['completed', 'failed'].includes(job.status)) break; await new Promise(r => setTimeout(r, 300)); }
  assert.equal(job.status, 'completed');
  let doc = await (await fetch(`${base}/api/documents/${job.documentId}`)).json();
  assert.equal(doc.status, 'invalid');
  const paths = doc.validationErrors.map(e => `${e.severity}:${e.path}`);
  assert.ok(paths.includes('error:supplier.edrpou'), paths.join(','));
  assert.ok(paths.includes('error:total'), 'sum of lines + VAT ≠ total');
  assert.ok(!paths.some(p => p.endsWith('supplier.iban')), 'valid IBAN passes');

  // original file is served inline with safe headers
  const file = await fetch(`${base}/api/documents/${doc.id}/file`);
  assert.equal(file.status, 200);
  assert.equal(file.headers.get('content-type'), 'application/pdf');
  assert.match(file.headers.get('content-disposition'), /^inline/);
  assert.equal(file.headers.get('x-content-type-options'), 'nosniff');

  // approving an invalid doc is refused
  assert.equal((await fetch(`${base}/api/documents/${doc.id}/review`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"action":"approve"}' })).status, 400);

  // ---------- UI: review screen, fix fields, save, approve, export ----------
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 950 } });
  const page = await context.newPage();
  const errors = []; page.on('pageerror', e => { if (!/WebSocket/.test(e.message)) errors.push(e.message); });
  await page.goto(base);
  await page.getByRole('button', { name: 'Історія', exact: true }).click();
  await page.getByText('invoice-77.pdf').first().click();
  await page.getByText('Схема не пройдена — у CRM не відправляти.').waitFor();
  await page.locator('.review-original iframe').waitFor();
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/review-invalid.png` });
  assert.equal(await page.getByRole('button', { name: 'Підтвердити' }).isDisabled(), true);

  await page.getByLabel('supplier.edrpou', { exact: true }).fill('14360570');
  await page.getByLabel('total', { exact: true }).fill('300,00');
  await page.getByLabel('total', { exact: true }).blur();
  await page.getByRole('button', { name: 'Зберегти й перевірити' }).click();
  await page.getByText('Збережено й перевірено повторно').waitFor();
  await page.locator('.review-title .status-pill', { hasText: 'На перевірці' }).waitFor();

  const [download] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'Завантажити Excel' }).click()]);
  const wb = XLSX.read(readFileSync(await download.path()));
  assert.deepEqual(wb.SheetNames, ['Поля', 'items']);
  const fields = XLSX.utils.sheet_to_json(wb.Sheets['Поля']);
  assert.equal(fields.find(r => r['Поле'] === 'total')['Значення'], 300);
  assert.equal(XLSX.utils.sheet_to_json(wb.Sheets.items).length, 2);

  await page.getByRole('button', { name: 'Підтвердити' }).click();
  await page.locator('.review-title .status-pill', { hasText: 'Підтверджено' }).waitFor();
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/review-approved.png` });

  // register export (CSV for 1C/BAS)
  const [csvDl] = await Promise.all([page.waitForEvent('download'), page.getByRole('button', { name: 'CSV' }).click()]);
  const csv = readFileSync(await csvDl.path(), 'utf8');
  assert.ok(csv.startsWith('﻿'), 'BOM for Excel/1C');
  assert.match(csv.split('\r\n')[0], /ID;Файл;Шаблон;Статус/);
  assert.equal(csv.trim().split('\r\n').length, 3, 'header + 2 line items');
  assert.match(csv, /300/);

  // server state after UI edits
  doc = await (await fetch(`${base}/api/documents/${doc.id}`)).json();
  assert.equal(doc.status, 'approved');
  assert.equal(doc.extractedData.total, 300);
  assert.equal(doc.originalExtractedData.total, 310, 'AI original kept for quality metrics');
  assert.equal(doc.editedBy, 'local@localhost');
  // approved documents are frozen
  const frozen = await fetch(`${base}/api/documents/${doc.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ extractedData: { ...doc.extractedData, total: 1 } }) });
  assert.equal(frozen.status, 409);
  const audit = await (await fetch(`${base}/api/v1/audit`)).json();
  const edit = audit.events.find(e => e.action === 'document.edit');
  assert.match(edit.detail, /supplier\.edrpou/);
  assert.match(edit.detail, /total/);
  // ---------- template schema builder ----------
  assert.equal((await fetch(`${base}/api/types`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'Bad', slug: 'bad-schema', prompt: 'x', schema: { fields: [{ path: 'a b' }] } }) })).status, 400);
  await page.getByRole('button', { name: 'Шаблони', exact: true }).click();
  await page.getByLabel('Назва (напр. Інвойс)').fill('Платіжка');
  await page.getByLabel('Ідентифікатор (Slug)').fill('payment-order');
  await page.getByLabel('Промпт для AI').fill('Поверни JSON {"payer_iban":null,"amount":null,"date":null,"purpose":null}');
  await page.getByLabel('Тип схеми').selectOption('custom');
  await page.getByLabel('Шлях поля 1').waitFor();
  assert.equal(await page.getByLabel('Формат поля 1').inputValue(), 'iban');
  assert.equal(await page.getByLabel('Формат поля 2').inputValue(), 'money');
  await page.getByRole('button', { name: 'Створити шаблон' }).click();
  await page.getByText('Схема: 4 пол.').waitFor();
  const types = await (await fetch(`${base}/api/types`)).json();
  const created = types.find(t => t.slug === 'payment-order');
  assert.equal(created.schema.fields.find(f => f.path === 'amount').format, 'money');
  if (process.env.SCREENSHOT_DIR) await page.screenshot({ path: `${process.env.SCREENSHOT_DIR}/templates-schema.png`, fullPage: true });

  assert.deepEqual(errors, []);
  console.log('PASS: P1 review — ЄДРПОУ/sum checks, original preview, field edit + revalidation, approve, freeze, XLSX/CSV export, audit diff.');
} finally {
  await browser.close();
  await srv.stop();
  await ai.close();
}
