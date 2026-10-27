import './config';
import { appendFileSync, existsSync, mkdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { storageMode } from './storage';

const settingsDir = () => path.resolve(process.env.LOCAL_SETTINGS_DIR || '.data/settings');
const auditFile = () => path.join(settingsDir(), 'audit.jsonl');

export type AuditEvent = {
  id: string;
  at: string;
  action: string;
  actor?: string;
  via?: 'ui' | 'integration' | 'worker' | 'system';
  documentId?: number | string;
  jobId?: string;
  typeSlug?: string;
  provider?: string;
  model?: string;
  promptTokens?: number;
  completionTokens?: number;
  durationMs?: number;
  estimatedCostUsd?: number;
  status?: string;
  detail?: string;
  workspaceId?: string;
};

const usePostgres = () => storageMode().isSupabaseConfigured && process.env.DOCAI_QUEUE !== 'file';
const camelToSnake: Record<string, string> = {
  documentId: 'document_id', jobId: 'job_id', typeSlug: 'type_slug', promptTokens: 'prompt_tokens', completionTokens: 'completion_tokens',
  durationMs: 'duration_ms', estimatedCostUsd: 'estimated_cost_usd', workspaceId: 'workspace_id',
};
const snakeToCamel = Object.fromEntries(Object.entries(camelToSnake).map(([a, b]) => [b, a]));
const toRow = (e: AuditEvent) => Object.fromEntries(Object.entries(e).filter(([, v]) => v !== undefined).map(([k, v]) => [camelToSnake[k] || k, k === 'documentId' ? String(v) : v]));
const fromRow = (r: any): AuditEvent => Object.fromEntries(Object.entries(r).filter(([, v]) => v !== null).map(([k, v]) => [snakeToCamel[k] || k, k === 'estimated_cost_usd' ? Number(v) : v])) as AuditEvent;

// Pending Postgres inserts, so tests / shutdown can wait for them.
const pending = new Set<Promise<unknown>>();
export async function flushAudit() { await Promise.all([...pending]); }

export function appendAudit(partial: Omit<AuditEvent, 'id' | 'at'> & { at?: string }) {
  const event: AuditEvent = {
    id: `aud_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`,
    at: partial.at || new Date().toISOString(),
    workspaceId: process.env.DOCAI_WORKSPACE_ID || 'default',
    ...partial,
  };
  if (usePostgres()) {
    const p = Promise.resolve(storageMode().supabase.from('docai_audit').insert([toRow(event)])).then(({ error }) => {
      if (error) console.error('audit insert failed', error.message);
    }).finally(() => pending.delete(p));
    pending.add(p);
    return event;
  }
  try {
    mkdirSync(settingsDir(), { recursive: true, mode: 0o700 });
    appendFileSync(auditFile(), JSON.stringify(event) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('audit write failed', e instanceof Error ? e.message : e);
  }
  return event;
}

/** Events since a date (newest last). File mode reads the whole log — fine up to tens of MB. */
export async function readAudit(sinceIso?: string, limit = 50_000): Promise<AuditEvent[]> {
  if (usePostgres()) {
    await flushAudit();
    let q = storageMode().supabase.from('docai_audit').select('*').order('at', { ascending: false }).limit(limit);
    if (sinceIso) q = q.gte('at', sinceIso);
    const { data, error } = await q;
    if (error) throw error;
    return (data || []).map(fromRow).reverse();
  }
  if (!existsSync(auditFile())) return [];
  if (statSync(auditFile()).size > 100 * 1024 * 1024) console.warn('[audit] audit.jsonl is over 100 MB — consider rotating it');
  const out: AuditEvent[] = [];
  for (const line of readFileSync(auditFile(), 'utf8').split('\n')) {
    if (!line) continue;
    try {
      const e = JSON.parse(line);
      if (!sinceIso || e.at >= sinceIso) out.push(e);
    } catch { /* skip corrupt line */ }
  }
  return out.slice(-limit);
}

export async function listAudit(limit = 100) {
  const n = Math.min(Math.max(limit, 1), 500);
  return (await readAudit(undefined, n)).slice(-n).reverse();
}

/** Compact summary for cost dashboards. */
export async function auditCostSummary(sinceIso?: string) {
  let promptTokens = 0;
  let completionTokens = 0;
  let estimatedCostUsd = 0;
  let parseCount = 0;
  const events = await readAudit(sinceIso);
  for (const e of events) {
    if (e.promptTokens) promptTokens += e.promptTokens;
    if (e.completionTokens) completionTokens += e.completionTokens;
    if (e.estimatedCostUsd) estimatedCostUsd += e.estimatedCostUsd;
    if (e.action === 'parse.completed' || e.action === 'job.completed') parseCount += 1;
  }
  return {
    events: events.length,
    parseCount,
    promptTokens,
    completionTokens,
    estimatedCostUsd: Math.round(estimatedCostUsd * 1_000_000) / 1_000_000,
  };
}
