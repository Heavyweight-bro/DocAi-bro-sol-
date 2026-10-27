import { jobStore, type ParseJob } from './jobs';
import { processDocumentBuffer } from './process-document';
import { sweepExpiredFiles } from './files';
import { appendAudit } from './audit';
import { deliverWebhook, eventForDocumentStatus, flushWebhookOutbox } from './webhooks';

let timer: NodeJS.Timeout | null = null;
let busy = false;
let lastSweep = 0;
const intervalMs = Math.max(500, Number(process.env.DOCAI_WORKER_INTERVAL_MS || 1500));

async function handleJob(job: ParseJob) {
  const store = jobStore();
  try {
    const buffer = await store.readFile(job);
    const lastAttempt = job.attempts >= job.maxAttempts;
    const result = await processDocumentBuffer({
      buffer,
      originalName: job.originalName,
      mimeType: job.mimeType,
      slug: job.slug,
      prompt: job.prompt,
      provider: job.provider,
      actor: job.actor,
      // A failed attempt that will be retried must not leave a "failed" document in history.
      persistFailure: lastAttempt,
    });

    if (result.parseStatus === 'failed' && !lastAttempt) {
      await store.fail(job.id, result.errorMessage || 'AI processing failed', true);
      appendAudit({
        action: 'job.retry',
        actor: job.actor,
        via: 'worker',
        jobId: job.id,
        typeSlug: job.slug,
        provider: result.provider,
        model: result.aiModel || undefined,
        promptTokens: result.promptTokens || undefined,
        completionTokens: result.completionTokens || undefined,
        estimatedCostUsd: result.estimatedCostUsd || undefined,
        detail: result.errorMessage,
        status: 'queued',
      });
      return;
    }

    await store.removeFile(job);
    await store.complete(job.id, {
      documentId: result.document.id,
      documentStatus: result.reviewStatus,
      durationMs: result.durationMs,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      estimatedCostUsd: result.estimatedCostUsd,
      aiModel: result.aiModel,
      error: result.parseStatus === 'failed' || result.parseStatus === 'invalid' ? result.errorMessage : undefined,
    }, result.parseStatus === 'failed' ? 'failed' : 'completed');

    appendAudit({
      action: result.parseStatus === 'failed' ? 'job.failed' : 'job.completed',
      actor: job.actor,
      via: 'worker',
      jobId: job.id,
      documentId: result.document.id,
      typeSlug: result.document.typeSlug,
      provider: result.provider,
      model: result.aiModel,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs: result.durationMs,
      estimatedCostUsd: result.estimatedCostUsd,
      status: result.reviewStatus,
      detail: [result.escalatedFrom ? `escalated from ${result.escalatedFrom}` : '', result.errorMessage || ''].filter(Boolean).join('; ') || undefined,
    });

    const evt = eventForDocumentStatus(result.reviewStatus);
    if (evt) {
      await deliverWebhook(evt, {
        jobId: job.id,
        documentId: result.document.id,
        status: result.reviewStatus,
        typeSlug: result.document.typeSlug,
        originalName: result.document.originalName,
        externalRef: job.externalRef,
        validationErrors: result.validationErrors,
        estimatedCostUsd: result.estimatedCostUsd,
        durationMs: result.durationMs,
        provider: result.provider,
        model: result.aiModel,
      });
    }
    await deliverWebhook(result.parseStatus === 'failed' ? 'job.failed' : 'job.completed', {
      jobId: job.id,
      documentId: result.document.id,
      status: result.reviewStatus,
      typeSlug: result.document.typeSlug,
      externalRef: job.externalRef,
    });
  } catch (e: any) {
    const message = e?.message || String(e);
    const permanent = e?.status === 400 || e?.status === 404 || e?.status === 415 || e?.code === 'ENOENT';
    const updated = await store.fail(job.id, message, !permanent).catch((err) => {
      console.error('[worker] could not record failure', err);
      return null;
    });
    if (updated?.status === 'failed') await store.removeFile(job).catch(() => undefined);
    const retrying = updated?.status === 'queued';
    appendAudit({
      action: retrying ? 'job.retry' : 'job.failed',
      actor: job.actor,
      via: 'worker',
      jobId: job.id,
      typeSlug: job.slug,
      detail: message,
      status: retrying ? 'queued' : 'failed',
    });
    if (retrying) return; // no terminal webhook until retries are exhausted
    await deliverWebhook('job.failed', { jobId: job.id, error: message, externalRef: job.externalRef, typeSlug: job.slug });
  }
}

/**
 * One round of background work: due webhook retries, retention sweep (hourly), then jobs until the budget runs out.
 * Used by the in-process timer, by `npm run worker` and by the cron endpoint on serverless hosts.
 */
export async function runWorkerTick({ budgetMs = 0, maxJobs = 1 } = {}) {
  const started = Date.now();
  let processed = 0;
  try {
    await flushWebhookOutbox();
  } catch (e) {
    console.error('[worker] webhook flush failed', e instanceof Error ? e.message : e);
  }
  if (Date.now() - lastSweep > 60 * 60_000) {
    lastSweep = Date.now();
    try {
      const removed = sweepExpiredFiles(await jobStore().activeFilePaths());
      if (removed) console.log(`[worker] retention: removed ${removed} expired file(s)`);
    } catch (e) {
      console.error('[worker] retention sweep failed', e instanceof Error ? e.message : e);
    }
  }
  while (processed < maxJobs && (budgetMs === 0 || Date.now() - started < budgetMs)) {
    const job = await jobStore().claim();
    if (!job) break;
    await handleJob(job);
    processed += 1;
  }
  return { processed, durationMs: Date.now() - started };
}

async function tick() {
  if (busy) return;
  busy = true;
  try {
    await runWorkerTick();
  } catch (e) {
    console.error('[worker] tick failed', e instanceof Error ? e.message : e);
  } finally {
    busy = false;
  }
}

export async function startWorker() {
  if (process.env.DOCAI_WORKER === '0' || process.env.VERCEL) {
    console.log('[worker] disabled');
    return;
  }
  if (timer) return;
  try {
    const recovered = await jobStore().recoverOrphans();
    if (recovered) console.log(`[worker] recovered ${recovered} interrupted job(s)`);
  } catch (e) {
    console.error('[worker] recovery failed', e instanceof Error ? e.message : e);
  }
  timer = setInterval(() => { void tick(); }, intervalMs);
  void tick();
  console.log(`[worker] started interval=${intervalMs}ms queue=${jobStore().kind}`);
}

export function stopWorker() {
  if (timer) clearInterval(timer);
  timer = null;
}
