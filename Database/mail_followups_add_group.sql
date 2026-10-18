-- 이미 만들어진 mail_followups 에 그룹 유형(G)을 추가한다.
-- Supabase SQL 편집기에 이 내용을 붙여 넣고 Run.

alter table public.mail_followups drop constraint if exists mail_followups_kind_check;
alter table public.mail_followups
  add constraint mail_followups_kind_check
  check (kind in ('A', 'A2', 'G', 'B'));
