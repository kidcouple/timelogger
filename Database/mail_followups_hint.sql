-- 2026-11-06: 메일 회신 카드 고객사 판정 근거 (맥 mail_followup.py → supabase_bridge.py 가 채움)
-- Supabase SQL Editor 에서 한 번 실행. 실행 전에도 맥·화면은 hint 없이 예전처럼 동작한다.
alter table public.mail_followups add column if not exists hint text;
