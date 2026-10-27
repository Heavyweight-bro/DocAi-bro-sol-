// Standalone background worker: `npm run worker`.
// Run the web server with DOCAI_WORKER=0 and one or more of these processes next to it
// (with Supabase configured the Postgres queue lets several workers share the load safely).
import './server/config';
import { startWorker, stopWorker } from './server/worker';
import { flushAudit } from './server/audit';

process.env.DOCAI_WORKER = '1';
await startWorker();
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, async () => {
    stopWorker();
    await flushAudit();
    process.exit(0);
  });
}
