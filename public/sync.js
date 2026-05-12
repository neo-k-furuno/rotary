// ロータリー出欠管理 - オフライン対応クライアント
// iPad のネット切断時にも受付を継続できるよう、ローカルキャッシュ + 出席キュー方式で動作する。
window.RA = (function () {
  const SNAPSHOT_KEY = 'ra_snapshot';
  const SNAPSHOT_TS_KEY = 'ra_snapshot_ts';
  const QUEUE_KEY = 'ra_queue';

  let snapshot = null;
  let queue = [];
  let listeners = { snapshot: [], status: [], queue: [] };
  let status = { online: null, lastPingMs: null, lastSyncAt: null };
  let evtSource = null;
  let sseRetryDelay = 1000;
  let queueDraining = false;

  // ---- Storage ----
  function loadFromStorage() {
    try {
      const raw = localStorage.getItem(SNAPSHOT_KEY);
      if (raw) snapshot = JSON.parse(raw);
    } catch (e) {}
    try {
      queue = JSON.parse(localStorage.getItem(QUEUE_KEY) || '[]');
    } catch (e) {
      queue = [];
    }
  }
  function saveSnapshot() {
    if (!snapshot) return;
    localStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
    localStorage.setItem(SNAPSHOT_TS_KEY, String(Date.now()));
  }
  function saveQueue() {
    localStorage.setItem(QUEUE_KEY, JSON.stringify(queue));
  }

  // ---- Events ----
  function on(type, fn) {
    if (!listeners[type]) listeners[type] = [];
    listeners[type].push(fn);
  }
  function emit(type) {
    for (const fn of listeners[type] || []) {
      try { fn(); } catch (e) { console.error(e); }
    }
  }

  // ---- Status ----
  function setOnline(v) {
    if (status.online === v) return;
    status.online = v;
    emit('status');
  }

  // ---- Time helper ----
  function nowLocal() {
    const d = new Date();
    const pad = (n) => String(n).padStart(2, '0');
    return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
  }

  // ---- Optimistic update + queue overlay ----
  function applyAttendInPlace(memberIds, ts) {
    if (!snapshot) return;
    const set = new Set(memberIds);
    for (const m of snapshot.members) {
      if (set.has(m.id)) {
        if (!m.attended) {
          m.attended = 1;
          m.attended_at = m.attended_at || ts;
        }
      }
    }
  }
  function applyCancelInPlace(memberId) {
    if (!snapshot) return;
    for (const m of snapshot.members) {
      if (m.id === memberId) {
        m.attended = 0;
        m.attended_at = null;
        break;
      }
    }
  }
  // サーバーから snapshot を受け取った後、未送信のキューを再度適用する。
  // これによりサーバーが知らない楽観的更新が消えないようにする。
  function overlayQueue() {
    for (const entry of queue) {
      if (entry.type === 'attend') applyAttendInPlace(entry.memberIds, entry.client_ts);
      else if (entry.type === 'cancel') applyCancelInPlace(entry.memberId);
    }
  }

  // ---- Network ----
  async function fetchWithTimeout(url, opts = {}, ms = 5000) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctrl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function ping() {
    const start = Date.now();
    try {
      const res = await fetchWithTimeout('/api/ping', { cache: 'no-store' }, 4000);
      if (res.ok) {
        status.lastPingMs = Date.now() - start;
        setOnline(true);
        return true;
      }
    } catch (e) {}
    setOnline(false);
    return false;
  }

  async function fetchSnapshot() {
    try {
      const res = await fetchWithTimeout('/api/snapshot', { cache: 'no-store' }, 8000);
      if (!res.ok) throw new Error('http ' + res.status);
      const data = await res.json();
      snapshot = data;
      overlayQueue();
      saveSnapshot();
      status.lastSyncAt = Date.now();
      setOnline(true);
      emit('snapshot');
      return true;
    } catch (e) {
      setOnline(false);
      return false;
    }
  }

  // ---- Queue ----
  function enqueueAttend(memberIds) {
    if (!Array.isArray(memberIds) || memberIds.length === 0) return null;
    const ts = nowLocal();
    const entry = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random(),
      type: 'attend',
      memberIds: memberIds.slice(),
      client_ts: ts,
      attempts: 0,
      created_at: ts,
    };
    queue.push(entry);
    applyAttendInPlace(memberIds, ts);
    saveSnapshot();
    saveQueue();
    emit('snapshot');
    emit('queue');
    drainQueue();
    return entry;
  }

  function enqueueCancel(memberId) {
    // オフライン中は cancel を呼ばせない方針（UI 側で制御）。ここに来たら即送信を試みる。
    const entry = {
      id: (crypto.randomUUID && crypto.randomUUID()) || String(Date.now()) + Math.random(),
      type: 'cancel',
      memberId,
      attempts: 0,
      created_at: nowLocal(),
    };
    queue.push(entry);
    applyCancelInPlace(memberId);
    saveSnapshot();
    saveQueue();
    emit('snapshot');
    emit('queue');
    drainQueue();
    return entry;
  }

  async function drainQueue() {
    if (queueDraining || queue.length === 0) return;
    queueDraining = true;
    try {
      while (queue.length > 0) {
        const entry = queue[0];
        let ok = false;
        try {
          if (entry.type === 'attend') {
            const res = await fetchWithTimeout('/api/attend', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ memberIds: entry.memberIds, client_ts: entry.client_ts }),
            }, 6000);
            ok = res.ok;
          } else if (entry.type === 'cancel') {
            const res = await fetchWithTimeout('/api/cancel', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ memberId: entry.memberId }),
            }, 6000);
            ok = res.ok;
          } else {
            // 未知のエントリは捨てる
            queue.shift();
            saveQueue();
            continue;
          }
        } catch (e) {
          ok = false;
        }
        if (ok) {
          queue.shift();
          saveQueue();
          emit('queue');
          setOnline(true);
          status.lastSyncAt = Date.now();
        } else {
          entry.attempts++;
          saveQueue();
          setOnline(false);
          break;
        }
      }
    } finally {
      queueDraining = false;
    }
  }

  // ---- SSE (auto-reconnect) ----
  function startSSE() {
    if (evtSource) {
      try { evtSource.close(); } catch (e) {}
    }
    try {
      evtSource = new EventSource('/api/events');
    } catch (e) {
      setOnline(false);
      setTimeout(startSSE, sseRetryDelay);
      sseRetryDelay = Math.min(sseRetryDelay * 1.5, 10000);
      return;
    }
    evtSource.onopen = () => {
      sseRetryDelay = 1000;
      setOnline(true);
    };
    evtSource.onmessage = (e) => {
      try {
        const data = JSON.parse(e.data);
        if (data.type === 'attendance_update' || data.type === 'data_reload') {
          fetchSnapshot();
        }
      } catch (err) {}
    };
    evtSource.onerror = () => {
      // EventSource は内部で自動再接続するため、CONNECTING 中の一時エラーは無視。
      // 本当に CLOSED になった時だけ手動で再接続する。
      if (!evtSource || evtSource.readyState !== EventSource.CLOSED) return;
      try { evtSource.close(); } catch (e) {}
      evtSource = null;
      // ping で実際の到達性を確認してから offline 表示する。
      ping();
      setTimeout(startSSE, sseRetryDelay);
      sseRetryDelay = Math.min(sseRetryDelay * 1.5, 10000);
    };
  }

  // ---- Init ----
  async function init() {
    loadFromStorage();
    if (snapshot) emit('snapshot');

    window.addEventListener('online', async () => {
      const ok = await ping();
      if (ok) { await fetchSnapshot(); drainQueue(); }
    });
    window.addEventListener('offline', () => setOnline(false));

    await fetchSnapshot();
    startSSE();

    // 定期的にキューを排出 + 接続確認
    setInterval(() => drainQueue(), 3000);
    setInterval(() => ping(), 10000);

    // ページ復帰時にも同期
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden) {
        ping().then((ok) => { if (ok) { fetchSnapshot(); drainQueue(); } });
      }
    });

    return snapshot;
  }

  // ---- Selectors ----
  function getGroups() {
    return snapshot ? snapshot.groups.slice() : [];
  }
  function getClubsByGroup(groupId) {
    if (!snapshot) return [];
    return snapshot.clubs.filter((c) => c.group_id === groupId);
  }
  function getMembersByClub(clubId) {
    if (!snapshot) return [];
    return snapshot.members.filter((m) => m.club_id === clubId);
  }
  function getMember(id) {
    if (!snapshot) return null;
    return snapshot.members.find((m) => m.id === id) || null;
  }

  return {
    init,
    on,
    enqueueAttend,
    enqueueCancel,
    fetchSnapshot,
    drainQueue,
    ping,
    getSnapshot: () => snapshot,
    getQueue: () => queue.slice(),
    getStatus: () => ({ ...status, queueSize: queue.length }),
    getGroups,
    getClubsByGroup,
    getMembersByClub,
    getMember,
  };
})();
