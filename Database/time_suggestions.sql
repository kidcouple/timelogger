-- 자동 제안 시간표 (2026-10-29, 타임로거 자동제안 1차).
-- 수집기(Windows/맥)가 '이 시간엔 이 일을 한 것 같다' 덩어리를 올리고, 사용자가 '하루 끝 확인' 화면(review.html)에서 확인·고침·버림.
-- 저장하는 것: 시작·끝·분야·가명·접두어·출처·할일 id 뿐 (창 제목·파일 내용·메일 본문 없음, 고객사 실명 없음).
-- Supabase SQL 편집기에서 한 번 실행. 다시 실행해도 안전 (IF NOT EXISTS / 정책 다시 만듦).
-- 실행 전에 secure_tables.sql 의 private.tl_is_owner() 가 이미 있어야 한다.

CREATE TABLE IF NOT EXISTS time_suggestions (
    id TEXT PRIMARY KEY,                       -- 수집기가 만든 고정 id (같은 덩어리를 두 번 올려도 덮어씀)
    day TEXT NOT NULL,                         -- YYYY-MM-DD (현지 날짜)
    start TEXT NOT NULL,                       -- ISO 시각
    "end" TEXT NOT NULL,
    area TEXT NOT NULL CHECK (area IN ('개발', '회의', '근무')),          -- 개인 분야는 들어올 수 없음
    clientalias TEXT CHECK (clientalias IS NULL OR clientalias ~ '^C[0-9]{2}$'),   -- 가명만 (실명 금지)
    prefix TEXT,                               -- 프로그램 접두어 (예: ZCOR)
    source TEXT NOT NULL CHECK (source IN ('claude', 'abap', 'outlook', 'lock', 'manual')),
    kind TEXT NOT NULL DEFAULT 'work' CHECK (kind IN ('work', 'idle')),   -- idle = 자리 비움 구간 (2차: 타이머 분할 질문 재료, 1차 화면에는 안 보임)
    taskid TEXT,                               -- 배정된 할일 (없으면 미배정 → 주간보고 제외)
    status TEXT NOT NULL DEFAULT 'suggested' CHECK (status IN ('suggested', 'confirmed', 'discarded')),
    logid TEXT,                                -- 확인되어 만들어진 logs.sessionid
    createdat TEXT,
    updatedat TEXT,
    username TEXT
);

CREATE INDEX IF NOT EXISTS idx_suggest_user_day ON time_suggestions(username, day);

-- '로그인한 본인'만 (secure_tables.sql 과 같은 규칙)
ALTER TABLE public.time_suggestions ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.time_suggestions FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS "본인만" ON public.time_suggestions;
REVOKE ALL ON public.time_suggestions FROM anon, authenticated;
GRANT SELECT, INSERT, UPDATE, DELETE ON public.time_suggestions TO authenticated;
CREATE POLICY "본인만" ON public.time_suggestions FOR ALL TO authenticated
    USING (private.tl_is_owner()) WITH CHECK (private.tl_is_owner());

-- 확인용: 개인 분야가 거부되는지 (오류가 나야 정상)
-- insert into time_suggestions(id, day, start, "end", area, source) values ('t', '2099-01-01', 'x', 'y', '개인', 'claude');
