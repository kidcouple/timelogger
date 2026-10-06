// Postgres lowercases columns, but JS uses camelCase.
const fieldMap = {
    reqdate: 'reqDate', reqtype: 'reqType', pstart: 'pStart', pend: 'pEnd',
    astart: 'aStart', aend: 'aEnd', actualtime: 'actualTime', reqdetail: 'reqDetail', procdetail: 'procDetail',
    reqimages: 'reqImages', procimages: 'procImages', createdat: 'createdAt',
    sessionid: 'sessionId', taskid: 'taskId', tasktitle: 'taskTitle',
    duration: 'duration', client: 'client', project: 'project',
    isissue: 'isIssue', issuememo: 'issueMemo', issueprogress: 'issueProgress', issuefollowup: 'issueFollowUp',
    isurgent: 'isUrgent', isimportant: 'isImportant',
    username: 'userName'
};

const KEEPALIVE_ID = '00000000-0000-4000-8000-000000000001';
const PAGE = 1000;

function toCamel(obj) {
    if (!obj) return obj;
    const res = {};
    for (const [k, v] of Object.entries(obj)) {
        res[fieldMap[k] || k] = v;
    }
    return res;
}

function toLower(obj) {
    if (!obj) return obj;
    const res = {};
    const reversed = Object.fromEntries(Object.entries(fieldMap).map(([k, v]) => [v, k]));
    for (const [k, v] of Object.entries(obj)) {
        res[reversed[k] || k] = v;
    }
    return res;
}

let remoteCfg = null;
async function loadRemoteConfig() {
    if (remoteCfg) return remoteCfg;
    const resp = await fetch('public-config.json', { cache: 'no-store' });
    if (!resp.ok) throw new Error('public-config.json 을 불러오지 못했습니다.');
    remoteCfg = await resp.json();
    if (!remoteCfg.supabaseUrl || !remoteCfg.supabaseAnonKey) {
        throw new Error('Supabase URL/키가 없습니다.');
    }
    remoteCfg.supabaseUrl = String(remoteCfg.supabaseUrl).replace(/\/$/, '');
    return remoteCfg;
}

