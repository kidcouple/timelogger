"""Supabase (PostgREST) 백엔드. Flask /api/db 와 주간보고가 쓰는 인터페이스."""
import json
import os
import time
import uuid
from datetime import datetime, timezone

import requests
from dotenv import load_dotenv

load_dotenv(override=True)

TABLES = {
    "clients": {
        "pk": "id",
        "columns": ["id", "name", "contact", "phone", "memo", "username"],
    },
    "projects": {
        "pk": "id",
        "columns": ["id", "name", "status", "icon", "memo", "username"],
    },
    "tasks": {
        "pk": "id",
        "columns": [
            "id", "seq", "title", "project", "client", "requester",
            "reqdate", "pstart", "pend", "astart", "aend", "status", "reqtype",
            "actualtime", "reqdetail", "procdetail", "reqimages", "procimages",
            "createdat", "isissue", "issuememo", "issueprogress", "issuefollowup",
            "notionlink", "username", "isurgent", "isimportant", "subtasks",
        ],
    },
    "logs": {
        "pk": "sessionid",
        "columns": ["sessionid", "taskid", "tasktitle", "start", "end", "duration", "username"],
    },
    "weekly_reports": {
        "pk": "id",
        "columns": ["id", "report_date", "week_label", "content_json", "username", "created_at"],
    },
}

BOOL_COLS = {"isissue", "isurgent", "isimportant"}
JSON_COLS = {"content_json"}
KEEPALIVE_ID = "00000000-0000-4000-8000-000000000001"
PAGE = 1000
UPSERT_CHUNK = 80
RETRY_STATUS = {502, 503, 504, 520, 522, 546}


def _creds():
    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (
        os.environ.get("SUPABASE_SERVICE_ROLE_KEY")
        or os.environ.get("SUPABASE_ANON_KEY")
        or os.environ.get("SUPABASE_KEY")
        or ""
    ).strip()
    if not url or not key:
        raise RuntimeError("SUPABASE_URL 과 SUPABASE_ANON_KEY 환경변수가 필요합니다.")
    return url, key


def _headers(extra=None):
    _, key = _creds()
    headers = {
        "apikey": key,
        "Authorization": f"Bearer {key}",
        "Accept": "application/json",
    }
    if extra:
        headers.update(extra)
    return headers


def _request(method, path, *, params=None, json_body=None, extra_headers=None, timeout=45):
    url, _ = _creds()
    last_err = None
    for attempt in range(4):
        try:
            resp = requests.request(
                method,
                f"{url}{path}",
                headers=_headers(extra_headers),
                params=params,
                json=json_body,
                timeout=timeout,
            )
        except requests.RequestException as e:
            last_err = e
            time.sleep(2 + attempt * 3)
            continue
        if resp.status_code in RETRY_STATUS or "not available" in (resp.text or "").lower():
            last_err = RuntimeError(f"HTTP {resp.status_code} {(resp.text or '')[:180]}")
            time.sleep(5 + attempt * 5)
            continue
        return resp
    raise RuntimeError(f"Supabase 요청 실패: {last_err}")


def _to_db_value(col, value):
    if value is None:
        return None
    if col in BOOL_COLS:
        if isinstance(value, str):
            return value.strip().lower() in ("1", "true", "t", "yes")
        return bool(value)
    if col in JSON_COLS:
        if isinstance(value, str):
            try:
                return json.loads(value)
            except (json.JSONDecodeError, TypeError):
                return value
        return value
    if isinstance(value, (dict, list)) and col not in JSON_COLS:
        return json.dumps(value, ensure_ascii=False)
    return value


def _from_db_value(col, value):
    if value is None:
        return None
    if col in BOOL_COLS:
        return bool(value)
    if col in JSON_COLS and isinstance(value, str):
        try:
            return json.loads(value)
        except (json.JSONDecodeError, TypeError):
            return value
    return value


def _row_to_dict(row):
    if not isinstance(row, dict):
        return {}
    return {str(k).lower(): _from_db_value(str(k).lower(), v) for k, v in row.items()}


