import './config';
import { createClient, type SupabaseClient } from '@supabase/supabase-js';

/** Single source of truth for where templates/documents live. */
export type StorageMode = { isSupabaseConfigured: boolean; isLocalMode: boolean; supabase: SupabaseClient };

let cached: StorageMode | null = null;

export function storageMode(): StorageMode {
  if (cached) return cached;
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const supabaseKey = process.env.SUPABASE_KEY || process.env.VITE_SUPABASE_ANON_KEY;
  const isSupabaseConfigured = !!(supabaseUrl && supabaseKey && !supabaseUrl.includes('placeholder'));
  const isLocalMode = !isSupabaseConfigured && !process.env.VERCEL && process.env.NODE_ENV !== 'production';
  const supabase = createClient(supabaseUrl || 'https://placeholder.supabase.co', supabaseKey || 'placeholder', {
    auth: { persistSession: false, autoRefreshToken: false },
  });
  cached = { isSupabaseConfigured, isLocalMode, supabase };
  return cached;
}

export function storageUnavailable() {
  return Object.assign(new Error('Сховище не налаштовано: задайте SUPABASE_URL і SUPABASE_KEY.'), { status: 503, expose: true });
}
