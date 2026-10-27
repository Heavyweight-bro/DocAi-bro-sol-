import './config';
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Request } from 'express';

const logDir = path.resolve(process.env.LOCAL_SETTINGS_DIR || '.data/settings');
const logFile = path.join(logDir, 'integration-access.jsonl');
const rateWindowMs = 60_000;
const rateLimit = Number(process.env.DOCAI_RATE_LIMIT_PER_MIN || 60);
const hits = new Map<string, { count: number; resetAt: number }>();

function configuredKeys(): string[] {
  const raw = process.env.DOCAI_INTEGRATION_KEYS || process.env.DOCAI_INTEGRATION_KEY || '';
  return raw.split(',').map((v) => v.trim()).filter((v) => v.length >= 16);
}

export function integrationKeysConfigured() {
  return configuredKeys().length > 0;
}

export function extractBearer(req: Request) {
  const header = req.get('authorization') || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const alt = req.get('x-docai-key');
  return alt ? alt.trim() : '';
}

function keyMatches(provided: string, expected: string) {
  const a = createHash('sha256').update(provided).digest();
  const b = createHash('sha256').update(expected).digest();
  return a.length === b.length && timingSafeEqual(a, b);
}

export function verifyIntegrationKey(provided: string) {
  if (!provided) return false;
  return configuredKeys().some((expected) => keyMatches(provided, expected));
}

export function logIntegrationAccess(entry: Record<string, unknown>) {
  try {
    mkdirSync(logDir, { recursive: true, mode: 0o700 });
    appendFileSync(logFile, JSON.stringify({ at: new Date().toISOString(), ...entry }) + '\n', { mode: 0o600 });
  } catch (e) {
    console.error('integration log failed', e instanceof Error ? e.message : e);
  }
}

export function rateLimitOk(bucket: string) {
  const now = Date.now();
  if (hits.size > 10_000) {
    for (const [k, v] of hits) if (v.resetAt < now) hits.delete(k);
  }
  const row = hits.get(bucket);
  if (!row || row.resetAt < now) {
    hits.set(bucket, { count: 1, resetAt: now + rateWindowMs });
    return true;
  }
  if (row.count >= rateLimit) return false;
  row.count += 1;
  return true;
}

/** Generate a sample key for docs (not stored). */
export function suggestIntegrationKey() {
  return `dok_${randomBytes(24).toString('base64url')}`;
}
