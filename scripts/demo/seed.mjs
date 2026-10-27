// Demo workspace for screenshots, videos and sales demos: `npm run demo:seed` → .data-demo/
// Synthetic companies and numbers only. Never touches the real .data/ directory.
import { mkdirSync, rmSync, writeFileSync, appendFileSync } from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);
const { chromium } = require('playwright');

const root = path.resolve(process.argv[2] || '.data-demo');
rmSync(root, { recursive: true, force: true });
mkdirSync(path.join(root, 'files'), { recursive: true });
mkdirSync(path.join(root, 'settings'), { recursive: true });

const { accountingPrompt } = await import('../../server/schemas.ts');
const day = 86_400_000;
const now = Date.now();
const rnd = (() => { let x = 42; return () => (x = (x * 16807) % 2147483647) / 2147483647; })();
const pick = (a) => a[Math.floor(rnd() * a.length)];

const suppliers = [
  { name: 'ТОВ «Альфа Логістик»', edrpou: '14360570', iban: 'UA213223130000026007233566001' },
  { name: 'ТОВ «Сонячні Системи»', edrpou: '40075815', iban: 'UA213223130000026007233566001' },
  { name: 'ФОП Коваленко О. В.', edrpou: '00032129', iban: 'UA213223130000026007233566001' },
];
const customer = { name: 'ТОВ «Демо Трейд»', edrpou: '00032106' };
const services = [['Доставка вантажу Київ — Львів', 1, 18500], ['Зберігання на складі, палето-місце', 12, 450], ['Монтаж обладнання', 1, 9600], ['Консультаційні послуги', 6, 1500], ['Оренда техніки, доба', 3, 2200]];

function invoice(i) {
  const s = suppliers[i % suppliers.length];
  const items = Array.from({ length: 1 + (i % 3) }, (_, k) => { const [d, q, p] = services[(i + k) % services.length]; return { description: d, quantity: q, unit_price: p, amount: q * p }; });
  const subtotal = items.reduce((a, b) => a + b.amount, 0);
  const vat = Math.round(subtotal * 0.2 * 100) / 100;
  return { invoice_number: `РФ-${2400 + i}`, date: new Date(now - (30 - (i % 30)) * day).toISOString().slice(0, 10), due_date: null, supplier: s, customer, currency: 'UAH', items, subtotal, vat, total: subtotal + vat };
}

const types = [
  { id: 1, name: 'Рахунок / Invoice', slug: 'invoice', prompt: accountingPrompt('invoice'), schema: 'invoice', createdAt: new Date(now - 40 * day).toISOString() },
  { id: 2, name: 'Акт виконаних робіт', slug: 'act', prompt: accountingPrompt('act'), schema: 'act', createdAt: new Date(now - 40 * day).toISOString() },
  { id: 3, name: 'Платіжне доручення', slug: 'payment-order', prompt: 'Поверни JSON {"number":null,"date":null,"payer_iban":null,"payee_edrpou":null,"amount":null,"purpose":null}', schema: { fields: [
    { path: 'number', type: 'string', required: true, label: 'Номер' }, { path: 'date', type: 'string', format: 'date', required: true, label: 'Дата' },
    { path: 'payer_iban', type: 'string', format: 'iban', required: true, label: 'IBAN платника' }, { path: 'payee_edrpou', type: 'string', format: 'edrpou', label: 'ЄДРПОУ отримувача' },
    { path: 'amount', type: 'number', format: 'money', required: true, label: 'Сума' }] }, createdAt: new Date(now - 20 * day).toISOString() },
  { id: 4, name: 'Договір', slug: 'contract', prompt: 'Витягни сторони договору, предмет, дати, суму, валюту та ключові зобов’язання у JSON. Поверни тільки JSON.', createdAt: new Date(now - 35 * day).toISOString() },
];

const models = [['openai/gpt-4o-mini', 0.15, 0.6], ['openai/gpt-4o-mini', 0.15, 0.6], ['openai/gpt-4o-mini', 0.15, 0.6], ['anthropic/claude-haiku-4-5', 1, 5]];
const audit = [];
const documents = [];
let id = Math.floor(now / 1000) * 1000 - 100_000;
const operators = ['o.koval@demo.ua', 'i.melnyk@demo.ua', 'integration:crm'];

