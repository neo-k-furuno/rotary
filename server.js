const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = parseInt(process.env.PORT, 10) || 3000;

// --- Database Setup ---
// 本番では DB_PATH 環境変数で永続ボリューム上のパスを指定する (例: /data/attendance.db)
const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'attendance.db');
const dbDir = path.dirname(DB_PATH);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS groups_tbl (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL UNIQUE
  );
  CREATE TABLE IF NOT EXISTS clubs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES groups_tbl(id),
    name TEXT NOT NULL,
    UNIQUE(group_id, name)
  );
  CREATE TABLE IF NOT EXISTS committees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    room TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 999
  );
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL REFERENCES clubs(id),
    committee_id INTEGER REFERENCES committees(id),
    name TEXT NOT NULL,
    name_kana TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    attended INTEGER NOT NULL DEFAULT 0,
    attended_at TEXT
  );
`);

// 既存DBから role / tag / committee_id カラムが無ければ追加 (マイグレーション)
const memberCols = db.prepare("PRAGMA table_info(members)").all().map(c => c.name);
if (!memberCols.includes('role')) {
  db.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT ''");
}
if (!memberCols.includes('tag')) {
  db.exec("ALTER TABLE members ADD COLUMN tag TEXT NOT NULL DEFAULT ''");
}
if (!memberCols.includes('committee_id')) {
  db.exec("ALTER TABLE members ADD COLUMN committee_id INTEGER REFERENCES committees(id)");
}

// 設定保存用テーブル (key-value)
db.exec(`
  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT
  );
  CREATE TABLE IF NOT EXISTS sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT NOT NULL,
    ended_at TEXT,
    note TEXT NOT NULL DEFAULT '',
    total_members INTEGER NOT NULL DEFAULT 0,
    total_attended INTEGER NOT NULL DEFAULT 0,
    snapshot_json TEXT
  );
`);

// 控え室設定の初期値 (なければ作成)
// 新形式: タグごとに個別メッセージを持つ
const defaultLounge = {
  enabled: true,
  tags: {
    '2026-27年度・三役':         { message: '' },
    'ゲスト・講演者':            { message: '' },
    '2026-27年度・ガバナー補佐': { message: '' },
    '協議会主導・委員長':        { message: '' },
    '支援室':                    { message: '' },
  },
  members: {}, // { "<member_id>": { message: '...' } }
};
const existing = db.prepare("SELECT value FROM settings WHERE key = 'lounge'").get();
if (!existing) {
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES ('lounge', ?, datetime('now', 'localtime'))"
  ).run(JSON.stringify(defaultLounge));
} else {
  // 旧形式 (tags: array + message: string) を新形式に自動マイグレーション
  try {
    const old = JSON.parse(existing.value);
    if (Array.isArray(old.tags) || typeof old.message === 'string') {
      const migrated = { enabled: old.enabled !== false, tags: {}, members: {} };
      // 既存タグ全部にデフォルトの旧 message を入れる
      for (const t of Object.keys(defaultLounge.tags)) {
        const wasIncluded = Array.isArray(old.tags) && old.tags.includes(t);
        migrated.tags[t] = { message: wasIncluded ? (old.message || '') : '' };
      }
      // member_ids -> members
      for (const id of (old.member_ids || [])) {
        migrated.members[String(id)] = { message: old.message || '' };
      }
      db.prepare("UPDATE settings SET value = ?, updated_at = datetime('now', 'localtime') WHERE key = 'lounge'")
        .run(JSON.stringify(migrated));
      console.log('lounge設定を新形式 (タグごとメッセージ) に移行しました');
    }
  } catch (e) {
    console.error('lounge設定マイグレーション失敗:', e.message);
  }
}

// --- SSE for real-time updates ---
const sseClients = new Set();

function broadcast(data) {
  const msg = `data: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    res.write(msg);
  }
}

// --- Middleware ---
app.use(express.json());

// ============== 認証 ==============
// 環境変数で上書き可能。本番は Fly.io secrets で設定推奨。
const STAFF_PASSWORD = process.env.STAFF_PASSWORD || 'tojima';
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'tjm';
const OWNER_PASSWORD = process.env.OWNER_PASSWORD || 'owner';
const APP_SECRET    = process.env.APP_SECRET    || 'dev-secret-change-me';
const COOKIE_MAX_AGE = 24 * 60 * 60; // 1日

