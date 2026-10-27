import "./server/config";
import { localStore, nextLocalId, persistLocal } from "./server/local-store";
import express from "express";
import multer from "multer";
import cors from "cors";
import path from "path";
import { randomBytes } from "node:crypto";
import { connection, publicSettings, updateSettings, canEditSettings, isProvider } from "./server/settings";
import { checkConnection } from "./server/providers";
import { integrationKeysConfigured } from "./server/integration";
import {
  actorOf, authStatus, clearLoginFailures, clearSessionCookie, deleteLocalUser, findUser, issueSession, listUsers,
  loginAllowed, principalOf, publicUser, recordLoginFailure, requireAuth, resolvePrincipal, setSessionCookie,
  upsertLocalUser, usersConfigured, verifyPassword,
} from "./server/auth";
import { processDocumentBuffer } from "./server/process-document";
import { createV1Router } from "./server/v1";
import { runWorkerTick, startWorker } from "./server/worker";
import { computeStats } from "./server/stats";
import { timingSafeEqual } from "node:crypto";
import { appendAudit, auditCostSummary } from "./server/audit";
import { deliverWebhook, eventForDocumentStatus, webhooksConfigured } from "./server/webhooks";
import { storageMode, storageUnavailable } from "./server/storage";
import { accountingSchemas, normalizeTemplateSchema, schemaForSlug, validateAgainstSchema } from "./server/schemas";
import { getTemplateBySlug } from "./server/templates";
import { localArchivePath } from "./server/files";

const { isSupabaseConfigured, isLocalMode, supabase } = storageMode();

// Use memory storage for Vercel Serverless compatibility
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });

const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY) app.set('trust proxy', process.env.TRUST_PROXY === 'true' ? true : process.env.TRUST_PROXY);

