-- 메일 카드 🔄 이 넣는 동기화 요청. 맥미니 mail_sync_watch.py 가 읽고 supabase_bridge.py sync 를 실행한다.
-- Supabase SQL 편집기에서 한 번 실행. 다시 실행해도 안전하다.

create table if not exists public.mail_sync_requests (
  id uuid primary key default gen_random_uuid(),
  requested_by text not null default coalesce(auth.jwt() ->> 'email', ''),
  requested_at timestamptz not null default now(),
  status text not null default 'pending' check (status in ('pending', 'running', 'done', 'error')),
  message text,
  finished_at timestamptz
);

alter table public.mail_sync_requests enable row level security;

revoke all on public.mail_sync_requests from anon, authenticated;
grant insert, select on public.mail_sync_requests to authenticated;

drop policy if exists "본인 동기화 요청" on public.mail_sync_requests;
drop policy if exists "본인 동기화 조회" on public.mail_sync_requests;

create policy "본인 동기화 요청" on public.mail_sync_requests
  for insert to authenticated
  with check (
    requested_by = coalesce(auth.jwt() ->> 'email', '')
    and requested_by <> ''
    and status = 'pending'
  );

create policy "본인 동기화 조회" on public.mail_sync_requests
  for select to authenticated
  using (requested_by = coalesce(auth.jwt() ->> 'email', ''));
