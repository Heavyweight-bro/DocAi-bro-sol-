import './config';
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { removeStagingFile, saveJobStagingFile } from './files';
import { storageMode } from './storage';

export type JobStatus = 'staging' | 'queued' | 'processing' | 'completed' | 'failed';

export type ParseJob = {
  id: string;
  status: JobStatus;
  createdAt: string;
  updatedAt: string;
  slug?: string;
  prompt?: string;
  provider: string;
  originalName: string;
  mimeType: string;
  /** File store: absolute staging path. Postgres store: "db:<jobId>". */
  filePath: string;
  storagePath?: string;
  actor?: string;
  via?: 'ui' | 'integration';
  externalRef?: string;
  idempotencyKey?: string;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt?: string;
  /** Worker lease: a processing job whose lease expired is treated as orphaned and re-queued. */
  leaseUntil?: string;
  error?: string;
  documentId?: number | string;
  documentStatus?: string;
  durationMs?: number;
  promptTokens?: number;
  completionTokens?: number;
  estimatedCostUsd?: number;
  aiModel?: string;
  workspaceId: string;
};

export type EnqueueInput = {
  slug?: string; prompt?: string; provider: string; originalName: string; mimeType: string;
  actor?: string; via?: 'ui' | 'integration'; externalRef?: string; idempotencyKey?: string;
};

export interface JobStore {
  readonly kind: 'file' | 'postgres';
  enqueue(input: EnqueueInput, buffer: Buffer): Promise<{ job: ParseJob; created: boolean }>;
  find(id: string): Promise<ParseJob | null>;
  list(limit: number): Promise<ParseJob[]>;
  claim(): Promise<ParseJob | null>;
  complete(id: string, patch: Partial<ParseJob>, status?: 'completed' | 'failed'): Promise<ParseJob | null>;
  fail(id: string, error: string, retry: boolean): Promise<ParseJob | null>;
  recoverOrphans(): Promise<number>;
  readFile(job: ParseJob): Promise<Buffer>;
  removeFile(job: ParseJob): Promise<void>;
  activeFilePaths(): Promise<Set<string>>;
}

const maxAttemptsDefault = () => Math.max(1, Number(process.env.DOCAI_JOB_MAX_ATTEMPTS || 3));
/** Longer than the slowest AI call (180 s timeout) plus archiving; override with DOCAI_JOB_LEASE_MS. */
const leaseMs = () => Math.max(30_000, Number(process.env.DOCAI_JOB_LEASE_MS || 10 * 60_000));
const backoffMs = (attempts: number) => Math.min(60_000, 2000 * 2 ** Math.max(0, attempts - 1));
const workspaceId = () => process.env.DOCAI_WORKSPACE_ID || 'default';

export function newJobId() {
  return `job_${Date.now().toString(36)}_${randomBytes(4).toString('hex')}`;
}

function newJob(input: EnqueueInput, id = newJobId()): ParseJob {
  const now = new Date().toISOString();
  return {
    id, status: 'queued', createdAt: now, updatedAt: now, attempts: 0, maxAttempts: maxAttemptsDefault(), workspaceId: workspaceId(),
    slug: input.slug, prompt: input.prompt, provider: input.provider, originalName: input.originalName, mimeType: input.mimeType,
    filePath: '', actor: input.actor, via: input.via, externalRef: input.externalRef, idempotencyKey: input.idempotencyKey,
  };
}

// ---------------------------------------------------------------- file store (single process)

class FileJobStore implements JobStore {
  readonly kind = 'file' as const;
  private jobs: ParseJob[];
  private readonly file = path.resolve(process.env.LOCAL_JOBS_PATH || '.data/jobs.json');

  constructor() {
    this.jobs = [];
    if (existsSync(this.file)) {
      try {
        const data = JSON.parse(readFileSync(this.file, 'utf8'));
        this.jobs = Array.isArray(data.jobs) ? data.jobs : Array.isArray(data) ? data : [];
      } catch { this.jobs = []; }
    }
  }

  private persist() {
    mkdirSync(path.dirname(this.file), { recursive: true, mode: 0o700 });
    writeFileSync(this.file + '.tmp', JSON.stringify({ jobs: this.jobs }, null, 2), { mode: 0o600 });
    renameSync(this.file + '.tmp', this.file);
  }

  async enqueue(input: EnqueueInput, buffer: Buffer) {
    if (input.idempotencyKey) {
      const existing = this.jobs.find((j) => j.idempotencyKey === input.idempotencyKey);
      if (existing) return { job: existing, created: false };
    }
    const job = newJob(input);
    const staged = saveJobStagingFile(job.id, input.originalName, buffer);
    job.filePath = staged.filePath;
    job.storagePath = staged.storagePath;
    this.jobs.unshift(job);
    if (this.jobs.length > 2000) this.jobs = this.jobs.slice(0, 2000);
    this.persist();
    return { job, created: true };
  }

