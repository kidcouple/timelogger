-- Supabase (PostgreSQL). 컬럼명은 소문자로 저장됩니다.

CREATE TABLE IF NOT EXISTS clients (
    id TEXT PRIMARY KEY,
    name TEXT,
    contact TEXT,
    phone TEXT,
    memo TEXT,
    username TEXT
);

CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT,
    icon TEXT,
    memo TEXT,
    username TEXT
);

CREATE TABLE IF NOT EXISTS tasks (
    id TEXT PRIMARY KEY,
    seq TEXT,
    title TEXT,
    project TEXT,
    client TEXT,
    requester TEXT,
    reqdate TEXT,
    pstart TEXT,
    pend TEXT,
    astart TEXT,
    aend TEXT,
    status TEXT,
    reqtype TEXT,
    actualtime NUMERIC,
    reqdetail TEXT,
    procdetail TEXT,
    reqimages TEXT,
    procimages TEXT,
    createdat TEXT,
    isissue BOOLEAN DEFAULT FALSE,
    issuememo TEXT,
    issueprogress TEXT,
    issuefollowup TEXT,
    notionlink TEXT,
    username TEXT,
    isurgent BOOLEAN DEFAULT FALSE,
    isimportant BOOLEAN DEFAULT FALSE,
    subtasks TEXT
);

CREATE TABLE IF NOT EXISTS logs (
    sessionid TEXT PRIMARY KEY,
    taskid TEXT,
    tasktitle TEXT,
    start TEXT,
    "end" TEXT,
    duration NUMERIC,
    username TEXT
);

CREATE TABLE IF NOT EXISTS weekly_reports (
    id TEXT PRIMARY KEY,
    report_date TEXT,
    week_label TEXT,
    content_json JSONB,
    username TEXT,
    created_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_clients_user ON clients(username);
CREATE INDEX IF NOT EXISTS idx_projects_user ON projects(username);
CREATE INDEX IF NOT EXISTS idx_tasks_user ON tasks(username);
CREATE INDEX IF NOT EXISTS idx_logs_user ON logs(username);
CREATE INDEX IF NOT EXISTS idx_reports_user ON weekly_reports(username);
