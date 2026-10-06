// 메일 회신 카드: 맥미니가 Supabase mail_followups 표에 올린 '회신 필요' 목록을 보여 주고, [회신 불필요] 로 status='done' 처리.
// 표는 RLS 로 '로그인한 본인'만 읽고 status 만 바꿀 수 있다 → supabaseClient.js 의 TL_Auth(Supabase Auth) 토큰으로만 호출.
// 공개 저장소이므로 키·이메일은 코드에 넣지 않는다. 공개(publishable) 키는 public-config.json, 로그인 토큰은 이 브라우저 localStorage.
(function () {
    const TABLE = 'mail_followups';
    const OPEN_KEY = 'TL_MAIL_CARD_OPEN';
    const REFRESH_MS = 3 * 60 * 1000;
    const KIND = { A: ['직접', '#4f8ef7'], A2: ['참조', '#8b949e'], B: ['내 약속', '#d29922'] };

    let rows = [];
    let state = 'idle';       // idle | login | loading | ok | error
    let errMsg = '';

    const $ = id => document.getElementById(id);
    const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    const safeGmail = u => /^https:\/\/mail\.google\.com\//.test(String(u || '')) ? u : '';

    // ---------- 로그인: supabaseClient.js 의 TL_Auth 공용 ----------
    const loadAuth = () => TL_Auth.load();
    const needLogin = () => TL_Auth.needLogin();

    async function api(method, query, body) {
        const cfg = await loadRemoteConfig();
        const token = await TL_Auth.accessToken();
        if (!token) throw needLogin();
        const r = await fetch(`${cfg.supabaseUrl}/rest/v1/${TABLE}?${query}`, {
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

    // ---------- 데이터 ----------
    async function load() {
        if (!loadAuth()) { state = 'login'; render(); return; }
        if (state !== 'ok') { state = 'loading'; render(); }
        try {
            rows = await api('GET', 'select=key,kind,date,age,client,subject,gmail&status=eq.open&order=age.asc');
            state = 'ok';
        } catch (e) {
            state = e.needLogin ? 'login' : 'error';
            errMsg = e.message;
        }
        render();
    }

    async function markDone(key) {
        const idx = rows.findIndex(r => r.key === key);
        if (idx < 0) return;
        const [removed] = rows.splice(idx, 1);
        render();
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

    function rowHtml(r) {
        const [label, color] = KIND[r.kind] || [r.kind, '#8b949e'];
        const age = Number(r.age) || 0;
        const ageColor = age >= 7 ? 'var(--red)' : age >= 3 ? '#ff9800' : 'var(--sub)';
        const link = safeGmail(r.gmail);
        return `<div class="mf-row">
            <span class="mf-kind" style="border-color:${color};color:${color}">${esc(label)}</span>
            <span class="mf-client" title="${esc(r.client)}">${esc(r.client || '-')}</span>
            <span class="mf-subject" title="${esc(r.subject)}">${esc(r.subject || '(제목 없음)')}</span>
            <span class="mf-age" style="color:${ageColor}" title="${esc(r.date)}">${age}일</span>
            <span class="mf-actions">
                ${link ? `<a class="mf-btn" href="${esc(link)}" target="_blank" rel="noopener noreferrer">Gmail 열기</a>` : ''}
                <button class="mf-btn mf-done" data-key="${esc(r.key)}">회신 불필요</button>
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
        if (state === 'loading' || state === 'idle') return '<div class="mf-msg">불러오는 중..</div>';
        if (state === 'error') return `<div class="mf-msg mf-err">불러오기 실패: ${esc(errMsg)}</div>`;
        if (!rows.length) return '<div class="mf-msg">회신할 메일 없음</div>';
        return rows.map(rowHtml).join('');
    }

    function render() {
        const card = $('mailFollowupCard');
        if (!card) return;
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
        if ($('mfReload')) $('mfReload').onclick = load;
        if ($('mfLogout')) $('mfLogout').onclick = logout;
        if ($('mfLoginForm')) $('mfLoginForm').onsubmit = login;
        card.querySelectorAll('.mf-done').forEach(b => { b.onclick = () => markDone(b.dataset.key); });
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
        #mailFollowupCard .mf-age { flex: none; width: 40px; text-align: right; font-size: 12px; }
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
        setInterval(() => { if (!document.hidden && state === 'ok') load(); }, REFRESH_MS);
        document.addEventListener('visibilitychange', () => { if (!document.hidden && state === 'ok') load(); });
    }

    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount);
    else mount();
})();