function hmac(s) { return crypto.createHmac('sha256', APP_SECRET).update(s).digest('hex'); }
function makeToken(role) { return role + '.' + hmac(role); }
function verifyToken(token) {
  if (!token) return null;
  const i = token.indexOf('.');
  if (i <= 0) return null;
  const role = token.slice(0, i);
  const sig  = token.slice(i + 1);
  if (role !== 'staff' && role !== 'admin' && role !== 'owner') return null;
  if (hmac(role) !== sig) return null;
  return role;
}
function parseCookies(header) {
  const out = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    out[part.slice(0, idx).trim()] = decodeURIComponent(part.slice(idx + 1).trim());
  }
  return out;
}

// 各ページに必要なロール (staff専用 / admin専用 / owner専用 / 共通)
const PATH_ROLE = {
  '/':               'staff',
  '/index.html':     'staff',
  '/admin.html':     'admin',
  '/dashboard.html': 'admin',
  '/owner.html':     'owner',
};
// 管理者専用 API (書き込み・設定系)
const ADMIN_API_RE = /^\/api\/(import|export|reset|settings|members)(\/|$)/;
// オーナー専用 API
const OWNER_API_RE = /^\/api\/owner(\/|$)/;

// ログインAPI
app.post('/api/login', (req, res) => {
  const pw = (req.body && req.body.password) || '';
  let role = null;
  if (pw === OWNER_PASSWORD)      role = 'owner';
  else if (pw === ADMIN_PASSWORD) role = 'admin';
  else if (pw === STAFF_PASSWORD) role = 'staff';
  if (!role) return res.status(401).json({ error: 'wrong password' });
  const token = makeToken(role);
  const attrs = [`app_auth=${token}`, `Max-Age=${COOKIE_MAX_AGE}`, 'Path=/', 'HttpOnly', 'SameSite=Lax'];
  if (process.env.NODE_ENV === 'production') attrs.push('Secure');
  res.setHeader('Set-Cookie', attrs.join('; '));
  res.json({ ok: true, role });
});

// 認証チェック middleware
app.use((req, res, next) => {
  // 認証不要なエンドポイント
  if (req.path === '/login.html' || req.path === '/api/login' || req.path === '/api/ping') return next();
  // JS/CSS/画像/font 等の静的アセットは公開 (HTMLは認証)
  if (/\.(js|css|png|jpe?g|webp|svg|ico|json|woff2?|map)$/i.test(req.path)) return next();

  const cookies = parseCookies(req.headers.cookie || '');
  const role = verifyToken(cookies.app_auth);

  // ブラウザのHTMLナビゲーションかAPI/fetchかを区別 (API は 302 redirect されない)
  const isApi = req.path.startsWith('/api/');
  const isHtmlNav = !isApi && (req.headers.accept || '').includes('text/html');

  if (!role) {
    if (isHtmlNav) {
      return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.status(401).json({ error: 'auth required' });
  }

  // ページ毎の必要ロール (staff専用 / admin専用) を厳密にチェック
  const requiredPathRole = PATH_ROLE[req.path];
  if (requiredPathRole && requiredPathRole !== role) {
    if (isHtmlNav) {
      // HTML ナビは再ログインを促す (異なるロールのページに行くにはパスワード入れ直し)
      return res.redirect('/login.html?next=' + encodeURIComponent(req.originalUrl));
    }
    return res.status(403).json({ error: `role required: ${requiredPathRole}` });
  }
  // admin専用 API
  if (ADMIN_API_RE.test(req.path) && role !== 'admin') {
    return res.status(403).json({ error: 'admin only' });
  }
  // owner専用 API
  if (OWNER_API_RE.test(req.path) && role !== 'owner') {
    return res.status(403).json({ error: 'owner only' });
  }
  req.userRole = role;
  next();
});
// ===================================

app.use(express.static(path.join(__dirname, 'public')));

// --- SSE endpoint ---
app.get('/api/events', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();
  sseClients.add(res);
  req.on('close', () => sseClients.delete(res));
});

