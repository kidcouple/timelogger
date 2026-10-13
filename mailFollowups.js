// 메일 회신 카드: 맥미니가 Supabase mail_followups 표에 올린 '회신 필요' 목록을 보여 주고, [회신 불필요] 로 status='done' 처리.
// 🔄 는 mail_sync_requests 에 요청을 넣고, 맥미니의 mail_sync_watch.py 가 supabase_bridge.py sync 를 실행한 뒤 목록을 다시 읽는다.
// 표는 RLS 로 '로그인한 본인'만 읽고 status 만 바꿀 수 있다 → supabaseClient.js 의 TL_Auth(Supabase Auth) 토큰으로만 호출.
// 공개 저장소이므로 키·이메일은 코드에 넣지 않는다. 공개(publishable) 키는 public-config.json, 로그인 토큰은 이 브라우저 localStorage.
(function () {
    const TABLE = 'mail_followups';
    const SYNC_TABLE = 'mail_sync_requests';
    const OPEN_KEY = 'TL_MAIL_CARD_OPEN';
    const REFRESH_MS = 3 * 60 * 1000;
    const PICKUP_WAIT_MS = 30 * 1000;      // 맥미니가 요청을 집어 가길 기다리는 시간
    const SYNC_WAIT_MS = 16 * 60 * 1000;   // 집어 간 뒤 mail_hourly.sh(최대 15분)를 기다리는 시간
    const KIND = { A: ['직접', '#4f8ef7'], A2: ['참조', '#8b949e'], G: ['그룹', '#7c4dff'], B: ['내 약속', '#d29922'] };
    const EXCLUDE_SUBJECTS = ['EchoLine 서비스', '[성주 주간 실적 보고]'];

    let rows = [];
    let state = 'idle';       // idle | login | loading | ok | error
    let errMsg = '';
    let syncMsg = '';
    let syncing = false;

    const $ = id => document.getElementById(id);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const safeGmail = u => /^https:\/\/mail\.google\.com\//.test(String(u || '')) ? u : '';
    const keepRow = r => !EXCLUDE_SUBJECTS.some(s => String(r.subject || '').includes(s));

    // ---------- 로그인: supabaseClient.js 의 TL_Auth 공용 ----------
    const loadAuth = () => TL_Auth.load();
    const needLogin = () => TL_Auth.needLogin();

    async function api(method, query, body, table) {
        const cfg = await loadRemoteConfig();
        const token = await TL_Auth.accessToken();
        if (!token) throw needLogin();
        const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${table || TABLE}?${query}`, {
            method,
            headers: {
                apikey: cfg.supabaseAnonKey,
                Authorization: `Bearer ${token}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
                Prefer: 'return=representation'
            },
            body: body ? JSON.stringify(body) : undefined
        });
        if (r.status === 401) { await TL_Auth.logout(); throw needLogin(); }
        if (!r.ok) throw new Error(await r.text() || `요청 실패 (${r.status})`);
        const text = await r.text();
        return text ? JSON.parse(text) : [];
    }

    const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

    function syncError(e) {
        const msg = String(e && e.message || e);
        if (/mail_sync_requests|PGRST205|42P01|schema cache/i.test(msg)) {
            return new Error('동기화 요청 표가 없습니다. Supabase에서 Database/mail_sync_requests.sql 을 한 번 실행하세요.');
        }
        return e.needLogin ? e : new Error(msg);
    }

    // 맥미니가 mail_sync_watch.py 로 이 행을 보고 supabase_bridge.py sync 를 실행한다.
    async function requestMacSync() {
        let created;
        try {
            created = await api('POST', 'select=id', { status: 'pending' }, SYNC_TABLE);
        } catch (e) {
            throw syncError(e);
        }
        const id = created && created[0] && created[0].id;
        if (!id) throw new Error('동기화 요청을 만들지 못했습니다.');
        const started = Date.now();
        let picked = false;
        while (true) {
            await sleep(2000);
            const found = await api('GET', `id=eq.${encodeURIComponent(id)}&select=status,message`, null, SYNC_TABLE);
            const row = found && found[0];
            if (!row) throw new Error('동기화 요청이 사라졌습니다.');
            if (row.status === 'done') return row.message || '';
            if (row.status === 'error') throw new Error(row.message || '맥미니 동기화에 실패했습니다.');
            picked = picked || row.status === 'running';
            const sec = Math.round((Date.now() - started) / 1000);
            if (!picked && sec * 1000 > PICKUP_WAIT_MS) {
                throw new Error(`맥미니가 ${sec}초 동안 동기화 요청을 받지 않았습니다.\n맥미니에서 mac_mini/mail_sync_watch.py 가 켜져 있는지 확인하세요.`);
            }
            if (sec * 1000 > SYNC_WAIT_MS) throw new Error('맥미니 메일 동기화가 너무 오래 걸립니다. 잠시 뒤 다시 확인하세요.');
            syncMsg = picked ? `맥미니에서 새 메일 가져오는 중… (${sec}초)` : `맥미니 응답을 기다리는 중… (${sec}초)`;
            render();
            showMailBusy(syncMsg);
        }
    }

    // ---------- 데이터 ----------
    async function load() {
        if (!loadAuth()) { state = 'login'; render(); return; }
        if (state !== 'ok') { state = 'loading'; syncMsg = syncMsg || '불러오는 중..'; render(); }
        try {
            rows = (await api('GET', 'select=key,kind,date,age,client,subject,gmail&status=eq.open&order=age.asc')).filter(keepRow);
            state = 'ok';
            syncMsg = '';
        } catch (e) {
            state = e.needLogin ? 'login' : 'error';
            errMsg = e.message;
        }
        render();
    }

    // 진행 상황을 창에 계속 보여 준다. [닫기] 하면 카드에서만 진행 상황을 보이고 끝나면 결과 창을 띄운다.
    let busyHidden = false;
    function showMailBusy(msg) {
        if (busyHidden) return;
        const box = document.getElementById('cAlert');
        const text = document.getElementById('cAlertMsg');
        const btns = document.getElementById('cAlertBtns');
        if (!box || !text || !btns) return;
        text.textContent = '메일함에서 새 메일을 가져오는 중…\n' + msg;
        if (!document.getElementById('mfBusyClose')) {
            btns.innerHTML = '<button id="mfBusyClose" style="flex:1; padding:12px; border-radius:8px; font-weight:bold; background:#5c606e; color:#fff; border:none; cursor:pointer">닫기 (계속 진행)</button>';
            document.getElementById('mfBusyClose').onclick = hideMailBusy;
        }
        box.style.display = 'flex';
    }
    function hideMailBusy() {
        busyHidden = true;
        const box = document.getElementById('cAlert');
        if (box && document.getElementById('mfBusyClose')) box.style.display = 'none';
    }

    async function reload() {
        if (syncing) return;
        if (!loadAuth()) { state = 'login'; render(); return; }
        syncing = true;
        state = 'loading';
        errMsg = '';
        syncMsg = '맥미니에 동기화 요청…';
        busyHidden = false;
        showMailBusy(syncMsg);
        render();
        let note = '';
        let result = '';
        try {
            note = await requestMacSync();
            syncMsg = '목록 불러오는 중…';
            render();
            showMailBusy(syncMsg);
            rows = (await api('GET', 'select=key,kind,date,age,client,subject,gmail&status=eq.open&order=age.asc')).filter(keepRow);
            state = 'ok';
            syncMsg = '';
            result = (note ? note + '\n\n' : '') + `회신 필요 ${rows.length}건을 불러왔습니다.`;
        } catch (e) {
            state = e.needLogin ? 'login' : 'error';
            errMsg = e.message;
            if (!e.needLogin) result = '메일을 가져오지 못했습니다.\n' + (e.message || '');
        } finally {
            syncing = false;
            hideMailBusy();
            render();
        }
        if (result && window.TL_Alert) await TL_Alert(esc(result));
        return state === 'ok';
    }

    function scrollersFrom(el) {
        const out = [];
        for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
            const s = getComputedStyle(n);
            if (/(auto|scroll)/.test(s.overflowY) || /(auto|scroll)/.test(s.overflowX)) out.push(n);
        }
        const root = document.scrollingElement;
        if (root && !out.includes(root)) out.push(root);
        return out;
    }

    function holdScroll(nodes) {
        const saved = nodes.map(n => [n, n.scrollTop, n.scrollLeft]);
        const until = performance.now() + 400;
        const put = () => {
            for (const [n, top, left] of saved) {
                if (n.scrollTop !== top) n.scrollTop = top;
                if (n.scrollLeft !== left) n.scrollLeft = left;
            }
        };
        put();
        const guard = () => { if (performance.now() < until) put(); };
        nodes.forEach(n => n.addEventListener('scroll', guard));
        requestAnimationFrame(put);
        setTimeout(put, 0);
        setTimeout(() => {
            put();
            nodes.forEach(n => n.removeEventListener('scroll', guard));
        }, 400);
    }

    function updateCount() {
        const el = document.querySelector('#mailFollowupCard .mf-count');
        if (!el) return;
        el.textContent = String(rows.length);
        el.classList.toggle('mf-has', rows.length > 0);
    }

    async function markDone(key, btn) {
        const idx = rows.findIndex(r => r.key === key);
        if (idx < 0) return;
        const [removed] = rows.splice(idx, 1);
        const card = $('mailFollowupCard');
        if (!btn && card) btn = [...card.querySelectorAll('.mf-done')].find(b => b.dataset.key === key);
        const rowEl = btn && btn.closest('.mf-row');
        const list = rowEl && rowEl.closest('.mf-body');
        if (rowEl && list) {
            const keep = scrollersFrom(rowEl);
            rowEl.remove();
            updateCount();
            if (!rows.length) list.innerHTML = '<div class="mf-msg">회신할 메일 없음</div>';
            holdScroll(keep);
        } else {
            render();
        }
        try {
            const res = await api('PATCH', `key=eq.${encodeURIComponent(key)}`, { status: 'done' });
            if (!Array.isArray(res) || res.length !== 1) throw new Error('처리 권한이 없거나 이미 목록에서 빠진 메일입니다.');
        } catch (e) {
            rows.splice(Math.min(idx, rows.length), 0, removed);
            if (e.needLogin) state = 'login';
            render();
            alert('회신 불필요 처리 실패: ' + e.message);
        }
    }

    async function login(ev) {
        ev.preventDefault();
        const email = $('mfEmail').value.trim(), password = $('mfPassword').value;
        if (!email || !password) return;
        const btn = $('mfLoginBtn');
        btn.disabled = true;
        btn.textContent = '로그인 중..';
        try {
            await TL_Auth.signIn(email, password);
            errMsg = '';
            await load();
        } catch (e) {
            errMsg = e.message;
            state = 'login';
            render();
        }
    }

    // 로그아웃하면 Time Logger 전체가 잠기므로 로그인 창으로
    async function logout() {
        await TL_Auth.logout();
        location.reload();
    }

    // ---------- 화면 ----------
    function isOpen() {
        try { return localStorage.getItem(OPEN_KEY) !== '0'; } catch (e) { return true; }
    }
    function toggle() {
        try { localStorage.setItem(OPEN_KEY, isOpen() ? '0' : '1'); } catch (e) { }
        render();
    }

    function receivedOn(r) {
        const raw = String(r.date || '');
        const m = raw.match(/^(\d{4})-(\d{2})-(\d{2})/);
        if (!m) return { label: '-', title: raw };
        const y = Number(m[1]);
        const label = y === new Date().getFullYear() ? `${m[2]}.${m[3]}` : `${String(y).slice(2)}.${m[2]}.${m[3]}`;
        const hm = raw.match(/T(\d{2}:\d{2})/);
        return { label, title: `${m[1]}-${m[2]}-${m[3]}${hm ? ' ' + hm[1] : ''}` };
    }

    function rowHtml(r) {
        const [label, color] = KIND[r.kind] || [r.kind, '#8b949e'];
        const age = Number(r.age) || 0;
        const ageColor = age >= 7 ? 'var(--red)' : age >= 3 ? '#ff9800' : 'var(--sub)';
        const when = receivedOn(r);
        const link = safeGmail(r.gmail);
        return `<div class="mf-row">
            <span class="mf-kind" style="border-color:${color};color:${color}">${esc(label)}</span>
            <span class="mf-client" title="${esc(r.client)}">${esc(r.client || '-')}</span>
            <span class="mf-subject" title="${esc(r.subject)}">${esc(r.subject || '(제목 없음)')}</span>
            <span class="mf-age" style="color:${ageColor}" title="${esc(when.title)}">${esc(when.label)}</span>
            <span class="mf-actions">
                ${link ? `<a class="mf-btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Gmail 열기</a>` : ''}
                <button type="button" class="mf-btn mf-done" data-key="${esc(r.key)}">회신 불필요</button>
            </span>
        </div>`;
    }

    function bodyHtml() {
        if (state === 'login') {
            return `<form id="mfLoginForm" class="mf-login">
                <input id="mfEmail" type="email" placeholder="Supabase 로그인 이메일" autocomplete="username" required>
                <input id="mfPassword" type="password" placeholder="비밀번호" autocomplete="current-password" required>
                <button id="mfLoginBtn" class="mf-btn" type="submit">로그인</button>
                ${errMsg ? `<span class="mf-msg mf-err">${esc(errMsg)}</span>` : ''}
            </form>`;
        }
        if (state === 'loading' || state === 'idle') return `<div class="mf-msg">${esc(syncMsg || '불러오는 중..')}</div>`;
        if (state === 'error') return `<div class="mf-msg mf-err">불러오기 실패: ${esc(errMsg)}</div>`;
        if (!rows.length) return '<div class="mf-msg">회신할 메일 없음</div>';
        return rows.map(rowHtml).join('');
    }

    function render() {
        const card = $('mailFollowupCard');
        if (!card) return;
        const prevBody = card.querySelector('.mf-body');
        const keepScroll = prevBody ? prevBody.scrollTop : 0;
        const keepPage = window.scrollY;
        if (card.contains(document.activeElement)) document.activeElement.blur();
        const open = isOpen();
        const signedIn = !!loadAuth();
        const count = state === 'ok' ? `<span class="mf-count${rows.length ? ' mf-has' : ''}">${rows.length}</span>` : '';
        card.innerHTML = `<div class="mf-head">
                <button class="mf-title" id="mfToggle" title="접기/펼치기">${open ? '▾' : '▸'} ✉️ 메일 회신 ${count}</button>
                <span class="mf-tools">
                    ${signedIn ? '<button class="mf-icon" id="mfReload" title="새로고침">🔄</button><button class="mf-icon" id="mfLogout" title="로그아웃">로그아웃</button>' : ''}
                </span>
            </div>
            ${open ? `<div class="mf-body">${bodyHtml()}</div>` : ''}`;
        $('mfToggle').onclick = toggle;
        if ($('mfReload')) $('mfReload').onclick = reload;
        if ($('mfLogout')) $('mfLogout').onclick = logout;
        if ($('mfLoginForm')) $('mfLoginForm').onsubmit = login;
        card.querySelectorAll('.mf-done').forEach(b => {
            b.onmousedown = ev => ev.preventDefault();
            b.onclick = ev => { ev.preventDefault(); markDone(b.dataset.key, b); };
        });
        const nextBody = card.querySelector('.mf-body');
        if (nextBody) nextBody.scrollTop = keepScroll;
        window.scrollTo(0, keepPage);
        holdScroll([nextBody, document.scrollingElement].filter(Boolean));
    }

    function injectStyle() {
        const css = `
        #mailFollowupCard { margin: 10px 16px; background: var(--panel); border: 1px solid var(--border); border-radius: 10px; padding: 8px 12px; }
        #mailFollowupCard .mf-head { display: flex; align-items: center; justify-content: space-between; gap: 8px; }
        #mailFollowupCard .mf-title { background: none; border: none; color: var(--text); font-size: 13px; font-weight: bold; cursor: pointer; padding: 2px 0; }
        #mailFollowupCard .mf-count { display: inline-block; min-width: 18px; padding: 0 6px; border-radius: 9px; background: var(--border); color: var(--sub); font-size: 11px; text-align: center; }
        #mailFollowupCard .mf-count.mf-has { background: var(--red); color: #fff; }
        #mailFollowupCard .mf-tools { display: flex; gap: 4px; }
        #mailFollowupCard .mf-icon { background: none; border: none; color: var(--sub); cursor: pointer; font-size: 12px; }
        #mailFollowupCard .mf-body { margin-top: 6px; max-height: 320px; overflow-y: auto; }
        #mailFollowupCard .mf-row { display: flex; align-items: center; gap: 10px; padding: 6px 0; border-top: 1px solid var(--border); font-size: 13px; }
        #mailFollowupCard .mf-kind { flex: none; width: 48px; text-align: center; box-sizing: border-box; font-size: 11px; border: 1px solid; border-radius: 4px; padding: 0 5px; white-space: nowrap; }
        #mailFollowupCard .mf-client { flex: 0 0 120px; color: var(--sub); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #mailFollowupCard .mf-subject { flex: 1; min-width: 0; color: var(--text); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
        #mailFollowupCard .mf-age { flex: none; width: 52px; text-align: right; font-size: 12px; font-variant-numeric: tabular-nums; }
        #mailFollowupCard .mf-actions { flex: none; display: flex; gap: 6px; }
        #mailFollowupCard .mf-btn { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 3px 8px; font-size: 12px; cursor: pointer; text-decoration: none; white-space: nowrap; }
        #mailFollowupCard .mf-btn:hover { border-color: var(--primary); }
        #mailFollowupCard .mf-done { color: var(--sub); }
        #mailFollowupCard .mf-msg { color: var(--sub); font-size: 12px; padding: 6px 0; }
        #mailFollowupCard .mf-err { color: var(--red); }
        #mailFollowupCard .mf-login { display: flex; flex-wrap: wrap; gap: 6px; align-items: center; padding: 4px 0; }
        #mailFollowupCard .mf-login input { background: var(--bg); border: 1px solid var(--border); color: var(--text); border-radius: 6px; padding: 4px 8px; font-size: 12px; }
        @media (max-width: 768px) {
            #mailFollowupCard { margin: 8px 12px; }
            #mailFollowupCard .mf-row { flex-wrap: wrap; gap: 4px 8px; }
            #mailFollowupCard .mf-client { flex: 1 1 auto; }
            #mailFollowupCard .mf-subject { flex: 1 1 100%; order: 5; white-space: normal; }
            #mailFollowupCard .mf-actions { order: 6; margin-left: auto; }
        }`;
        const s = document.createElement('style');
        s.textContent = css;
        document.head.appendChild(s);
    }

    function mount() {
        const anchor = $('statusPanel') || $('listContainer');
        if (!anchor || $('mailFollowupCard')) return;
        injectStyle();
        const card = document.createElement('div');
        card.id = 'mailFollowupCard';
        anchor.parentNode.insertBefore(card, anchor);
        render();
        load();
        setInterval(() => { if (!document.hidden && state === 'ok' && !syncing) load(); }, REFRESH_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && state === 'ok' && !syncing) load(); });
    }

    window.TL_reloadMailFollowups = reload;

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
