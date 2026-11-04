-- 작업 항목 통합 (2026-11-04): Time Logger 의 clients·projects 를 '작업 항목'의 유일한 원본으로 쓴다.
-- 위키 70_작업일지/프로젝트.md 는 맥미니 mac_mini/items_export.py 가 이 두 표에서 자동 생성한다.
-- Supabase SQL 편집기에서 한 번 실행. 다시 실행해도 안전 (IF NOT EXISTS).
-- 순서: 이 SQL 실행 -> mac_mini/items_import_once.py --apply (위키 목록을 앱으로 한 번 이관) -> 웹 앱 배포 -> items_export 예약 등록.
-- 주의: 컬럼이 없는 상태에서 새 화면(clients.html·projects.html)으로 저장하면 실패한다. SQL 을 먼저 실행할 것.
--
-- itemid 는 clients 와 projects 를 통틀어 유일해야 한다 ('I01', 'I02' ...; 위키 프로젝트.md 의 ID 와 같다).
-- 두 표에 걸친 유일성은 DB 제약으로 걸 수 없어 화면(tlNextItemId)과 import 스크립트가 지킨다.
-- 각 표 안에서는 아래 부분 유니크 인덱스로 중복을 막는다.

ALTER TABLE clients  ADD COLUMN IF NOT EXISTS itemid  TEXT;     -- 항목 ID (예: I04)
ALTER TABLE clients  ADD COLUMN IF NOT EXISTS folders TEXT;     -- 작업 폴더 토막, 쉼표로 여러 개 (예: Development/OOO)
ALTER TABLE clients  ADD COLUMN IF NOT EXISTS aliases TEXT;     -- 일지 머리줄에 다르게 쓴 이름, 쉼표로 여러 개
ALTER TABLE clients  ADD COLUMN IF NOT EXISTS status  TEXT;     -- '사용' / '종료' (삭제 대신 종료 — 옛 기록이 계속 이 항목으로 합쳐짐)

ALTER TABLE projects ADD COLUMN IF NOT EXISTS kind    TEXT;     -- 운영 / 프로젝트 / 내부 (projects_kind.sql 을 아직 안 돌렸어도 안전)
ALTER TABLE projects ADD COLUMN IF NOT EXISTS itemid  TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS folders TEXT;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS aliases TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS uq_clients_itemid  ON clients(username, itemid)  WHERE itemid IS NOT NULL AND itemid <> '';
CREATE UNIQUE INDEX IF NOT EXISTS uq_projects_itemid ON projects(username, itemid) WHERE itemid IS NOT NULL AND itemid <> '';
