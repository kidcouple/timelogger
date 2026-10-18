"""Time Logger 배포 스크립트

    python deploy.py cloudrun             Cloud Run 빌드 + 배포
    python deploy.py cloudrun --no-bump   서비스워커 캐시 버전을 올리지 않음
    python deploy.py pages                현재 브랜치를 origin/main 으로 push (GitHub Pages)

환경변수 GCP_PROJECT, SERVICE, REGION 으로 기본값을 덮어쓸 수 있다.
"""
import argparse
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
GCP_PROJECT = os.environ.get("GCP_PROJECT", "openclaw-server-hwang-2026")
SERVICE = os.environ.get("SERVICE", "time-logger")
REGION = os.environ.get("REGION", "asia-northeast3")
SW_FILE = ROOT / "service-worker.js"


def run(cmd, capture=False):
    print("$", " ".join(cmd))
    res = subprocess.run(cmd, cwd=ROOT, text=True, encoding="utf-8",
                         capture_output=capture)
    if res.returncode != 0:
        sys.exit(res.returncode)
    return res.stdout.strip() if capture else ""


def bump_cache():
    """정적 파일 변경이 브라우저에 반영되도록 service-worker 캐시 버전 +1."""
    text = SW_FILE.read_text(encoding="utf-8")
    m = re.search(r"time-logger-v(\d+)", text)
    if not m:
        sys.exit("service-worker.js 에서 캐시 버전을 찾지 못했습니다.")
    cur, nxt = int(m.group(1)), int(m.group(1)) + 1
    SW_FILE.write_text(text.replace(f"time-logger-v{cur}", f"time-logger-v{nxt}", 1),
                       encoding="utf-8", newline="")
    print(f"▶ 캐시 버전: v{cur} → v{nxt}")


def deploy_cloudrun(bump):
    gcloud = shutil.which("gcloud")
    if not gcloud:
        sys.exit("gcloud 를 찾을 수 없습니다. Google Cloud SDK 를 설치/PATH 등록하세요.")
    if bump:
        bump_cache()
    print(f"▶ Cloud Run 배포: {SERVICE} ({GCP_PROJECT}, {REGION})")
    # 기존 서비스의 환경변수/시크릿은 재배포 시 유지된다
    run([gcloud, "run", "deploy", SERVICE, "--source", ".",
         "--project", GCP_PROJECT, "--region", REGION,
         "--allow-unauthenticated", "--quiet"])
    url = run([gcloud, "run", "services", "describe", SERVICE,
               "--project", GCP_PROJECT, "--region", REGION,
               "--format=value(status.url)"], capture=True)
    print("▶ URL:", url)


def deploy_pages():
    branch = run(["git", "rev-parse", "--abbrev-ref", "HEAD"], capture=True)
    dirty = run(["git", "status", "--porcelain", "--untracked-files=no"], capture=True)
    if dirty:
        sys.exit("커밋되지 않은 변경이 있습니다. 먼저 커밋하세요:\n" + dirty)
    print(f"▶ GitHub push: {branch} → origin/main")
    run(["git", "push", "origin", f"{branch}:main"])


def main():
    ap = argparse.ArgumentParser(description="Time Logger 배포")
    ap.add_argument("target", choices=["cloudrun", "pages"])
    ap.add_argument("--no-bump", action="store_true",
                    help="서비스워커 캐시 버전을 올리지 않음")
    args = ap.parse_args()
    if args.target == "cloudrun":
        deploy_cloudrun(not args.no_bump)
    else:
        deploy_pages()
    print("✔ 완료")


if __name__ == "__main__":
    main()
