-- 메일 회신 카드용 표 (맥미니 supabase_bridge.py 가 올리고, Time Logger 는 읽기 + status 변경만)
-- Supabase SQL 편집기에서 한 번 실행. <로그인 이메일> 은 Time Logger 에 로그인할 계정 이메일로 바꾼다.
-- 다시 실행해도 안전하다 (정책은 지우고 다시 만듦).
--
-- 표에 들어가는 것: key · kind · date · age · client · subject · gmail · status 뿐 (본문·보낸 사람·첨부 없음)
-- 맥미니는 service_role 키(RLS 우회, 키체인 보관)로 올리고 지운다. Time Logger 코드에는 공개(publishable) 키만 있다.

create table if not exists public.mail_followups (
  key text primary key,
  kind text not null check (kind in ('A','A2','B')),
  date date,
  age int,
  client text,
  subject text,
  gmail text,
  status text not null default 'open' check (status in ('open','done')),
  updated_at timestamptz not null default now()
);

alter table public.mail_followups enable row level security;

-- Supabase 는 새 표에 anon·authenticated 전체 권한(UPDATE 포함)을 기본으로 준다.
-- 표 단위 UPDATE 가 남아 있으면 열 단위 grant 를 해도 다른 열을 바꿀 수 있으므로, 전부 회수한 뒤 필요한 것만 다시 준다.
revoke all on public.mail_followups from anon, authenticated;
grant select, update (status) on public.mail_followups to authenticated;

drop policy if exists "본인만 읽기" on public.mail_followups;
drop policy if exists "본인만 처리함" on public.mail_followups;

create policy "본인만 읽기" on public.mail_followups
  for select to authenticated
  using ((auth.jwt() ->> 'email') = '<로그인 이메일>');

create policy "본인만 처리함" on public.mail_followups
  for update to authenticated
  using ((auth.jwt() ->> 'email') = '<로그인 이메일>')
  with check ((auth.jwt() ->> 'email') = '<로그인 이메일>' and status in ('open','done'));

-- 확인용 (결과: anon 없음, authenticated 는 SELECT 와 status 열 UPDATE 만)
-- select grantee, privilege_type from information_schema.role_table_grants where table_name = 'mail_followups';
-- select grantee, privilege_type, column_name from information_schema.column_privileges where table_name = 'mail_followups' and grantee = 'authenticated';