// --- API: Groups ---
app.get('/api/groups', (req, res) => {
  const rows = db.prepare('SELECT id, name FROM groups_tbl ORDER BY id').all();
  res.json(rows);
});

// --- API: Clubs by group ---
app.get('/api/groups/:groupId/clubs', (req, res) => {
  const rows = db.prepare('SELECT id, name FROM clubs WHERE group_id = ? ORDER BY name').all(req.params.groupId);
  res.json(rows);
});

// --- API: Settings (key-value) ---
app.get('/api/settings/:key', (req, res) => {
  const row = db.prepare('SELECT value, updated_at FROM settings WHERE key = ?').get(req.params.key);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    res.json({ value: JSON.parse(row.value), updated_at: row.updated_at });
  } catch (e) {
    res.json({ value: row.value, updated_at: row.updated_at });
  }
});

app.put('/api/settings/:key', (req, res) => {
  const value = req.body && req.body.value;
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  const serialized = typeof value === 'string' ? value : JSON.stringify(value);
  db.prepare(
    "INSERT INTO settings (key, value, updated_at) VALUES (?, ?, datetime('now', 'localtime'))" +
    " ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at"
  ).run(req.params.key, serialized);
  broadcast({ type: 'settings_update', key: req.params.key });
  res.json({ ok: true });
});

// --- API: Members by tag (大タグでの一括取得) ---
app.get('/api/tags/:tag/members', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, name_kana, role, tag, attended FROM members WHERE tag = ? ORDER BY name_kana, name'
  ).all(req.params.tag);
  res.json(rows);
});

// --- API: Members CRUD (admin) ---
// POST /api/members - 新規作成 (club_id, name 必須)
app.post('/api/members', (req, res) => {
  const b = req.body || {};
  if (!b.club_id || !b.name) return res.status(400).json({ error: 'club_id and name required' });
  const club = db.prepare('SELECT id FROM clubs WHERE id = ?').get(b.club_id);
  if (!club) return res.status(400).json({ error: 'club_id not found' });
  if (b.committee_id) {
    const co = db.prepare('SELECT id FROM committees WHERE id = ?').get(b.committee_id);
    if (!co) return res.status(400).json({ error: 'committee_id not found' });
  }
  const info = db.prepare(
    'INSERT INTO members (club_id, committee_id, name, name_kana, role, tag) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(
    b.club_id,
    b.committee_id || null,
    String(b.name).trim(),
    String(b.name_kana || '').trim(),
    String(b.role || '').trim(),
    String(b.tag || '').trim()
  );
  broadcast({ type: 'data_reload' });
  res.json({ ok: true, id: info.lastInsertRowid });
});

// PUT /api/members/:id - 更新 (フィールドは部分更新可)
app.put('/api/members/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT * FROM members WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  const b = req.body || {};
  if (b.club_id) {
    const club = db.prepare('SELECT id FROM clubs WHERE id = ?').get(b.club_id);
    if (!club) return res.status(400).json({ error: 'club_id not found' });
  }
  if (b.committee_id) {
    const co = db.prepare('SELECT id FROM committees WHERE id = ?').get(b.committee_id);
    if (!co) return res.status(400).json({ error: 'committee_id not found' });
  }
  const updated = {
    club_id: b.club_id !== undefined ? b.club_id : existing.club_id,
    committee_id: b.committee_id !== undefined ? (b.committee_id || null) : existing.committee_id,
    name: b.name !== undefined ? String(b.name).trim() : existing.name,
    name_kana: b.name_kana !== undefined ? String(b.name_kana).trim() : existing.name_kana,
    role: b.role !== undefined ? String(b.role).trim() : existing.role,
    tag: b.tag !== undefined ? String(b.tag).trim() : existing.tag,
  };
  db.prepare(
    'UPDATE members SET club_id = ?, committee_id = ?, name = ?, name_kana = ?, role = ?, tag = ? WHERE id = ?'
  ).run(updated.club_id, updated.committee_id, updated.name, updated.name_kana, updated.role, updated.tag, id);
  broadcast({ type: 'data_reload' });
  res.json({ ok: true });
});