// --- Middleware ---
app.use((req, res, next) => {
  (req as any).requestId = randomBytes(6).toString('hex');
  res.setHeader('X-Request-Id', (req as any).requestId);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use(cors({ origin: process.env.APP_ORIGIN || false, credentials: true }));
app.use(express.json({ limit: '256kb' }));
// CSRF guard: browsers always send Origin on cross-site state-changing requests. It is NOT an authentication signal.
app.use('/api', (req, res, next) => {
  const origin = req.get('origin');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && origin && origin !== `${req.protocol}://${req.get('host')}` && origin !== process.env.APP_ORIGIN) return res.status(403).json({ error: 'Запит з іншого сайту відхилено' });
  next();
});

const httpError = (status: number, message: string) => Object.assign(new Error(message), { status, expose: true });

function mapSupabaseDoc(d: any) {
  let extractedData = d.extracted_data;
  if (typeof extractedData === 'string') {
    try { extractedData = JSON.parse(extractedData); } catch { extractedData = { format: 'text', content: extractedData }; }
  }
  return {
    ...d,
    originalName: d.original_name,
    mimeType: d.mime_type,
    typeSlug: d.type_slug,
    createdAt: d.created_at,
    extractedData,
    validationErrors: d.validation_errors || extractedData?._validation_errors || [],
    storagePath: d.storage_path || extractedData?._storage_path || undefined,
    status: d.status || extractedData?._status || undefined,
    errorMessage: d.error_message || undefined,
    originalExtractedData: d.original_extracted_data ?? undefined,
    createdBy: d.created_by || undefined,
    editedBy: d.edited_by || extractedData?._edited_by || undefined,
    editedAt: d.edited_at || extractedData?._edited_at || undefined,
    reviewedBy: d.reviewed_by || extractedData?._reviewed_by || undefined,
    reviewedAt: d.reviewed_at || undefined,
    reviewNote: d.review_note || extractedData?._review_note || undefined,
  };
}

/**
 * Supabase update that degrades gracefully on older schemas (42703 = unknown column):
 * full patch → core status columns → metadata folded into extracted_data.
 */
async function updateDocumentRow(id: string, attempts: Record<string, unknown>[]) {
  let last: any;
  for (const patch of attempts) {
    last = await supabase.from('documents').update(patch).eq('id', id).select().single();
    if (last.error?.code !== '42703') break;
  }
  if (last.error) throw last.error;
  return mapSupabaseDoc(last.data);
}

async function getDocumentById(id: string) {
  if (isLocalMode) {
    return localStore.documents.find((d) => String(d.id) === id) || null;
  }
  if (!isSupabaseConfigured) return null;
  const { data: d, error } = await supabase.from('documents').select('*').eq('id', id).maybeSingle();
  if (error) throw error;
  return d ? mapSupabaseDoc(d) : null;
}

async function reviewDocumentById(id: string, action: 'approve' | 'reject', note?: string, actor?: string) {
  const nextStatus = action === 'approve' ? 'approved' : 'rejected';
  if (isLocalMode) {
    const document = localStore.documents.find((d) => String(d.id) === id);
    if (!document) throw httpError(404, 'Документ не знайдено');
    if (document.status === 'failed') throw httpError(400, 'Не можна підтвердити документ із помилкою обробки');
    if (document.status === 'invalid' && action === 'approve') {
      throw httpError(400, 'Спочатку виправте поля: схема обліку не пройдена');
    }
    document.status = nextStatus;
    document.reviewedAt = new Date().toISOString();
    document.reviewNote = note;
    document.reviewedBy = actor;
    persistLocal();
    appendAudit({ action: `review.${action}`, actor, via: 'ui', documentId: document.id, typeSlug: document.typeSlug, status: nextStatus });
    const evt = eventForDocumentStatus(nextStatus);
    if (evt) await deliverWebhook(evt, { documentId: document.id, status: nextStatus, typeSlug: document.typeSlug, actor, note });
    return document;
  }
  if (!isSupabaseConfigured) throw storageUnavailable();
  const { data: existing, error: readError } = await supabase.from('documents').select('*').eq('id', id).maybeSingle();
  if (readError) throw readError;
  if (!existing) throw httpError(404, 'Документ не знайдено');
  if (existing.status === 'failed') throw httpError(400, 'Не можна підтвердити документ із помилкою обробки');
  if (existing.status === 'invalid' && action === 'approve') {
    throw httpError(400, 'Спочатку виправте поля: схема обліку не пройдена');
  }
  const extracted = typeof existing.extracted_data === 'string' ? JSON.parse(existing.extracted_data) : { ...(existing.extracted_data || {}) };
  const doc = await updateDocumentRow(id, [
    { status: nextStatus, reviewed_by: actor || null, reviewed_at: new Date().toISOString(), review_note: note || null },
    { status: nextStatus },
    { extracted_data: { ...extracted, _status: nextStatus, _review_note: note, _reviewed_by: actor } },
  ]);
  appendAudit({ action: `review.${action}`, actor, via: 'integration', documentId: doc.id, typeSlug: doc.typeSlug, status: nextStatus });
  const evt = eventForDocumentStatus(nextStatus);
  if (evt) await deliverWebhook(evt, { documentId: doc.id, status: nextStatus, typeSlug: doc.typeSlug, actor, note });
  return doc;
}

// --- Auth ---

app.get('/api/auth/me', (req, res) => {
  res.set('Cache-Control', 'no-store').json({ ...authStatus(req), companyName: publicSettings().companyName });
});

app.post('/api/auth/login', (req, res, next) => {
  try {
    const email = typeof req.body?.email === 'string' ? req.body.email.trim().toLowerCase() : '';
    const password = typeof req.body?.password === 'string' ? req.body.password : '';
    const throttleKeys = [`ip:${req.ip}`, `email:${email}`];
    if (!throttleKeys.every(loginAllowed)) return res.status(429).json({ error: 'Забагато спроб входу. Спробуйте через 15 хвилин.' });
    const user = findUser(email);
    const ok = verifyPassword(password, user?.passwordHash || '') && !!user;
    if (!ok || !user) {
      throttleKeys.forEach(recordLoginFailure);
      appendAudit({ action: 'auth.login_failed', actor: email || undefined, via: 'ui', detail: `ip=${req.ip}` });
      return res.status(401).json({ error: 'Невірний email або пароль' });
    }
    throttleKeys.forEach(clearLoginFailures);
    setSessionCookie(req, res, issueSession(user));
    appendAudit({ action: 'auth.login', actor: user.email, via: 'ui' });
    res.set('Cache-Control', 'no-store').json({ user: { email: user.email, role: user.role, name: user.name, kind: 'user' } });
  } catch (error) { next(error); }
});

app.post('/api/auth/logout', (req, res) => {
  const principal = resolvePrincipal(req);
  clearSessionCookie(req, res);
  if (principal && principal !== 'bad_key') appendAudit({ action: 'auth.logout', actor: principal.email, via: 'ui' });
  res.json({ ok: true });
});

app.get('/api/users', requireAuth('admin'), (_req, res) => {
  res.set('Cache-Control', 'no-store').json({ users: listUsers().map(publicUser) });
});
app.put('/api/users', requireAuth('admin'), (req, res, next) => {
  try {
    const user = upsertLocalUser(req.body || {});
    appendAudit({ action: 'user.upsert', actor: actorOf(req), via: 'ui', detail: `${user.email} role=${user.role}` });
    res.json(user);
  } catch (error) { next(error); }
});
app.delete('/api/users/:email', requireAuth('admin'), (req, res, next) => {
  try {
    if (principalOf(req)?.email === req.params.email.toLowerCase()) throw httpError(400, 'Не можна видалити власний обліковий запис');
    deleteLocalUser(req.params.email);
    appendAudit({ action: 'user.delete', actor: actorOf(req), via: 'ui', detail: req.params.email });
    res.json({ ok: true });
  } catch (error) { next(error); }
});

// --- API Routes ---

app.get("/api/health", async (req, res) => {
  const principal = resolvePrincipal(req);
  const base = { status: "ok", apiVersions: ['v1'] };
  // Unauthenticated callers (load balancers, uptime checks) only learn that the service is alive.
  if (!principal || principal === 'bad_key') return res.json(base);
  res.json({
    ...base,
    supabaseConfigured: !!isSupabaseConfigured,
    aiConfigured: connection().configured,
    provider: connection().provider,
    storage: isSupabaseConfigured ? "supabase" : isLocalMode ? "local" : "none",
    filesArchived: true,
    integrationKeysConfigured: integrationKeysConfigured(),
    webhooksConfigured: webhooksConfigured(),
    usersConfigured: usersConfigured(),
    queueWorker: process.env.DOCAI_WORKER !== '0' && !process.env.VERCEL,
    settingsEditable: canEditSettings(req) && principal.role === 'admin',
    maxUploadBytes: 10 * 1024 * 1024,
    env: process.env.NODE_ENV,
    isVercel: !!process.env.VERCEL,
    accountingSchemas: ['invoice', 'act'],
    cost: principal.role === 'admin' ? await auditCostSummary().catch(() => undefined) : undefined,
  });
});

app.get('/api/settings', requireAuth('viewer'), (req, res) => {
  const editable = canEditSettings(req) && principalOf(req)?.role === 'admin';
  res.set('Cache-Control', 'no-store').json({ ...publicSettings(), editable });
});
app.use('/api/settings', requireAuth('admin'), (req, res, next) => {
  if (!canEditSettings(req) || req.get('x-docai-settings') !== '1' || !req.is('application/json')) return res.status(403).json({ error: 'Зміна ключів доступна лише локально. На сервері використайте змінні середовища.' });
  next();
});
app.put('/api/settings', (req, res) => {
  try {
    const result = updateSettings(req.body);
    appendAudit({ action: 'settings.update', actor: actorOf(req), via: 'ui', provider: result.provider });
    res.set('Cache-Control', 'no-store').json({ ...result, editable: true });
  }
  catch (error: any) { res.status(400).json({ error: error.message }); }
});
app.post('/api/settings/test', async (req, res) => {
  if (!isProvider(req.body.provider)) return res.status(400).json({ error: 'Невідомий AI-провайдер' });
  try {
    res.json(await checkConnection(
      req.body.provider,
      typeof req.body.key === 'string' ? req.body.key : undefined,
      typeof req.body.endpoint === 'string' ? req.body.endpoint : undefined,
      typeof req.body.apiVersion === 'string' ? req.body.apiVersion : undefined,
    ));
  } catch (error: any) { res.status(400).json({ error: error.name === 'TimeoutError' ? 'Перевірка перевищила 15 секунд.' : error.message }); }
});

function validateTemplateBody(body: any) {
  const { name, slug, prompt } = body || {};
  if (![name, slug, prompt].every(v => typeof v === "string" && v.trim())) throw httpError(400, "Всі поля обов'язкові");
  const safeSlug = slug.trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(safeSlug) || safeSlug === 'custom') throw httpError(400, 'Slug: латинські літери, цифри та дефіси; custom зарезервовано.');
  if (name.length > 120 || prompt.length > 20_000) throw httpError(400, 'Назва до 120 символів, промпт до 20 000 символів');
  const record: { name: string; slug: string; prompt: string; schema?: unknown } = { name: name.trim(), slug: safeSlug, prompt: prompt.trim() };
  if (body.schema !== undefined) record.schema = normalizeTemplateSchema(body.schema);
  return record;
}