  async find(id: string) { return this.jobs.find((j) => j.id === id) || null; }

  async list(limit: number) {
    return [...this.jobs].sort((a, b) => b.createdAt.localeCompare(a.createdAt)).slice(0, limit);
  }

  private expire(now = Date.now()) {
    let changed = 0;
    for (const job of this.jobs) {
      if (job.status !== 'processing') continue;
      if (job.leaseUntil && Date.parse(job.leaseUntil) > now) continue;
      changed += 1;
      delete job.leaseUntil;
      job.updatedAt = new Date(now).toISOString();
      if (job.attempts >= job.maxAttempts) {
        job.status = 'failed';
        job.error = job.error || 'Обробку перервано (перезапуск сервера або тайм-аут) і спроби вичерпано';
      } else {
        job.status = 'queued';
        job.error = 'Попередню спробу перервано; завдання повернуто в чергу';
      }
    }
    if (changed) this.persist();
    return changed;
  }

  async claim() {
    const now = Date.now();
    this.expire(now);
    const job = this.jobs
      .filter((j) => j.status === 'queued' && !(j.nextAttemptAt && Date.parse(j.nextAttemptAt) > now))
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))[0];
    if (!job) return null;
    job.status = 'processing';
    job.attempts += 1;
    job.updatedAt = new Date().toISOString();
    job.leaseUntil = new Date(now + leaseMs()).toISOString();
    delete job.nextAttemptAt;
    this.persist();
    return job;
  }

  async complete(id: string, patch: Partial<ParseJob>, status: 'completed' | 'failed' = 'completed') {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    Object.assign(job, patch, { status, updatedAt: new Date().toISOString() });
    delete job.leaseUntil;
    this.persist();
    return job;
  }

  async fail(id: string, error: string, retry: boolean) {
    const job = this.jobs.find((j) => j.id === id);
    if (!job) return null;
    job.error = error;
    job.updatedAt = new Date().toISOString();
    delete job.leaseUntil;
    if (retry && job.attempts < job.maxAttempts) {
      job.status = 'queued';
      job.nextAttemptAt = new Date(Date.now() + backoffMs(job.attempts)).toISOString();
    } else {
      job.status = 'failed';
    }
    this.persist();
    return job;
  }

  /** On startup of a single in-process worker every processing job is orphaned. */
  async recoverOrphans() {
    for (const job of this.jobs) if (job.status === 'processing') job.leaseUntil = new Date(0).toISOString();
    return this.expire();
  }

  async readFile(job: ParseJob) { return readFileSync(job.filePath); }
  async removeFile(job: ParseJob) { removeStagingFile(job.filePath); }
  async activeFilePaths() {
    return new Set(this.jobs.filter((j) => j.status === 'queued' || j.status === 'processing').map((j) => j.filePath));
  }
}

// ---------------------------------------------------------------- Postgres store (Supabase, multi-node)

type JobRow = {
  id: string; status: JobStatus; created_at: string; updated_at: string; payload: any; idempotency_key: string | null;
  attempts: number; max_attempts: number; next_attempt_at: string | null; lease_until: string | null; result: any; error: string | null; workspace_id: string;
};

function fromRow(r: JobRow): ParseJob {
  const p = r.payload || {};
  const res = r.result || {};
  return {
    id: r.id, status: r.status, createdAt: r.created_at, updatedAt: r.updated_at, attempts: r.attempts, maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at || undefined, leaseUntil: r.lease_until || undefined, error: r.error || undefined,
    workspaceId: r.workspace_id, idempotencyKey: r.idempotency_key || undefined, filePath: `db:${r.id}`,
    slug: p.slug, prompt: p.prompt, provider: p.provider, originalName: p.originalName, mimeType: p.mimeType,
    actor: p.actor, via: p.via, externalRef: p.externalRef,
    documentId: res.documentId, documentStatus: res.documentStatus, durationMs: res.durationMs, promptTokens: res.promptTokens,
    completionTokens: res.completionTokens, estimatedCostUsd: res.estimatedCostUsd, aiModel: res.aiModel,
  };
}

const resultKeys = ['documentId', 'documentStatus', 'durationMs', 'promptTokens', 'completionTokens', 'estimatedCostUsd', 'aiModel'] as const;

/**
 * Tables docai_jobs + docai_job_files and function docai_claim_job() — see db/schema.sql.
 * Claiming uses FOR UPDATE SKIP LOCKED, so any number of workers (servers, cron, separate process) can run safely.
 * Uploaded files are staged in the database (base64) so a web node without a disk (Vercel) can enqueue.
 */
class PostgresJobStore implements JobStore {
  readonly kind = 'postgres' as const;
  private get db() { return storageMode().supabase; }