// ---------- 로그인 (Supabase Auth REST) ----------
// 모든 표는 RLS 로 '로그인한 본인'만 읽고 쓸 수 있다. 공개(publishable) 키만으로는 아무것도 안 됨.
// 로그인 토큰은 이 브라우저 localStorage 에만 저장 (키·이메일은 코드에 넣지 않음).
const TL_Auth = (() => {
    const AUTH_KEY = 'TL_MAIL_AUTH';   // 메일 카드에서 먼저 쓰던 이름 그대로 (이미 로그인한 브라우저는 다시 로그인 불필요)
    let refreshing = null;

    function load() {
        try { return JSON.parse(localStorage.getItem(AUTH_KEY) || 'null'); } catch (e) { return null; }
    }
    function save(a) {
        try { a ? localStorage.setItem(AUTH_KEY, JSON.stringify(a)) : localStorage.removeItem(AUTH_KEY); } catch (e) { }
    }
    async function token(grant, body) {
        const cfg = await loadRemoteConfig();
        const r = await fetch(`${cfg.supabaseUrl}/auth/v1/token?grant_type=${grant}`, {
            method: 'POST',
            headers: { apikey: cfg.supabaseAnonKey, 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok) {
            const e = new Error(j.error_description || j.msg || j.message || `로그인 실패 (${r.status})`);
            e.status = r.status;
            throw e;
        }
        const a = { access: j.access_token, refresh: j.refresh_token, exp: Date.now() + (j.expires_in || 3600) * 1000, email: (j.user && j.user.email) || '' };
        save(a);
        return a;
    }
    function needLogin() {
        const e = new Error('로그인이 필요합니다.');
        e.needLogin = true;
        return e;
    }
    // 유효한 access token (만료 1분 전이면 갱신). 로그인 안 돼 있으면 null.
    async function accessToken() {
        let a = load();
        if (!a) return null;
        if (Date.now() > a.exp - 60 * 1000) {
            // 여러 요청이 동시에 갱신하면 refresh token 이 한 번만 유효하므로 하나로 묶는다
            refreshing = refreshing || token('refresh_token', { refresh_token: a.refresh }).finally(() => { refreshing = null; });
            try {
                a = await refreshing;
            } catch (e) {
                if (e.status >= 400 && e.status < 500) { save(null); return null; }   // 만료·폐기 → 다시 로그인
                throw e;                                                              // 네트워크 오류는 로그인 유지
            }
        }
        return a.access;
    }
    async function logout() {
        const a = load();
        save(null);
        if (a) {
            try {
                const cfg = await loadRemoteConfig();
                await fetch(`${cfg.supabaseUrl}/auth/v1/logout`, { method: 'POST', headers: { apikey: cfg.supabaseAnonKey, Authorization: `Bearer ${a.access}` } });
            } catch (e) { }
        }
    }
    // 로컬 Flask(/api/*) 호출용 헤더
    async function authHeaders() {
        const t = await accessToken();
        if (!t) { showGate(); throw needLogin(); }
        return { Authorization: `Bearer ${t}` };
    }

    // 로그인 안 돼 있으면 화면 전체를 덮는 로그인 창. 성공하면 새로고침해서 데이터를 다시 불러온다.
    function showGate(msg) {
        if (document.getElementById('tlAuthGate')) return;
        if (!document.body) { document.addEventListener('DOMContentLoaded', () => showGate(msg)); return; }
        const g = document.createElement('div');
        g.id = 'tlAuthGate';
        g.innerHTML = `<form id="tlAuthForm" style="background:#1c1f27;border:1px solid #2a2d35;border-radius:12px;padding:24px;width:min(340px,calc(100vw - 32px));display:flex;flex-direction:column;gap:10px;color:#e6edf3;font-family:Inter,sans-serif;">
                <div style="font-size:16px;font-weight:700;">🔒 Time Logger 로그인</div>
                <div style="font-size:12px;color:#8b949e;">Supabase 계정으로 로그인해야 데이터를 볼 수 있습니다.</div>
                <input id="tlAuthEmail" type="email" placeholder="이메일" autocomplete="username" required style="background:#111318;border:1px solid #2a2d35;color:#e6edf3;border-radius:6px;padding:8px 10px;font-size:14px;">
                <input id="tlAuthPw" type="password" placeholder="비밀번호" autocomplete="current-password" required style="background:#111318;border:1px solid #2a2d35;color:#e6edf3;border-radius:6px;padding:8px 10px;font-size:14px;">
                <button id="tlAuthBtn" type="submit" style="background:#4f8ef7;border:none;color:#fff;border-radius:6px;padding:9px;font-size:14px;font-weight:600;cursor:pointer;">로그인</button>
                <div id="tlAuthMsg" style="font-size:12px;color:#f85149;min-height:14px;"></div>
            </form>`;
        g.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(10,12,16,0.92);display:flex;align-items:center;justify-content:center;';
        document.body.appendChild(g);
        const m = document.getElementById('tlAuthMsg');
        if (msg) m.textContent = msg;
        document.getElementById('tlAuthForm').onsubmit = async ev => {
            ev.preventDefault();
            const btn = document.getElementById('tlAuthBtn');
            btn.disabled = true;
            btn.textContent = '로그인 중..';
            m.textContent = '';
            try {
                await token('password', { email: document.getElementById('tlAuthEmail').value.trim(), password: document.getElementById('tlAuthPw').value });
                location.reload();
            } catch (e) {
                m.textContent = e.message;
                btn.disabled = false;
                btn.textContent = '로그인';
            }
        };
        document.getElementById('tlAuthEmail').focus();
    }

    if (!load()) showGate();
    return { load, accessToken, authHeaders, logout, showGate, needLogin, signIn: (email, password) => token('password', { email, password }) };
})();
window.TL_Auth = TL_Auth;

// 로컬 Flask(/api/*) 호출: 로그인 토큰을 붙인다 (서버가 Supabase 에 토큰을 확인)
async function tlApiFetch(url, init = {}) {
    const headers = { ...(init.headers || {}), ...(await TL_Auth.authHeaders()) };
    return fetch(url, { ...init, headers });
}
// 토큰이 필요한 파일 내려받기 (<a href> 로는 헤더를 못 붙이므로 받아서 저장)
async function tlApiDownload(url) {
    const r = await tlApiFetch(url);
    if (!r.ok) throw new Error((await r.text()) || `다운로드 실패 (${r.status})`);
    const cd = r.headers.get('Content-Disposition') || '';
    const m = cd.match(/filename\*=UTF-8''([^;]+)/i) || cd.match(/filename="?([^";]+)"?/i);
    const name = m ? decodeURIComponent(m[1]) : 'download.xlsx';
    const href = URL.createObjectURL(await r.blob());
    const a = document.createElement('a');
    a.href = href;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(href), 10000);
}
window.tlApiFetch = tlApiFetch;
window.tlApiDownload = tlApiDownload;