const ages = Array.from({ length: 44 }, (_, i) => (i >= 40 ? i - 40 : Math.floor(rnd() ** 0.8 * 29) + 1)).sort((a, b) => b - a);
for (let i = 0; i < 44; i++) {
  const ageDays = ages[i];
  const created = new Date(now - ageDays * day - rnd() * 6 * 3600_000);
  const slug = i === 41 ? 'invoice' : i % 7 === 3 ? 'contract' : i % 5 === 1 ? 'act' : 'invoice';
  const data = slug === 'invoice' ? invoice(i) : slug === 'act'
    ? { act_number: `А-${310 + i}`, date: created.toISOString().slice(0, 10), contractor: suppliers[i % 3].name, customer: customer.name, currency: 'UAH', services: [{ description: 'Технічне обслуговування', quantity: 1, price: 12000, amount: 12000 }], subtotal: 10000, vat: 2000, total: 12000 }
    : { contract_number: `Д-${88 + i}/2026`, signed_at: created.toISOString().slice(0, 10), parties: [{ role: 'Виконавець', name: suppliers[i % 3].name }, { role: 'Замовник', name: customer.name }], subject: 'Логістичні послуги', amount: 250000, currency: 'UAH' };
  const [model, inP, outP] = pick(models);
  const escalated = i % 11 === 6;
  const promptTokens = 1800 + Math.floor(rnd() * 2400);
  const completionTokens = 260 + Math.floor(rnd() * 380);
  let cost = (promptTokens * inP + completionTokens * outP) / 1e6;
  if (escalated) cost += (promptTokens * 2 + completionTokens * 8) / 1e6;
  const edited = i % 6 === 2;
  const status = i >= 40 ? (i === 41 ? 'invalid' : 'pending_review') : slug === 'contract' ? 'completed' : i % 13 === 5 ? 'rejected' : 'approved';
  const actor = pick(operators);
  id += 1000 + Math.floor(rnd() * 900);
  const doc = {
    id, originalName: slug === 'invoice' ? `rahunok-${data.invoice_number}.pdf` : slug === 'act' ? `akt-${data.act_number}.pdf` : `dogovir-${88 + i}.pdf`,
    mimeType: 'application/pdf', typeSlug: slug, extractedData: data, createdAt: created.toISOString(), status,
    validationErrors: [], createdBy: actor, aiModel: escalated ? 'openai/gpt-4.1' : model, escalatedFrom: escalated ? model : undefined,
    promptTokens, completionTokens, estimatedCostUsd: Math.round(cost * 1e6) / 1e6, durationMs: 3500 + Math.floor(rnd() * 9000), provider: model.split('/')[0],
  };
  if (edited && status !== 'pending_review') { doc.originalExtractedData = { ...data, total: (data.total || 0) + 100 }; doc.editedBy = 'o.koval@demo.ua'; doc.editedAt = new Date(created.getTime() + 3600_000).toISOString(); }
  if (status === 'approved' || status === 'rejected') { doc.reviewedBy = pick(operators.slice(0, 2)); doc.reviewedAt = new Date(created.getTime() + 2 * 3600_000).toISOString(); }
  documents.unshift(doc);
  const ev = (action, extra, at = created) => audit.push({ id: `aud_demo_${audit.length}`, at: at.toISOString(), action, actor, via: actor.startsWith('integration') ? 'integration' : 'worker', documentId: id, typeSlug: slug, workspaceId: 'default', ...extra });
  ev('job.completed', { provider: doc.provider, model: doc.aiModel, promptTokens, completionTokens, durationMs: doc.durationMs, estimatedCostUsd: doc.estimatedCostUsd, status, detail: escalated ? `escalated from ${model}` : undefined });
  if (doc.editedBy) ev('document.edit', { actor: doc.editedBy, via: 'ui', detail: 'змінено: total' }, new Date(doc.editedAt));
  if (i % 9 === 4) ev('job.retry', { detail: 'openai: обробку не завершено', status: 'queued' }, new Date(created.getTime() - 60_000));
}

