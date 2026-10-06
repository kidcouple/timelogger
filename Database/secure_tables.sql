-- Time Logger 표 잠그기: 공개(publishable/anon) 키로는 아무것도 못 하고, '로그인한 본인'만 읽고 쓴다.
-- Supabase SQL 편집기에서 한 번 실행. <로그인 이메일> (한 곳) 을 Time Logger 에 로그인하는 계정 이메일로 바꾼다.
-- 다시 실행해도 안전하다 (기존 정책은 모두 지우고 다시 만듦).
--
-- 반드시 '로그인 기능이 들어간 Time Logger' 를 먼저 배포한 뒤 실행 (순서가 바뀌면 배포 전까지 화면이 비어 보임).
-- 맥미니 브리지(service_role) 는 RLS 를 우회하므로 영향 없음.

-- 본인 확인 함수: API 로 노출되지 않는 private 스키마에 둔다 (이메일은 여기 한 곳만)
create schema if not exists private;
revoke all on schema private from public, anon;
grant usage on schema private to authenticated;

create or replace function private.tl_is_owner()
returns boolean
language sql
stable
as $$
  select coalesce((auth.jwt() ->> 'email') = '<로그인 이메일>', false)
$$;
revoke all on function private.tl_is_owner() from public, anon;
grant execute on function private.tl_is_owner() to authenticated;

do $$
declare
  t text;
  p record;
begin
  foreach t in array array['tasks', 'logs', 'clients', 'projects', 'weekly_reports'] loop
    execute format('alter table public.%I enable row level security', t);
    execute format('alter table public.%I force row level security', t);

    -- 이전에 만든 정책(예: anon 전체 허용)을 이름과 상관없이 전부 삭제
    for p in select policyname from pg_policies where schemaname = 'public' and tablename = t loop
      execute format('drop policy %I on public.%I', p.policyname, t);
    end loop;

    execute format('revoke all on public.%I from anon, authenticated', t);
    execute format('grant select, insert, update, delete on public.%I to authenticated', t);

    execute format($f$create policy "본인만" on public.%I for all to authenticated
                      using (private.tl_is_owner()) with check (private.tl_is_owner())$f$, t);
  end loop;
end $$;

-- id 자동 증가 열이 있으면 insert 에 필요
grant usage on all sequences in schema public to authenticated;
revoke all on all sequences in schema public from anon;

-- 확인용 1: RLS 가 꺼진 public 표가 남아 있는지 (결과가 없어야 정상)
-- select tablename from pg_tables where schemaname = 'public' and not rowsecurity;
-- 확인용 2: anon 에 남은 권한 (결과가 없어야 정상)
-- select table_name, privilege_type from information_schema.role_table_grants where table_schema = 'public' and grantee = 'anon';