const supabase = {
    get currentUser() {
        return localStorage.getItem('TL_USER') || '황선균';
    },
    set currentUser(val) {
        localStorage.setItem('TL_USER', val);
    },

    // 로컬(app.py)에서 열어도 브라우저가 로그인 토큰으로 Supabase 에 직접 접속한다 (서버를 거치는 /api/db 는 없앰)
    async fetch(table, options = {}) {
        const cfg = await loadRemoteConfig();
        const token = await TL_Auth.accessToken();
        if (!token) { TL_Auth.showGate(); throw TL_Auth.needLogin(); }
        const method = options.method || 'GET';
        const headers = {
            apikey: cfg.supabaseAnonKey,
            Authorization: `Bearer ${token}`,
            Accept: 'application/json'
        };
        // 토큰이 서버에서 거부되면(만료·폐기) 로그인 창
        const fetch = async (url, init) => {
            const r = await window.fetch(url, init);
            if (r.status === 401) { await TL_Auth.logout(); TL_Auth.showGate('로그인이 만료되었습니다. 다시 로그인하세요.'); throw TL_Auth.needLogin(); }
            return r;
        };

        const params = new URLSearchParams();
        const query = { ...(options.query || {}) };
        if (method === 'GET' || method === 'DELETE') {
            params.set('username', `eq.${this.currentUser}`);
        }
        for (const [k, v] of Object.entries(query)) {
            if (v === undefined || v === null) continue;
            const col = String(k).replace(/^eq\./, '');
            const val = String(v).replace(/^eq\./, '');
            params.set(col, `eq.${val}`);
        }

        if (method === 'GET') {
            params.set('select', '*');
            const rows = [];
            let offset = 0;
            while (true) {
                const rangeHeaders = { ...headers, Range: `${offset}-${offset + PAGE - 1}`, Prefer: 'count=exact' };
                const url = `${cfg.supabaseUrl}/rest/v1/${table}?${params}`;
                const response = await fetch(url, { method: 'GET', headers: rangeHeaders });
                if (!response.ok) {
                    throw new Error(await response.text());
                }
                const text = await response.text();
                const chunk = text ? JSON.parse(text) : [];
                const list = Array.isArray(chunk) ? chunk : [];
                rows.push(...list.map(toCamel));
                if (list.length < PAGE) break;
                offset += PAGE;
            }
            if (table === 'weekly_reports') {
                return rows.filter(r => r.id !== KEEPALIVE_ID);
            }
            return rows;
        }

        if (method === 'POST') {
            headers['Content-Type'] = 'application/json';
            headers.Prefer = 'resolution=merge-duplicates,return=minimal';
            let body = Array.isArray(options.body) ? options.body : [options.body];
            body.forEach(item => {
                if (!item.userName && !item.username) item.userName = this.currentUser;
            });
            body = body.map(toLower);
            const url = `${cfg.supabaseUrl}/rest/v1/${table}`;
            for (let i = 0; i < body.length; i += 80) {
                const chunk = body.slice(i, i + 80);
                const response = await fetch(url, { method: 'POST', headers, body: JSON.stringify(chunk) });
                if (!response.ok) {
                    throw new Error(await response.text());
                }
            }
            return null;
        }

        if (method === 'DELETE') {
            headers.Prefer = 'return=minimal';
            const url = `${cfg.supabaseUrl}/rest/v1/${table}?${params}`;
            const response = await fetch(url, { method: 'DELETE', headers });
            if (!response.ok) {
                throw new Error(await response.text());
            }
            return null;
        }

        throw new Error(`unsupported method ${method}`);
    },

    async getTable(table) {
        return await this.fetch(table) || [];
    },

    async upsert(table, data) {
        return await this.fetch(table, {
            method: 'POST',
            body: data
        });
    },

    async delete(table, idColumn, idValue) {
        return await this.fetch(table, {
            method: 'DELETE',
            query: { [idColumn]: idValue }
        });
    }
};

window.supabaseAPI = supabase;
