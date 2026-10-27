import { readAudit } from './audit';
import { localStore } from './local-store';
import { storageMode } from './storage';
import { rateFor } from './cost';
import { isProvider } from './settings';

type DocLite = { status?: string; typeSlug?: string; createdAt?: string; editedBy?: string; extractedData?: any };

async function documentsSince(sinceIso: string): Promise<DocLite[]> {
  const modes = storageMode();
  if (modes.isLocalMode) return localStore.documents.filter((d) => (d.createdAt || '') >= sinceIso);
  if (!modes.isSupabaseConfigured) return [];
  // Minimal columns; edited_by may not exist on older schemas → retry without it.
  let res: any = await modes.supabase.from('documents').select('status,type_slug,created_at,edited_by').gte('created_at', sinceIso).limit(50_000);
  if (res.error?.code === '42703') res = await modes.supabase.from('documents').select('status,type_slug,created_at').gte('created_at', sinceIso).limit(50_000);
  if (res.error) throw res.error;
  return (res.data || []).map((d: any) => ({ status: d.status, typeSlug: d.type_slug, createdAt: d.created_at, editedBy: d.edited_by }));
}

const round = (n: number, digits = 4) => Math.round(n * 10 ** digits) / 10 ** digits;
const dayOf = (iso: string) => iso.slice(0, 10);

/** Cost, throughput and quality for the admin dashboard (the audit log is the source of truth for AI spend). */
export async function computeStats(days = 30) {
  const since = new Date(Date.now() - days * 86_400_000);
  since.setUTCHours(0, 0, 0, 0);
  const sinceIso = since.toISOString();
  const [events, docs] = await Promise.all([readAudit(sinceIso), documentsSince(sinceIso)]);

  const byDay = new Map<string, { day: string; documents: number; costUsd: number; failed: number }>();
  for (let t = since.getTime(); t <= Date.now(); t += 86_400_000) {
    const day = dayOf(new Date(t).toISOString());
    byDay.set(day, { day, documents: 0, costUsd: 0, failed: 0 });
  }
  const byModel = new Map<string, { model: string; runs: number; costUsd: number; promptTokens: number; completionTokens: number; durationMs: number; priced: boolean }>();
  const byActor = new Map<string, number>();
  let costUsd = 0, promptTokens = 0, completionTokens = 0, processed = 0, failed = 0, retries = 0, escalated = 0, edits = 0;

  for (const e of events) {
    const spend = e.estimatedCostUsd || 0;
    costUsd += spend;
    promptTokens += e.promptTokens || 0;
    completionTokens += e.completionTokens || 0;
    const day = byDay.get(dayOf(e.at));
    if (day) day.costUsd += spend;
    const terminal = e.action === 'parse.completed' || e.action === 'job.completed' || e.action === 'parse.failed' || e.action === 'job.failed';
    if (terminal) {
      processed += 1;
      if (day) day.documents += 1;
      if (e.action.endsWith('failed')) { failed += 1; if (day) day.failed += 1; }
      if (e.actor) byActor.set(e.actor, (byActor.get(e.actor) || 0) + 1);
    }
    if (e.action === 'job.retry') retries += 1;
    if (e.action === 'document.edit') edits += 1;
    if (/escalated from/.test(e.detail || '')) escalated += 1;
    if (e.model && (terminal || e.action === 'job.retry')) {
      const row = byModel.get(e.model) || { model: e.model, runs: 0, costUsd: 0, promptTokens: 0, completionTokens: 0, durationMs: 0, priced: true };
      row.runs += 1;
      row.costUsd += spend;
      row.promptTokens += e.promptTokens || 0;
      row.completionTokens += e.completionTokens || 0;
      row.durationMs += e.durationMs || 0;
      const provider = e.provider || e.model.split('/')[0];
      if (isProvider(provider)) row.priced = rateFor(provider, e.model).known;
      byModel.set(e.model, row);
    }
  }

  const statuses: Record<string, number> = {};
  const byTemplate = new Map<string, { typeSlug: string; documents: number; approved: number; edited: number; invalid: number }>();
  let reviewed = 0, approvedClean = 0, editedDocs = 0;
  for (const d of docs) {
    const status = d.status || (d.extractedData?.status === 'failed' ? 'failed' : 'completed');
    statuses[status] = (statuses[status] || 0) + 1;
    const t = byTemplate.get(d.typeSlug || 'custom') || { typeSlug: d.typeSlug || 'custom', documents: 0, approved: 0, edited: 0, invalid: 0 };
    t.documents += 1;
    if (status === 'approved') t.approved += 1;
    if (status === 'invalid') t.invalid += 1;
    if (d.editedBy) { t.edited += 1; editedDocs += 1; }
    byTemplate.set(t.typeSlug, t);
    if (status === 'approved' || status === 'rejected') {
      reviewed += 1;
      if (status === 'approved' && !d.editedBy) approvedClean += 1;
    }
  }

  return {
    period: { days, since: sinceIso },
    totals: {
      documentsProcessed: processed,
      failed,
      retries,
      escalated,
      manualEdits: edits,
      costUsd: round(costUsd),
      costPerDocumentUsd: processed ? round(costUsd / processed, 5) : 0,
      promptTokens,
      completionTokens,
    },
    quality: {
      reviewed,
      approvedWithoutEdits: approvedClean,
      // Share of human-reviewed documents the AI got right without any correction.
      firstPassAccuracy: reviewed ? round(approvedClean / reviewed, 3) : null,
      editedDocuments: editedDocs,
      pendingReview: statuses.pending_review || 0,
      invalid: statuses.invalid || 0,
    },
    statuses,
    byDay: [...byDay.values()].map((d) => ({ ...d, costUsd: round(d.costUsd) })),
    byModel: [...byModel.values()].map((m) => ({ ...m, costUsd: round(m.costUsd), avgDurationMs: m.runs ? Math.round(m.durationMs / m.runs) : 0 })).sort((a, b) => b.costUsd - a.costUsd),
    byTemplate: [...byTemplate.values()].sort((a, b) => b.documents - a.documents),
    byActor: [...byActor.entries()].map(([actor, documents]) => ({ actor, documents })).sort((a, b) => b.documents - a.documents).slice(0, 20),
  };
}
