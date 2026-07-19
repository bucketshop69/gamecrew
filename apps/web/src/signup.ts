/**
 * Early-access signup → Supabase `early_access_signups` via the Data API.
 * The anon key is a public client key by design; the table is write-only for
 * it (insert policy, no select), so the list can never be read from here.
 */

const url = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export type SignupResult = 'ok' | 'duplicate' | 'error';

export async function submitEarlyAccess(email: string): Promise<SignupResult> {
  if (!url || !anonKey) return 'error';
  try {
    const response = await fetch(`${url.replace(/\/$/, '')}/rest/v1/early_access_signups`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        apikey: anonKey,
        Authorization: `Bearer ${anonKey}`,
        Prefer: 'return=minimal',
      },
      body: JSON.stringify({ email: email.trim().toLowerCase(), source: 'landing' }),
    });
    if (response.ok) return 'ok';
    if (response.status === 409) return 'duplicate';
    return 'error';
  } catch {
    return 'error';
  }
}
