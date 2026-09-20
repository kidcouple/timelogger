import os
import json
import re
import time
import datetime
import smtplib
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
import threading
from flask import Flask, request, send_from_directory, jsonify
from google.cloud import storage
import openpyxl
import requests
from dotenv import load_dotenv

# Load environment variables from .env file if it exists
load_dotenv(override=True)
import db as local_db

app = Flask(__name__, static_folder=None)

# Configuration
BUCKET_NAME = os.environ.get("BUCKET_NAME", "time-logger-data-hwang")
DATA_FILES = ["timelogger_todo.csv", "timelogger_log.csv", "timelogger_clients.csv", "timelogger_projects.csv"]
ATTACHMENTS_DIR = "attachments"

import logging
logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

# SMTP Settings
SMTP_SERVER = os.environ.get("SMTP_SERVER", "smtp.gmail.com")
SMTP_PORT = int(os.environ.get("SMTP_PORT", "587"))
SMTP_USER = os.environ.get("SMTP_USER", "")
SMTP_PASS = os.environ.get("SMTP_PASS", "").replace('\xa0', '').replace(' ', '') 
REPORT_RECEIVER = os.environ.get("REPORT_RECEIVER", "hwang.sunkyun@gmail.com")
REPORT_SECRET = os.environ.get("REPORT_SECRET", "")

def get_storage_client():
    try: return storage.Client()
    except: return None

def download_from_gcs():
    client = get_storage_client()
    if not client: return
    try:
        bucket = client.bucket(BUCKET_NAME)
        blobs = list(client.list_blobs(BUCKET_NAME))
        for blob in blobs:
            if blob.name.endswith('.db'):
                continue
            if "/" in blob.name: os.makedirs(os.path.dirname(blob.name), exist_ok=True)
            blob.download_to_filename(blob.name)
    except: pass


KEEPALIVE_INTERVAL_SEC = int(os.environ.get("KEEPALIVE_INTERVAL_SEC", "600"))


def _keepalive_loop():
    while True:
        time.sleep(max(60, KEEPALIVE_INTERVAL_SEC))
        try:
            local_db.heartbeat()
            logger.info("db keepalive ok")
        except Exception as e:
            logger.warning("db keepalive failed: %s", e)


def start_keepalive_thread():
    t = threading.Thread(target=_keepalive_loop, name="db-keepalive", daemon=True)
    t.start()


def get_root_path(): return os.path.dirname(os.path.abspath(__file__))


start_keepalive_thread()

@app.route('/')
@app.route('/index.html')
def index(): return send_from_directory(get_root_path(), 'index.html')
@app.route('/timer.html')
def timer(): return send_from_directory(get_root_path(), 'timer.html')
@app.route('/clients.html')
def clients_page(): return send_from_directory(get_root_path(), 'clients.html')
@app.route('/projects.html')
def projects_page(): return send_from_directory(get_root_path(), 'projects.html')


@app.route("/api/public-config")
def api_public_config():
    return jsonify({"db": "supabase"})


@app.route("/api/health")
@app.route("/api/keepalive")
def api_keepalive():
    try:
        local_db.heartbeat()
        return jsonify({"status": "ok", "db": "supabase"})
    except Exception as e:
        logger.warning("keepalive failed: %s", e)
        return jsonify({"status": "error", "error": str(e)}), 503


def _request_username():
    return (
        (request.headers.get("X-User-Name") or request.args.get("username") or "").strip()
        or "황선균"
    )


@app.route("/api/db/<table>", methods=["GET", "POST", "DELETE"])
def api_db(table):
    if table not in local_db.TABLES:
        return jsonify({"error": "unknown table"}), 404
    username = _request_username()
    try:
        if request.method == "GET":
            return jsonify(local_db.select(table, username=username))
        if request.method == "POST":
            payload = request.get_json(silent=True)
            if payload is None:
                return jsonify({"error": "JSON body required"}), 400
            local_db.upsert(table, payload, username=username)
            return ("", 204)
        filters = {k: v for k, v in request.args.items() if k.lower() != "username"}
        if not filters:
            return jsonify({"error": "delete filter required"}), 400
        local_db.delete(table, filters, username=username)
        return ("", 204)
    except Exception as e:
        logger.exception("api_db %s %s", request.method, table)
        return jsonify({"error": str(e)}), 500


