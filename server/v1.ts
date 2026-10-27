import { Router } from 'express';
import multer from 'multer';
import path from 'node:path';
import { actorOf, hasRole, principalOf, requireAuth } from './auth';
import { connection, isProvider } from './settings';
import { jobStore, publicJob } from './jobs';
import { resolvePrompt } from './process-document';
import { appendAudit, auditCostSummary, listAudit } from './audit';
import { listWebhookDeliveries, redeliverWebhook, webhooksConfigured } from './webhooks';

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 10 * 1024 * 1024, files: 1 } });
const mimeByExtension: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  '.xls': 'application/vnd.ms-excel',
  '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.json': 'application/json',
  '.csv': 'text/csv',
  '.txt': 'text/plain',
};

export function createV1Router(deps: {
  getDocument: (id: string) => Promise<any | null>;
  reviewDocument: (id: string, action: 'approve' | 'reject', note?: string, actor?: string) => Promise<any>;
  updateDocument: (id: string, extractedData: unknown, actor?: string) => Promise<any>;
  stats: (days: number) => Promise<Record<string, unknown>>;
}) {
  const router = Router();
  router.use(requireAuth('viewer'));

  router.get('/health', async (req, res, next) => {
    try {
      res.json({
        apiVersion: 'v1',
        status: 'ok',
        queue: jobStore().kind,
        webhooksConfigured: webhooksConfigured(),
        cost: hasRole(principalOf(req), 'admin') ? await auditCostSummary() : undefined,
      });
    } catch (e) { next(e); }
  });

  router.post(['/parse', '/parse/:slug'], requireAuth('operator'), upload.single('document'), async (req, res, next) => {
    try {
      if (!req.file) return res.status(400).json({ error: 'Файл не надано' });
      if (!/\.(pdf|docx|xlsx|xls|csv|json|txt|png|jpe?g|webp)$/i.test(req.file.originalname)) {
        return res.status(415).json({ error: 'Формат не підтримується. Використайте PDF, DOCX, Excel, CSV, JSON, TXT або зображення.' });
      }
      const provider = req.body.provider || connection().provider;
      if (!isProvider(provider)) return res.status(400).json({ error: 'Невідомий AI-провайдер' });
      if (!connection(provider).configured) return res.status(503).json({ error: 'Підключіть обраного AI-провайдера у налаштуваннях.' });

      const file = req.file;
      file.originalname = Buffer.from(file.originalname, 'latin1').toString('utf8');
      const slug = (req.params.slug || req.body.slug || '').trim() || undefined;
      let prompt = typeof req.body.prompt === 'string' ? req.body.prompt : undefined;
      prompt = await resolvePrompt(slug, prompt); // 404 for an unknown template; DB errors go to the error handler

      const extension = path.extname(file.originalname).toLowerCase();
      const mimeType = mimeByExtension[extension] || file.mimetype;
      const actor = actorOf(req);
      const externalRef = (req.get('x-docai-external-ref') || req.body.externalRef || req.body.external_ref || '').slice(0, 200) || undefined;
      const rawIdempotencyKey = (req.get('idempotency-key') || req.body.idempotencyKey || '').slice(0, 200);
      // Keys are scoped per caller so two integrations cannot collide or read each other's jobs by guessing keys.
      const idempotencyKey = rawIdempotencyKey ? `${actor || 'anonymous'}|${rawIdempotencyKey}` : undefined;
      const via = (req as any).integrationAuth ? 'integration' : 'ui';

      const { job, created } = await jobStore().enqueue(
        { slug, prompt, provider, originalName: file.originalname, mimeType, actor, via, externalRef, idempotencyKey },
        file.buffer,
      );
      appendAudit({
        action: created ? 'job.enqueued' : 'job.idempotent_hit',
        actor,
        via,
        jobId: job.id,
        typeSlug: slug || 'custom',
        provider,
        status: job.status,
        detail: externalRef ? `externalRef=${externalRef}` : undefined,
      });
      const base = `${req.protocol}://${req.get('host')}`;
      return res.status(created ? 202 : 200).json({
        apiVersion: 'v1',
        jobId: job.id,
        status: publicJob(job).status,
        statusUrl: `${base}/api/v1/jobs/${job.id}`,
        documentUrlTemplate: `${base}/api/v1/documents/{id}`,
        created,
      });
    } catch (error) {
      next(error);
    }
  });

  router.get('/jobs/:id', async (req, res, next) => {
    try {
      const job = await jobStore().find(req.params.id);
      if (!job) return res.status(404).json({ error: 'Завдання не знайдено' });
      return res.json({ apiVersion: 'v1', ...publicJob(job) });
    } catch (e) { next(e); }
  });

  router.get('/jobs', async (req, res, next) => {
    try {
      const limit = Math.min(Math.max(Number(req.query.limit) || 50, 1), 500);
      res.json({ apiVersion: 'v1', jobs: (await jobStore().list(limit)).map(publicJob) });
    } catch (e) { next(e); }
  });

  router.get('/documents/:id', async (req, res, next) => {
    try {
      if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
      const doc = await deps.getDocument(req.params.id);
      if (!doc) return res.status(404).json({ error: 'Документ не знайдено' });
      return res.json({ apiVersion: 'v1', ...doc });
    } catch (e) {
      next(e);
    }
  });

  router.patch('/documents/:id', requireAuth('operator'), async (req, res, next) => {
    try {
      if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
      const doc = await deps.updateDocument(req.params.id, req.body?.extractedData, actorOf(req));
      return res.json({ apiVersion: 'v1', ...doc });
    } catch (e) {
      next(e);
    }
  });

  router.post('/documents/:id/review', requireAuth('operator'), async (req, res, next) => {
    try {
      if (!/^[1-9]\d*$/.test(req.params.id)) return res.status(400).json({ error: 'Некоректний ID документа' });
      const action = req.body?.action;
      if (action !== 'approve' && action !== 'reject') {
        return res.status(400).json({ error: 'action має бути approve або reject' });
      }
      const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, 500) : undefined;
      const actor = actorOf(req);
      const doc = await deps.reviewDocument(req.params.id, action, note, actor);
      return res.json({ apiVersion: 'v1', ...doc });
    } catch (e) {
      next(e);
    }
  });

  router.get('/audit', requireAuth('admin'), async (req, res, next) => {
    try {
      const limit = Number(req.query.limit) || 100;
      res.json({ apiVersion: 'v1', summary: await auditCostSummary(), events: await listAudit(limit) });
    } catch (e) { next(e); }
  });

  router.get('/webhooks', requireAuth('admin'), async (req, res, next) => {
    try {
      res.json({ apiVersion: 'v1', configured: webhooksConfigured(), deliveries: await listWebhookDeliveries(Number(req.query.limit) || 50) });
    } catch (e) { next(e); }
  });

  router.post('/webhooks/:id/redeliver', requireAuth('admin'), async (req, res, next) => {
    try {
      const delivered = await redeliverWebhook(req.params.id);
      appendAudit({ action: 'webhook.redeliver', actor: actorOf(req), via: 'ui', detail: `${req.params.id} delivered=${delivered}` });
      res.json({ apiVersion: 'v1', delivered });
    } catch (e) { next(e); }
  });

  router.get('/stats', requireAuth('admin'), async (req, res, next) => {
    try {
      const days = Math.min(Math.max(Number(req.query.days) || 30, 1), 365);
      res.json({ apiVersion: 'v1', ...(await deps.stats(days)) });
    } catch (e) { next(e); }
  });

  return router;
}
