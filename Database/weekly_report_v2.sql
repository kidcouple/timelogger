-- 주간보고 개편 (11-04): 메일 → 주간보고 등록, 위키 노트 요청.
-- Supabase SQL 편집기에서 한 번 실행. 다시 실행해도 안전하다.

-- 할일: 주간보고 포함 여부 / 등록한 메일 key / 위키 노트 생성 요청
alter table public.tasks add column if not exists inreport boolean;   -- null=예전 할일(옛 규칙), true=포함, false=제외
alter table public.tasks add column if not exists mailkey text;       -- 메일 회신 카드에서 등록한 스레드 key
alter table public.tasks add column if not exists wikireq boolean;    -- true 면 맥미니가 위키 노트를 만든 뒤 null 로 되돌린다

-- 메일 회신 목록: 내가 회신해 목록에서 빠졌지만 등록된 요청은 지우지 않고 'replied' 로 둔다 (완료 후보)
alter table public.mail_followups add column if not exists replied_at date;
alter table public.mail_followups drop constraint if exists mail_followups_status_check;
alter table public.mail_followups
  add constraint mail_followups_status_check check (status in ('open', 'done', 'replied'));
