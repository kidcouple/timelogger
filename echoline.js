// 에코라인등록: 월별 완료건 조회 → Gmail 검색 링크(앱은 메일 권한 없음) → EcholineRequestTemplate.xlsx 일괄 생성.
// 공개 저장소이므로 고객사 코드·별칭·계정·회사 템플릿은 코드에 넣지 않고 이 브라우저의 localStorage 에만 저장한다.
(function () {
    const EXCELJS_URL = 'https://cdn.jsdelivr.net/npm/exceljs@4.4.0/dist/exceljs.min.js';
    const CFG_KEY = 'TL_ECHOLINE_CFG';
    const TPL_KEY = 'TL_ECHOLINE_TPL';
    const STOP_WORDS = /^(건|요청|요청의|관련|문의|변경|확인|지원|처리)$/;

    let current = [];

    const $ = id => document.getElementById(id);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const allTasks = () => (typeof tasks !== 'undefined' && Array.isArray(tasks)) ? tasks : [];

    function loadCfg() {
        try { return Object.assign({ gmailAccount: '', myEchoId: '', clients: {} }, JSON.parse(localStorage.getItem(CFG_KEY) || '{}')); }
        catch (e) { return { gmailAccount: '', myEchoId: '', clients: {} }; }
    }
    function saveCfg(cfg) { localStorage.setItem(CFG_KEY, JSON.stringify(cfg)); }

    function pd(s) {
        const m = /(\d{4})\D+(\d{1,2})\D+(\d{1,2})/.exec(String(s || ''));
        return m ? new Date(+m[1], +m[2] - 1, +m[3]) : null;
    }
    const iso = d => d ? `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}` : '';
    const gdate = d => iso(d).replace(/-/g, '/');
    function addDays(d, n) { const x = new Date(d); x.setDate(x.getDate() + n); return x; }
    function taskMinutes(t) {
        if (typeof taskTime === 'function') return taskTime(t) || 0;
        return parseFloat(t.actualTime) > 0 ? parseFloat(t.actualTime) : 0;
    }

    // ---------- 고객사 인식 ----------
    // 고객사명은 앱/메일/라벨마다 표기가 달라(ABC-H ↔ 에이비씨테크㈜ ↔ 14.ABC-H)
    // 한 이름으로 AND 검색하지 않고 {라벨 OR 별칭들} 묶음으로 넣는다.
    function clientInfo(name, cfg) {
        const base = String(name || '').trim();
        const c = cfg.clients[base] || {};
        if (!base || c.skip) return { label: '', terms: [] };
        // 자동 별칭: ㈜/주식회사·앞 '한국'·뒤 '제약'·-H/-I 접미 제거, 띄어쓰기 제거
        const core = base.replace(/\(주\)|㈜|주식회사/g, '').replace(/^한국/, '').replace(/\s*제약$/, '').replace(/-[A-Z]$/i, '').trim();
        const manual = String(c.aliases || '').split(',').map(s => s.trim());
        const terms = [...new Set([base, base.replace(/\s+/g, ''), core, ...manual].filter(w => w && w.length >= 2))];
        return { label: String(c.label || '').trim(), terms };
    }
    function clientGroup(t, cfg) {
        const { label, terms } = clientInfo(t.client, cfg);
        const parts = [label ? `label:${label.toLowerCase().replace(/\s+/g, '-')}` : '',
            ...terms.map(w => /[\s\-]/.test(w) ? `"${w}"` : w)].filter(Boolean);
        return parts.length ? `{${parts.join(' ')}}` : '';
    }

    // ---------- Gmail 검색어 ----------
    // subject: 연산자는 단어 정확 일치라 '방식'으로 '오더방식'을 못 찾는다. 일반 검색은 한국어 부분일치가 된다.
    function keywords(t) {
        return String(t.title || '').replace(/^\s*((re|fw|fwd)\s*:\s*)+/i, '').replace(/[\[\]()【】「」"'·,]/g, ' ')
            .split(/\s+/).filter(w => w.length >= 2 && !STOP_WORDS.test(w)).slice(0, 4);
    }
    function buildQuery(t, mode, cfg) {
        const from = addDays(pd(t.reqDate) || pd(t.aStart) || new Date(), -14);
        const to = addDays(pd(t.aEnd) || new Date(), 14);
        const date = ` after:${gdate(from)} before:${gdate(to)}`;
        const kw = keywords(t).join(' ');
        const cg = clientGroup(t, cfg);
        const q = {
            client: `${cg}${date}`,
            kw: `${kw}${date}`,
            or: `{${kw}} ${cg}${date}`,
        }[mode] || `${kw} ${cg}${date}`;
        return q.replace(/\s+/g, ' ').trim();
    }
    function gmailUrl(q, cfg) {
        const a = String(cfg.gmailAccount || '').trim();
        const base = a.includes('@')
            ? `https://mail.google.com/mail/?authuser=${encodeURIComponent(a)}`
            : `https://mail.google.com/mail/u/${encodeURIComponent(a || '0')}/`;
        return `${base}#search/${encodeURIComponent(q)}`;
    }

    // ---------- UI ----------
    function ensureModal() {
        if ($('echolineModal')) return;
        const style = document.createElement('style');
        style.textContent = `
            #echolineModal .modal { width: 1180px; max-width: 97%; }
            #echolineModal table { width:100%; border-collapse:collapse; font-size:12.5px; }
            #echolineModal th, #echolineModal td { border-bottom:1px solid var(--border); padding:6px 5px; text-align:left; vertical-align:top; }
            #echolineModal th { color:var(--sub); font-weight:600; }
            #echolineModal tr.eco-target { cursor:pointer; } #echolineModal tr.eco-target:hover { background:rgba(255,255,255,.04); }
            #echolineModal tr.eco-sel { background:rgba(124,77,255,.18) !important; }
            #echolineModal tr.eco-done td { color:var(--sub); opacity:.7; }
            #echolineModal .eco-sec { margin:10px 0 4px; font-weight:700; font-size:13px; }
            #echolineModal .eco-badge { padding:1px 7px; border-radius:10px; font-size:11px; color:#fff; }
            #echolineModal .eco-row { display:flex; gap:8px; align-items:center; flex-wrap:wrap; }
            #echolineModal input.eco-in { background:var(--bg, #14161c); color:inherit; border:1px solid var(--border); border-radius:5px; padding:5px 7px; }
            #echolineModal .eco-note { color:var(--sub); font-size:11.5px; }
            #echolineModal .eco-btn { padding:5px 10px; border:1px solid var(--border); border-radius:5px; background:var(--panel); color:inherit; cursor:pointer; font-size:12px; }
            #echolineModal .eco-btn.pri { background:#1a73e8; border-color:#1a73e8; color:#fff; font-weight:600; }
            #echolineModal .eco-btn.ok { background:#188038; border-color:#188038; color:#fff; font-weight:600; }
            #echolineModal .eco-btn.on { background:#6a1b9a; border-color:#6a1b9a; color:#fff; }
            #echolineModal .eco-panel { margin-top:10px; padding:10px; border:1px solid var(--border); border-radius:8px; }
            #echolineModal .eco-cfg td input { width:100%; box-sizing:border-box; }
            #echolineModal .eco-sheet-wrap { overflow:auto; max-height:60vh; border:1px solid var(--border); border-radius:6px; }
            #echolineModal table.eco-sheet { border-collapse:collapse; width:max-content; font-size:12px; }
            #echolineModal table.eco-sheet th { position:sticky; top:0; z-index:1; background:#262a35; border:1px solid var(--border); padding:4px 6px; white-space:nowrap; }
            #echolineModal table.eco-sheet td { border:1px solid var(--border); padding:0; }
            #echolineModal table.eco-sheet td.eco-rh { padding:3px 6px; color:var(--sub); white-space:nowrap; background:#1f222b; position:sticky; left:0; }
            #echolineModal table.eco-sheet input { width:100%; box-sizing:border-box; border:none; background:transparent; color:inherit; padding:5px 6px; font-size:12px; outline:none; }
            #echolineModal table.eco-sheet input:focus { background:rgba(26,115,232,.18); box-shadow:inset 0 0 0 2px #1a73e8; }
            #echolineModal table.eco-sheet td.eco-empty { background:rgba(239,83,80,.18); }
            #echolineModal table.eco-sheet tr.eco-off td:not(.eco-rh) { opacity:.35; }
        `;
        document.head.appendChild(style);
        const ov = document.createElement('div');
        ov.id = 'echolineModal';
        ov.className = 'overlay';
        ov.innerHTML = `
            <div class="modal">
                <div class="modal-head">
                    <span>📋 에코라인등록</span>
                    <button onclick="closeEcholineModal()" style="background:none;border:none;color:var(--sub);font-size:18px;cursor:pointer">✕</button>
                </div>
                <div class="modal-body" style="gap:10px;">
                    <div class="eco-row">
                        <button class="eco-btn on" id="ecoTabList">목록</button>
                        <button class="eco-btn" id="ecoTabSheet">📝 엑셀 시트</button>
                        <button class="eco-btn" id="ecoTabCfg">⚙ 설정</button>
                        <span style="flex:1"></span>
                        <span class="eco-row" id="ecoMonthWrap" style="gap:4px">년월
                            <button class="eco-btn" id="ecoPrev" title="이전월">◀</button>
                            <input type="month" id="ecoYm" class="eco-in">
                            <button class="eco-btn" id="ecoNext" title="다음월">▶</button></span>
                        <button class="eco-btn ok" id="ecoToSheet">📝 엑셀 시트 작성 →</button>
                        <button class="eco-btn ok" id="ecoExport" style="display:none">⬇ 엑셀 다운로드</button>
                    </div>
                    <div id="ecoList"></div>
                    <div id="ecoPanel" class="eco-panel" style="display:none"></div>
                    <div id="ecoSheet" style="display:none"></div>
                    <div id="ecoCfg" style="display:none"></div>
                </div>
            </div>`;
        document.body.appendChild(ov);
        $('ecoTabList').onclick = () => showTab('list');
        $('ecoTabSheet').onclick = () => showTab('sheet');
        $('ecoTabCfg').onclick = () => showTab('cfg');
        $('ecoToSheet').onclick = () => showTab('sheet');
        $('ecoYm').onchange = () => changeMonth($('ecoYm').value);
        $('ecoPrev').onclick = () => shiftMonth(-1);
        $('ecoNext').onclick = () => shiftMonth(1);
        $('ecoExport').onclick = exportExcel;
    }

    let activeTab = 'list';
    let lastYm = '';
    function changeMonth(ym) {
        if (grid.dirty && grid.ym && grid.ym !== ym
            && !confirm('엑셀 시트에 입력한 내용이 있습니다. 다른 월로 이동하면 입력 내용이 초기화됩니다. 계속할까요?')) {
            $('ecoYm').value = lastYm;
            return;
        }
        $('ecoYm').value = ym;
        lastYm = ym;
        showTab(activeTab);
    }
    function shiftMonth(n) {
        const [y, m] = String(lastYm || $('ecoYm').value).split('-').map(Number);
        const d = new Date(y, m - 1 + n, 1);
        changeMonth(`${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`);
    }

    function showTab(tab) {
        activeTab = tab;
        $('ecoTabList').classList.toggle('on', tab === 'list');
        $('ecoTabSheet').classList.toggle('on', tab === 'sheet');
        $('ecoTabCfg').classList.toggle('on', tab === 'cfg');
        $('ecoList').style.display = tab === 'list' ? '' : 'none';
        $('ecoSheet').style.display = tab === 'sheet' ? '' : 'none';
        $('ecoCfg').style.display = tab === 'cfg' ? '' : 'none';
        $('ecoMonthWrap').style.display = tab === 'cfg' ? 'none' : '';
        $('ecoToSheet').style.display = tab === 'list' ? '' : 'none';
        $('ecoExport').style.display = tab === 'sheet' ? '' : 'none';
        $('ecoPanel').style.display = 'none';
        renderList();   // 등록 대상(current) 갱신은 항상
        if (tab === 'sheet') renderSheet();
        if (tab === 'cfg') renderCfg();
    }

    function badge(t) {
        const color = { '에코라인': '#4a148c', '메일': '#e65100', '유선': '#9e7c00' }[t.reqType] || '#555';
        return `<span class="eco-badge" style="background:${color}">${esc(t.reqType || '없음')}</span>`;
    }

    function renderList() {
        const [y, m] = String($('ecoYm').value || '').split('-').map(Number);
        const done = allTasks().filter(t => t.status === '완료');
        const inMonth = done.filter(t => { const e = pd(t.aEnd); return e && e.getFullYear() === y && e.getMonth() + 1 === m; })
            .sort((a, b) => (pd(a.aEnd) - pd(b.aEnd)));
        const targets = inMonth.filter(t => t.reqType !== '에코라인');
        const registered = inMonth.filter(t => t.reqType === '에코라인');
        const missing = done.filter(t => !pd(t.aEnd));
        current = targets;
        const head = `<tr><th>순번</th><th>작업명</th><th>고객</th><th>요청유형</th><th>신청일</th><th>실제종료</th><th>공수</th><th>처리내역</th></tr>`;
        const rows = (arr, cls) => arr.map(t => {
            const mins = taskMinutes(t);
            return `<tr class="${cls}" data-id="${esc(t.id || t.seq)}">
                <td>${esc(t.seq)}</td><td>${esc(t.title)}</td><td>${esc(t.client)}</td><td>${badge(t)}</td>
                <td>${esc(t.reqDate)}</td><td>${esc(t.aEnd)}</td><td>${mins ? (mins / 60).toFixed(1) + 'h' : ''}</td>
                <td>${esc(String(t.procDetail || '').slice(0, 60))}</td></tr>`;
        }).join('');
        $('ecoList').innerHTML =
            `<div class="eco-sec">🟠 등록 대상 ${targets.length}건 — 행 클릭 시 Gmail 검색</div><table>${head}${rows(targets, 'eco-target')}</table>` +
            `<div class="eco-sec">🟣 에코라인 접수건 = 등록됨 ${registered.length}건</div><table>${head}${rows(registered, 'eco-done')}</table>` +
            (missing.length ? `<div class="eco-sec" style="color:#ef5350">⚠ 완료인데 실제종료 누락 ${missing.length}건 — 월 판정 불가, 종료일 입력 필요</div><table>${head}${rows(missing, 'eco-target')}</table>` : '');
        document.querySelectorAll('#ecoList tr.eco-target').forEach(tr => tr.onclick = () => selectTask(tr));
        $('ecoPanel').style.display = 'none';
    }

    function selectTask(tr) {
        document.querySelectorAll('#ecoList tr').forEach(r => r.classList.remove('eco-sel'));
        tr.classList.add('eco-sel');
        const t = allTasks().find(x => String(x.id || x.seq) === tr.dataset.id);
        if (!t) return;
        const cfg = loadCfg();
        const info = clientInfo(t.client, cfg);
        const p = $('ecoPanel');
        p.style.display = 'block';
        p.innerHTML = `
            <div style="margin-bottom:8px"><b>#${esc(t.seq)} ${esc(t.title)}</b> · ${esc(t.client)}</div>
            <div class="eco-row"><input id="ecoQ" class="eco-in" style="flex:1; min-width:400px; font-family:Consolas,monospace">
                <button class="eco-btn pri" id="ecoGo">🔍 Gmail에서 검색 (새 탭)</button></div>
            <div class="eco-row" style="margin-top:6px">
                <button class="eco-btn" data-m="plain">① 핵심어+고객사</button><button class="eco-btn" data-m="kw">② 핵심어만</button>
                <button class="eco-btn" data-m="or">③ 넓게 (단어 중 하나라도)</button><button class="eco-btn" data-m="client">④ 고객사 메일 전체</button>
                <button class="eco-btn" id="ecoWide">기간 해제</button></div>
            <div class="eco-note" style="margin-top:6px">고객사 인식: 라벨 ${esc(info.label || '미지정')} / 별칭 ${esc(info.terms.join(', ') || '없음(조건 생략)')} — ⚙ 설정에서 수정</div>
            ${cfg.gmailAccount ? '' : '<div class="eco-note" style="color:#ffb74d">⚠ ⚙ 설정에서 회사 Gmail 주소를 지정하세요 (미지정 시 첫 번째 로그인 계정으로 열림)</div>'}`;
        $('ecoQ').value = buildQuery(t, 'plain', cfg);
        $('ecoGo').onclick = () => window.open(gmailUrl($('ecoQ').value, loadCfg()), '_blank', 'noopener,noreferrer');
        p.querySelectorAll('button[data-m]').forEach(b => b.onclick = () => { $('ecoQ').value = buildQuery(t, b.dataset.m, loadCfg()); });
        $('ecoWide').onclick = () => { $('ecoQ').value = $('ecoQ').value.replace(/\s*(after|before):\S+/g, '').trim(); };
    }

    // ---------- 설정 ----------
    const CODE_FIELDS = [['label', 'Gmail 라벨'], ['aliases', '별칭(쉼표)'], ['reqUser', '요청자ID'], ['saL', '영역대'], ['saM', '영역중'], ['saS', '영역소'], ['stL', '유형대'], ['stM', '유형중']];

    function renderCfg() {
        const cfg = loadCfg();
        const names = [...new Set([...allTasks().map(t => String(t.client || '').trim()), ...Object.keys(cfg.clients)].filter(Boolean))].sort();
        const tpl = localStorage.getItem(TPL_KEY);
        $('ecoCfg').innerHTML = `
            <div class="eco-note" style="margin-bottom:8px">🔒 아래 설정과 템플릿은 이 브라우저에만 저장되며 서버/저장소로 전송되지 않습니다.</div>
            <div class="eco-row" style="margin-bottom:8px">
                <label>회사 Gmail 주소 <input id="ecoAcct" class="eco-in" style="width:260px" value="${esc(cfg.gmailAccount)}" placeholder="name@company.com 또는 1"></label>
                <label>내 Echoline 담당자 ID <input id="ecoMyId" class="eco-in" style="width:120px" value="${esc(cfg.myEchoId)}"></label>
            </div>
            <div class="eco-row" style="margin-bottom:10px">
                <span>템플릿: ${tpl ? '✅ 등록됨' : '❌ 없음'}</span>
                <input type="file" id="ecoTplFile" accept=".xlsx">
                <span class="eco-note">EcholineRequestTemplate.xlsx (Echoline 일괄등록 화면의 Template Download)</span>
            </div>
            <div style="max-height:380px; overflow:auto">
            <table class="eco-cfg"><tr><th>고객사</th>${CODE_FIELDS.map(f => `<th>${f[1]}</th>`).join('')}<th title="자사 등 고객사 검색조건 제외">제외</th></tr>
            ${names.map(n => { const c = cfg.clients[n] || {}; return `<tr data-name="${esc(n)}"><td>${esc(n)}</td>
                ${CODE_FIELDS.map(f => `<td><input class="eco-in" data-f="${f[0]}" value="${esc(c[f[0]] || '')}"></td>`).join('')}
                <td><input type="checkbox" data-f="skip" ${c.skip ? 'checked' : ''}></td></tr>`; }).join('')}
            </table></div>
            <div class="eco-row" style="margin-top:10px; justify-content:flex-end"><button class="eco-btn ok" id="ecoSave">저장</button></div>`;
        $('ecoTplFile').onchange = async (e) => {
            const f = e.target.files[0];
            if (!f) return;
            const bytes = new Uint8Array(await f.arrayBuffer());
            let bin = '';
            for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
            try { localStorage.setItem(TPL_KEY, btoa(bin)); alert('템플릿을 저장했습니다.'); }
            catch (err) { alert('템플릿 저장 실패(브라우저 저장공간 부족): ' + err.message); }
            renderCfg();
        };
        $('ecoSave').onclick = () => {
            const next = loadCfg();
            next.gmailAccount = $('ecoAcct').value.trim();
            next.myEchoId = $('ecoMyId').value.trim();
            document.querySelectorAll('#ecoCfg tr[data-name]').forEach(tr => {
                const c = {};
                tr.querySelectorAll('[data-f]').forEach(inp => {
                    if (inp.type === 'checkbox') { if (inp.checked) c.skip = true; }
                    else if (inp.value.trim()) c[inp.dataset.f] = inp.value.trim();
                });
                if (Object.keys(c).length) next.clients[tr.dataset.name] = c; else delete next.clients[tr.dataset.name];
            });
            saveCfg(next);
            alert('저장했습니다.');
        };
    }

    // ---------- 엑셀 시트(화면 편집) ----------
    // 템플릿 'For Upload' 16개 컬럼과 1:1. code 표시는 고객사 기본값으로 저장/전파되는 컬럼.
    const SHEET_COLS = [
        { k: 'reqUser', n: '요청자ID', w: 100, code: true },
        { k: 'reqDate', n: '요청일자', w: 145 },
        { k: 'resDate', n: '처리희망일', w: 145 },
        { k: 'saL', n: '영역대', w: 65, code: true },
        { k: 'saM', n: '영역중', w: 65, code: true },
        { k: 'saS', n: '영역소', w: 80, code: true },
        { k: 'title', n: '제목', w: 230 },
        { k: 'reqComment', n: '요청내용', w: 200 },
        { k: 'stL', n: '유형대', w: 60, code: true },
        { k: 'stM', n: '유형중', w: 65, code: true },
        { k: 'owner', n: '담당자ID', w: 85 },
        { k: 'ws', n: '실적시작', w: 95 },
        { k: 'we', n: '실적종료', w: 95 },
        { k: 'desc', n: '처리내역', w: 230 },
        { k: 'hours', n: '확정공수', w: 60 },
        { k: 'cause', n: '원인', w: 50 },
    ];
    let grid = { ym: '', rows: [], dirty: false };   // rows: [{ client, seq, on, v: {k: value} }]

    function buildGrid() {
        const cfg = loadCfg();
        grid = {
            ym: $('ecoYm').value, dirty: false,
            rows: current.map(t => {
                const c = cfg.clients[String(t.client || '').trim()] || {};
                const mins = taskMinutes(t);
                return {
                    client: String(t.client || '').trim(), seq: t.seq, on: true,
                    v: {
                        reqUser: c.reqUser || '', reqDate: `${iso(pd(t.reqDate) || pd(t.aStart))} 09:00:00`,
                        resDate: `${iso(pd(t.pEnd) || pd(t.aEnd))} 18:00:00`,
                        saL: c.saL || '', saM: c.saM || '', saS: c.saS || '', title: t.title || '',
                        reqComment: t.reqDetail || t.title || '', stL: c.stL || '', stM: c.stM || '',
                        owner: cfg.myEchoId || '', ws: iso(pd(t.aStart) || pd(t.aEnd)), we: iso(pd(t.aEnd)),
                        desc: t.procDetail || t.title || '', hours: mins ? String(+(mins / 60).toFixed(1)) : '', cause: 'N/A',
                    },
                };
            }),
        };
    }

    function renderSheet() {
        if (grid.ym !== $('ecoYm').value) buildGrid();
        const empties = grid.rows.reduce((n, r) => n + (r.on ? SHEET_COLS.filter(c => !r.v[c.k]).length : 0), 0);
        $('ecoSheet').innerHTML = `
            <div class="eco-row" style="margin-bottom:6px">
                <span class="eco-note">${grid.rows.length}건 · 빈 칸 <b style="color:${empties ? '#ef5350' : '#66bb6a'}">${empties}</b>개 —
                    Enter/↑↓ 이동 · 엑셀에서 여러 칸 복사→붙여넣기 가능 · 🔑코드 칸 입력 시 같은 고객사 빈 칸에 자동 채움</span>
                <span style="flex:1"></span>
                <label class="eco-note"><input type="checkbox" id="ecoSaveDef" checked> 입력한 코드를 고객사 기본값으로 저장</label>
                <button class="eco-btn" id="ecoReload" title="입력 내용을 버리고 할일 데이터로 다시 채움">↺ 다시 불러오기</button>
            </div>
            ${grid.rows.length ? `<div class="eco-sheet-wrap"><table class="eco-sheet">
                <tr><th title="엑셀 포함 여부">포함</th><th>순번</th><th>고객</th>${SHEET_COLS.map(c => `<th style="min-width:${c.w}px">${c.n}${c.code ? ' 🔑' : ''}</th>`).join('')}</tr>
                ${grid.rows.map((r, i) => `<tr data-r="${i}" class="${r.on ? '' : 'eco-off'}">
                    <td class="eco-rh"><input type="checkbox" data-on="${i}" ${r.on ? 'checked' : ''} style="width:auto"></td>
                    <td class="eco-rh">${esc(r.seq)}</td><td class="eco-rh">${esc(r.client)}</td>
                    ${SHEET_COLS.map((c, j) => `<td class="${r.v[c.k] ? '' : 'eco-empty'}"><input data-i="${i}" data-j="${j}" value="${esc(r.v[c.k])}"></td>`).join('')}
                </tr>`).join('')}
            </table></div>` : '<div class="eco-note">이 달의 등록 대상이 없습니다.</div>'}`;
        $('ecoReload').onclick = () => { if (!grid.dirty || confirm('입력한 내용을 버리고 다시 불러올까요?')) { grid.ym = ''; renderSheet(); } };
        $('ecoSheet').querySelectorAll('input[data-on]').forEach(cb => cb.onchange = () => {
            grid.rows[+cb.dataset.on].on = cb.checked;
            cb.closest('tr').classList.toggle('eco-off', !cb.checked);
        });
        $('ecoSheet').querySelectorAll('input[data-i]').forEach(inp => {
            inp.oninput = () => setCell(+inp.dataset.i, +inp.dataset.j, inp.value, false);
            inp.onchange = () => setCell(+inp.dataset.i, +inp.dataset.j, inp.value, true);
            inp.onkeydown = e => {
                const di = { Enter: 1, ArrowDown: 1, ArrowUp: -1 }[e.key];
                if (!di || e.isComposing) return;
                e.preventDefault();
                focusCell(+inp.dataset.i + di, +inp.dataset.j);
            };
            inp.onpaste = e => {
                const text = (e.clipboardData || window.clipboardData).getData('text');
                if (!/[\t\n]/.test(text.replace(/\r?\n$/, ''))) return;   // 단일 값은 기본 붙여넣기
                e.preventDefault();
                const lines = text.replace(/\r/g, '').replace(/\n$/, '').split('\n');
                lines.forEach((line, di) => line.split('\t').forEach((val, dj) => {
                    const i = +inp.dataset.i + di, j = +inp.dataset.j + dj;
                    if (grid.rows[i] && SHEET_COLS[j]) setCell(i, j, val.trim(), true);
                }));
            };
        });
    }

    function cellInput(i, j) { return $('ecoSheet').querySelector(`input[data-i="${i}"][data-j="${j}"]`); }
    function focusCell(i, j) { const el = cellInput(i, j); if (el) { el.focus(); el.select(); } }

    // commit=true: 값 확정 → 코드 컬럼이면 같은 고객사의 빈 칸에 전파
    function setCell(i, j, val, commit) {
        const col = SHEET_COLS[j], row = grid.rows[i];
        row.v[col.k] = val;
        grid.dirty = true;
        const paint = (ri) => {
            const el = cellInput(ri, j);
            if (!el) return;
            if (el.value !== grid.rows[ri].v[col.k]) el.value = grid.rows[ri].v[col.k];
            el.parentElement.classList.toggle('eco-empty', !grid.rows[ri].v[col.k]);
        };
        paint(i);
        if (commit && col.code && val && row.client) {
            grid.rows.forEach((r, ri) => { if (ri !== i && r.client === row.client && !r.v[col.k]) { r.v[col.k] = val; paint(ri); } });
        }
    }

    function saveCodesAsDefaults() {
        const cfg = loadCfg();
        grid.rows.filter(r => r.on && r.client).forEach(r => {
            SHEET_COLS.filter(col => col.code && r.v[col.k]).forEach(col => {
                const c = cfg.clients[r.client] || (cfg.clients[r.client] = {});
                if (!c[col.k]) c[col.k] = r.v[col.k];
            });
        });
        const owner = grid.rows.find(r => r.on && r.v.owner);
        if (!cfg.myEchoId && owner) cfg.myEchoId = owner.v.owner;
        saveCfg(cfg);
    }

    // ---------- 엑셀 ----------
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

    // 엑셀 시트 → EcholineRequestTemplate.xlsx (원본 서식 유지, 3행 예시부터 덮어쓰기, 날짜는 텍스트)
    async function exportExcel() {
        const rows = grid.rows.filter(r => r.on);
        if (!rows.length) return alert('포함된 행이 없습니다.');
        const tpl = localStorage.getItem(TPL_KEY);
        if (!tpl) { alert('먼저 ⚙ 설정에서 EcholineRequestTemplate.xlsx 를 한 번 선택해 주세요.'); return showTab('cfg'); }
        const blanks = rows.map(r => {
            const miss = SHEET_COLS.filter(c => !r.v[c.k]).map(c => c.n);
            return miss.length ? `#${r.seq} ${r.client || '(고객 없음)'}: ${miss.join(', ')}` : '';
        }).filter(Boolean);
        if (blanks.length && !confirm(`빈 칸이 남아 있습니다. 그래도 생성할까요?\n\n${blanks.join('\n')}`)) return;
        if ($('ecoSaveDef') && $('ecoSaveDef').checked) saveCodesAsDefaults();
        const ExcelJS = await loadExcelJS();
        const wb = new ExcelJS.Workbook();
        await wb.xlsx.load(Uint8Array.from(atob(tpl), c => c.charCodeAt(0)).buffer);
        const ws = wb.getWorksheet('For Upload') || wb.worksheets[0];
        rows.forEach((r, i) => {
            const row = ws.getRow(3 + i);
            SHEET_COLS.forEach((c, j) => { const cell = row.getCell(j + 1); cell.value = r.v[c.k] || ''; cell.numFmt = '@'; });
            row.commit();
        });
        const out = await wb.xlsx.writeBuffer();
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([out], { type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' }));
        a.download = `EcholineRequestTemplate_${grid.ym}.xlsx`;
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 10000);
        grid.dirty = false;
    }

    window.openEcholineModal = function () {
        ensureModal();
        const d = new Date();
        d.setDate(1);                   // 31일에 setMonth 하면 다음 달로 넘어가는 것 방지
        d.setMonth(d.getMonth() - 1);   // 기본값 = 지난달
        $('ecoYm').value = lastYm = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
        $('echolineModal').style.display = 'flex';
        showTab('list');
    };
    window.closeEcholineModal = function () {
        const m = $('echolineModal');
        if (m) m.style.display = 'none';
    };
})();
