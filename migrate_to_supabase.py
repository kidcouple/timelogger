"""로컬 timelogger.db 내용을 Supabase로 올립니다.

사용:  python migrate_to_supabase.py
Drive 파일은 임시 복사본에서 읽어서 잠금/지연을 피합니다.
"""
import os
import shutil
import sqlite3
import sys
import tempfile

from dotenv import load_dotenv

load_dotenv(override=True)

import db as remote_db

ROOT = os.path.dirname(os.path.abspath(__file__))
SQLITE_PATH = os.environ.get("DB_PATH") or os.path.join(ROOT, "timelogger.db")
TABLES = ["clients", "projects", "tasks", "logs", "weekly_reports"]


def _read_sqlite(path):
    conn = sqlite3.connect(path, timeout=30)
    conn.row_factory = sqlite3.Row
    try:
        out = {}
        for table in TABLES:
            rows = conn.execute(f"SELECT * FROM {table}").fetchall()
            out[table] = [dict(r) for r in rows]
        return out
    finally:
        conn.close()


def main():
    if not os.path.exists(SQLITE_PATH):
        print(f"SQLite 파일이 없습니다: {SQLITE_PATH}")
        return 1

    tmp = os.path.join(tempfile.gettempdir(), "timelogger_migrate.db")
    print(f"복사 중: {SQLITE_PATH} -> {tmp}")
    shutil.copy2(SQLITE_PATH, tmp)
    data = _read_sqlite(tmp)
    try:
        os.remove(tmp)
    except OSError:
        pass

    for table, rows in data.items():
        print(f"{table}: 로컬 {len(rows)}건 업로드")
        if not rows:
            continue
        n = remote_db.upsert(table, rows)
        print(f"{table}: upsert {n}건")

    print("원격 건수 확인")
    for table in TABLES:
        n = len(remote_db.select(table))
        print(f"{table}: supabase {n}건")
    print("완료")
    return 0


if __name__ == "__main__":
    sys.exit(main())
