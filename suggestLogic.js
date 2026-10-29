// 자동 제안(time_suggestions) 계산 — 화면(review.html)·주간보고·시험(node)이 같이 쓰는 순수 함수 모음.
// 상태: suggested(제안) · confirmed(확인) · discarded(버림). 확인하지 않은 제안은 시간으로 치지 않는다.
(function (root) {
    const SNAP = 15;

    const pad = n => String(n).padStart(2, '0');
    // 'YYYY-MM-DD' (현지 날짜)
    const dayOf = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
    // 주간보고·할일이 쓰는 'YYYY. MM. DD'
    const dotDay = day => day.replace(/^(\d{4})-(\d{2})-(\d{2})$/, '$1. $2. $3');

    // 그날 0시부터의 분 (다른 날이면 0 / 1440 으로 자름)
    function minOfDay(iso, day) {
        const d = new Date(iso);
        const base = new Date(`${day}T00:00:00`);
        const m = Math.round((d - base) / 60000);
        return Math.max(0, Math.min(1440, m));
    }
    function isoAt(day, minutes) {
        const base = new Date(`${day}T00:00:00`);
        return new Date(base.getTime() + minutes * 60000).toISOString();
    }
    // 15분 단위로 붙임 (fine=true 면 1분 단위)
    function snap(minutes, fine) {
        const s = fine ? 1 : SNAP;
        return Math.round(minutes / s) * s;
    }
    const durMin = (start, end) => Math.max(0, Math.round((new Date(end) - new Date(start)) / 60000));

    // 그날 겹치는 기록(logs)
    function logsOfDay(logs, day) {
        return (logs || []).filter(l => l && l.start && l.end && dayOf(new Date(l.start)) === day);
    }
    function suggestionsOfDay(sugs, day) {
        return (sugs || []).filter(s => s && s.day === day && (s.kind || 'work') !== 'idle');   // 자리 비움은 2차에서
    }

    // 위쪽 요약 줄: 확인 시간 / 남은 제안 / 미배정
    function summarize(sugs, logs, day) {
        const ls = logsOfDay(logs, day);
        const confirmedMin = ls.reduce((a, l) => a + (parseFloat(l.duration) || durMin(l.start, l.end)), 0)
            + suggestionsOfDay(sugs, day).filter(s => s.status === 'confirmed' && !s.taskId)
                .reduce((a, s) => a + durMin(s.start, s.end), 0);
        const pending = suggestionsOfDay(sugs, day).filter(s => s.status === 'suggested');
        return {
            confirmedMin,
            pending: pending.length,
            unassigned: pending.filter(s => !s.taskId).length
        };
    }

    // 확인: 할일이 있으면 logs 한 줄 + 할일 시간 누적 (타이머와 같은 규칙: aStart 비었으면 그날로)
    function confirm(s, task, now) {
        const at = (now || new Date()).toISOString();
        const out = { suggestion: { ...s, status: 'confirmed', updatedAt: at }, log: null, task: null };
        if (!s.taskId || !task) return out;               // 미배정 확인 → 기록은 만들지 않음 (주간보고 제외, 경고에만 셈)
        const minutes = durMin(s.start, s.end);
        const sid = 'G' + s.id;
        out.log = { sessionId: sid, taskId: task.id, taskTitle: task.title, start: s.start, end: s.end, duration: minutes };
        out.suggestion.logId = sid;
        const t = { ...task };
        const as = String(t.aStart || '').trim();
        if (!as || as === '"') t.aStart = dotDay(s.day);
        t.actualTime = Math.round(parseFloat(t.actualTime || 0)) + minutes;
        if (t.status === 'todo') t.status = 'wip';
        out.task = t;
        return out;
    }

    function discard(s, now) {
        return { ...s, status: 'discarded', updatedAt: (now || new Date()).toISOString() };
    }
    function restore(s, now) {                           // 버림 되돌리기
        return { ...s, status: 'suggested', updatedAt: (now || new Date()).toISOString() };
    }
    // 모두 확인: 배정된 제안만
    function confirmAllTargets(sugs, day) {
        return suggestionsOfDay(sugs, day).filter(s => s.status === 'suggested' && s.taskId);
    }

    // 시간표에 그릴 블록 (버림 제외). 확인된 제안은 기록(logs)으로 이미 보이므로 중복 제외
    function blocks(sugs, logs, day) {
        const out = [];
        for (const l of logsOfDay(logs, day)) {
            out.push({ kind: 'log', id: l.sessionId, taskId: l.taskId, s: minOfDay(l.start, day), e: minOfDay(l.end, day) });
        }
        for (const x of suggestionsOfDay(sugs, day)) {
            if (x.status === 'discarded') continue;
            if (x.status === 'confirmed' && x.logId) continue;
            out.push({ kind: x.status === 'confirmed' ? 'confirmed' : 'suggested', id: x.id, taskId: x.taskId || null,
                       area: x.area, s: minOfDay(x.start, day), e: minOfDay(x.end, day) });
        }
        return out.sort((a, b) => a.s - b.s);
    }

    // 근무시간 안의 빈 구간 (분). 클릭 → 기록으로 채우기
    function gaps(bl, workStart, workEnd) {
        const res = [];
        let cur = workStart;
        for (const b of bl.slice().sort((a, b) => a.s - b.s)) {
            if (b.e <= cur) continue;
            if (b.s > cur) res.push({ s: cur, e: Math.min(b.s, workEnd) });
            cur = Math.max(cur, b.e);
            if (cur >= workEnd) break;
        }
        if (cur < workEnd) res.push({ s: cur, e: workEnd });
        return res.filter(g => g.e - g.s >= 1);
    }

    // 주간보고: 그 주에 기록(logs)이 있는 할일 id
    function taskIdsWithLogs(logs, startDate, endDate) {
        const s = new Date(startDate); s.setHours(0, 0, 0, 0);
        const e = new Date(endDate); e.setHours(23, 59, 59, 999);
        const ids = new Set();
        for (const l of logs || []) {
            if (!l || !l.start || !l.taskId) continue;
            const d = new Date(l.start);
            if (d >= s && d <= e && (parseFloat(l.duration) || 0) > 0) ids.add(String(l.taskId));
        }
        return ids;
    }
    // 주간보고 경고: 확인됐지만 미배정인 시간(분)
    function unassignedMinutes(sugs, startDate, endDate) {
        const s = dayOf(new Date(startDate)), e = dayOf(new Date(endDate));
        return (sugs || []).filter(x => x && x.status === 'confirmed' && !x.taskId && (x.kind || 'work') !== 'idle' && x.day >= s && x.day <= e)
            .reduce((a, x) => a + durMin(x.start, x.end), 0);
    }

    const api = { SNAP, dayOf, dotDay, minOfDay, isoAt, snap, durMin, summarize, confirm, discard, restore,
                  confirmAllTargets, blocks, gaps, taskIdsWithLogs, unassignedMinutes };
    if (typeof module !== 'undefined' && module.exports) module.exports = api;
    else root.TL_Suggest = api;
})(typeof window !== 'undefined' ? window : globalThis);