// DELETE /api/members/:id - 削除
app.delete('/api/members/:id', (req, res) => {
  const id = parseInt(req.params.id, 10);
  const existing = db.prepare('SELECT id FROM members WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'not found' });
  db.prepare('DELETE FROM members WHERE id = ?').run(id);
  broadcast({ type: 'data_reload' });
  res.json({ ok: true });
});

// --- API: Members by club ---
app.get('/api/clubs/:clubId/members', (req, res) => {
  const rows = db.prepare(
    'SELECT id, name, name_kana, role, tag, attended FROM members WHERE club_id = ? ORDER BY name_kana, name'
  ).all(req.params.clubId);
  res.json(rows);
});

// --- API: Mark attendance (multiple) ---
// 冪等。既に出席済みの場合 attended_at は上書きしない（先勝ち）。
// client_ts を受け取り、オフライン中の操作でも本来の受付時刻を記録する。
// レスポンスには各IDが「新規登録」だったか「既に出席済み」だったかを返し、
// 別端末で先に受付された場合に運用者が気付けるようにする。
app.post('/api/attend', (req, res) => {
  const { memberIds, client_ts } = req.body;
  if (!Array.isArray(memberIds) || memberIds.length === 0) {
    return res.status(400).json({ error: 'memberIds required' });
  }
  const ts = client_ts || nowLocal();
  const placeholders = memberIds.map(() => '?').join(',');
  const before = db.prepare(
    `SELECT id, name, attended, attended_at FROM members WHERE id IN (${placeholders})`
  ).all(...memberIds);
  const beforeMap = new Map(before.map((m) => [m.id, m]));

  const stmt = db.prepare(
    'UPDATE members SET attended = 1, attended_at = COALESCE(attended_at, ?) WHERE id = ?'
  );
  const tx = db.transaction((ids) => {
    for (const id of ids) stmt.run(ts, id);
  });
  tx(memberIds);

  const results = memberIds.map((id) => {
    const m = beforeMap.get(id);
    if (!m) return { id, status: 'not_found' };
    return {
      id,
      name: m.name,
      status: m.attended === 1 ? 'already_attended' : 'newly_attended',
      attended_at: m.attended === 1 ? m.attended_at : ts,
    };
  });

  broadcast({ type: 'attendance_update' });
  res.json({ ok: true, results });
});

function nowLocal() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}

// --- API: Snapshot (groups + clubs + members を一括取得) ---
// iPad 起動時に1回だけ叩く想定。以後は SSE でローカルキャッシュを更新。
app.get('/api/snapshot', (req, res) => {
  const groups = db.prepare('SELECT id, name FROM groups_tbl ORDER BY id').all();
  const clubs = db.prepare('SELECT id, group_id, name FROM clubs ORDER BY group_id, name').all();
  const members = db.prepare(
    'SELECT id, club_id, committee_id, name, name_kana, role, tag, attended, attended_at FROM members ORDER BY club_id, name_kana, name'
  ).all();
  const committees = db.prepare(
    'SELECT id, name, room, sort_order FROM committees ORDER BY sort_order, id'
  ).all();
  const settingsRows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  for (const r of settingsRows) {
    try { settings[r.key] = JSON.parse(r.value); }
    catch (e) { settings[r.key] = r.value; }
  }
  res.json({ groups, clubs, members, committees, settings, server_ts: nowLocal() });
});

// --- API: Ping (接続テスト用) ---
app.get('/api/ping', (req, res) => {
  res.json({ ok: true, ts: Date.now() });
});

// --- API: Cancel attendance ---
app.post('/api/cancel', (req, res) => {
  const { memberId } = req.body;
  if (!memberId) return res.status(400).json({ error: 'memberId required' });
  db.prepare('UPDATE members SET attended = 0, attended_at = NULL WHERE id = ?').run(memberId);
  broadcast({ type: 'attendance_update' });
  res.json({ ok: true });
});

