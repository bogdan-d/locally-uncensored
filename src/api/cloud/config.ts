// LU Cloud endpoints. The anon key is public by design (it only unlocks
// RLS-guarded, user-scoped access); real authorization is the user's session
// token. VITE_* overrides exist for developing against a local uselu server
// (`VITE_LU_CLOUD_URL=http://localhost:3000 npm run dev`).

export const CLOUD_BASE: string =
  (import.meta.env.VITE_LU_CLOUD_URL as string | undefined) ?? 'https://lu-labs.ai'

export const SUPABASE_URL: string =
  (import.meta.env.VITE_LU_SUPABASE_URL as string | undefined) ??
  'https://lrrhheztdytyfpizvuup.supabase.co'

export const SUPABASE_ANON_KEY: string =
  (import.meta.env.VITE_LU_SUPABASE_ANON_KEY as string | undefined) ??
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImxycmhoZXp0ZHl0eWZwaXp2dXVwIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODMxNDkwNzUsImV4cCI6MjA5ODcyNTA3NX0.1AuX4tmup82d3NHLAgQx1KdXhwlCkPcX7liB6eNSkAU'
