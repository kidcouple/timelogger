#!/usr/bin/env python3
"""위키 작업일지 시간을 Supabase work_entries 로 올린다 (맥미니 launchd, 10분 주기).

하루 노트(70_작업일지/YYYY/MM/YYYY-MM-DD.md)의 '## 한 일' -> '### 항목' 아래 '- [[작업일지]]' 링크를 모으고,
각 작업일지 머리줄(날짜 · 고객사 · 프로젝트 · PC · 상태 · 작업 시간 X시간 Y분)과 '# 제목'을 읽어 한 줄(행)로 만든다.
항목 종류(운영/프로젝트/내부)는 프로젝트 목록(70_작업일지/프로젝트.md)을 _timelog/tools/items.py 로 읽어 붙인다.
목록에 없는 항목은 kind='미등록'. 고객사 실명은 코드에 없고 데이터로만 다룬다.

  python3 worklog_time_bridge.py --vault ~/Wiki --days 21            # 올리기
  python3 worklog_time_bridge.py --vault ~/Wiki --dry-run --days 7   # 읽기만 (네트워크 없음)

접속 정보는 mail_sync_watch.py 와 같은 방식(supabase.json + 키체인 wiki-supabase, 또는 환경변수)으로 읽는다.
사용자 이름(username)은 환경변수 TL_USERNAME 또는 --username (없으면 Time Logger 기본 사용자).
"""
import argparse
import datetime
import glob
import json
import os
import re
import subprocess
import sys
import unicodedata
import urllib.error
import urllib.parse
import urllib.request

KEYCHAIN_SERVICE = "wiki-supabase"
SUPABASE_JSON = os.path.expanduser("~/Wiki-Import/mail/supabase.json")
MAIL_DIR = os.environ.get("MAIL_BRIDGE_DIR", "/Users/sunkyunhwang/Masking/wiki-tools/mail")
TABLE = "work_entries"
DEFAULT_USERNAME = "황선균"   # index.html / supabaseClient.js 의 기본 사용자와 같다
SKIP_DIRS = {".obsidian", ".trash", ".git"}
UPSERT_CHUNK = 80
DELETE_CHUNK = 20

KIND_MAP = {"고객사운영": "운영", "운영": "운영", "프로젝트": "프로젝트", "내부": "내부"}


# ---------------------------------------------------------------- Supabase (mail_sync_watch.py 와 같은 방식)
def load_env_file(path):
    if not os.path.isfile(path):
        return
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, value = line.split("=", 1)
            os.environ.setdefault(key.strip(), value.strip().strip('"').strip("'"))


