-- Early-access signups for the GameCrew landing page.
-- Run once in the Supabase dashboard SQL editor (or psql).
--
-- Access model: the landing page holds only the public anon key, so this
-- table is write-only for it — anon may INSERT, and can never SELECT,
-- UPDATE or DELETE. Read the list from the dashboard (or a service role).

create table public.early_access_signups (
  id uuid primary key default gen_random_uuid(),
  email text not null
    check (email ~* '^[^@[:space:]]+@[^@[:space:]]+\.[^@[:space:]]+$' and length(email) <= 254),
  source text not null default 'landing',
  created_at timestamptz not null default now()
);

-- One signup per address, case-insensitive; duplicates surface as HTTP 409.
create unique index early_access_signups_email_key
  on public.early_access_signups (lower(email));

alter table public.early_access_signups enable row level security;

create policy "anyone can join early access"
  on public.early_access_signups
  for insert
  to anon
  with check (true);

-- Write-only for public keys: no select/update/delete policy, and trim the
-- default table grants down to insert.
revoke all on public.early_access_signups from anon, authenticated;
grant insert on public.early_access_signups to anon;
