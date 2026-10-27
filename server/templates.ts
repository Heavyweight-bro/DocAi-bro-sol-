import { localStore } from './local-store';
import { storageMode, type StorageMode } from './storage';

export type TemplateRecord = { id: number; name: string; slug: string; prompt: string; schema?: unknown };

/** Look up a template by slug in whichever store is active (null for custom / unknown). */
export async function getTemplateBySlug(slug: string | undefined, modes: StorageMode = storageMode()): Promise<TemplateRecord | null> {
  if (!slug || slug === 'custom') return null;
  if (modes.isLocalMode) return localStore.types.find((t) => t.slug === slug) || null;
  if (!modes.isSupabaseConfigured) return null;
  const { data, error } = await modes.supabase.from('document_types').select('*').eq('slug', slug).maybeSingle();
  if (error) throw error;
  return data || null;
}