def fetch_table(table, username):
    """Supabase 조회. 주간보고 등 서버 로직용."""
    try:
        return local_db.select(table, username=username)
    except Exception as e:
        logger.warning("fetch_table %s error: %s", table, e)
        return []


def parse_task_date(s):
    """Flatpickr 'Y. m. d', ISO date, Supabase 등 여러 문자열을 date로 변환."""
    if s is None:
        return None
    s = str(s).strip()
    if not s:
        return None
    if "T" in s:
        s = s.split("T", 1)[0].strip()
    s = re.sub(r"[\.\s]+$", "", s)
    fmts_date = ("%Y. %m. %d", "%Y.%m.%d", "%Y-%m-%d", "%Y/%m/%d")
    for fmt in fmts_date:
        for chunk in (s, s[:10]):
            try:
                return datetime.datetime.strptime(chunk, fmt).date()
            except ValueError:
                continue
    for fmt in ("%Y-%m-%d %H:%M:%S", "%Y-%m-%d %H:%M:%S.%f"):
        for chunk in (s, s[:19], s[:26]):
            try:
                return datetime.datetime.strptime(chunk, fmt).date()
            except ValueError:
                continue
    m = re.match(r"^(\d{4})\s*\.\s*(\d{1,2})\s*\.\s*(\d{1,2})\s*$", s)
    if m:
        try:
            return datetime.date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
        except ValueError:
            return None
    return None


def format_task_date(d):
    if not d:
        return ""
    return d.strftime("%Y. %m. %d")


def interval_overlaps_week(ps_date, pe_date, w_start, w_end):
    """계획 구간 [ps,pe]가 주간 [w_start,w_end]와 겹치면 True (한쪽만 있어도 처리)."""
    if ps_date is None and pe_date is None:
        return False
    if ps_date is None:
        return w_start <= pe_date <= w_end
    if pe_date is None:
        return w_start <= ps_date <= w_end
    return ps_date <= w_end and pe_date >= w_start


import glob

@app.route('/api/csv-backups')
def list_csv_backups():
    try:
        home = os.path.expanduser('~')
        directory = os.path.join(home, 'Downloads')
        # 패턴: timelogger_backup_*.csv
        pattern = os.path.join(directory, 'timelogger_backup_*.csv')
        files = glob.glob(pattern)
        
        file_list = []
        for f in files:
            stats = os.stat(f)
            basename = os.path.basename(f)
            file_list.append({
                "name": basename,
                "mtime": stats.st_mtime,
                "path": f,
                "size": stats.st_size
            })
        # 수정시간 역순(최신순) 정렬
        file_list.sort(key=lambda x: x['mtime'], reverse=True)
        return jsonify(file_list)
    except Exception as e:
        return jsonify({"error": str(e)}), 500

@app.route('/api/csv-backups/read')
def read_csv_backup():
    path = request.args.get('path')
    if not path:
        return jsonify({"error": "Path is required"}), 400
    try:
        home = os.path.expanduser('~')
        downloads = os.path.join(home, 'Downloads')
        # 보안 체크: Downloads 폴더 하위인지
        if not os.path.realpath(path).startswith(os.path.realpath(downloads)):
            return jsonify({"error": "Invalid path"}), 403
        if not path.endswith('.csv'):
            return jsonify({"error": "Not a CSV file"}), 400
            
        with open(path, 'r', encoding='utf-8-sig') as f:
            content = f.read()
        return jsonify({"content": content})
    except Exception as e:
        return jsonify({"error": str(e)}), 500
@app.route('/api/weekly-report/download')
def download_weekly_report():
    file_path = request.args.get('path')
    if not file_path:
        return jsonify({"error": "Path required"}), 400
        
    # 만약 상대경로(파일명만)가 넘어왔을 때 ~/Downloads 를 자동 보강하는 안전장치
    if not file_path.startswith('/') and not file_path.startswith('\\'):
        home = os.path.expanduser('~')
        file_path = os.path.join(home, 'Downloads', file_path)
        
    if not os.path.exists(file_path):
        return jsonify({"error": "File not found", "tried_path": file_path}), 404
        
    # Security check: only allow excel files with report name
    if '주간업무보고' not in os.path.basename(file_path):
        return jsonify({"error": "Access denied"}), 403
        
    from flask import send_file
    return send_file(file_path, as_attachment=True)

