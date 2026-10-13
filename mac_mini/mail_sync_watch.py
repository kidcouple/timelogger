#!/usr/bin/env python3
"""mail_sync_requests 를 보다가 mail_hourly.sh 로 새 메일을 가져온 뒤 목록을 올린다.

맥미니에서 한 번 켜 둔다. 키는 환경변수, 메일 폴더 .env,
또는 supabase_bridge.py 와 같은 키체인(wiki-supabase)에서 읽는다.

  cd /Users/sunkyunhwang/Masking/wiki-tools/mail
  python3 /path/to/Time\\ logger/mac_mini/mail_sync_watch.py
"""
import json
import os
import subprocess
import sys
import time
import urllib.error
import urllib.request

MAIL_DIR = os.environ.get("MAIL_BRIDGE_DIR", "/Users/sunkyunhwang/Masking/wiki-tools/mail")
KEYCHAIN_SERVICE = "wiki-supabase"
SUPABASE_JSON = os.path.expanduser("~/Wiki-Import/mail/supabase.json")
POLL_SEC = 3


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
    load_env_file(os.path.join(MAIL_DIR, ".env"))
    url = (os.environ.get("SUPABASE_URL") or "").strip().rstrip("/")
    key = (os.environ.get("SUPABASE_SERVICE_ROLE_KEY") or os.environ.get("SUPABASE_KEY") or "").strip()
    if not url or not key:
        bridge_url, bridge_key = bridge_config()
        url = url or bridge_url
        key = key or bridge_key
    if not url or not key:
        sys.exit(
            "SUPABASE_URL 과 SUPABASE_SERVICE_ROLE_KEY 가 필요합니다. "
            "메일 폴더 .env 또는 키체인 서비스 wiki-supabase 를 확인하세요."
        )
    return url, key


def request(method, url, key, body=None):
    data = None if body is None else json.dumps(body).encode("utf-8")
    req = urllib.request.Request(url, data=data, method=method)
    req.add_header("apikey", key)
    req.add_header("Authorization", f"Bearer {key}")
    req.add_header("Accept", "application/json")
    req.add_header("Content-Type", "application/json")
    req.add_header("Prefer", "return=representation")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            raw = resp.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        detail = e.read().decode("utf-8", "replace")[:300]
        raise RuntimeError(f"HTTP {e.code} {detail}") from e
    return json.loads(raw) if raw else []


def claim(url, key):
    pending = request(
        "GET",
        f"{url}/rest/v1/mail_sync_requests?status=eq.pending&select=id&order=requested_at.asc&limit=1",
        key,
    )
    if not pending:
        return None
    row_id = pending[0]["id"]
    claimed = request(
        "PATCH",
        f"{url}/rest/v1/mail_sync_requests?id=eq.{row_id}&status=eq.pending",
        key,
        {"status": "running"},
    )
    return row_id if claimed else None


def finish(url, key, row_id, status, message):
    body = {"status": status, "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())}
    if message:
        body["message"] = message[:500]
    request("PATCH", f"{url}/rest/v1/mail_sync_requests?id=eq.{row_id}", key, body)


def run_sync():
    # 새로고침은 이미 올려 둔 목록이 아니라, 메일함의 새 메일부터 다시 가져온다.
    script = os.path.join(MAIL_DIR, "mail_hourly.sh")
    if not os.path.isfile(script):
        raise RuntimeError(f"mail_hourly.sh 가 없습니다: {script}")
    proc = subprocess.run(
        ["/bin/zsh", script],
        cwd=MAIL_DIR,
        capture_output=True,
        text=True,
        timeout=900,
    )
    lines = [ln.strip() for ln in (proc.stdout or "").splitlines() if ln.strip()]
    picked = [ln for ln in lines if ln.startswith("새 메일") or ln.startswith("A. 회신") or ln.startswith("Supabase:")]
    summary = "\n".join(picked or lines[-3:])
    if proc.returncode != 0:
        err = (proc.stderr or "").strip().splitlines()
        raise RuntimeError(summary or (err[-1] if err else f"sync 종료 코드 {proc.returncode}"))
    if summary:
        print(summary, flush=True)
    return summary


def main():
    url, key = creds()
    print(f"mail sync watch: {MAIL_DIR}", flush=True)
    while True:
        try:
            row_id = claim(url, key)
            if not row_id:
                time.sleep(POLL_SEC)
                continue
            try:
                summary = run_sync()
            except Exception as e:
                finish(url, key, row_id, "error", str(e))
                print(f"sync failed: {e}", flush=True)
            else:
                finish(url, key, row_id, "done", summary or "")
                print(f"sync done: {row_id}", flush=True)
        except Exception as e:
            print(f"watch error: {e}", flush=True)
            time.sleep(POLL_SEC)


if __name__ == "__main__":
    main()