/** Supabase projects created before the schema column existed: retry without it instead of failing the save. */
async function writeTemplate(op: 'insert' | 'update', body: Record<string, unknown>, id?: number) {
  const run = (payload: Record<string, unknown>) => op === 'insert'
    ? supabase.from("document_types").insert([payload]).select().single()
    : supabase.from("document_types").update(payload).eq("id", id!).select().maybeSingle();
  let result = await run(body);
  let schemaSaved = body.schema !== undefined;
  if (result.error?.code === '42703' && 'schema' in body) {
    const { schema: _omit, ...rest } = body;
    result = await run(rest);
    schemaSaved = false;
  }
  return { ...result, schemaSaved };
}

app.get('/api/schemas', requireAuth('viewer'), (_req, res) => {
  res.json(accountingSchemas);
});

app.get("/api/types", requireAuth('viewer'), async (req, res, next) => {
  try {
    if (isLocalMode) return res.json(localStore.types);
    if (!isSupabaseConfigured) throw storageUnavailable();
    const { data, error } = await supabase.from("document_types").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data.map(t => ({ ...t, createdAt: t.created_at })));
  } catch (error) {
    next(error);
  }
});

app.post("/api/types", requireAuth('admin'), async (req, res, next) => {
  try {
    const body = validateTemplateBody(req.body);
    if (isLocalMode) {
      if (localStore.types.some(t => t.slug === body.slug)) return res.status(409).json({ error: 'Такий slug вже існує' });
      const record = { id: nextLocalId(), ...body, createdAt: new Date().toISOString() };
      localStore.types.unshift(record);
      persistLocal();
      appendAudit({ action: 'template.create', actor: actorOf(req), via: 'ui', typeSlug: body.slug });
      return res.json(record);
    }
    if (!isSupabaseConfigured) throw storageUnavailable();
    const { data, error, schemaSaved } = await writeTemplate('insert', body);
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Такий slug вже існує' });
      throw error;
    }
    appendAudit({ action: 'template.create', actor: actorOf(req), via: 'ui', typeSlug: body.slug });
    res.json({ ...data, createdAt: data.created_at, warning: body.schema !== undefined && !schemaSaved ? 'Схему не збережено: додайте колонку schema (див. DEPLOYMENT_GUIDE).' : undefined });
  } catch (error) {
    next(error);
  }
});