// --- API: Dashboard data ---
app.get('/api/dashboard', (req, res) => {
  const clubs = db.prepare(`
    SELECT c.id, c.name as club_name, g.name as group_name, g.id as group_id,
      COUNT(m.id) as total,
      SUM(CASE WHEN m.attended = 1 THEN 1 ELSE 0 END) as attended
    FROM clubs c
    JOIN groups_tbl g ON c.group_id = g.id
    JOIN members m ON m.club_id = c.id
    GROUP BY c.id
    ORDER BY g.id, c.name
  `).all();

  const members = db.prepare(`
    SELECT m.id, m.name, m.name_kana, m.role, m.tag, m.attended, m.attended_at,
      c.id as club_id, c.name as club_name,
      g.id as group_id, g.name as group_name,
      m.committee_id
    FROM members m
    JOIN clubs c ON m.club_id = c.id
    JOIN groups_tbl g ON c.group_id = g.id
    ORDER BY g.id, c.name, m.name
  `).all();

  const committees = db.prepare(
    'SELECT id, name, room FROM committees ORDER BY sort_order, id'
  ).all();

  const totalMembers = members.length;
  const totalAttended = members.filter(m => m.attended).length;

  res.json({ clubs, members, committees, totalMembers, totalAttended });
});

// --- CSV helpers ---
function csvQuote(s) {
  if (s == null) return '';
  const v = String(s);
  return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
}
// 1行を CSV カラムに分解 (簡易: 引用符内のカンマに対応)
function parseCsvLine(line) {
  const out = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else { inQ = false; }
      } else {
        cur += ch;
      }
    } else {
      if (ch === ',') { out.push(cur); cur = ''; }
      else if (ch === '"' && cur === '') { inQ = true; }
      else { cur += ch; }
    }
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// --- API: CSV Export ---
app.get('/api/export', (req, res) => {
  const rows = db.prepare(`
    SELECT g.name as group_name, c.name as club_name, m.name as member_name,
      m.role, m.tag,
      COALESCE(co.name, '') as committee_name,
      COALESCE(co.room, '') as committee_room,
      CASE WHEN m.attended = 1 THEN '出席' ELSE '未出席' END as status,
      COALESCE(m.attended_at, '') as attended_at
    FROM members m
    JOIN clubs c ON m.club_id = c.id
    JOIN groups_tbl g ON c.group_id = g.id
    LEFT JOIN committees co ON m.committee_id = co.id
    ORDER BY g.id, c.name, m.name
  `).all();

  const BOM = '\uFEFF';
  let csv = BOM + 'グループ,クラブ,名前,役職,大タグ,協議会,部屋,出欠,出席時刻\n';
  for (const r of rows) {
    csv += [
      csvQuote(r.group_name), csvQuote(r.club_name), csvQuote(r.member_name),
      csvQuote(r.role), csvQuote(r.tag),
      csvQuote(r.committee_name), csvQuote(r.committee_room),
      r.status, r.attended_at,
    ].join(',') + '\n';
  }

  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename=attendance_export.csv');
  res.send(csv);
});