def _normalize_row(table, row, username=None):
    if not isinstance(row, dict):
        return {}
    spec = TABLES[table]
    clean = {}
    for k, v in row.items():
        key = str(k).strip().lower()
        if key in spec["columns"]:
            clean[key] = _to_db_value(key, v)
    if username and not clean.get("username"):
        clean["username"] = username
    pk = spec["pk"]
    if not clean.get(pk):
        if table == "tasks" and clean.get("seq"):
            clean[pk] = clean["seq"]
        else:
            clean[pk] = str(uuid.uuid4())
    if table == "weekly_reports" and not clean.get("created_at"):
        clean["created_at"] = datetime.now(timezone.utc).isoformat()
    return clean


def _eq_params(spec, username=None, filters=None):
    params = {"select": "*"}
    if username and "username" in spec["columns"]:
        params["username"] = f"eq.{username}"
    for col, val in (filters or {}).items():
        col = str(col).lower()
        if col not in spec["columns"]:
            continue
        params[col] = f"eq.{val}"
    return params


def select(table, username=None, filters=None):
    if table not in TABLES:
        raise ValueError(f"unknown table: {table}")
    spec = TABLES[table]
    params = _eq_params(spec, username, filters)
    rows = []
    offset = 0
    while True:
        extra = {"Range": f"{offset}-{offset + PAGE - 1}", "Prefer": "count=exact"}
        resp = _request("GET", f"/rest/v1/{table}", params=params, extra_headers=extra)
        if resp.status_code not in (200, 206):
            raise RuntimeError(f"{table} GET HTTP {resp.status_code} {(resp.text or '')[:240]}")
        chunk = resp.json() if resp.content else []
        if not isinstance(chunk, list):
            raise RuntimeError(f"{table} unexpected body")
        rows.extend(_row_to_dict(r) for r in chunk)
        if len(chunk) < PAGE:
            break
        offset += PAGE
    if table == "weekly_reports":
        rows = [r for r in rows if r.get("id") != KEEPALIVE_ID]
    return rows


def upsert(table, data, username=None):
    if table not in TABLES:
        raise ValueError(f"unknown table: {table}")
    rows = data if isinstance(data, list) else [data]
    normalized = [_normalize_row(table, r, username) for r in rows if r]
    if not normalized:
        return 0
    extra = {
        "Content-Type": "application/json",
        "Prefer": "resolution=merge-duplicates,return=minimal",
    }
    for i in range(0, len(normalized), UPSERT_CHUNK):
        chunk = normalized[i:i + UPSERT_CHUNK]
        resp = _request("POST", f"/rest/v1/{table}", json_body=chunk, extra_headers=extra)
        if resp.status_code not in (200, 201, 204):
            raise RuntimeError(f"{table} UPSERT HTTP {resp.status_code} {(resp.text or '')[:240]}")
    return len(normalized)


def delete(table, filters, username=None):
    if table not in TABLES:
        raise ValueError(f"unknown table: {table}")
    spec = TABLES[table]
    params = _eq_params(spec, username, filters)
    params.pop("select", None)
    if len(params) == 0:
        raise ValueError("delete requires a filter")
    resp = _request(
        "DELETE",
        f"/rest/v1/{table}",
        params=params,
        extra_headers={"Prefer": "return=minimal"},
    )
    if resp.status_code not in (200, 204):
        raise RuntimeError(f"{table} DELETE HTTP {resp.status_code} {(resp.text or '')[:240]}")
    return True


def ping():
    """Pause 방지용 가벼운 조회."""
    resp = _request(
        "GET",
        "/rest/v1/clients",
        params={"select": "id", "limit": "1"},
    )
    if resp.status_code not in (200, 206):
        raise RuntimeError(f"ping HTTP {resp.status_code} {(resp.text or '')[:180]}")
    return True


def heartbeat():
    """조회 + 고정 행 upsert로 DB 활동을 남긴다."""
    ping()
    now = datetime.now(timezone.utc)
    upsert(
        "weekly_reports",
        {
            "id": KEEPALIVE_ID,
            "report_date": now.strftime("%Y. %m. %d"),
            "week_label": "keepalive",
            "username": "system",
            "content_json": {"ts": now.isoformat(), "source": "heartbeat"},
            "created_at": now.isoformat(),
        },
    )
    return True
