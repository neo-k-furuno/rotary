const express = require('express');
const Database = require('better-sqlite3');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const os = require('os');

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
  CREATE TABLE IF NOT EXISTS members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    club_id INTEGER NOT NULL REFERENCES clubs(id),
    name TEXT NOT NULL,
    name_kana TEXT NOT NULL DEFAULT '',
    role TEXT NOT NULL DEFAULT '',
    tag TEXT NOT NULL DEFAULT '',
    attended INTEGER NOT NULL DEFAULT 0,
    attended_at TEXT
  );
`);

// 既存DBから role / tag カラムが無ければ追加 (マイグレーション)
const memberCols = db.prepare("PRAGMA table_info(members)").all().map(c => c.name);
if (!memberCols.includes('role')) {
  db.exec("ALTER TABLE members ADD COLUMN role TEXT NOT NULL DEFAULT ''");
}
if (!memberCols.includes('tag')) {
  db.exec("ALTER TABLE members ADD COLUMN tag TEXT NOT NULL DEFAULT ''");
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
    'SELECT id, club_id, name, name_kana, role, tag, attended, attended_at FROM members ORDER BY club_id, name_kana, name'
  ).all();
  res.json({ groups, clubs, members, server_ts: nowLocal() });
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
    SELECT m.id, m.name, m.role, m.tag, m.attended, m.attended_at,
      c.id as club_id, c.name as club_name,
      g.id as group_id, g.name as group_name
    FROM members m
    JOIN clubs c ON m.club_id = c.id
    JOIN groups_tbl g ON c.group_id = g.id
    ORDER BY g.id, c.name, m.name
  `).all();

  const totalMembers = members.length;
  const totalAttended = members.filter(m => m.attended).length;

  res.json({ clubs, members, totalMembers, totalAttended });
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
      CASE WHEN m.attended = 1 THEN '出席' ELSE '未出席' END as status,
      COALESCE(m.attended_at, '') as attended_at
    FROM members m
    JOIN clubs c ON m.club_id = c.id
    JOIN groups_tbl g ON c.group_id = g.id
    ORDER BY g.id, c.name, m.name
  `).all();

  const BOM = '\uFEFF';
  let csv = BOM + 'グループ,クラブ,名前,役職,大タグ,出欠,出席時刻\n';
  for (const r of rows) {
    csv += [
      csvQuote(r.group_name), csvQuote(r.club_name), csvQuote(r.member_name),
      csvQuote(r.role), csvQuote(r.tag),
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
    db.exec('DELETE FROM members; DELETE FROM clubs; DELETE FROM groups_tbl;');

    const insertGroup = db.prepare('INSERT OR IGNORE INTO groups_tbl (id, name) VALUES (?, ?)');
    const findClub = db.prepare('SELECT id FROM clubs WHERE group_id = ? AND name = ?');
    const insertClub = db.prepare('INSERT INTO clubs (group_id, name) VALUES (?, ?)');
    const insertMember = db.prepare(
      'INSERT INTO members (club_id, name, name_kana, role, tag) VALUES (?, ?, ?, ?, ?)'
    );

    const tx = db.transaction((lines) => {
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

        if (!groupId || !groupName || !clubName || !memberName) continue;

        insertGroup.run(groupId, groupName);

        let club = findClub.get(groupId, clubName);
        if (!club) {
          const info = insertClub.run(groupId, clubName);
          club = { id: info.lastInsertRowid };
        }

        insertMember.run(club.id, memberName, memberKana, memberRole, memberTag);
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

// --- Start ---
app.listen(PORT, '0.0.0.0', () => {
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