// --- API: CSV Import ---
const upload = multer({ dest: os.tmpdir() });
app.post('/api/import', upload.single('file'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

  try {
    const raw = fs.readFileSync(req.file.path, 'utf-8');
    const lines = raw.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '').split('\n').filter(l => l.trim());

    // Skip header
    const header = lines.shift();

    // Clear existing data
    db.exec('DELETE FROM members; DELETE FROM clubs; DELETE FROM groups_tbl; DELETE FROM committees;');

    const insertGroup = db.prepare('INSERT OR IGNORE INTO groups_tbl (id, name) VALUES (?, ?)');
    const findClub = db.prepare('SELECT id FROM clubs WHERE group_id = ? AND name = ?');
    const insertClub = db.prepare('INSERT INTO clubs (group_id, name) VALUES (?, ?)');
    const findCommittee = db.prepare('SELECT id, room FROM committees WHERE name = ?');
    const insertCommittee = db.prepare('INSERT INTO committees (name, room, sort_order) VALUES (?, ?, ?)');
    const updateCommitteeRoom = db.prepare('UPDATE committees SET room = ? WHERE id = ?');
    const insertMember = db.prepare(
      'INSERT INTO members (club_id, name, name_kana, role, tag, committee_id) VALUES (?, ?, ?, ?, ?, ?)'
    );

    const tx = db.transaction((lines) => {
      let committeeOrder = 0;
      for (const line of lines) {
        const cols = parseCsvLine(line);
        if (cols.length < 4) continue;

        const groupId = parseInt(cols[0], 10);
        const groupName = cols[1];
        const clubName = cols[2];
        const memberName = cols[3];
        const memberKana = cols[4] || '';
        const memberRole = cols[5] || '';
        const memberTag  = cols[6] || '';
        const committeeName = cols[7] || '';
        const committeeRoom = cols[8] || '';

        if (!groupId || !groupName || !clubName || !memberName) continue;

        insertGroup.run(groupId, groupName);

        let club = findClub.get(groupId, clubName);
        if (!club) {
          const info = insertClub.run(groupId, clubName);
          club = { id: info.lastInsertRowid };
        }

        let committeeId = null;
        if (committeeName) {
          let row = findCommittee.get(committeeName);
          if (!row) {
            committeeOrder += 1;
            const info = insertCommittee.run(committeeName, committeeRoom, committeeOrder);
            committeeId = info.lastInsertRowid;
          } else {
            committeeId = row.id;
            // 部屋情報が空だったら埋める
            if (!row.room && committeeRoom) {
              updateCommitteeRoom.run(committeeRoom, committeeId);
            }
          }
        }

        insertMember.run(club.id, memberName, memberKana, memberRole, memberTag, committeeId);
      }
    });

    tx(lines);
    fs.unlinkSync(req.file.path);

    broadcast({ type: 'data_reload' });
    res.json({ ok: true, message: 'Import completed' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// --- API: Reset all attendance ---
app.post('/api/reset', (req, res) => {
  db.prepare('UPDATE members SET attended = 0, attended_at = NULL').run();
  broadcast({ type: 'attendance_update' });
  res.json({ ok: true });
});

// --- API: Owner (受付開始/終了/セッション履歴) ---
// 受付開始: 出席状態を全リセットし、新しいセッション行を作成
app.post('/api/owner/start', (req, res) => {
  const note = (req.body && req.body.note) || '';
  const startedAt = nowLocal();
  const tx = db.transaction(() => {
    // 出欠リセット
    db.prepare('UPDATE members SET attended = 0, attended_at = NULL').run();
    // 進行中のセッションを終了させる (異常終了扱い)
    const ongoing = db.prepare('SELECT id FROM sessions WHERE ended_at IS NULL').all();
    if (ongoing.length > 0) {
      db.prepare("UPDATE sessions SET ended_at = ?, note = note || ' (異常終了)' WHERE ended_at IS NULL")
        .run(startedAt);
    }
    // 新規セッション作成
    const totalMembers = db.prepare('SELECT COUNT(*) as c FROM members').get().c;
    const info = db.prepare(
      'INSERT INTO sessions (started_at, note, total_members, total_attended) VALUES (?, ?, ?, 0)'
    ).run(startedAt, note, totalMembers);
    return info.lastInsertRowid;
  });
  const sessionId = tx();
  broadcast({ type: 'attendance_update' });
  broadcast({ type: 'session_start' });
  res.json({ ok: true, session_id: sessionId, started_at: startedAt });
});

// 受付終了: 現在の出席状態をスナップショットとしてセッションに保存
app.post('/api/owner/end', (req, res) => {
  const session = db.prepare(
    'SELECT id, started_at FROM sessions WHERE ended_at IS NULL ORDER BY id DESC LIMIT 1'
  ).get();
  if (!session) return res.status(400).json({ error: 'no ongoing session' });

  const endedAt = nowLocal();
  // 現在の出席者を取得
  const attended = db.prepare(`
    SELECT m.id, m.name, m.name_kana, m.role, m.tag, m.attended_at,
      c.name as club_name, g.name as group_name,
      COALESCE(co.name, '') as committee_name,
      COALESCE(co.room, '') as committee_room
    FROM members m
    JOIN clubs c ON m.club_id = c.id
    JOIN groups_tbl g ON c.group_id = g.id
    LEFT JOIN committees co ON m.committee_id = co.id
    WHERE m.attended = 1
    ORDER BY m.attended_at
  `).all();
  const totalMembers = db.prepare('SELECT COUNT(*) as c FROM members').get().c;
  const snapshot = {
    started_at: session.started_at,
    ended_at: endedAt,
    total_members: totalMembers,
    total_attended: attended.length,
    attended_members: attended,
  };
  db.prepare(
    'UPDATE sessions SET ended_at = ?, total_members = ?, total_attended = ?, snapshot_json = ? WHERE id = ?'
  ).run(endedAt, totalMembers, attended.length, JSON.stringify(snapshot), session.id);
  broadcast({ type: 'session_end' });
  res.json({ ok: true, session_id: session.id, ended_at: endedAt, total_attended: attended.length });
});

// セッション一覧 (snapshot は含めない、軽量化)
app.get('/api/owner/sessions', (req, res) => {
  const rows = db.prepare(
    'SELECT id, started_at, ended_at, note, total_members, total_attended FROM sessions ORDER BY id DESC LIMIT 50'
  ).all();
  res.json(rows);
});

// セッション詳細 (snapshot含む)
app.get('/api/owner/sessions/:id', (req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!row) return res.status(404).json({ error: 'not found' });
  try {
    row.snapshot = row.snapshot_json ? JSON.parse(row.snapshot_json) : null;
  } catch (e) { row.snapshot = null; }
  delete row.snapshot_json;
  res.json(row);
});

// セッションの出席者リストを CSV ダウンロード
app.get('/api/owner/sessions/:id/csv', (req, res) => {
  const row = db.prepare('SELECT * FROM sessions WHERE id = ?').get(req.params.id);
  if (!row || !row.snapshot_json) return res.status(404).json({ error: 'not found' });
  const snap = JSON.parse(row.snapshot_json);
  const BOM = '﻿';
  let csv = BOM + '出席時刻,名前,フリガナ,グループ,クラブ,役職,大タグ,協議会,部屋\n';
  for (const m of snap.attended_members) {
    csv += [
      m.attended_at || '',
      csvQuote(m.name), csvQuote(m.name_kana),
      csvQuote(m.group_name), csvQuote(m.club_name),
      csvQuote(m.role), csvQuote(m.tag),
      csvQuote(m.committee_name), csvQuote(m.committee_room),
    ].join(',') + '\n';
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=session_${row.id}.csv`);
  res.send(csv);
});

// --- Seed dummy data ---
function seedDummyData() {
  const count = db.prepare('SELECT COUNT(*) as c FROM groups_tbl').get();
  if (count.c > 0) return;

  const clubNames = [
    // 第1グループ (7)
    ['豊前RC', '豊前西RC', '苅田RC', '田川RC', '行橋RC', '行橋COSMOSRC', '行橋みやこRC'],
    // 第2グループ (12)
    ['小倉RC', '小倉中央RC', '小倉東RC', '小倉南RC', '小倉西RC', '門司RC', '門司西RC', '門司西めかりRC', '戸畑RC', '戸畑東RC', '若松RC', '若松中央RC'],
    // 第3グループ (8)
    ['飯塚RC', '直方RC', '直方中央RC', '遠賀RC', '八幡RC', '八幡中央RC', '八幡南RC', '八幡西RC'],
    // 第4グループ (16)
    ['太宰府RC', '福岡RC', '福岡エアポートRC', '福岡平成RC', '福岡東RC', '福岡東令和あけぼのRC', '福岡城南RC', '福岡南RC', '福岡南ファミリアRC', '福岡東南RC', '福岡東南けやきRC', '博多イブニングRC', '博多イブニングトワイライトRC', '宗像RC', '対馬RC', '対馬ちんぐRC'],
    // 第5グループ (11)
    ['福岡中央RC', '福岡中央エンジョイRC', '福岡イブニングRC', '福岡城西RC', '福岡城東RC', '福岡北RC', '福岡西RC', '博多RC', '壱岐RC', '壱岐中央RC', '糸島RC'],
    // 第6グループ (10)
    ['甘木RC', '久留米RC', '久留米中央RC', '久留米中央みらいRC', '久留米東RC', '久留米北RC', '小郡RC', '小郡七夕RC', '鳥栖RC', '浮羽RC'],
    // 第7グループ (8)
    ['筑後RC', '大川RC', '大牟田RC', '大牟田北RC', '大牟田南RC', '八女RC', '八女グリーンRC', '柳川RC'],
  ];

  const familyNames = [
    ['田中', 'たなか'], ['鈴木', 'すずき'], ['佐藤', 'さとう'], ['高橋', 'たかはし'], ['渡辺', 'わたなべ'],
    ['伊藤', 'いとう'], ['山本', 'やまもと'], ['中村', 'なかむら'], ['小林', 'こばやし'], ['加藤', 'かとう'],
    ['吉田', 'よしだ'], ['山田', 'やまだ'], ['佐々木', 'ささき'], ['松本', 'まつもと'], ['井上', 'いのうえ'],
    ['木村', 'きむら'], ['林', 'はやし'], ['斎藤', 'さいとう'], ['清水', 'しみず'], ['山口', 'やまぐち'],
    ['森', 'もり'], ['池田', 'いけだ'], ['橋本', 'はしもと'], ['阿部', 'あべ'], ['石川', 'いしかわ'],
    ['前田', 'まえだ'], ['藤田', 'ふじた'], ['小川', 'おがわ'], ['岡田', 'おかだ'], ['後藤', 'ごとう'],
  ];
  const givenNames = [
    ['太郎', 'たろう'], ['次郎', 'じろう'], ['三郎', 'さぶろう'], ['一夫', 'かずお'], ['正雄', 'まさお'],
    ['和夫', 'かずお'], ['幸一', 'こういち'], ['誠', 'まこと'], ['浩', 'ひろし'], ['隆', 'たかし'],
    ['修', 'おさむ'], ['豊', 'ゆたか'], ['勝', 'まさる'], ['進', 'すすむ'], ['明', 'あきら'],
    ['博', 'ひろし'], ['茂', 'しげる'], ['清', 'きよし'], ['功', 'いさお'], ['実', 'みのる'],
  ];

  const totalClubs = clubNames.reduce((sum, g) => sum + g.length, 0);
  const membersPerClub = Math.max(5, Math.round(600 / totalClubs));

  const insertGroup = db.prepare('INSERT INTO groups_tbl (id, name) VALUES (?, ?)');
  const insertClub = db.prepare('INSERT INTO clubs (group_id, name) VALUES (?, ?)');
  const insertMember = db.prepare('INSERT INTO members (club_id, name, name_kana) VALUES (?, ?, ?)');

  let memberCount = 0;

  db.transaction(() => {
    for (let g = 1; g <= 7; g++) {
      insertGroup.run(g, `第${g}グループ`);
      for (const clubName of clubNames[g - 1]) {
        const info = insertClub.run(g, clubName);
        const clubId = info.lastInsertRowid;

        const numMembers = membersPerClub + (memberCount % 4);
        for (let i = 0; i < numMembers; i++) {
          const [fn, fnk] = familyNames[(memberCount + i) % familyNames.length];
          const [gn, gnk] = givenNames[(memberCount + i * 3) % givenNames.length];
          insertMember.run(clubId, `${fn} ${gn}`, `${fnk} ${gnk}`);
        }
        memberCount += numMembers;
      }
    }
  })();

  console.log(`Seeded ${memberCount} members`);
}

// ダミーデータは本番運用のため自動投入しない (必要なら手動で seedDummyData() を呼ぶ)

// --- Graceful shutdown ---
// Fly.io 等で SIGTERM が来た時にSSE接続とDBを綺麗に閉じる
function gracefulShutdown(signal) {
  return () => {
    console.log(`[${signal}] シャットダウン中...`);
    for (const res of sseClients) {
      try { res.end(); } catch (e) {}
    }
    sseClients.clear();
    try { db.close(); } catch (e) {}
    setTimeout(() => process.exit(0), 500);
  };
}
process.on('SIGTERM', gracefulShutdown('SIGTERM'));
process.on('SIGINT',  gracefulShutdown('SIGINT'));

// --- Start ---
const server = app.listen(PORT, '0.0.0.0', () => {
  const interfaces = os.networkInterfaces();
  let localIP = 'localhost';
  for (const iface of Object.values(interfaces)) {
    for (const cfg of iface) {
      if (cfg.family === 'IPv4' && !cfg.internal) {
        localIP = cfg.address;
        break;
      }
    }
  }
  console.log('');
  console.log('=== ロータリー出欠管理システム ===');
  console.log(`  iPad受付画面:  http://${localIP}:${PORT}/`);
  console.log(`  PC集計画面:    http://${localIP}:${PORT}/dashboard.html`);
  console.log('');
});
