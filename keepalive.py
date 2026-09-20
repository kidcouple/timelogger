"""Supabase 무료 플랜이 유휴로 멈추지 않도록 DB를 한 번 건드린다.

GCP/Cloud Run은 쓰지 않는다. Windows 작업 스케줄러와 로컬 Flask 스레드만 사용.
"""
import sys
import traceback

from dotenv import load_dotenv

load_dotenv(override=True)


def main():
    import db

    db.heartbeat()
    print("supabase heartbeat ok")
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception:
        traceback.print_exc()
        sys.exit(1)