@app.route('/api/weekly-report', methods=['GET', 'POST'])
def generate_weekly_report():
    secret = request.args.get("secret") or request.headers.get("X-Report-Secret")
    user = request.args.get("user", "황선균") # Default for legacy
    if REPORT_SECRET and secret != REPORT_SECRET:
        return jsonify({"error": "Unauthorized"}), 401

    try:
        # Date Setup
        today = datetime.date.today()
        # 금요일 시작 - 목요일 종료 사이클. '방금 끝난 주'를 금주 실적으로 본다.
        # 종료일 = 가장 최근의 목요일(오늘이 목이면 오늘), 시작일 = 종료일-6 (직전 금요일)
        back_to_thu = (today.weekday() - 3) % 7  # 목요일(weekday=3)까지 거슬러 갈 일수
        end_date = today - datetime.timedelta(days=back_to_thu)  # Thursday
        start_date = end_date - datetime.timedelta(days=6)       # Friday
        
        next_start_date = start_date + datetime.timedelta(days=7)
        next_end_date = end_date + datetime.timedelta(days=7)
        
        week_label = f'{end_date.month}월 {((end_date.day-1)//7)+1}주차'
        action = request.args.get('action', 'all') # all, open, send
        home = os.path.expanduser('~')
        output_file = os.path.join(home, 'Downloads', f'CO팀 {week_label} 주간업무보고_{user}.xlsx')

        if action == 'send':
            # 이전에 로컬에서 수정 및 저장한 원본 파일이 존재하는지 검증
            if not os.path.exists(output_file):
                return jsonify({'error': f'수정된 엑셀 파일({output_file})을 찾을 수 없습니다. 먼저 파일을 생성 및 저장하세요.'}), 400
        else:
            # 1. Fetch Data (Filtered by user)
            tasks = fetch_table('tasks', user)
            task_map = {t['id']: t for t in tasks if isinstance(t, dict) and t.get('id')}

            logs = fetch_table('logs', user)
            
            cur_week_results = []
            next_week_plans = []
            issue_tasks = []
            
            seen_next = set()
            for t in tasks:
                if t.get('client') == '에이치에스케이': continue

                astart_str = t.get('astart') or t.get('aStart')
                aend_str = t.get('aend') or t.get('aEnd')
                pstart_str = t.get('pstart') or t.get('pStart')
                pend_str = t.get('pend') or t.get('pEnd')

                as_date = parse_task_date(astart_str)
                ae_date = parse_task_date(aend_str)
                ps_date = parse_task_date(pstart_str)
                pe_date = parse_task_date(pend_str)

                clabel = (str(t.get('client') or '').strip() or '미지정')

                status_val = t.get('status') or ''
                is_not_done = status_val != 'done'
                p_name = str(t.get('project') or '').strip()
                is_open_project = bool(p_name and p_name not in ['"', '""']) and is_not_done

                # 금주 실적: '타이머로 실제 작업한 것'을 기준으로 한다.
                #   - actualtime(실제 소요시간)이 있고, 실착수일(aStart)이 금주(전주 금~금주 목)에 든 경우.
                #   - aStart가 비어 있으면 aEnd/pStart로 보완 판정.
                #   - 진행 중(미완료) 프로젝트는 날짜와 무관하게 항상 포함한다.
                try:
                    actual_time = float(t.get('actualtime') or t.get('actualTime') or 0)
                except (TypeError, ValueError):
                    actual_time = 0
                work_date = as_date or ae_date or ps_date
                worked_this_week = (
                    actual_time > 0 and work_date is not None
                    and start_date <= work_date <= end_date
                )
                in_cur = is_open_project or worked_this_week

                if in_cur:
                    item = {
                        'client': clabel,
                        'project': t.get('project'),
                        'title': t.get('title') or '제목 없음',
                        'astart': astart_str or pstart_str or '',
                        'isissue': t.get('isissue') or t.get('isIssue') or False,
                        'issuememo': t.get('issuememo') or t.get('issueMemo'),
                        'issueprogress': t.get('issueprogress') or t.get('issueProgress'),
                        'issuefollowup': t.get('issuefollowup') or t.get('issueFollowUp')
                    }
                    cur_week_results.append(item)
                    if item.get('isissue'): issue_tasks.append(item)

                # 차주: 미완료이면서 (계획기간이 차주와 겹치거나, 진행 중 프로젝트)인 경우.
                #       진행 중(미완료) 프로젝트는 날짜와 무관하게 차주 계획에도 항상 포함.
                if is_not_done and (
                    is_open_project
                    or interval_overlaps_week(ps_date, pe_date, next_start_date, next_end_date)
                ):
                    tid = str(t.get('id') or t.get('seq') or '')
                    if not tid:
                        tid = f"{t.get('client')}::{t.get('title')}"
                    if tid not in seen_next:
                        seen_next.add(tid)
                        next_week_plans.append(t)


            # 2. Category Mapper & Sorting
            def get_category_info(t):
                p_name = str(t.get('project') or '').strip()
                if p_name and p_name not in ['"', '""']:
                    return ('프로젝트', 2)
                return ('고객 운영', 1)

            def group_tasks_by_client(rows, is_cur_week=True):
                from collections import defaultdict
                import datetime
                grouped = defaultdict(list)
                for t in rows:
                    cat, _ = get_category_info(t)
                    client = t.get('client') or '기타'
                    grouped[(cat, client)].append(t)
                    
                out = []
                for (cat, client), items in grouped.items():
                    titles = [i.get('title', '제목 없음') + (' (이슈)' if i.get('isissue') or i.get('isIssue') else '') for i in items]
                    merged_title = '\n'.join(titles)
                    
                    dates = []
                    for i in items:
                        for k in ['astart', 'aend', 'pstart', 'pend', 'aStart', 'aEnd', 'pStart', 'pEnd']:
                            d = parse_task_date(i.get(k))
                            if d: dates.append(d)
                    
                    if is_cur_week:
                        base_date = min(dates) if dates else start_date
                        if base_date < start_date:
                            base_date = start_date
                        elif base_date > end_date:
                            base_date = end_date
                        date_display = format_task_date(base_date)
                    else:
                        base_date = min(dates) if dates else next_start_date
                        if cat == '프로젝트':
                            days_diff = (base_date.weekday() - next_start_date.weekday()) % 7
                            target_date = next_start_date + datetime.timedelta(days=days_diff)
                            date_display = format_task_date(target_date)
                        else:
                            if base_date < next_start_date:
                                base_date = next_start_date
                            date_display = format_task_date(base_date)
                            
                    out.append({
                        'client': client,
                        'title': merged_title,
                        'date_display': date_display,
                        'isissue': any(i.get('isissue') or i.get('isIssue') for i in items),
                        'project': items[0].get('project')
                    })
                return out

            cur_week_results = group_tasks_by_client(cur_week_results, is_cur_week=True)
            cur_week_results.sort(key=lambda x: (
                get_category_info(x)[1],
                x.get('client', ''),
            ))

            next_week_plans = group_tasks_by_client(next_week_plans, is_cur_week=False)
            next_week_plans.sort(key=lambda x: (
                get_category_info(x)[1],
                x.get('client', ''),
            ))

            def get_pstart_date(t):
                ps = parse_task_date(t.get('pstart') or t.get('pStart'))
                if ps:
                    return ps
                pe = parse_task_date(t.get('pend') or t.get('pEnd'))
                return pe if pe else datetime.date(9999, 1, 1)

            next_week_plans.sort(key=get_pstart_date)

            # 3. Template Selection
            template_path = None
            for f in os.listdir('.'):
                if f.endswith('.xlsx') and not f.startswith('~$'):
                    template_path = f
                    break
            
            if not template_path: 
                return jsonify({'error': 'Template not found', 'files': os.listdir('.')}), 500
            
            wb = openpyxl.load_workbook(template_path)
            ws1 = wb['■CO팀 주요 업무']
            
            # Writing Logic Helper
            from openpyxl.cell.cell import MergedCell

            def write_section_data(ws, header_text, results):
                # 템플릿의 각 카테고리 블록은 넉넉한 행 수(약 20행)를 미리 확보하고 있어
                # 동적 행 삽입 없이 기입한다. 블록 용량을 초과하는 만큼만 안전하게 잘리며,
                # 그런 경우 logger 경고로 누락을 알린다.
                sec_start = 5
                for r in range(1, 200):
                    if ws.cell(row=r, column=1).value and header_text in str(ws.cell(row=r, column=1).value):
                        sec_start = r + 2
                        break
                cat_list = ['고객 운영', '프로젝트', '조직관리', '기타사항']
                block_starts = {}
                for r in range(sec_start - 1, sec_start + 120):
                    val = str(ws.cell(row=r, column=1).value or '')
                    for cat in cat_list:
                        if cat in val:
                            block_starts[cat] = r
                            break
                    # '2. ' 만으로 끊으면 본문에 "12. 3" 같은 문자가 있을 때 오탐 가능 → 차주 섹션 제목으로만 종료
                    if header_text == '1. 금주' and ('2. 차주' in val or '2.차주' in val):
                        break

                data_map = {cat: [] for cat in cat_list}
                for t in results:
                    cat_name, _ = get_category_info(t)
                    if cat_name in data_map: data_map[cat_name].append(t)

                cat_list = ['고객 운영', '프로젝트', '조직관리', '기타사항']
                for i, cat in enumerate(cat_list):
                    if cat not in block_starts: continue
                    r_start = block_starts[cat]
                    r_end = r_start + 5
                    if i + 1 < len(cat_list) and cat_list[i+1] in block_starts:
                        r_end = block_starts[cat_list[i+1]]
                    else:
                        for r in range(r_start + 1, r_start + 120):
                            v = str(ws.cell(row=r, column=1).value or '')
                            if '2. ' in v or '특이사항' in v: r_end = r; break
                            r_end = r

                    def set_val(r, c, val):
                        cell = ws.cell(row=r, column=c)
                        if not isinstance(cell, MergedCell):
                            cell.value = val
                            if cell.alignment:
                                if c in (3, 4):  # 일자, 담당
                                    cell.alignment = cell.alignment.copy(wrapText=True, horizontal='center', vertical='center')
                                elif c == 5:     # 주요내용
                                    cell.alignment = cell.alignment.copy(wrapText=True, horizontal='left', vertical='center')
                                else:
                                    cell.alignment = cell.alignment.copy(wrapText=True, vertical='center')

                    r_idx = r_start
                    for t in data_map[cat]:
                        set_val(r_idx, 2, t.get('client'))
                        date_val = t.get('date_display') or t.get('astart') or t.get('pstart') or t.get('pStart')
                        set_val(r_idx, 3, date_val)
                        set_val(r_idx, 4, user)
                        title_str = t.get('title') or ''
                        set_val(r_idx, 5, title_str)
                        
                        # 줄 수에 비례하여 동적으로 행 높이(너비)를 지정 (기본 16)
                        lines = title_str.count('\n') + 1
                        ws.row_dimensions[r_idx].height = max(16, lines * 16)
                        
                        r_idx += 1
                        if r_idx >= r_end:
                            remaining = len(data_map[cat]) - (r_idx - r_start)
                            if remaining > 0:
                                logger.warning(
                                    "주간보고 블록 용량 초과: %s/%s '%s' 블록(%d행)에 %d건 누락. 템플릿 행을 늘리세요.",
                                    header_text, cat, r_end - r_start, len(data_map[cat]), remaining)
                            break
                    for r in range(r_idx, r_end):
                        for c in range(2, 6):
                            cell = ws.cell(row=r, column=c)
                            if not isinstance(cell, MergedCell):
                                cell.value = None

            write_section_data(ws1, '1. 금주', cur_week_results)
            write_section_data(ws1, '2. 차주', next_week_plans)

            # Write 이슈 및 특이사항
            ws2 = wb['■ 주요 이슈 및 특이사항']
            row_idx = 5
            for t in issue_tasks:
                cat_name, _ = get_category_info(t)
                
                def set_val2(r, c, val):
                    cell = ws2.cell(row=r, column=c)
                    if not isinstance(cell, MergedCell):
                        cell.value = val

                set_val2(row_idx, 1, cat_name)
                set_val2(row_idx, 2, t.get('client'))
                set_val2(row_idx, 3, t.get('issuememo') or t.get('title'))
                set_val2(row_idx, 4, user)
                set_val2(row_idx, 5, t.get('issueprogress') or '')
                set_val2(row_idx, 6, t.get('issuefollowup') or '')
                row_idx += 1

            os.makedirs(os.path.dirname(output_file), exist_ok=True)
            wb.save(output_file)

            # 3. Archive
            report_data = {
                'report_date': today.strftime('%Y. %m. %d'), 
                'week_label': week_label, 
                'username': user,
                'content_json': {'cur_count': len(cur_week_results), 'next_count': len(next_week_plans), 'issue_count': len(issue_tasks)}
            }
            local_db.upsert('weekly_reports', report_data, username=user)

            if action == 'open':
                try:
                    import subprocess, platform
                    if platform.system() == 'Windows':
                        os.startfile(output_file)
                    elif platform.system() == 'Darwin':
                        script = f'tell application "Microsoft Excel" to activate\ntell application "Microsoft Excel" to open POSIX file "{output_file}"'
                        res = subprocess.run(['osascript', '-e', script], capture_output=True, text=True)
                        if res.returncode != 0:
                            subprocess.run(['open', output_file])
                        subprocess.run(['open', '-R', output_file])
                    else:
                        subprocess.run(['xdg-open', output_file])
                        
                    return jsonify({'status': 'success', 'file': output_file, 'action': 'opened'})
                except Exception as e:
                    logger.warning(f"Failed to open excel: {str(e)}")
                    return jsonify({'status': 'success', 'file': output_file, 'action': 'opened', 'warning': f'Failed to open locally: {str(e)}'})


        if action == 'open':
            return jsonify({'status': 'success', 'file': output_file, 'action': 'opened'})

        # 4. Email
        logger.info(f"===> Email Logic Reached for user={user}, action={action}")
        if action in ['all', 'send'] and SMTP_USER and SMTP_PASS:
            msg = MIMEMultipart(); msg['From'] = SMTP_USER; msg['To'] = REPORT_RECEIVER
            msg['Subject'] = f"[자동발송] {week_label} 주간보고서 - {user}"
            msg.attach(MIMEText(f"{week_label} 보고서입니다.", 'plain'))
            
            try:
                with open(output_file, "rb") as f:
                    part = MIMEBase("application", "vnd.openxmlformats-officedocument.spreadsheetml.sheet")
                    part.set_payload(f.read())
                encoders.encode_base64(part)
                # Proper encoding for filenames with non-ASCII characters
                from email.header import Header
                part.add_header("Content-Disposition", "attachment", filename=Header(output_file, "utf-8").encode())
                msg.attach(part)
                
                logger.info(f"Attempting to send email to {REPORT_RECEIVER} via {SMTP_SERVER}:{SMTP_PORT}")
                with smtplib.SMTP(SMTP_SERVER, SMTP_PORT, timeout=20) as server:
                    server.starttls()
                    server.login(SMTP_USER, SMTP_PASS)
                    server.send_message(msg)
                email_status = "sent"
            except Exception as mail_err:
                logger.error(f"Email sending failed: {mail_err}")
                email_status = f"failed: {str(mail_err)}"
        else: email_status = "skipped"

        return jsonify({"status": "success", "file": output_file, "counts": report_data["content_json"], "email": email_status})
    except Exception as e: 
        logger.error(f"Report generation error: {e}")
        return jsonify({"error": str(e)}), 500


