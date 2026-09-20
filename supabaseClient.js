// Postgres/SQLite lowercases columns, but JS uses camelCase.
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

const supabase = {
    get currentUser() {
        return localStorage.getItem('TL_USER') || '황선균';
    },
    set currentUser(val) {
        localStorage.setItem('TL_USER', val);
    },

    _headers() {
        return { 'Content-Type': 'application/json' };
    },

    async fetch(table, options = {}) {
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
        const fetchOptions = { method, headers: this._headers() };
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
            console.error(`DB Error (${method} ${table}):`, errText);
            throw new Error(errText);
        }

        if (response.status === 204) return null;

        const text = await response.text();
        if (!text) return null;

        const data = JSON.parse(text);
        return Array.isArray(data) ? data.map(toCamel) : toCamel(data);
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
