import './config';
import { existsSync, mkdirSync, readdirSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import path from 'node:path';

const filesRoot = path.resolve(process.env.LOCAL_FILES_DIR || '.data/files');
const jobsRoot = path.join(filesRoot, 'jobs');

function safeName(name: string) {
  return name.replace(/[^\w.\-()\u0400-\u04FF]+/g, '_').slice(0, 120) || 'document';
}

/** Persist original upload locally (dev / single-node). */
export function saveLocalFile(id: string | number, originalName: string, buffer: Buffer, mimeType: string) {
  mkdirSync(filesRoot, { recursive: true, mode: 0o700 });
  const filename = `${id}_${safeName(originalName)}`;
  const full = path.join(filesRoot, filename);
  writeFileSync(full, buffer, { mode: 0o600 });
  return { filePath: full, storagePath: `local:${filename}`, mimeType };
}

/** Staging path for queued jobs (worker reads this file). */
export function saveJobStagingFile(jobId: string, originalName: string, buffer: Buffer) {
  mkdirSync(jobsRoot, { recursive: true, mode: 0o700 });
  const filename = `${jobId}_${safeName(originalName)}`;
  const full = path.join(jobsRoot, filename);
  writeFileSync(full, buffer, { mode: 0o600 });
  return { filePath: full, storagePath: `job:${filename}` };
}

export async function saveSupabaseFile(
  supabase: { storage: { from: (bucket: string) => { upload: (path: string, body: Buffer, opts: { contentType: string; upsert: boolean }) => Promise<{ error: { message: string } | null }> } } },
  id: string | number,
  originalName: string,
  buffer: Buffer,
  mimeType: string,
) {
  const bucket = process.env.SUPABASE_STORAGE_BUCKET || 'documents';
  const objectPath = `${id}/${Date.now()}_${safeName(originalName)}`;
  const { error } = await supabase.storage.from(bucket).upload(objectPath, buffer, {
    contentType: mimeType,
    upsert: false,
  });
  if (error) {
    console.error('[storage] supabase upload failed:', error.message);
    return null;
  }
  return { storagePath: `supabase:${bucket}/${objectPath}`, mimeType };
}

export function localFileExists(storagePath?: string) {
  if (!storagePath?.startsWith('local:')) return false;
  return existsSync(path.join(filesRoot, storagePath.slice('local:'.length)));
}

/** Delete a queue staging file once its job reached a terminal state (never touches the archive). */
export function removeStagingFile(filePath?: string) {
  if (!filePath) return false;
  const full = path.resolve(filePath);
  if (path.dirname(full) !== jobsRoot) return false;
  try {
    unlinkSync(full);
    return true;
  } catch {
    return false;
  }
}

/** Absolute path of an archived original for `local:` storage paths (null if missing or outside the archive). */
export function localArchivePath(storagePath?: string) {
  if (!storagePath?.startsWith('local:')) return null;
  const full = path.resolve(filesRoot, storagePath.slice('local:'.length));
  if (path.dirname(full) !== filesRoot || !existsSync(full)) return null;
  return full;
}

/**
 * Retention sweep.
 * - Archive: files older than DOCAI_FILE_RETENTION_DAYS (0/unset = keep forever).
 * - Staging: leftovers older than 2 days that no active job references.
 */
export function sweepExpiredFiles(activeStaging: Set<string> = new Set(), now = Date.now()) {
  let removed = 0;
  const retentionDays = Number(process.env.DOCAI_FILE_RETENTION_DAYS || 0);
  const sweepDir = (dir: string, maxAgeMs: number, keep: (full: string) => boolean) => {
    if (!existsSync(dir)) return;
    for (const name of readdirSync(dir)) {
      const full = path.join(dir, name);
      try {
        const st = statSync(full);
        if (!st.isFile() || keep(full) || now - st.mtimeMs < maxAgeMs) continue;
        unlinkSync(full);
        removed += 1;
      } catch { /* ignore races */ }
    }
  };
  if (retentionDays > 0) sweepDir(filesRoot, retentionDays * 86_400_000, () => false);
  sweepDir(jobsRoot, 2 * 86_400_000, (full) => activeStaging.has(full));
  return removed;
}