  async enqueue(input: EnqueueInput, buffer: Buffer) {
    const job = newJob(input);
    const { originalName, mimeType, slug, prompt, provider, actor, via, externalRef } = input;
    const row = {
      id: job.id, status: 'staging', payload: { originalName, mimeType, slug, prompt, provider, actor, via, externalRef },
      idempotency_key: input.idempotencyKey || null, max_attempts: job.maxAttempts, workspace_id: job.workspaceId,
    };
    const inserted = await this.db.from('docai_jobs').insert([row]).select().single();
    if (inserted.error?.code === '23505' && input.idempotencyKey) {
      const existing = await this.db.from('docai_jobs').select('*').eq('idempotency_key', input.idempotencyKey).single();
      if (existing.error) throw existing.error;
      return { job: fromRow(existing.data), created: false };
    }
    if (inserted.error) throw inserted.error;
    const file = await this.db.from('docai_job_files').insert([{ job_id: job.id, content_base64: buffer.toString('base64') }]);
    if (file.error) {
      await this.db.from('docai_jobs').update({ status: 'failed', error: 'Не вдалося зберегти файл завдання' }).eq('id', job.id);
      throw file.error;
    }
    const queued = await this.db.from('docai_jobs').update({ status: 'queued', updated_at: new Date().toISOString() }).eq('id', job.id).select().single();
    if (queued.error) throw queued.error;
    return { job: fromRow(queued.data), created: true };
  }

  async find(id: string) {
    const { data, error } = await this.db.from('docai_jobs').select('*').eq('id', id).maybeSingle();
    if (error) throw error;
    return data ? fromRow(data) : null;
  }

  async list(limit: number) {
    const { data, error } = await this.db.from('docai_jobs').select('*').order('created_at', { ascending: false }).limit(Math.min(limit, 1000));
    if (error) throw error;
    return (data || []).map(fromRow);
  }

  async claim() {
    const { data, error } = await this.db.rpc('docai_claim_job', { lease_seconds: Math.round(leaseMs() / 1000) });
    if (error) throw error;
    const row = Array.isArray(data) ? data[0] : data;
    return row ? fromRow(row) : null;
  }

  private async update(id: string, patch: Record<string, unknown>) {
    const { data, error } = await this.db.from('docai_jobs').update({ ...patch, updated_at: new Date().toISOString() }).eq('id', id).select().maybeSingle();
    if (error) throw error;
    return data ? fromRow(data) : null;
  }

  async complete(id: string, patch: Partial<ParseJob>, status: 'completed' | 'failed' = 'completed') {
    const result = Object.fromEntries(resultKeys.filter((k) => patch[k] !== undefined).map((k) => [k, patch[k]]));
    return this.update(id, { status, result, error: patch.error ?? null, lease_until: null });
  }

  async fail(id: string, error: string, retry: boolean) {
    const job = await this.find(id);
    if (!job) return null;
    const again = retry && job.attempts < job.maxAttempts;
    return this.update(id, {
      status: again ? 'queued' : 'failed', error, lease_until: null,
      next_attempt_at: again ? new Date(Date.now() + backoffMs(job.attempts)).toISOString() : null,
    });
  }

  /** Other nodes may still be working: only leases that already expired are recovered (inside docai_claim_job). */
  async recoverOrphans() { return 0; }

  async readFile(job: ParseJob) {
    const { data, error } = await this.db.from('docai_job_files').select('content_base64').eq('job_id', job.id).maybeSingle();
    if (error) throw error;
    if (!data) throw Object.assign(new Error('Файл завдання не знайдено'), { code: 'ENOENT' });
    return Buffer.from(data.content_base64, 'base64');
  }

  async removeFile(job: ParseJob) {
    const { error } = await this.db.from('docai_job_files').delete().eq('job_id', job.id);
    if (error) console.error('[jobs] staged file cleanup failed', error.message);
  }

  async activeFilePaths() { return new Set<string>(); }
}

let store: JobStore | null = null;
/** Postgres when Supabase is configured (unless DOCAI_QUEUE=file), otherwise a local JSON file. */
export function jobStore(): JobStore {
  if (store) return store;
  const wantFile = process.env.DOCAI_QUEUE === 'file';
  store = storageMode().isSupabaseConfigured && !wantFile ? new PostgresJobStore() : new FileJobStore();
  return store;
}

export function publicJob(job: ParseJob) {
  return {
    jobId: job.id,
    status: job.status === 'staging' ? 'queued' : job.status,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    typeSlug: job.slug || 'custom',
    originalName: job.originalName,
    attempts: job.attempts,
    maxAttempts: job.maxAttempts,
    error: job.error,
    documentId: job.documentId,
    documentStatus: job.documentStatus,
    durationMs: job.durationMs,
    promptTokens: job.promptTokens,
    completionTokens: job.completionTokens,
    estimatedCostUsd: job.estimatedCostUsd,
    aiModel: job.aiModel,
    provider: job.provider,
    externalRef: job.externalRef,
    nextAttemptAt: job.nextAttemptAt,
  };
}