app.put("/api/types/:id", requireAuth('admin'), async (req, res, next) => {
  try {
    const body = validateTemplateBody(req.body);
    const id = Number(req.params.id);
    if (isLocalMode) {
      if (localStore.types.some(t => t.slug === body.slug && t.id !== id)) return res.status(409).json({ error: 'Такий slug вже існує' });
      const index = localStore.types.findIndex(t => t.id === id);
      if (index < 0) return res.status(404).json({ error: 'Шаблон не знайдено' });
      const record = { ...localStore.types[index], ...body, updatedAt: new Date().toISOString() };
      localStore.types[index] = record;
      persistLocal();
      appendAudit({ action: 'template.update', actor: actorOf(req), via: 'ui', typeSlug: body.slug });
      return res.json(record);
    }
    if (!isSupabaseConfigured) throw storageUnavailable();
    const { data, error, schemaSaved } = await writeTemplate('update', body, id);
    if (error) {
      if (error.code === '23505') return res.status(409).json({ error: 'Такий slug вже існує' });
      throw error;
    }
    if (!data) return res.status(404).json({ error: 'Шаблон не знайдено' });
    appendAudit({ action: 'template.update', actor: actorOf(req), via: 'ui', typeSlug: body.slug });
    res.json({ ...data, createdAt: data.created_at, warning: body.schema !== undefined && !schemaSaved ? 'Схему не збережено: додайте колонку schema (див. DEPLOYMENT_GUIDE).' : undefined });
  } catch (error) {
    next(error);
  }
});