// The invoice the review screen opens: AI misread the total and one ЄДРПОУ digit.
const focus = documents.find((d) => d.status === 'invalid');
focus.extractedData = { ...focus.extractedData, invoice_number: 'РФ-2441', supplier: { ...suppliers[0], edrpou: '14360571' }, total: focus.extractedData.total + 1000 };
focus.originalName = 'rahunok-RF-2441.pdf';
focus.validationErrors = [
  { path: 'supplier.edrpou', severity: 'error', message: '«ЄДРПОУ постачальника (supplier.edrpou)»: 14360571 — некоректний ЄДРПОУ/РНОКПП (контрольна сума)' },
  { path: 'total', severity: 'error', message: `Сума рядків ${focus.extractedData.subtotal} (+ ПДВ ${focus.extractedData.vat}) не дорівнює підсумку ${focus.extractedData.total}` },
];
focus.errorMessage = focus.validationErrors.map((e) => `${e.path}: ${e.message}`).join('; ');

// Render real-looking PDFs for every document so the review screen shows an original.
const browser = await chromium.launch({ headless: true, executablePath: process.env.CHROMIUM_PATH || undefined });
const page = await browser.newPage();
for (const doc of documents) {
  const d = doc.id === focus.id ? { ...focus.extractedData, supplier: suppliers[0], total: focus.extractedData.total - 1000 } : doc.extractedData;
  const lines = (d.items || d.services || []).map((it, k) => `<tr><td>${k + 1}</td><td>${it.description}</td><td>${it.quantity}</td><td>${(it.unit_price ?? it.price).toLocaleString('uk-UA')}</td><td>${it.amount.toLocaleString('uk-UA')}</td></tr>`).join('');
  const title = doc.typeSlug === 'invoice' ? `Рахунок на оплату № ${d.invoice_number}` : doc.typeSlug === 'act' ? `Акт виконаних робіт № ${d.act_number}` : `Договір № ${d.contract_number}`;
  const supplier = d.supplier || { name: d.contractor || d.parties?.[0]?.name, edrpou: '', iban: '' };
  await page.setContent(`<html><body style="font-family:Arial;padding:36px;color:#111;font-size:13px">
    <h2 style="margin:0 0 4px">${title}</h2><div>від ${d.date || d.signed_at}</div><hr>
    <p><b>Постачальник:</b> ${supplier.name}<br>ЄДРПОУ ${supplier.edrpou || '—'}<br>IBAN ${supplier.iban || '—'}</p>
    <p><b>Покупець:</b> ${customer.name}, ЄДРПОУ ${customer.edrpou}</p>
    ${lines ? `<table border="1" cellspacing="0" cellpadding="6" width="100%"><tr><th>№</th><th>Найменування</th><th>К-сть</th><th>Ціна, грн</th><th>Сума, грн</th></tr>${lines}</table>` : `<p>Предмет: ${d.subject}. Сума договору: ${d.amount?.toLocaleString('uk-UA')} грн.</p>`}
    ${d.subtotal ? `<p style="text-align:right">Разом без ПДВ: ${d.subtotal.toLocaleString('uk-UA')}<br>ПДВ 20%: ${d.vat.toLocaleString('uk-UA')}<br><b>Всього до сплати: ${d.total.toLocaleString('uk-UA')} грн</b></p>` : ''}
    <p style="margin-top:40px">Директор ____________ / підпис /</p></body></html>`);
  const file = `${doc.id}_${doc.originalName}`;
  writeFileSync(path.join(root, 'files', file), await page.pdf({ format: 'A4' }));
  doc.storagePath = `local:${file}`;
}
await browser.close();

writeFileSync(path.join(root, 'docai.json'), JSON.stringify({ types, documents }, null, 2));
for (const e of audit.sort((a, b) => a.at.localeCompare(b.at))) appendFileSync(path.join(root, 'settings', 'audit.jsonl'), JSON.stringify(e) + '\n');
console.log(`Demo workspace: ${root} — ${documents.length} documents, ${types.length} templates, ${audit.length} audit events.`);
console.log('Run: npm run demo  (http://localhost:3001, login admin / admin)');
