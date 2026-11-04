// 서버(app.py /api/weekly-report)가 없는 GitHub Pages 환경용: 브라우저에서 템플릿을 채워 엑셀을 내려받는다.
// 집계/배치 로직은 app.py generate_weekly_report 와 동일하게 유지할 것.
(function () {
    const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    const TEMPLATE_URL = 'report_template.xlsx';
    const CAT_LIST = ['고객 운영', '프로젝트', '조직관리', '기타사항'];

    let excelJsPromise = null;
    function loadExcelJS() {
        if (window.ExcelJS) return Promise.resolve(window.ExcelJS);
        if (!excelJsPromise) {
            excelJsPromise = new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = EXCELJS_URL;
                s.onload = () => resolve(window.ExcelJS);
                s.onerror = () => { excelJsPromise = null; reject(new Error('ExcelJS 라이브러리를 불러오지 못했습니다.')); };
                document.head.appendChild(s);
            });
        }
        return excelJsPromise;
    }

    function parseTaskDate(s) {
        if (s === null || s === undefined) return null;
        s = String(s).trim();
        if (!s) return null;
        if (s.includes('T')) s = s.split('T', 1)[0].trim();
        s = s.replace(/[.\s]+$/, '');
        const m = /^(\d{4})\s*[-./]\s*(\d{1,2})\s*[-./]\s*(\d{1,2})/.exec(s);
        if (!m) return null;
        const d = new Date(+m[1], +m[2] - 1, +m[3]);
        return isNaN(d.getTime()) ? null : d;
    }

    const pad = n => String(n).padStart(2, '0');
    const formatTaskDate = d => d ? `${d.getFullYear()}. ${pad(d.getMonth() + 1)}. ${pad(d.getDate())}` : '';
    const addDays = (d, n) => { const r = new Date(d); r.setDate(r.getDate() + n); return r; };
    const pyWeekday = d => (d.getDay() + 6) % 7; // Mon=0 … Sun=6

    function intervalOverlapsWeek(ps, pe, w0, w1) {
        if (!ps && !pe) return false;
        if (!ps) return w0 <= pe && pe <= w1;
        if (!pe) return w0 <= ps && ps <= w1;
        return ps <= w1 && pe >= w0;
    }

    function categoryOf(t) {
        const p = String(t.project ?? '').trim();
        return (p && p !== '"' && p !== '""') ? ['프로젝트', 2] : ['고객 운영', 1];
    }

    // 할일 하나가 (금주 실적, 차주 일정)에 들어가는가. 타이머 없이 완료일 기준 (11-04).
    // ※ app.py report_flags 와 같은 로직으로 유지할 것. index.html 미리보기도 window.TL_reportFlags 를 쓴다.
    function reportFlags(t, wStart, wEnd, nStart, nEnd, loggedIds) {
        const inrep = t.inreport ?? t.inReport;
        const inrepS = String(inrep ?? '').trim().toLowerCase();
        if (inrep === false || ['false', 'f', '0'].includes(inrepS)) return [false, false];
        const explicit = inrep === true || ['true', 't', '1'].includes(inrepS);

        const asD = parseTaskDate(t.aStart ?? t.astart), aeD = parseTaskDate(t.aEnd ?? t.aend);
        const psD = parseTaskDate(t.pStart ?? t.pstart), peD = parseTaskDate(t.pEnd ?? t.pend);
        const reqD = parseTaskDate(t.reqDate ?? t.reqdate);

        const isNotDone = (t.status || '') !== 'done';
        const isOpenProject = categoryOf(t)[0] === '프로젝트' && isNotDone;
        const carried = explicit && isNotDone;

        const actualTime = parseFloat(t.actualTime ?? t.actualtime ?? 0) || 0;
        const workDate = asD || aeD || psD;
        const timerWeek = (actualTime > 0 && workDate && wStart <= workDate && workDate <= wEnd) || (loggedIds && loggedIds.has(String(t.id)));
        const doneInWeek = !!(aeD && wStart <= aeD && aeD <= wEnd);
        const since = asD || reqD;
        const carriedCur = carried && (!since || since <= wEnd);

        const inCur = !!(isOpenProject || timerWeek || doneInWeek || carriedCur);
        const inNext = !!((isNotDone && (isOpenProject || carried || intervalOverlapsWeek(psD, peD, nStart, nEnd)))
            || (aeD && nStart <= aeD && aeD <= nEnd));
        return [inCur, inNext];
    }
    window.TL_reportFlags = reportFlags;

    // 주간보고에서 뺄 고객사. 서버판은 report_config.js(window.TL_REPORT_EXCLUDE), 공개 사이트(GitHub Pages)는 이 브라우저의
    // localStorage 'TL_REPORT_EXCLUDE'(JSON 배열)에서 읽는다. 고객사 이름을 공개 저장소에 올리지 않기 위함 (11-04).
    function excludedClients() {
        let list = window.TL_REPORT_EXCLUDE;
        if (!Array.isArray(list)) {
            try { list = JSON.parse(localStorage.getItem('TL_REPORT_EXCLUDE') || '[]'); } catch (e) { list = []; }
        }
        return new Set((Array.isArray(list) ? list : []).map(x => String(x).trim()).filter(Boolean));
    }
    window.TL_excludedClients = excludedClients;

    function buildReportData(tasks, logs) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const endDate = addDays(today, -((pyWeekday(today) - 3 + 7) % 7)); // 목요일
        const startDate = addDays(endDate, -6);                             // 금요일
        const nextStartDate = addDays(startDate, 7);
        const nextEndDate = addDays(endDate, 7);
        const weekLabel = `${endDate.getMonth() + 1}월 ${Math.floor((endDate.getDate() - 1) / 7) + 1}주차`;

        const cur = [], next = [], issues = [];
        // 자동 제안 1차: 그 주에 확인된 기록(logs)이 있는 할일도 금주 실적 (옛 규칙)
        const loggedIds = (typeof TL_Suggest !== 'undefined' && logs) ? TL_Suggest.taskIdsWithLogs(logs, startDate, endDate) : new Set();
        const seenNext = new Set();
        const excluded = excludedClients();
        let missingClient = 0;

        for (const t of tasks || []) {
            if (excluded.has(String(t.client || '').trim())) continue;
            const aStart = t.aStart ?? t.astart;
            const pStart = t.pStart ?? t.pstart;

            const [inCur, inNext] = reportFlags(t, startDate, endDate, nextStartDate, nextEndDate, loggedIds);

            if (inCur) {
                const item = {
                    client: String(t.client || '').trim() || '미지정',
                    project: t.project,
                    title: t.title || '제목 없음',
                    aStart: aStart || pStart || '',
                    isIssue: !!(t.isIssue ?? t.isissue),
                    issueMemo: t.issueMemo ?? t.issuememo,
                    issueProgress: t.issueProgress ?? t.issueprogress,
                    issueFollowUp: t.issueFollowUp ?? t.issuefollowup
                };
                if (item.client === '미지정') missingClient++;
                cur.push(item);
                if (item.isIssue) issues.push(item);
            }

            if (inNext) {
                const tid = String(t.id || t.seq || '') || `${t.client}::${t.title}`;
                if (!seenNext.has(tid)) {
                    seenNext.add(tid);
                    next.push(t);
                }
            }
        }

        const groupByClient = (rows, isCur) => {
            const order = [];
            const groups = new Map();
            for (const t of rows) {
                const key = `${categoryOf(t)[0]}\u0000${t.client || '기타'}`;
                if (!groups.has(key)) { groups.set(key, []); order.push(key); }
                groups.get(key).push(t);
            }
            return order.map(key => {
                const items = groups.get(key);
                const [cat, client] = key.split('\u0000');
                const dates = [];
                for (const i of items) {
                    for (const k of ['aStart', 'aEnd', 'pStart', 'pEnd', 'astart', 'aend', 'pstart', 'pend']) {
                        const d = parseTaskDate(i[k]);
                        if (d) dates.push(d);
                    }
                }
                const minD = dates.length ? new Date(Math.min(...dates)) : null;
                let dateDisplay;
                if (isCur) {
                    let base = minD || startDate;
                    if (base < startDate) base = startDate;
                    else if (base > endDate) base = endDate;
                    dateDisplay = formatTaskDate(base);
                } else {
                    let base = minD || nextStartDate;
                    if (cat === '프로젝트') {
                        const diff = (pyWeekday(base) - pyWeekday(nextStartDate) + 7) % 7;
                        dateDisplay = formatTaskDate(addDays(nextStartDate, diff));
                    } else {
                        if (base < nextStartDate) base = nextStartDate;
                        dateDisplay = formatTaskDate(base);
                    }
                }
                return {
                    client,
                    title: items.map(i => (i.title || '제목 없음') + ((i.isIssue ?? i.isissue) ? ' (이슈)' : '')).join('\n'),
                    dateDisplay,
                    project: items[0].project
                };
            });
        };

        const byCatClient = (a, b) => {
            const d = categoryOf(a)[1] - categoryOf(b)[1];
            if (d) return d;
            return a.client < b.client ? -1 : a.client > b.client ? 1 : 0;
        };

        return {
            weekLabel,
            cur: groupByClient(cur, true).sort(byCatClient),
            next: groupByClient(next, false).sort(byCatClient),
            issues,
            missingClient
        };
    }

    // 병합 셀의 종속 셀에는 쓰지 않는다 (openpyxl MergedCell 건너뛰기와 동일).
    const isMergedSlave = cell => cell.isMerged && cell.master && cell.master.address !== cell.address;
    // ExcelJS는 병합 종속 셀에서도 대표 셀 값을 돌려주므로, openpyxl처럼 빈 값으로 취급한다.
    const cellText = (ws, r, c) => {
        const cell = ws.getCell(r, c);
        if (isMergedSlave(cell)) return '';
        const v = cell.value;
        if (v === null || v === undefined) return '';
        if (typeof v === 'object' && Array.isArray(v.richText)) return v.richText.map(x => x.text).join('');
        return String(v);
    };

    function writeSection(ws, headerText, results, user) {
        let secStart = 5;
        for (let r = 1; r < 200; r++) {
            if (cellText(ws, r, 1).includes(headerText)) { secStart = r + 2; break; }
        }
        const blockStarts = {};
        for (let r = secStart - 1; r < secStart + 120; r++) {
            const val = cellText(ws, r, 1);
            const cat = CAT_LIST.find(c => val.includes(c));
            if (cat) blockStarts[cat] = r;
            if (headerText === '1. 금주' && (val.includes('2. 차주') || val.includes('2.차주'))) break;
        }

        const dataMap = Object.fromEntries(CAT_LIST.map(c => [c, []]));
        for (const t of results) dataMap[categoryOf(t)[0]].push(t);

        CAT_LIST.forEach((cat, i) => {
            if (!(cat in blockStarts)) return;
            const rStart = blockStarts[cat];
            let rEnd = rStart + 5;
            if (i + 1 < CAT_LIST.length && CAT_LIST[i + 1] in blockStarts) {
                rEnd = blockStarts[CAT_LIST[i + 1]];
            } else {
                for (let r = rStart + 1; r < rStart + 120; r++) {
                    const v = cellText(ws, r, 1);
                    rEnd = r;
                    if (v.includes('2. ') || v.includes('특이사항')) break;
                }
            }

            const setVal = (r, c, val) => {
                const cell = ws.getCell(r, c);
                if (isMergedSlave(cell)) return;
                cell.value = val;
                const al = { ...(cell.alignment || {}), wrapText: true, vertical: 'middle' };
                if (c === 3 || c === 4) al.horizontal = 'center';
                else if (c === 5) al.horizontal = 'left';
                cell.alignment = al;
            };

            let rIdx = rStart;
            const items = dataMap[cat];
            for (const t of items) {
                setVal(rIdx, 2, t.client);
                setVal(rIdx, 3, t.dateDisplay || '');
                setVal(rIdx, 4, user);
                const title = t.title || '';
                setVal(rIdx, 5, title);
                ws.getRow(rIdx).height = Math.max(16, (title.split('\n').length) * 16);
                rIdx++;
                if (rIdx >= rEnd) {
                    const remaining = items.length - (rIdx - rStart);
                    if (remaining > 0) console.warn(`주간보고 블록 용량 초과: ${headerText}/${cat} 블록에 ${remaining}건 누락`);
                    break;
                }
            }
            for (let r = rIdx; r < rEnd; r++) {
                for (let c = 2; c < 6; c++) {
                    const cell = ws.getCell(r, c);
                    if (!isMergedSlave(cell)) cell.value = null;
                }
            }
        });
    }

    async function generateWeeklyReportExcel(tasks, user, logs) {
        const ExcelJS = await loadExcelJS();
        const resp = await fetch(TEMPLATE_URL, { cache: 'no-store' });
        if (!resp.ok) throw new Error(`엑셀 템플릿(${TEMPLATE_URL})을 불러오지 못했습니다.`);

        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(await resp.arrayBuffer());

        const data = buildReportData(tasks, logs);
        window._tlMissingClient = data.missingClient || 0;   // 화면 안내용 (고객사 없는 요청 수)
        const ws1 = wb.getWorksheet('■CO팀 주요 업무');
        const ws2 = wb.getWorksheet('■ 주요 이슈 및 특이사항');
        if (!ws1 || !ws2) throw new Error('템플릿 시트 이름이 예상과 다릅니다.');

        writeSection(ws1, '1. 금주', data.cur, user);
        writeSection(ws1, '2. 차주', data.next, user);

        let row = 5;
        for (const t of data.issues) {
            const setVal2 = (c, val) => {
                const cell = ws2.getCell(row, c);
                if (!isMergedSlave(cell)) cell.value = val;
            };
            setVal2(1, categoryOf(t)[0]);
            setVal2(2, t.client);
            setVal2(3, t.issueMemo || t.title);
            setVal2(4, user);
            setVal2(5, t.issueProgress || '');
            setVal2(6, t.issueFollowUp || '');
            row++;
        }

        const buf = await wb.xlsx.writeBuffer();
        const fileName = `CO팀 ${data.weekLabel} 주간업무보고_${user}.xlsx`;
        const url = URL.createObjectURL(new Blob([buf], {
            type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        }));
        const a = document.createElement('a');
        a.href = url;
        a.download = fileName;
        document.body.appendChild(a);
        a.click();
        a.remove();
        setTimeout(() => URL.revokeObjectURL(url), 10000);
        return fileName;
    }

    window.generateWeeklyReportExcel = generateWeeklyReportExcel;
})();