app.delete("/api/types/:id", requireAuth('admin'), async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    if (isLocalMode) {
      const existing = localStore.types.find(t => t.id === id);
      if (!existing) return res.status(404).json({ error: 'Шаблон не знайдено' });
      localStore.types = localStore.types.filter(t => t.id !== id);
      persistLocal();
      appendAudit({ action: 'template.delete', actor: actorOf(req), via: 'ui', typeSlug: existing.slug });
      return res.json({ success: true });
    }
    if (!isSupabaseConfigured) throw storageUnavailable();
    const { data, error } = await supabase.from("document_types").delete().eq("id", id).select('slug');
    if (error) throw error;
    if (!data?.length) return res.status(404).json({ error: 'Шаблон не знайдено' });
    appendAudit({ action: 'template.delete', actor: actorOf(req), via: 'ui', typeSlug: data[0].slug });
    res.json({ success: true });
  } catch (error) {
    next(error);
  }
});

app.get("/api/documents", requireAuth('viewer'), async (req, res, next) => {
  try {
    if (isLocalMode) return res.json(localStore.documents);
    if (!isSupabaseConfigured) throw storageUnavailable();
    const { data, error } = await supabase.from("documents").select("*").order("created_at", { ascending: false });
    if (error) throw error;
    res.json(data.map(mapSupabaseDoc));
  } catch (error) {
    next(error);
  }
});

app.get('/api/documents/:id', requireAuth('viewer'), async (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
    const document = await getDocumentById(req.params.id);
    return document ? res.json(document) : res.status(404).json({ error: 'Документ не знайдено' });
  } catch (error) { next(error); }
});

/** Collect changed leaf paths between two JSON values (for the audit trail of manual corrections). */
function diffPaths(before: any, after: any, prefix = '', out: string[] = []): string[] {
  if (out.length > 50) return out;
  const isObj = (v: any) => v && typeof v === 'object';
  if (isObj(before) && isObj(after) && Array.isArray(before) === Array.isArray(after)) {
    const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
    for (const k of keys) diffPaths(before[k], after[k], Array.isArray(after) ? `${prefix}[${k}]` : prefix ? `${prefix}.${k}` : k, out);
    return out;
  }
  if (JSON.stringify(before) !== JSON.stringify(after)) out.push(prefix || '(root)');
  return out;
}

function assertEditablePayload(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw httpError(400, 'extractedData має бути JSON-об’єктом');
  if (JSON.stringify(value).length > 200_000) throw httpError(413, 'Дані документа завеликі (понад 200 КБ)');
}