def keychain_key(account):
    if not account:
        return ""
    proc = subprocess.run(
        ["security", "find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", account, "-w"],
        capture_output=True,
        text=True,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""


def bridge_config():
    if not os.path.isfile(SUPABASE_JSON):
        return "", ""
    with open(SUPABASE_JSON, encoding="utf-8") as f:
        cfg = json.load(f)
    url = (cfg.get("url") or "").strip().rstrip("/")
    key = (cfg.get("_test_key") or "").strip() or keychain_key(url)
    return url, key


def creds():
    url, key = bridge_config()
    if not url or not key:
        load_env_file(os.path.join(MAIL_DIR, ".env"))
        url = url or (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
        key = key or (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY") or "").strip()
    if not url or not key:
        sys.exit(
            "SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다. "
            "메일 폴더 .env 또는 키체인 서비스 wiki-supabase 를 확인하세요."
        )
    return url, key


def request(method, url, key, body=None, prefer="return=representation"):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", prefer)
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"HTTP {e.code} {detail}") from e
    return json.loads(raw) if raw else []


# ---------------------------------------------------------------- items.py (맥·윈도우 공용, 드라이브 _timelog/tools)
def import_items(items_file):
    cands = []
    if os.environ.get("TIMELOG_TOOLS"):
        cands.append(os.environ["TIMELOG_TOOLS"])
    here = os.path.dirname(os.path.abspath(__file__))
    cands += [here, os.path.join(here, "tools")]
    rel = os.path.join("5.AI", "01_Work_Archive", "Development", "_timelog", "tools")
    cands += glob.glob(os.path.expanduser(os.path.join("~/Library/CloudStorage/GoogleDrive-*/내 드라이브", rel)))
    cands += [os.path.join("G:\\", "내 드라이브", rel)]
    for d in cands:
        if os.path.isfile(os.path.join(d, "items.py")):
            sys.path.insert(0, d)
            import items  # noqa: E402
            return items
    sys.exit("items.py 를 찾지 못했습니다. 환경변수 TIMELOG_TOOLS 에 _timelog/tools 경로를 지정하세요.")


# ---------------------------------------------------------------- 볼트 읽기
def nfc(s):
    return unicodedata.normalize("NFC", s or "")


def build_index(vault):
    """파일명(확장자 뺀 것) -> [경로...]. 볼트를 한 번만 훑는다."""
    index = {}
    for root, dirs, files in os.walk(vault):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            if fn.endswith(".md"):
                index.setdefault(nfc(fn[:-3]), []).append(os.path.join(root, fn))
    for lst in index.values():
        lst.sort()
    return index


LINK_RE = re.compile(r"^- \[\[([^\]]+)\]\]")
FIELD_SPLIT = re.compile(r"\s·\s(?=(?:날짜|고객사|프로젝트|PC|상태|작업 시간):)")


def link_name(raw):
    name = raw.split("|", 1)[0].split("#", 1)[0].strip()
    name = name.replace("\\", "/").rsplit("/", 1)[-1]
    if name.endswith(".md"):
        name = name[:-3]
    return nfc(name)


def parse_daily(path):
    """-> [(항목 제목, 링크 이름)] ('## 한 일' 안 '### 항목' 아래 맨 앞 단계 링크만)"""
    out, in_done, heading = [], False, ""
    with open(path, encoding="utf-8") as f:
        for ln in f:
            ln = ln.rstrip("\n")
            if ln.startswith("## "):
                in_done = ln[3:].strip() == "한 일"
                heading = ""
                continue
            if not in_done:
                continue
            if ln.startswith("### "):
                heading = ln[4:].strip()
                continue
            m = LINK_RE.match(ln)
            if m and heading:
                out.append((heading, link_name(m.group(1))))
    return out


def parse_minutes(text):
    m = re.search(r"(?:(\d+)\s*시간)?\s*(?:(\d+)\s*분)?", text or "")
    if not text or not m or not (m.group(1) or m.group(2)):
        return None
    return int(m.group(1) or 0) * 60 + int(m.group(2) or 0)


def parse_worklog(path):
    """-> dict(title, fields) 머리줄('- 날짜: ...')과 '# 제목'. 머리줄이 없으면 fields 는 빈 dict."""
    title, fields, in_front, started = "", {}, False, False
    with open(path, encoding="utf-8") as f:
        for i, ln in enumerate(f):
            ln = ln.rstrip("\n")
            if i == 0 and ln.strip() == "---":
                in_front = True
                continue
            if in_front:
                if ln.strip() == "---":
                    in_front = False
                continue
            if not title and ln.startswith("# "):
                title = ln[2:].strip()
                started = True
                continue
            if started and not fields and ln.startswith("- 날짜:"):
                for part in FIELD_SPLIT.split(ln[2:]):
                    k, _, v = part.partition(":")
                    fields[k.strip()] = v.strip()
                break
    return {"title": title, "fields": fields}


def pc_of(text):
    t = (text or "").lower()
    if "윈도우" in t or "win" in t:
        return "win"
    if "맥" in t or "mac" in t:
        return "mac"
    return text or ""


def match_item(items_mod, items, heading):
    """### 항목 제목 -> (id, name, kind). 이름·별칭이 (공백·하이픈·밑줄·대소문자 무시) 정확히 같을 때만. 없으면 미등록."""
    h = items_mod.norm(heading)
    for it in items:
        if h and h in {items_mod.norm(it["name"])} | {items_mod.norm(a) for a in it["aliases"]}:
            return it["id"], it["name"], KIND_MAP.get(it["kind"].strip(), "미등록")
    return "", re.sub(r"^\(미등록\)\s*", "", heading).strip(), "미등록"


def pick_path(paths, minutes_cache):
    """같은 파일명이 여러 폴더에 있으면 '작업 시간'이 있는 쪽을 쓴다."""
    for p in paths:
        w = minutes_cache.setdefault(p, parse_worklog(p))
        if w["fields"].get("작업 시간"):
            return p
    return paths[0]


def win_worklog_dir():
    """드라이브 윈도우 원본 일지 폴더 (_timelog/win/worklog). 볼트 사본은 고객사 이름이 가려지거나 늦게 갱신되므로 원본을 우선한다."""
    rel = os.path.join("5.AI", "01_Work_Archive", "Development", "_timelog", "win", "worklog")
    cands = []
    if os.environ.get("TIMELOG_WIN_WORKLOG"):
        cands.append(os.environ["TIMELOG_WIN_WORKLOG"])
    cands += glob.glob(os.path.expanduser(os.path.join("~/Library/CloudStorage/GoogleDrive-*/내 드라이브", rel)))
    cands += [os.path.join("G:\\", "내 드라이브", rel)]
    for d in cands:
        if os.path.isdir(d):
            return d
    return ""


def strip_ops(text):
    return re.sub(r"\s*운영\s*$", "", text or "").strip()


def resolve_item(items_mod, items, heading, fields):
    """### 항목 제목 -> 못 찾으면 머리줄 프로젝트 -> 고객사 순으로 목록과 맞춘다 (정확 일치 -> 포함 일치).
    -> (id, name, kind, matched)"""
    iid, iname, kind = match_item(items_mod, items, heading)
    if iid:
        return iid, iname, kind, True
    by = items_mod.by_id(items)
    for text in (fields.get("프로젝트", ""), strip_ops(fields.get("고객사", "")), fields.get("고객사", "")):
        for fn in (items_mod.match_name, items_mod.match_contains):
            found = fn(items, text)
            if found:
                it = by[found]
                return it["id"], it["name"], KIND_MAP.get(it["kind"].strip(), "미등록"), True
    return "", iname, kind, False


def make_row(name, d, w, heading, items_mod, items, username, now, warns):
    f = w["fields"]
    minutes = parse_minutes(f.get("작업 시간"))
    if not minutes:
        warns.append(f"{d} 작업 시간 없음(건너뜀): {name}")
        return None
    day = f.get("날짜") if re.fullmatch(r"\d{4}-\d{2}-\d{2}", f.get("날짜", "")) else d.isoformat()
    iid, iname, kind, matched = resolve_item(items_mod, items, heading, f)
    if not matched:
        warns.append(f"{d} 목록에 없는 항목(미등록): {name} / {iname}")
    client = f.get("고객사", "")
    if client.startswith("해당 없음") and kind in ("운영", "프로젝트"):
        kind = "내부"                        # 머리줄이 내부 업무면 주간보고(운영·프로젝트)에 넣지 않는다
    if kind == "운영" and matched:
        client = iname                      # 운영은 항목 이름으로 통일 (같은 고객사가 두 줄로 나뉘지 않게)
    else:
        client = strip_ops(client)
    return {
        "id": name, "day": day, "itemid": iid, "item": iname, "kind": kind,
        "client": client, "project": f.get("프로젝트", ""), "title": w["title"] or name,
        "minutes": minutes, "pc": pc_of(f.get("PC")), "username": username, "updatedat": now,
    }


def collect(vault, days, items_mod, items, username):
    today = datetime.date.today()
    since = today - datetime.timedelta(days=days - 1)
    index = build_index(vault)
    cache, rows, seen, warns = {}, [], set(), []
    wdir = win_worklog_dir()
    base = os.path.join(vault, "70_작업일지")
    daily = []
    for root, dirs, files in os.walk(base):
        dirs[:] = [d for d in dirs if d not in SKIP_DIRS]
        for fn in files:
            m = re.fullmatch(r"(\d{4}-\d{2}-\d{2})\.md", fn)
            if m:
                d = datetime.date.fromisoformat(m.group(1))
                if since <= d <= today:
                    daily.append((d, os.path.join(root, fn)))
    daily.sort()
    now = datetime.datetime.now(datetime.timezone.utc).isoformat(timespec="seconds")
    for d, path in daily:
        for heading, name in parse_daily(path):
            if name in seen:
                continue
            paths = index.get(name)
            if not paths:
                warns.append(f"{d} 링크 대상 없음: {name}")
                continue
            if len(paths) > 1:
                warns.append(f"{d} 같은 파일명 {len(paths)}곳: {name} (작업 시간이 있는 쪽 사용)")
            wp = pick_path(paths, cache)
            orig = os.path.join(wdir, name + ".md") if wdir else ""
            if orig and os.path.isfile(orig):          # 윈도우 원본이 있으면 원본 머리줄을 쓴다
                wp = orig
            w = cache.setdefault(wp, parse_worklog(wp))
            row = make_row(name, d, w, heading, items_mod, items, username, now, warns)
            if row:
                seen.add(name)
                rows.append(row)
    # 하루 노트에 아직 링크되지 않은 윈도우 원본 (하루 노트는 하루 두 번만 만들어진다)
    if wdir:
        for path in sorted(glob.glob(os.path.join(wdir, "*.md"))):
            m = re.match(r"(\d{4}-\d{2}-\d{2})_", os.path.basename(path))
            name = nfc(os.path.basename(path)[:-3])
            if not m or name in seen:
                continue
            d = datetime.date.fromisoformat(m.group(1))
            if not (since <= d <= today):
                continue
            w = cache.setdefault(path, parse_worklog(path))
            row = make_row(name, d, w, "", items_mod, items, username, now, warns)
            if row:
                seen.add(name)
                rows.append(row)
    return rows, since, today, warns


# ---------------------------------------------------------------- 출력·업로드
def fmt(m):
    return f"{m // 60}시간 {m % 60}분"


def print_dry(rows, warns):
    print(f"{'day':10} {'kind':6} {'item':24} {'pc':4} {'분':>4}  title")
    for r in sorted(rows, key=lambda x: (x["day"], x["item"], x["id"])):
        print(f"{r['day']:10} {r['kind']:6} {r['item'][:24]:24} {r['pc']:4} {r['minutes']:>4}  {r['title']}")
    print("\n-- 날짜별 항목별 합계 --")
    agg = {}
    for r in rows:
        agg[(r["day"], r["item"], r["kind"])] = agg.get((r["day"], r["item"], r["kind"]), 0) + r["minutes"]
    day_tot = {}
    for (day, item, kind), m in sorted(agg.items()):
        print(f"{day}  {item[:30]:30} {kind:6} {fmt(m)}")
        day_tot[day] = day_tot.get(day, 0) + m
    print("\n-- 날짜별 합계 --")
    for day, m in sorted(day_tot.items()):
        print(f"{day}  {fmt(m)}")
    for w in warns:
        print("주의:", w)


def upload(rows, since, until, username):
    url, key = creds()
    base = f"{url}/rest/v1/{TABLE}"
    for i in range(0, len(rows), UPSERT_CHUNK):
        request("POST", base, key, rows[i:i + UPSERT_CHUNK], prefer="resolution=merge-duplicates,return=minimal")
    print(f"올림: {len(rows)}건", flush=True)
    if not rows:
        print("올린 행이 없어 지우기는 건너뜁니다.", flush=True)
        return
    q = urllib.parse.urlencode({
        "select": "id", "username": f"eq.{username}",
        "and": f"(day.gte.{since.isoformat()},day.lte.{until.isoformat()})",
    })
    existing = {r["id"] for r in request("GET", f"{base}?{q}", key)}
    stale = sorted(existing - {r["id"] for r in rows})
    for i in range(0, len(stale), DELETE_CHUNK):
        ids = ",".join('"' + s.replace('"', '\\"') + '"' for s in stale[i:i + DELETE_CHUNK])
        dq = urllib.parse.urlencode({"username": f"eq.{username}", "id": f"in.({ids})"})
        request("DELETE", f"{base}?{dq}", key, prefer="return=minimal")
    print(f"지움: {len(stale)}건", flush=True)


def main():
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8")
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--vault", default=os.environ.get("WIKI_VAULT") or os.path.expanduser("~/Wiki"))
    ap.add_argument("--days", type=int, default=21)
    ap.add_argument("--dry-run", action="store_true", help="읽은 행만 출력하고 올리지 않는다 (네트워크 없음)")
    ap.add_argument("--items-file", default=None, help="프로젝트 목록 표 (기본: <vault>/70_작업일지/프로젝트.md)")
    ap.add_argument("--username", default=os.environ.get("TL_USERNAME") or DEFAULT_USERNAME)
    a = ap.parse_args()

    items_file = a.items_file or os.path.join(a.vault, "70_작업일지", "프로젝트.md")
    items_mod = import_items(items_file)
    items = items_mod.load(items_file)
    rows, since, until, warns = collect(a.vault, a.days, items_mod, items, a.username)
    if a.dry_run:
        print_dry(rows, warns)
        return
    for w in warns:
        print("주의:", w, flush=True)
    upload(rows, since, until, a.username)


if __name__ == "__main__":
    main()
