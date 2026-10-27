import { createClient } from '@supabase/supabase-js';

// Limits. Change them here and in supabase/schema.sql (file_size_limit) together.
export const BUCKET = 'files';
export const MAX_FILE_MB = 25;
export const MAX_FILES_PER_SPACE = 200;
export const MAX_TEXT_CHARS = 100000;
export const FILE_DAYS = 7;
export const CODE_MINUTES = 5;
export const NETWORK_JOIN_HOURS = 24;

let client;

// Server-only client. Uses the service role key, which bypasses row level
// security, so it must never be sent to the browser.
export function db() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY is not set in the environment.');
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

// Safe to send to the browser: the anon key can only use live sync,
// because every table is locked by row level security.
export function publicConfig() {
  return {
    supabaseUrl: process.env.SUPABASE_URL || '',
    supabaseAnonKey: process.env.SUPABASE_ANON_KEY || '',
    maxFileMb: MAX_FILE_MB,
    maxTextChars: MAX_TEXT_CHARS,
    fileDays: FILE_DAYS,
  };
}