/** Manual correction by an operator: store the new data, keep the AI original once, re-validate, reset review. */
async function updateDocumentById(id: string, extractedData: any, actor?: string) {
  assertEditablePayload(extractedData);
  const existing = await getDocumentById(id);
  if (!existing) throw httpError(404, 'Документ не знайдено');
  if (existing.status === 'approved') throw httpError(409, 'Документ уже підтверджено. Спочатку відхиліть його, якщо дані треба змінити.');
  if (existing.status === 'failed') throw httpError(400, 'Документ з помилкою AI не має даних для редагування — оброби файл повторно.');
  const template = await getTemplateBySlug(existing.typeSlug).catch(() => null);
  const schema = schemaForSlug(existing.typeSlug, template?.schema);
  const check = schema ? validateAgainstSchema(extractedData, existing.typeSlug, template?.schema) : { ok: true, errors: [] };
  const status = schema ? (check.ok ? 'pending_review' : 'invalid') : 'completed';
  const errorMessage = check.ok ? undefined : check.errors.filter(e => e.severity !== 'warning').map(e => `${e.path || 'document'}: ${e.message}`).join('; ');
  const changed = diffPaths(existing.extractedData, extractedData);
  const editedAt = new Date().toISOString();
  let doc: any;
  if (isLocalMode) {
    const document = localStore.documents.find((d) => String(d.id) === id)!;
    if (document.originalExtractedData === undefined) document.originalExtractedData = document.extractedData;
    Object.assign(document, { extractedData, status, validationErrors: check.errors, errorMessage, editedAt, editedBy: actor });
    persistLocal();
    doc = document;
  } else {
    if (!isSupabaseConfigured) throw storageUnavailable();
    const core = { extracted_data: extractedData, status, validation_errors: check.errors, error_message: errorMessage || null };
    doc = await updateDocumentRow(id, [
      { ...core, edited_by: actor || null, edited_at: editedAt, ...(existing.originalExtractedData === undefined ? { original_extracted_data: existing.extractedData } : {}) },
      core,
      // Legacy schema without status columns: keep metadata inside extracted_data like the insert fallback does.
      { extracted_data: { ...extractedData, _status: status, _validation_errors: check.errors, _edited_by: actor, _edited_at: editedAt } },
    ]);
  }
  appendAudit({ action: 'document.edit', actor, via: 'ui', documentId: doc.id, typeSlug: doc.typeSlug, status, detail: changed.length ? `змінено: ${changed.slice(0, 20).join(', ')}` : 'без змін' });
  await deliverWebhook('document.updated', { documentId: doc.id, status, typeSlug: doc.typeSlug, actor, changedFields: changed.slice(0, 50), validationErrors: check.errors });
  return doc;
}

app.patch('/api/documents/:id', requireAuth('operator'), async (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
    res.json(await updateDocumentById(req.params.id, req.body?.extractedData, actorOf(req)));
  } catch (error) { next(error); }
});

const previewableMime = /^(application\/pdf|image\/(png|jpeg|webp)|text\/(plain|csv)|application\/json)$/;