# Global cache for Notion DB schema to avoid redundant API calls
NOTION_SCHEMA_CACHE = {}

@app.route('/api/notion/create', methods=['POST'])
def create_notion_page():
    data = request.json or {}
    title = data.get('title', '제목 없는 업무')
    client = data.get('client') or '미지정 고객사'
    reqDate = data.get('reqDate') or ''
    reqDetail = data.get('reqDetail') or ''
    procDetail = data.get('procDetail') or ''
    
    page_title = title
    
    notion_key = os.environ.get("NOTION_API_KEY", "").strip()
    notion_db = os.environ.get("NOTION_DB_ID", "").strip()

    # Fallback to older format if needed, but NOTION_DB_ID is prioritized now
    if not notion_db:
         notion_db = os.environ.get("NOTION_TODO_DB_ID", "").strip()

    if notion_key and not (notion_key.startswith("secret_") or notion_key.startswith("ntn_")):
         notion_key = "ntn_" + notion_key
         
    if not notion_key or not notion_db:
         return jsonify({"status": "error", "message": "서버에 Notion API Key 또는 DB ID가 설정되지 않았습니다."}), 400
         
    notion_db = notion_db.replace('-', '')
    
    headers = {
        "Authorization": "Bearer " + notion_key,
        "Content-Type": "application/json",
        "Notion-Version": "2026-03-11"
    }

    task_payload = {
        "parent": {"database_id": notion_db},
        "properties": {
            "제목": {"title": [{"text": {"content": page_title}}]},
            "고객사": {"rich_text": [{"text": {"content": client}}]},
            "요청일자": {"rich_text": [{"text": {"content": reqDate}}]}
        },
        "children": [
            {
                "object": "block",
                "type": "heading_3",
                "heading_3": { "rich_text": [{ "type": "text", "text": { "content": "📝 요청 내역" } }] }
            },
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": { "rich_text": [{ "type": "text", "text": { "content": reqDetail or "(내용 없음)" } }] }
            },
            {
                "object": "block",
                "type": "heading_3",
                "heading_3": { "rich_text": [{ "type": "text", "text": { "content": "✅ 업무 일지 (처리 내역)" } }] }
            },
            {
                "object": "block",
                "type": "paragraph",
                "paragraph": { "rich_text": [{ "type": "text", "text": { "content": procDetail or "(내용 없음)" } }] }
            }
        ]
    }

    resp = requests.post("https://api.notion.com/v1/pages", headers=headers, json=task_payload)
        
    if resp.status_code == 200:
        return jsonify({"status": "success", "url": resp.json().get("url")})
    else:
        error_msg = "Notion 페이지 생성 실패"
        if resp.status_code == 400: error_msg = "잘못된 요청: 하위 페이지 데이터 구조가 틀렸습니다."
        return jsonify({"status": "error", "message": f"{error_msg}\n상세: {resp.text}"}), resp.status_code

