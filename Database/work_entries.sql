-- 위키 작업일지 시간표 (2026-11-04). 맥미니 mac_mini/worklog_time_bridge.py 가 볼트의 작업일지에서 읽어 올린다.
-- Time Logger 의 ⏱ 작업시간 통계와 주간보고 '금주 실적'이 이 표를 읽는다 (읽기 전용).
-- 저장하는 것: 작업일지 파일명·날짜·항목·종류·고객사·프로젝트·작업명(노트 제목)·분·PC 뿐. 고객사 실명은 데이터로만 들어간다.
-- Supabase SQL 편집기에서 한 번 실행. 다시 실행해도 안전 (IF NOT EXISTS / 정책 다시 만듦).
-- 실행 전에 secure_tables.sql 의 private.tl_is_owner() 가 이미 있어야 한다.
-- 맥미니는 service_role 키(RLS 우회)로 올리고 지운다. 웹 앱은 로그인한 본인만 읽는다.

CREATE TABLE IF NOT EXISTS work_entries (
    id TEXT PRIMARY KEY,                       -- 작업일지 파일명(.md 뺀 것). 같은 일지를 다시 올려도 덮어씀
    day TEXT NOT NULL,                         -- YYYY-MM-DD (일지 머리줄 날짜)
    itemid TEXT,                               -- 프로젝트 목록(70_작업일지/프로젝트.md)의 ID. 목록에 없으면 비어 있음
    item TEXT,                                 -- 항목 이름 (하루 노트 '### 항목' 제목)
    kind TEXT NOT NULL CHECK (kind IN ('운영', '프로젝트', '내부', '미등록')),   -- 목록의 '고객사운영' 은 '운영' 으로 저장
    client TEXT,                               -- 일지 머리줄 고객사 (내부 일은 '해당 없음(내부)')
    project TEXT,                              -- 일지 머리줄 프로젝트
    title TEXT,                                -- 작업명 = 일지 '# 제목'
    minutes INTEGER NOT NULL DEFAULT 0,        -- 머리줄 '작업 시간 X시간 Y분' 을 분으로
    pc TEXT,                                   -- win / mac
    username TEXT,
    updatedat TEXT
);

CREATE INDEX IF NOT EXISTS idx_work_entries_user_day ON work_entries(username, day);

-- '로그인한 본인'만 (secure_tables.sql 과 같은 규칙)
ALTER TABLE public.work_entries ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.work_entries FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "본인만" ON public.work_entries;
REVOKE ALL ON public.work_entries FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.work_entries TO authenticated;
CREATE POLICY "본인만" ON public.work_entries FOR ALL TO authenticated
    USING (private.tl_is_owner()) WITH CHECK (private.tl_is_owner());

-- 확인용: 종류가 4가지 밖이면 거부되어야 한다 (오류가 나야 정상)
-- insert into work_entries(id, day, kind) values ('t', '2099-01-01', '기타');