/** Original file for the review screen. Only inert types are shown inline; everything else downloads. */
app.get('/api/documents/:id/file', requireAuth('viewer'), async (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
    const doc = await getDocumentById(req.params.id);
    if (!doc) return res.status(404).json({ error: 'Документ не знайдено' });
    const storagePath: string = doc.storagePath || '';
    const mime = String(doc.mimeType || 'application/octet-stream');
    const inline = previewableMime.test(mime) && req.query.download !== '1';
    const filename = encodeURIComponent(String(doc.originalName || 'document'));
    if (storagePath.startsWith('supabase:')) {
      const [bucket, ...rest] = storagePath.slice('supabase:'.length).split('/');
      const { data, error } = await supabase.storage.from(bucket).createSignedUrl(rest.join('/'), 120, inline ? undefined : { download: String(doc.originalName || 'document') });
      if (error || !data?.signedUrl) throw error || new Error('signed url failed');
      return res.redirect(302, data.signedUrl);
    }
    const full = localArchivePath(storagePath);
    if (!full) return res.status(404).json({ error: 'Оригінал файлу не збережено (старий запис або файл видалено за терміном зберігання).' });
    res.setHeader('Content-Type', mime.startsWith('text/') || mime === 'application/json' ? `${mime === 'application/json' ? 'text/plain' : mime}; charset=utf-8` : mime);
    res.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${filename}`);
    res.setHeader('Cache-Control', 'private, no-store');
    res.setHeader('Content-Security-Policy', "default-src 'none'; img-src 'self'; style-src 'unsafe-inline'; object-src 'self'");
    res.sendFile(full);
  } catch (error) { next(error); }
});

/** Legacy sync parse — kept for UI / older clients. Prefer POST /api/v1/parse (202 + jobId). */
app.post(["/api/parse", "/api/parse/:slug"], requireAuth('operator'), upload.single("document"), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: "Файл не надано" });
    if (!/\.(pdf|docx|xlsx|xls|csv|json|txt|png|jpe?g|webp)$/i.test(req.file.originalname)) return res.status(415).json({ error: 'Формат не підтримується. Використайте PDF, DOCX, Excel, CSV, JSON, TXT або зображення.' });
    const provider = req.body.provider || connection().provider;
    if (!isProvider(provider)) return res.status(400).json({ error: 'Невідомий AI-провайдер' });
    if (!connection(provider).configured) return res.status(503).json({ error: 'Підключіть обраного AI-провайдера у налаштуваннях.' });

    const file = req.file;
    file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
    const slug = req.params.slug || req.body.slug;
    const actor = actorOf(req);
    const via = (req as any).integrationAuth ? 'integration' : 'ui';

    const result = await processDocumentBuffer({
      buffer: file.buffer,
      originalName: file.originalname,
      mimeType: file.mimetype,
      slug: typeof slug === 'string' ? slug : undefined,
      prompt: typeof req.body.prompt === 'string' ? req.body.prompt : undefined,
      provider,
      actor,
    });

    appendAudit({
      action: result.parseStatus === 'failed' ? 'parse.failed' : 'parse.completed',
      actor,
      via,
      documentId: result.document.id,
      typeSlug: result.document.typeSlug,
      provider: result.provider,
      model: result.aiModel,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs: result.durationMs,
      estimatedCostUsd: result.estimatedCostUsd,
      status: result.reviewStatus,
      detail: result.errorMessage || undefined,
    });

    const evt = eventForDocumentStatus(result.reviewStatus);
    if (evt) {
      await deliverWebhook(evt, {
        documentId: result.document.id,
        status: result.reviewStatus,
        typeSlug: result.document.typeSlug,
        originalName: result.document.originalName,
        validationErrors: result.validationErrors,
        estimatedCostUsd: result.estimatedCostUsd,
        durationMs: result.durationMs,
        provider: result.provider,
        model: result.aiModel,
        sync: true,
      });
    }

    if (result.parseStatus === 'failed') {
      return res.status(500).json({ error: result.errorMessage, id: result.document.id, status: 'failed' });
    }
    return res.status(result.reviewStatus === 'invalid' ? 422 : 200).json({
      ...result.document,
      error: result.reviewStatus === 'invalid' ? result.errorMessage : undefined,
    });
  } catch (error: any) {
    next(error);
  }
});

app.post('/api/documents/:id/review', requireAuth('operator'), async (req, res, next) => {
  try {
    if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
    const action = req.body?.action;
    if (action !== 'approve' && action !== 'reject') {
      return res.status(400).json({ error: 'action має бути approve або reject' });
    }
    const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
    const document = await reviewDocumentById(req.params.id, action, note, actorOf(req));
    return res.json(document);
  } catch (error: any) {
    next(error);
  }
});

app.use('/api/v1', createV1Router({
  getDocument: getDocumentById,
  reviewDocument: reviewDocumentById,
  updateDocument: updateDocumentById,
  stats: (days) => computeStats(days),
}));

/**
 * Background work for hosts without a long-running process (Vercel Cron, external scheduler).
 * Authorization: Bearer <DOCAI_CRON_SECRET or CRON_SECRET>. Vercel Cron sends CRON_SECRET automatically.
 */
app.all('/api/internal/worker-tick', async (req, res, next) => {
  try {
    const secret = (process.env.DOCAI_CRON_SECRET || process.env.CRON_SECRET || '').trim();
    const provided = (req.get('authorization') || '').replace(/^Bearer\s+/i, '');
    const ok = secret.length >= 16 && provided.length === secret.length && timingSafeEqual(Buffer.from(provided), Buffer.from(secret));
    if (!ok) return res.status(401).json({ error: 'Невірний або не налаштований DOCAI_CRON_SECRET' });
    const budgetMs = Math.min(Math.max(Number(req.query.budgetMs) || 45_000, 1_000), 280_000);
    res.json(await runWorkerTick({ budgetMs, maxJobs: 50 }));
  } catch (error) { next(error); }
});

app.use('/api', (req, res) => res.status(404).json({ error: 'API-адресу не знайдено' }));

// --- Error Handling ---
// Registered before the SPA/Vite middleware is attached so API errors never fall through to HTML.
app.use('/api', (err: any, req: express.Request, res: express.Response, _next: express.NextFunction) => {
  const requestId = (req as any).requestId;
  if (err?.code === 'LIMIT_FILE_SIZE') return res.status(413).json({ error: 'Файл перевищує ліміт 10 MB', requestId });
  if (err?.type === 'entity.too.large') return res.status(413).json({ error: 'Запит завеликий', requestId });
  if (err?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Некоректний JSON у запиті', requestId });
  const status = Number(err?.status) >= 400 && Number(err?.status) < 600 ? Number(err.status) : 500;
  console.error(`API Error [${requestId}] ${req.method} ${req.path}:`, err);
  // 4xx messages are written for users; 5xx internals (DB errors, stack traces) stay in server logs.
  const message = status < 500 || err?.expose ? err?.message || 'Помилка запиту' : 'Внутрішня помилка сервера. Повідомте адміністратору код запиту.';
  res.status(status).json({ error: message, requestId });
});

// --- Static Files & Vite ---

const setupStaticAndVite = async () => {
  if (process.env.NODE_ENV !== "production" && !process.env.VERCEL) {
    try {
      const port = Number(process.env.PORT) || 3000;
      const { createServer: createViteServer } = await import("vite");
      const vite = await createViteServer({
        server: {
          middlewareMode: true,
          allowedHosts: true,
          hmr: process.env.DISABLE_HMR === 'true' ? false : { clientPort: port },
        },
        appType: "spa",
      });
      app.use(vite.middlewares);
    } catch (e) {
      console.error("Vite setup failed:", e);
    }
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res, next) => {
      if (req.path.startsWith('/api')) return next();
      res.sendFile(path.join(distPath, "index.html"), (err) => {
        if (err) res.status(404).send("Frontend missing");
      });
    });
  }
};

// --- Start ---
const start = async () => {
  await setupStaticAndVite();
  if (!process.env.VERCEL) {
    await startWorker();
    const port = Number(process.env.PORT) || 3000;
    app.listen(port, process.env.HOST || (process.env.NODE_ENV === "production" ? "0.0.0.0" : "127.0.0.1"), () => {
      console.log(`Server running on http://localhost:${port}`);
      if (process.env.NODE_ENV === 'production' && !usersConfigured()) {
        console.warn('[auth] No users configured (DOCAI_USERS). The UI will ask for login and nobody can sign in; API works only with integration keys.');
      }
    });
  }
};

if (!process.env.VERCEL) {
  start().catch((error) => {
    console.error('Failed to start server:', error);
    process.exit(1);
  });
} else {
  setupStaticAndVite().catch((error) => console.error('Vite/static setup failed:', error));
}

export default app;
