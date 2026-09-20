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

function isLocalHost() {
    const h = location.hostname;
    return h === 'localhost' || h === '127.0.0.1';
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

const supabase = {
    get currentUser() {
        return localStorage.getItem('TL_USER') || '황선균';
    },
    set currentUser(val) {
        localStorage.setItem('TL_USER', val);
    },

    async fetch(table, options = {}) {
        if (isLocalHost()) {
            try {
                return await this._fetchLocal(table, options);
            } catch (e) {
                console.warn('local /api/db failed, using Supabase REST', e);
            }
        }
        return await this._fetchRemote(table, options);
    },

    async _fetchLocal(table, options = {}) {
        let url = `/api/db/${table}`;
        const queryParams = { ...(options.query || {}), username: this.currentUser };
        const qs = new URLSearchParams();
        for (const [k, v] of Object.entries(queryParams)) {
            if (v === undefined || v === null) continue;
            qs.set(k, String(v).replace(/^eq\./, ''));
        }
        const q = qs.toString();
        if (q) url += '?' + q;

        const method = options.method || 'GET';
        const fetchOptions = { method, headers: { 'Content-Type': 'application/json' } };
        if (options.body) {
            const body = Array.isArray(options.body) ? options.body : [options.body];
            body.forEach(item => {
                if (!item.userName && !item.username) item.userName = this.currentUser;
            });
            fetchOptions.body = JSON.stringify(body.length === 1 ? toLower(body[0]) : body.map(toLower));
        }

        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
            const errText = await response.text();
            throw new Error(errText);
        }
        if (response.status === 204) return null;
        const text = await response.text();
        if (!text) return null;
        const data = JSON.parse(text);
        return Array.isArray(data) ? data.map(toCamel) : toCamel(data);
    },

    async _fetchRemote(table, options = {}) {
        const cfg = await loadRemoteConfig();
        const method = options.method || 'GET';
        const headers = {
            apikey: cfg.supabaseAnonKey,
            Authorization: `Bearer ${cfg.supabaseAnonKey}`,
            Accept: 'application/json'
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
