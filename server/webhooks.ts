import './config';
import { createHmac, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { storageMode } from './storage';

export type WebhookEventType =
  | 'document.pending_review'
  | 'document.approved'
  | 'document.rejected'
  | 'document.failed'
  | 'document.invalid'
  | 'document.updated'
  | 'job.completed'
  | 'job.failed';

export type WebhookPayload = {
  id: string;
  apiVersion: 'v1';
  type: WebhookEventType;
  createdAt: string;
  workspaceId: string;
  data: Record<string, unknown>;
};

export type Delivery = {
  id: string;
  type: WebhookEventType;
  url: string;
  body: string;
  status: 'pending' | 'delivered' | 'failed';
  attempts: number;
  nextAttemptAt: string;
  createdAt: string;
  deliveredAt?: string;
  lastStatus?: number;
  lastError?: string;
};

function webhookUrl() {
  return (process.env.DOCAI_WEBHOOK_URL || '').trim();
}

function webhookSecret() {
  return (process.env.DOCAI_WEBHOOK_SECRET || '').trim();
}

export function webhooksConfigured() {
  return !!webhookUrl();
}

export function signWebhookBody(body: string, secret: string) {
  return createHmac('sha256', secret).update(body).digest('hex');
}

/** Replay-safe signature: HMAC over "<unix seconds>.<body>". Receivers should reject timestamps older than ~5 min. */
export function signWebhookV2(body: string, secret: string, timestamp: number) {
  return `t=${timestamp},v1=${createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex')}`;
}

// Retry schedule after a failed attempt: 1m, 5m, 30m, 2h, 6h, 24h (scaled by DOCAI_WEBHOOK_RETRY_BASE_MS for tests).
const retryMultipliers = [1, 5, 30, 120, 360, 1440];
const retryBaseMs = () => Math.max(10, Number(process.env.DOCAI_WEBHOOK_RETRY_BASE_MS || 60_000));
export const maxWebhookAttempts = retryMultipliers.length + 1;

// ---------------------------------------------------------------- outbox stores

interface OutboxStore {
  add(d: Delivery): Promise<void>;
  due(limit: number): Promise<Delivery[]>;
  update(id: string, patch: Partial<Delivery>): Promise<void>;
  list(limit: number): Promise<Delivery[]>;
  get(id: string): Promise<Delivery | null>;
}

class FileOutbox implements OutboxStore {
  private rows: Delivery[] = [];
  private readonly file = path.join(path.resolve(process.env.LOCAL_SETTINGS_DIR || '.data/settings'), 'webhook-outbox.json');
  constructor() {
    if (existsSync(this.file)) {
      try { this.rows = JSON.parse(readFileSync(this.file, 'utf8')).deliveries || []; } catch { this.rows = []; }
    }
  }
  private persist() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify({ deliveries: this.rows }), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }
  async add(d: Delivery) {
    this.rows.unshift(d);
    // Keep undelivered events; trim delivered history.
    if (this.rows.length > 2000) this.rows = this.rows.filter((r, i) => r.status === 'pending' || i < 1500);
    this.persist();
  }
  async due(limit: number) {
    const now = Date.now();
    return this.rows.filter((r) => r.status === 'pending' && Date.parse(r.nextAttemptAt) <= now).reverse().slice(0, limit);
  }
  async update(id: string, patch: Partial<Delivery>) {
    const row = this.rows.find((r) => r.id === id);
    if (row) { Object.assign(row, patch); this.persist(); }
  }
  async list(limit: number) { return this.rows.slice(0, limit); }
  async get(id: string) { return this.rows.find((r) => r.id === id) || null; }
}

const toRow = (d: Partial<Delivery>) => {
  const map: Record<string, string> = { nextAttemptAt: 'next_attempt_at', createdAt: 'created_at', deliveredAt: 'delivered_at', lastStatus: 'last_status', lastError: 'last_error' };
  return Object.fromEntries(Object.entries(d).filter(([, v]) => v !== undefined).map(([k, v]) => [map[k] || k, v]));
};
const fromRow = (r: any): Delivery => ({
  id: r.id, type: r.type, url: r.url, body: r.body, status: r.status, attempts: r.attempts, nextAttemptAt: r.next_attempt_at,
  createdAt: r.created_at, deliveredAt: r.delivered_at || undefined, lastStatus: r.last_status ?? undefined, lastError: r.last_error || undefined,
});

class PostgresOutbox implements OutboxStore {
  private get db() { return storageMode().supabase; }
  async add(d: Delivery) { const { error } = await this.db.from('docai_webhook_deliveries').insert([toRow(d)]); if (error) throw error; }
  async due(limit: number) {
    const { data, error } = await this.db.from('docai_webhook_deliveries').select('*').eq('status', 'pending').lte('next_attempt_at', new Date().toISOString()).order('created_at').limit(limit);
    if (error) throw error;
    return (data || []).map(fromRow);
  }
  async update(id: string, patch: Partial<Delivery>) { const { error } = await this.db.from('docai_webhook_deliveries').update(toRow(patch)).eq('id', id); if (error) throw error; }
  async list(limit: number) {
    const { data, error } = await this.db.from('docai_webhook_deliveries').select('*').order('created_at', { ascending: false }).limit(limit);
    if (error) throw error;
    return (data || []).map(fromRow);
  }
  async get(id: string) {
    const { data, error } = await this.db.from('docai_webhook_deliveries').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? fromRow(data) : null;
  }
}