def extract_notion_page_id(url):
    if not url: return None
    import re
    match = re.search(r'([a-f0-9]{32})', url.replace('-', ''))
    if match: return match.group(1)
    return None

@app.route('/api/notion/delete', methods=['POST'])
def delete_notion_page():
    data = request.json or {}
    url = data.get('url')
    if not url: return jsonify({"status": "error", "message": "주소가 없습니다"}), 400
    
    page_id = extract_notion_page_id(url)
    if not page_id: return jsonify({"status": "error", "message": "ID 추출 실패"}), 400
    
    notion_key = os.environ.get("NOTION_API_KEY", "").strip()
    if notion_key and not (notion_key.startswith("secret_") or notion_key.startswith("ntn_")):
         notion_key = "ntn_" + notion_key
    if not notion_key: return jsonify({"status": "error", "message": "API Key 누락"}), 400
         
    headers = { "Authorization": f"Bearer {notion_key}", "Notion-Version": "2026-03-11", "Content-Type": "application/json" }
    
    try:
        resp = requests.patch(f"https://api.notion.com/v1/pages/{page_id}", headers=headers, json={"archived": True})
        if resp.status_code == 200:
             return jsonify({"status": "success"})
        return jsonify({"status": "error", "message": resp.text}), resp.status_code
    except Exception as e:
         return jsonify({"status": "error", "message": str(e)}), 500

@app.errorhandler(Exception)
def handle_exception(e):
    return jsonify({"status": "error", "message": f"서버 내부 에러(Python): {str(e)}"}), 500

@app.route('/<path:filename>')
def serve_static(filename):
    try: return send_from_directory(get_root_path(), filename)
    except: return jsonify({"error": "File not found"}), 404

if __name__ == '__main__':
    app.run(host='0.0.0.0', port=int(os.environ.get('PORT', 8080)))