let outbox: OutboxStore | null = null;
function store(): OutboxStore {
  if (!outbox) outbox = storageMode().isSupabaseConfigured && process.env.DOCAI_QUEUE !== 'file' ? new PostgresOutbox() : new FileOutbox();
  return outbox;
}

// ---------------------------------------------------------------- delivery

const inFlight = new Set<string>();

async function attempt(d: Delivery) {
  if (inFlight.has(d.id)) return;
  inFlight.add(d.id);
  const secret = webhookSecret();
  const timestamp = Math.floor(Date.now() / 1000);
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    'User-Agent': 'DocAI-Webhook/1.1',
    'X-DocAI-Event': d.type,
    'X-DocAI-Delivery': d.id,
    'X-DocAI-Attempt': String(d.attempts + 1),
    'X-DocAI-Timestamp': String(timestamp),
  };
  if (secret) {
    headers['X-DocAI-Signature'] = `sha256=${signWebhookBody(d.body, secret)}`;
    headers['X-DocAI-Signature-256'] = signWebhookV2(d.body, secret, timestamp);
  }
  const attempts = d.attempts + 1;
  try {
    const res = await fetch(d.url, { method: 'POST', headers, body: d.body, signal: AbortSignal.timeout(15_000), redirect: 'manual' });
    if (res.ok) {
      await store().update(d.id, { status: 'delivered', attempts, deliveredAt: new Date().toISOString(), lastStatus: res.status, lastError: undefined });
      return true;
    }
    const text = await res.text().catch(() => '');
    await scheduleRetry(d, attempts, res.status, `HTTP ${res.status} ${text.slice(0, 200)}`);
  } catch (e) {
    await scheduleRetry(d, attempts, undefined, e instanceof Error ? e.message : String(e));
  } finally {
    inFlight.delete(d.id);
  }
  return false;
}

async function scheduleRetry(d: Delivery, attempts: number, lastStatus: number | undefined, lastError: string) {
  const exhausted = attempts >= maxWebhookAttempts;
  const delay = retryBaseMs() * (retryMultipliers[attempts - 1] ?? retryMultipliers[retryMultipliers.length - 1]);
  console.error(`[webhook] ${d.type} ${d.id} attempt ${attempts} failed: ${lastError}${exhausted ? ' — giving up' : ''}`);
  await store().update(d.id, {
    attempts, lastStatus, lastError,
    status: exhausted ? 'failed' : 'pending',
    nextAttemptAt: new Date(Date.now() + delay).toISOString(),
  });
}

/**
 * Record the event in the outbox and try to send it right away (without blocking the caller).
 * Failures are retried by the worker (flushWebhookOutbox) on the schedule above.
 */
export async function deliverWebhook(type: WebhookEventType, data: Record<string, unknown>) {
  const url = webhookUrl();
  if (!url) return { queued: false, reason: 'not_configured' as const };
  const payload: WebhookPayload = {
    id: `evt_${randomBytes(12).toString('hex')}`,
    apiVersion: 'v1',
    type,
    createdAt: new Date().toISOString(),
    workspaceId: process.env.DOCAI_WORKSPACE_ID || 'default',
    data,
  };
  const delivery: Delivery = {
    id: payload.id, type, url, body: JSON.stringify(payload), status: 'pending', attempts: 0,
    nextAttemptAt: payload.createdAt, createdAt: payload.createdAt,
  };
  try {
    await store().add(delivery);
  } catch (e) {
    console.error('[webhook] outbox write failed', e instanceof Error ? e.message : e);
    return { queued: false, reason: 'outbox_error' as const };
  }
  // Serverless functions freeze after the response, so there the first attempt is awaited.
  const first = attempt(delivery).catch((e) => console.error('[webhook] attempt error', e));
  if (process.env.VERCEL) await first;
  return { queued: true as const, id: delivery.id };
}

/** Send due retries. Called by the worker loop / cron tick. */
export async function flushWebhookOutbox(limit = 20) {
  if (!webhooksConfigured()) return 0;
  const due = await store().due(limit);
  let sent = 0;
  for (const d of due) if (await attempt(d)) sent += 1;
  return sent;
}

export async function listWebhookDeliveries(limit = 50) {
  return (await store().list(Math.min(Math.max(limit, 1), 500))).map(({ body, ...rest }) => ({ ...rest, payload: JSON.parse(body) }));
}

/** Manual re-send from the admin UI/API (also revives a delivery that exhausted its retries). */
export async function redeliverWebhook(id: string) {
  const d = await store().get(id);
  if (!d) throw Object.assign(new Error('Доставку не знайдено'), { status: 404 });
  await store().update(id, { status: 'pending', nextAttemptAt: new Date().toISOString() });
  return attempt({ ...d, status: 'pending' });
}

/** Map document status to webhook event. */
export function eventForDocumentStatus(status: string): WebhookEventType | null {
  switch (status) {
    case 'pending_review': return 'document.pending_review';
    case 'approved': return 'document.approved';
    case 'rejected': return 'document.rejected';
    case 'failed': return 'document.failed';
    case 'invalid': return 'document.invalid';
    default: return null;
  }
}
