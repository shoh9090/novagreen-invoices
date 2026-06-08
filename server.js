const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   Хранилище сканов Cloudflare R2 (S3-совместимое). Подключается
   только если заданы переменные R2_*; иначе сканы хранятся в базе.
   Библиотека грузится «лениво», чтобы без R2 ничего не падало.
   ============================================================ */
const R2_BUCKET = process.env.R2_BUCKET || '';
const r2Configured = !!(process.env.R2_ACCOUNT_ID && process.env.R2_ACCESS_KEY_ID && process.env.R2_SECRET_ACCESS_KEY && R2_BUCKET);
let S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand;
if (r2Configured) {
  try { ({ S3Client, PutObjectCommand, GetObjectCommand, DeleteObjectCommand } = require('@aws-sdk/client-s3')); }
  catch (e) { console.error('⚠️ Не установлен @aws-sdk/client-s3 — обновите package.json. R2 отключён.', e.message); }
}
const r2 = (r2Configured && S3Client)
  ? new S3Client({
      region: 'auto',
      endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      credentials: { accessKeyId: process.env.R2_ACCESS_KEY_ID, secretAccessKey: process.env.R2_SECRET_ACCESS_KEY }
    })
  : null;
console.log(r2 ? '✅ Cloudflare R2 подключён (bucket: ' + R2_BUCKET + ')' : 'ℹ️ R2 не настроен — сканы в базе');

function keyForDoc(docKey, mediaType) {
  const ext = (mediaType || '').includes('png') ? 'png' : 'jpg';
  const safe = (docKey || 'doc').replace(/[^a-zA-Z0-9_\-]+/g, '_').slice(0, 80);
  return `invoices/${safe}.${ext}`;
}
async function r2Upload(docKey, base64, mediaType) {
  if (!r2 || !base64) return null;
  const key = keyForDoc(docKey, mediaType);
  await r2.send(new PutObjectCommand({ Bucket: R2_BUCKET, Key: key, Body: Buffer.from(base64, 'base64'), ContentType: mediaType || 'image/jpeg' }));
  return key;
}
async function r2GetDataUrl(key, mediaType) {
  if (!r2 || !key) return null;
  const resp = await r2.send(new GetObjectCommand({ Bucket: R2_BUCKET, Key: key }));
  const bytes = await resp.Body.transformToByteArray();
  return 'data:' + (mediaType || resp.ContentType || 'image/jpeg') + ';base64,' + Buffer.from(bytes).toString('base64');
}
async function r2Delete(key) {
  if (!r2 || !key) return;
  try { await r2.send(new DeleteObjectCommand({ Bucket: R2_BUCKET, Key: key })); } catch (e) { /* не критично */ }
}

// Фоновый перенос старых сканов (base64 в базе) в R2 — один раз после старта
async function migrateBase64ToR2() {
  if (!pool || !r2) return;
  try {
    let moved = 0;
    for (let i = 0; i < 100; i++) {
      const r = await pool.query("SELECT id, doc_key, image_base64, image_media_type FROM invoices WHERE image_base64 IS NOT NULL AND image_key IS NULL LIMIT 50");
      if (!r.rows.length) break;
      for (const row of r.rows) {
        try {
          const key = await r2Upload(row.doc_key, row.image_base64, row.image_media_type);
          if (key) { await pool.query('UPDATE invoices SET image_key=$1, image_base64=NULL WHERE id=$2', [key, row.id]); moved++; }
        } catch (e) { /* при сбое оставляем base64 */ }
      }
    }
    if (moved) console.log('✅ Перенесено старых сканов в R2:', moved);
  } catch (e) { console.error('Авто-перенос в R2:', e.message); }
}
setTimeout(migrateBase64ToR2, 6000);

/* ============================================================
   База данных PostgreSQL (Railway). Если DATABASE_URL не задан —
   программа работает как раньше, просто без сохранения в базу.
   ============================================================ */
const pool = process.env.DATABASE_URL ? new Pool({ connectionString: process.env.DATABASE_URL }) : null;

async function initDb() {
  if (!pool) { console.log('ℹ️ DATABASE_URL не задан — база отключена'); return; }
  await pool.query(`
    CREATE TABLE IF NOT EXISTS invoices (
      id BIGSERIAL PRIMARY KEY,
      doc_key TEXT UNIQUE,
      invoice_number TEXT,
      invoice_date TEXT,
      invoice_date_iso DATE,
      customer_name TEXT,
      inn TEXT,
      delivery_point TEXT,
      order_number TEXT,
      total_amount NUMERIC,
      vat_amount NUMERIC,
      manual_correction TEXT,
      correction_comment TEXT,
      recognition_status TEXT,
      confidence_score REAL,
      crm_found BOOLEAN,
      crm_sd_id TEXT,
      crm_invoice_number TEXT,
      crm_total NUMERIC,
      crm_diff NUMERIC,
      crm_match BOOLEAN,
      crm_agent TEXT,
      file_name TEXT,
      page_number INT,
      image_base64 TEXT,
      image_media_type TEXT,
      operator TEXT,
      uploaded_at TEXT,
      saved_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE INDEX IF NOT EXISTS idx_inv_num ON invoices(invoice_number);
    CREATE INDEX IF NOT EXISTS idx_inv_inn ON invoices(inn);
    CREATE INDEX IF NOT EXISTS idx_inv_date ON invoices(invoice_date_iso);
    CREATE INDEX IF NOT EXISTS idx_inv_cust ON invoices(customer_name);
  `);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS image_key TEXT;`);
  await pool.query(`ALTER TABLE invoices ADD COLUMN IF NOT EXISTS crm_agent_name TEXT;`);
  await pool.query(`CREATE TABLE IF NOT EXISTS crm_agents (
    sd_id TEXT PRIMARY KEY,
    name TEXT,
    login TEXT,
    phone TEXT,
    code TEXT,
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );`);
  await pool.query(`CREATE TABLE IF NOT EXISTS bot_agents (
    id BIGSERIAL PRIMARY KEY,
    chat_id TEXT UNIQUE,
    phone TEXT,
    tg_name TEXT,
    agent_code TEXT,
    agent_name TEXT,
    status TEXT DEFAULT 'pending',
    created_at TIMESTAMPTZ DEFAULT NOW()
  );`);
  console.log('✅ База данных готова (таблица invoices)');
}
initDb().catch(e => console.error('Ошибка инициализации базы:', e.message));

function dateToIso(d) {
  const m = (d || '').toString().match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

/* ============================================================
   Авторизация. Включается, когда задан AUTH_SECRET (и есть база).
   Пока AUTH_SECRET не задан — программа открыта, как раньше.
   ============================================================ */
const crypto = require('crypto');
const AUTH_SECRET = process.env.AUTH_SECRET || '';
const AUTH_ON = !!(AUTH_SECRET && pool);

function hashPassword(pw) {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(String(pw), salt, 64).toString('hex');
  return `scrypt$${salt}$${hash}`;
}
function verifyPassword(pw, stored) {
  try {
    const parts = String(stored).split('$'); const salt = parts[1], hash = parts[2];
    const h = crypto.scryptSync(String(pw), salt, 64).toString('hex');
    return crypto.timingSafeEqual(Buffer.from(h, 'hex'), Buffer.from(hash, 'hex'));
  } catch (e) { return false; }
}
function b64url(buf) { return Buffer.from(buf).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, ''); }
function signToken(payload) {
  const body = b64url(JSON.stringify(payload));
  const sig = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
  return body + '.' + sig;
}
function verifyToken(token) {
  try {
    const [body, sig] = String(token).split('.'); if (!body || !sig) return null;
    const exp = b64url(crypto.createHmac('sha256', AUTH_SECRET).update(body).digest());
    if (sig.length !== exp.length || !crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(exp))) return null;
    const p = JSON.parse(Buffer.from(body.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString());
    if (p.exp && Date.now() > p.exp) return null;
    return p;
  } catch (e) { return null; }
}
async function initUsers() {
  if (!pool || !AUTH_ON) { if (AUTH_SECRET && !pool) console.log('⚠️ AUTH_SECRET задан, но нет базы — авторизация не включится'); return; }
  await pool.query(`CREATE TABLE IF NOT EXISTS users (
    id BIGSERIAL PRIMARY KEY, username TEXT UNIQUE NOT NULL, password_hash TEXT NOT NULL,
    full_name TEXT, role TEXT DEFAULT 'accountant', active BOOLEAN DEFAULT true, created_at TIMESTAMPTZ DEFAULT NOW());`);
  const login = process.env.ADMIN_LOGIN, pw = process.env.ADMIN_PASSWORD;
  if (login && pw) {
    await pool.query(`INSERT INTO users (username,password_hash,full_name,role,active)
      VALUES ($1,$2,'Администратор','admin',true)
      ON CONFLICT (username) DO UPDATE SET password_hash=$2, role='admin', active=true`, [login, hashPassword(pw)]);
    console.log('✅ Администратор обеспечен: ' + login);
  } else {
    console.log('⚠️ Не заданы ADMIN_LOGIN/ADMIN_PASSWORD — некому будет войти!');
  }
  console.log('🔐 Авторизация ВКЛЮЧЕНА');
}
initUsers().catch(e => console.error('Ошибка инициализации пользователей:', e.message));

// Middleware: защищаем все /api/* кроме входа и конфига
app.use((req, res, next) => {
  if (!AUTH_ON) return next();
  if (!req.path.startsWith('/api/')) return next();
  if (req.path === '/api/login' || req.path === '/api/config') return next();
  const h = req.headers.authorization || ''; const t = h.startsWith('Bearer ') ? h.slice(7) : '';
  const p = verifyToken(t);
  if (!p) return res.status(401).json({ error: 'Требуется вход в систему' });
  req.user = p; next();
});
function adminOnly(req, res, next) {
  if (AUTH_ON && (!req.user || req.user.role !== 'admin')) return res.status(403).json({ error: 'Доступ только для администратора' });
  next();
}

app.post('/api/login', async (req, res) => {
  if (!AUTH_ON) return res.json({ ok: true, authDisabled: true });
  const { username, password } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Введите логин и пароль' });
  try {
    const r = await pool.query('SELECT * FROM users WHERE username=$1 AND active=true', [username]);
    if (!r.rows.length || !verifyPassword(password, r.rows[0].password_hash)) return res.status(401).json({ error: 'Неверный логин или пароль' });
    const u = r.rows[0];
    const token = signToken({ uid: u.id, username: u.username, role: u.role, name: u.full_name, exp: Date.now() + 7 * 24 * 3600 * 1000 });
    res.json({ token, user: { username: u.username, name: u.full_name, role: u.role } });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/me', (req, res) => {
  if (!AUTH_ON) return res.json({ authDisabled: true });
  res.json({ user: { username: req.user.username, name: req.user.name, role: req.user.role } });
});

// Управление пользователями (для админ-панели, Этап Б)
app.get('/api/users', adminOnly, async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  const r = await pool.query('SELECT id,username,full_name,role,active,created_at FROM users ORDER BY created_at');
  res.json({ rows: r.rows });
});
app.post('/api/users', adminOnly, async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  const { username, password, full_name, role } = req.body || {};
  if (!username || !password) return res.status(400).json({ error: 'Нужны логин и пароль' });
  try {
    await pool.query(`INSERT INTO users (username,password_hash,full_name,role,active) VALUES ($1,$2,$3,$4,true)
      ON CONFLICT (username) DO UPDATE SET password_hash=$2, full_name=$3, role=$4, active=true`,
      [username, hashPassword(password), full_name || null, (role === 'admin' ? 'admin' : 'accountant')]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/users/:id', adminOnly, async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  const { active, password, full_name, role } = req.body || {};
  try {
    if (password) await pool.query('UPDATE users SET password_hash=$1 WHERE id=$2', [hashPassword(password), req.params.id]);
    if (typeof active === 'boolean') await pool.query('UPDATE users SET active=$1 WHERE id=$2', [active, req.params.id]);
    if (full_name !== undefined) await pool.query('UPDATE users SET full_name=$1 WHERE id=$2', [full_name, req.params.id]);
    if (role) await pool.query('UPDATE users SET role=$1 WHERE id=$2', [(role === 'admin' ? 'admin' : 'accountant'), req.params.id]);
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   1. Claude API — распознавание (безопасный прокси)
   ============================================================ */
app.post('/api/claude', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY не задан в настройках Railway.' });
  try {
    // Принудительно используем актуальную модель (можно переопределить переменной CLAUDE_MODEL)
    const body = req.body || {};
    body.model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
    if (!body.max_tokens) body.max_tokens = 1500;

    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) console.error('Anthropic error', r.status, JSON.stringify(data).slice(0, 400));
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Ошибка Claude API: ' + err.message });
  }
});

/* Самодиагностика: открыть в браузере /api/selftest — покажет точную причину */
app.get('/api/selftest', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.json({ ok: false, where: 'config', error: 'ANTHROPIC_API_KEY не задан в Railway' });
  const model = process.env.CLAUDE_MODEL || 'claude-sonnet-4-6';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      body: JSON.stringify({ model, max_tokens: 16, messages: [{ role: 'user', content: 'Ответь одним словом: работает' }] })
    });
    const data = await r.json();
    if (!r.ok) return res.json({ ok: false, where: 'anthropic', httpStatus: r.status, model, key_prefix: key.slice(0, 8), error: data.error ? data.error.message : data });
    const text = (data.content || []).map(c => c.text || '').join('');
    res.json({ ok: true, model, reply: text });
  } catch (e) {
    res.json({ ok: false, where: 'network', error: e.message });
  }
});

/* Диагностика заказов: /api/sd-debug?date=ГГГГ-ММ-ДД — покажет заказы за дату */
app.get('/api/sd-debug', async (req, res) => {
  const domain = process.env.SD_DOMAIN;
  const date = (req.query.date || '').toString().trim();
  if (!date) return res.json({ error: 'Добавьте ?date=ГГГГ-ММ-ДД в адрес (например ?date=2026-05-11)' });
  try {
    const auth = await sdLogin(false);
    const ST = [1, 2, 3, 4, 5];
    async function q(filter) {
      const r = await fetch(`https://${domain}/api/v2`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ method: 'getOrder', auth: { userId: auth.userId, token: auth.token }, params: { limit: 300, filter } })
      });
      const j = await r.json();
      const orders = (j.result && j.result.order) || [];
      return {
        count: orders.length,
        total_in_crm: j.pagination && j.pagination.total,
        sample: orders.slice(0, 60).map(o => ({ SD_id: o.SD_id, invoiceNumber: o.invoiceNumber, date: o.dateDocument, client: o.client && o.client.clientName, legal: o.client && o.client.clientLegalName, total: o.totalSummaAfterDiscount }))
      };
    }
    res.json({
      date,
      by_dateLoad: await q({ include: 'all', status: ST, period: { dateLoad: { from: date, to: date } } }),
      by_date: await q({ include: 'all', status: ST, period: { date: { from: date, to: date } } })
    });
  } catch (e) {
    res.json({ error: e.message });
  }
});

/* ============================================================
   2. SalesDoctor — получение заказа по номеру
   ============================================================ */
let sdToken = { userId: null, token: null, ts: 0 };

async function sdLogin(force) {
  const domain   = process.env.SD_DOMAIN;
  const login    = process.env.SD_LOGIN;
  const password = process.env.SD_PASSWORD;
  if (!domain || !login || !password) {
    throw new Error('SalesDoctor не настроен (SD_DOMAIN / SD_LOGIN / SD_PASSWORD).');
  }
  // Переиспользуем токен 50 минут (повторный login обнуляет старый токен)
  if (!force && sdToken.token && (Date.now() - sdToken.ts) < 50 * 60 * 1000) return sdToken;
  const r = await fetch(`https://${domain}/api/v2`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'login', auth: { login, password } })
  });
  const j = await r.json();
  if (!j.status || !j.result) {
    throw new Error('Не удалось войти в SalesDoctor: ' + (j.error && j.error.message || 'проверьте логин/пароль'));
  }
  sdToken = { userId: j.result.userId, token: j.result.token, ts: Date.now() };
  return sdToken;
}

app.post('/api/sd/order', async (req, res) => {
  const domain = process.env.SD_DOMAIN;
  try {
    const b = req.body || {};
    const invNum   = (b.invoiceNumber || '').toString().trim();
    const point    = (b.point || '').toString().trim();
    const customer = (b.customer || '').toString().trim();
    const rawDate  = (b.date || '').toString().trim();           // ДД.ММ.ГГГГ со скана
    if (!invNum && !point) return res.status(400).json({ error: 'Нет данных для поиска (номер СФ или точка).' });

    // ДД.ММ.ГГГГ → ГГГГ-ММ-ДД
    function toISO(d) { const m = d.match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/); return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null; }
    function shift(iso, days) { const dt = new Date(iso + 'T00:00:00Z'); dt.setUTCDate(dt.getUTCDate() + days); return dt.toISOString().slice(0, 10); }
    const iso = toISO(rawDate);
    const norm = s => (s == null ? '' : String(s)).replace(/\s+/g, '').toLowerCase();

    let auth = await sdLogin(false);
    async function fetchOrders(filter) {
      const makeBody = (a) => ({ method: 'getOrder', auth: { userId: a.userId, token: a.token }, params: { limit: 1000, filter } });
      let r = await fetch(`https://${domain}/api/v2`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makeBody(auth)) });
      let j = await r.json();
      if (j.error && j.error.code === 401) {
        auth = await sdLogin(true);
        r = await fetch(`https://${domain}/api/v2`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makeBody(auth)) });
        j = await r.json();
      }
      return (j.result && j.result.order) || [];
    }

    const ST = [1, 2, 3, 4, 5];
    let orders = [];
    if (iso) {
      // окно ±2 дня по дате документа (отгрузки)
      orders = await fetchOrders({ include: 'all', status: ST, period: { dateLoad: { from: shift(iso, -2), to: shift(iso, 2) } } });
      // если по дате документа ничего — пробуем по дате заказа (заявки)
      if (!orders.length) orders = await fetchOrders({ include: 'all', status: ST, period: { date: { from: shift(iso, -2), to: shift(iso, 2) } } });
    }

    // 1) основной ключ — номер счёт-фактуры (цифры, устойчив к распознаванию)
    let match = invNum ? orders.find(o => norm(o.invoiceNumber) === norm(invNum)) : null;
    let matchedBy = match ? 'invoiceNumber' : null;
    // 2) запасной — по торговой точке / юр. названию
    if (!match && (point || customer)) {
      match = orders.find(o => {
        const cn = norm(o.client && o.client.clientName), ln = norm(o.client && o.client.clientLegalName);
        return (point && cn === norm(point)) || (customer && ln === norm(customer));
      });
      if (match) matchedBy = 'point';
    }

    if (!match) return res.json({ found: false, scanned: { invoiceNumber: invNum, date: iso, point }, looked: orders.length });

    const o = match;
    res.json({
      found: true, matchedBy,
      order: {
        code_1C: o.code_1C, SD_id: o.SD_id, CS_id: o.CS_id,
        status: o.status, invoiceNumber: o.invoiceNumber, dateDocument: o.dateDocument,
        comment: o.comment,
        totalSumma: o.totalSumma, discountSumma: o.discountSumma,
        totalSummaAfterDiscount: o.totalSummaAfterDiscount,
        totalReturnsSumma: o.totalReturnsSumma, totalReturnsCount: o.totalReturnsCount,
        client: o.client || {}, agent: o.agent || {}, expeditor: o.expeditor || {},
        products: (o.orderProducts || []).map(p => ({
          name: p.product && p.product.name, code: p.product && p.product.code_1C,
          quantity: p.quantity, price: p.price, summa: p.summa, returned: p.returned
        }))
      }
    });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ============================================================
   3. Telegram — отправка уведомления
   ============================================================ */
function managerMap() {
  try { return JSON.parse(process.env.MANAGER_MAP || '{}'); } catch (e) { return {}; }
}

app.post('/api/telegram/send', async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN;
  if (!token) return res.status(400).json({ error: 'Telegram не настроен (TELEGRAM_BOT_TOKEN).' });
  try {
    const { text, managerCode } = req.body || {};
    let chatId = (req.body && req.body.chatId) || '';
    if (!chatId && managerCode) chatId = managerMap()[managerCode];   // карта агент → chat_id
    if (!chatId) chatId = process.env.TELEGRAM_DEFAULT_CHAT_ID;
    if (!chatId) return res.status(400).json({ error: 'Нет chat_id (укажите TELEGRAM_DEFAULT_CHAT_ID).' });
    if (!text)   return res.status(400).json({ error: 'Пустой текст сообщения.' });

    const r = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true })
    });
    const j = await r.json();
    if (!j.ok) return res.status(502).json({ error: j.description || 'Ошибка Telegram' });
    res.json({ ok: true });
  } catch (err) {
    res.status(502).json({ error: err.message });
  }
});

/* ============================================================
   3b. Двусторонний Telegram-бот: регистрация агентов + выдача сканов
   ============================================================ */
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
function normPhone(p) { return (p == null ? '' : String(p)).replace(/\D/g, '').replace(/^0+/, ''); }
async function sdFetchAgents() {
  const domain = process.env.SD_DOMAIN;
  const auth = await sdLogin(false);
  const r = await fetch(`https://${domain}/api/v2`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: 'getAgent', auth: { userId: auth.userId, token: auth.token }, params: { limit: 1000 } })
  });
  const j = await r.json();
  const list = (j.result && (j.result.agent || j.result.agents)) || [];
  return list.map(a => ({
    sd_id: a.SD_id || a.sd_id || a.id || a.code_1C || '',
    name: a.agentName || a.name || a.fio || a.fullName || '',
    login: a.login || a.username || '',
    phone: normPhone(a.phone || a.phoneNumber || a.telephone || a.tel || a.mobile || ''),
    code: a.code_1C || a.code || '',
    _active: !(a.active === false || a.isActive === false || a.deleted === true || a.isDeleted === true || /^deleted_user/i.test(String(a.login || a.username || '')) || String(a.status || '').toLowerCase() === 'inactive')
  })).filter(a => a.sd_id && a._active).map(a => { delete a._active; return a; });
}
async function tgApi(method, body) {
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/${method}`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
  }).then(r => r.json()).catch(e => ({ ok: false, description: e.message }));
}
async function tgSend(chatId, text, extra) {
  if (!TG_TOKEN) return;
  return tgApi('sendMessage', Object.assign({ chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true }, extra || {}));
}
async function tgSendDoc(chatId, buffer, mtype, caption, filename) {
  if (!TG_TOKEN) return;
  const form = new FormData();
  form.append('chat_id', String(chatId));
  if (caption) form.append('caption', caption);
  form.append('document', new Blob([buffer], { type: mtype || 'image/jpeg' }), filename || 'invoice.jpg');
  return fetch(`https://api.telegram.org/bot${TG_TOKEN}/sendDocument`, { method: 'POST', body: form }).then(r => r.json()).catch(e => ({ ok: false, description: e.message }));
}

// автоустановка webhook при старте
async function setupWebhook() {
  if (!TG_TOKEN) return;
  const domain = process.env.APP_URL || (process.env.RAILWAY_PUBLIC_DOMAIN ? 'https://' + process.env.RAILWAY_PUBLIC_DOMAIN : '');
  if (!domain) { console.log('ℹ️ APP_URL не задан — webhook бота не установлен'); return; }
  const url = domain.replace(/\/+$/, '') + '/telegram/webhook';
  const j = await tgApi('setWebhook', { url, allowed_updates: ['message'] });
  console.log('Telegram webhook:', j.ok ? ('OK → ' + url) : j.description);
}
setTimeout(setupWebhook, 3500);

const KB_PHONE = { keyboard: [[{ text: '📱 Отправить мой номер', request_contact: true }]], resize_keyboard: true, one_time_keyboard: true };

// helper: достать картинку накладной в виде буфера
async function invoiceImageBuffer(row) {
  let dataUrl = null;
  if (row.image_key && r2) { try { dataUrl = await r2GetDataUrl(row.image_key, row.image_media_type); } catch (e) {} }
  if (!dataUrl && row.image_base64) dataUrl = 'data:' + (row.image_media_type || 'image/jpeg') + ';base64,' + row.image_base64;
  if (!dataUrl) return null;
  const m = dataUrl.match(/^data:(.*?);base64,(.*)$/); if (!m) return null;
  return { buffer: Buffer.from(m[2], 'base64'), mtype: m[1] };
}

app.post('/telegram/webhook', async (req, res) => {
  res.json({ ok: true }); // отвечаем Telegram сразу
  try {
    const msg = req.body && req.body.message; if (!msg) return;
    const chatId = msg.chat && msg.chat.id; if (!chatId) return;
    if (!pool) { await tgSend(chatId, 'База данных не подключена.'); return; }

    // /start
    if (msg.text && msg.text.trim().toLowerCase().startsWith('/start')) {
      await tgSend(chatId, '<b>Novagreen — бот для торговой команды</b>\n\nЧтобы получить доступ, отправьте свой номер телефона кнопкой ниже. После подтверждения администратором вы сможете запрашивать сканы счёт-фактур: просто пришлите номер СФ, и бот вернёт скан.', { reply_markup: KB_PHONE });
      return;
    }
    // получен контакт (телефон)
    if (msg.contact && msg.contact.phone_number) {
      const phone = normPhone(msg.contact.phone_number);
      const name = [msg.from && msg.from.first_name, msg.from && msg.from.last_name].filter(Boolean).join(' ');
      await pool.query(`INSERT INTO bot_agents (chat_id, phone, tg_name, status) VALUES ($1,$2,$3,'pending')
        ON CONFLICT (chat_id) DO UPDATE SET phone=$2, tg_name=$3`, [String(chatId), phone, name]);
      let linkMsg = '';
      try {
        const ca = await pool.query('SELECT sd_id,name FROM crm_agents WHERE phone=$1 LIMIT 1', [phone]);
        if (ca.rows.length) {
          await pool.query('UPDATE bot_agents SET agent_code=$1, agent_name=$2 WHERE chat_id=$3', [ca.rows[0].sd_id, ca.rows[0].name, String(chatId)]);
          linkMsg = '\nВ CRM вы определены как: <b>' + ca.rows[0].name + '</b>';
        }
      } catch (e) {}
      await tgSend(chatId, '✅ Номер получен: +' + phone + linkMsg + '\nЗаявка отправлена администратору. Как только вас подтвердят — присылайте номер счёт-фактуры.', { reply_markup: { remove_keyboard: true } });
      return;
    }
    // текст — запрос накладной
    if (msg.text) {
      const reg = await pool.query('SELECT * FROM bot_agents WHERE chat_id=$1', [String(chatId)]);
      const a = reg.rows[0];
      if (!a) { await tgSend(chatId, 'Сначала отправьте /start и поделитесь номером телефона.'); return; }
      if (a.status === 'blocked') { await tgSend(chatId, 'Ваш доступ заблокирован. Обратитесь к администратору.'); return; }
      if (a.status !== 'active') { await tgSend(chatId, '⏳ Доступ ещё не подтверждён администратором. Пожалуйста, подождите.'); return; }
      const q = msg.text.trim().replace(/[^\dA-Za-z]/g, '');
      if (!q) { await tgSend(chatId, 'Отправьте номер счёт-фактуры цифрами, например <b>49586</b>.'); return; }
      const inv = await pool.query(`SELECT id, invoice_number, customer_name, delivery_point, invoice_date, total_amount, image_base64, image_media_type, image_key
        FROM invoices WHERE invoice_number=$1 ORDER BY saved_at DESC LIMIT 1`, [q]);
      if (!inv.rows.length) { await tgSend(chatId, '❌ Счёт-фактура № ' + q + ' не найдена в базе.'); return; }
      const row = inv.rows[0];
      const caption = `СФ № ${row.invoice_number}\n${row.customer_name || ''}\n${row.delivery_point || ''}\n${row.invoice_date || ''}${row.total_amount ? ' · ' + Number(row.total_amount).toLocaleString('ru-RU') + ' сум' : ''}`;
      const img = await invoiceImageBuffer(row);
      if (!img) { await tgSend(chatId, caption + '\n\n(скан недоступен)'); return; }
      const ext = (img.mtype || '').includes('png') ? 'png' : 'jpg';
      const fname = ('SF_' + row.invoice_number + '_' + (row.delivery_point || '')).replace(/[^a-zA-Z0-9_\-]+/g, '_').slice(0, 50) + '.' + ext;
      await tgSendDoc(chatId, img.buffer, img.mtype, caption, fname);
      return;
    }
  } catch (e) { console.error('webhook error:', e.message); }
});

// Админ: список и управление агентами бота
app.get('/api/bot-agents', adminOnly, async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  const r = await pool.query('SELECT id,chat_id,phone,tg_name,agent_code,agent_name,status,created_at FROM bot_agents ORDER BY created_at DESC');
  res.json({ rows: r.rows });
});
app.get('/api/agents-seen', adminOnly, async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  try { const r = await pool.query("SELECT DISTINCT crm_agent FROM invoices WHERE crm_agent IS NOT NULL AND crm_agent<>'' ORDER BY 1"); res.json({ rows: r.rows.map(x => x.crm_agent) }); }
  catch (e) { res.status(500).json({ error: e.message }); }
});
app.post('/api/crm-agents/sync', adminOnly, async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  try {
    const list = await sdFetchAgents();
    const ids = list.map(a => a.sd_id);
    for (const a of list) {
      await pool.query(`INSERT INTO crm_agents (sd_id,name,login,phone,code,updated_at) VALUES ($1,$2,$3,$4,$5,NOW())
        ON CONFLICT (sd_id) DO UPDATE SET name=$2, login=$3, phone=$4, code=$5, updated_at=NOW()`,
        [a.sd_id, a.name, a.login, a.phone, a.code]);
    }
    // убрать тех, кого больше нет среди активных
    if (ids.length) await pool.query('DELETE FROM crm_agents WHERE NOT (sd_id = ANY($1::text[]))', [ids]);
    res.json({ ok: true, count: list.length, sample: list.slice(0, 5) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.get('/api/crm-agents', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  const r = await pool.query('SELECT sd_id,name,login,phone,code FROM crm_agents ORDER BY name');
  res.json({ rows: r.rows });
});
app.post('/api/bot-agents/:id', adminOnly, async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  const { status, agent_code, agent_name } = req.body || {};
  try {
    if (status) await pool.query('UPDATE bot_agents SET status=$1 WHERE id=$2', [status, req.params.id]);
    if (agent_code !== undefined) await pool.query('UPDATE bot_agents SET agent_code=$1 WHERE id=$2', [agent_code || null, req.params.id]);
    if (agent_name !== undefined) await pool.query('UPDATE bot_agents SET agent_name=$1 WHERE id=$2', [agent_name || null, req.params.id]);
    if (status === 'active') {
      const r = await pool.query('SELECT chat_id FROM bot_agents WHERE id=$1', [req.params.id]);
      if (r.rows[0]) await tgSend(r.rows[0].chat_id, '✅ Доступ подтверждён! Пришлите номер счёт-фактуры — и я верну скан.', { reply_markup: { remove_keyboard: true } });
    }
    res.json({ ok: true });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// Адресное уведомление о расхождении: лично агенту (по привязке) либо в общий чат
app.post('/api/telegram/notify', async (req, res) => {
  if (!TG_TOKEN) return res.status(400).json({ error: 'Telegram не настроен' });
  if (!pool) return res.status(400).json({ error: 'Нет базы' });
  const invNum = (req.body && req.body.invoice_number || '').toString().trim();
  if (!invNum) return res.status(400).json({ error: 'Нет номера СФ' });
  try {
    const r = await pool.query('SELECT * FROM invoices WHERE invoice_number=$1 ORDER BY saved_at DESC LIMIT 1', [invNum]);
    if (!r.rows.length) return res.status(404).json({ error: 'Накладная не найдена в базе' });
    const v = r.rows[0];
    const diff = Number(v.crm_diff) || 0;
    const lines = [
      '⚠️ <b>Расхождение по счёт-фактуре</b>',
      'СФ № ' + (v.invoice_number || '—'),
      (v.customer_name || '') + (v.delivery_point ? (' · ' + v.delivery_point) : ''),
      'Дата: ' + (v.invoice_date || '—'),
      'Скан: ' + (v.total_amount != null ? Number(v.total_amount).toLocaleString('ru-RU') : '—') + ' сум',
      'CRM: ' + (v.crm_total != null ? Number(v.crm_total).toLocaleString('ru-RU') : '—') + ' сум',
      'Разница: ' + (diff > 0 ? '+' : '') + diff.toLocaleString('ru-RU') + ' сум'
    ];
    if (v.manual_correction === 'Да') lines.push('✏️ На скане есть ручные исправления');
    const text = lines.join('\n');

    let chatId = null, sentTo = 'default';
    if (v.crm_agent || v.crm_agent_name) {
      const a = await pool.query(
        `SELECT chat_id FROM bot_agents WHERE status='active' AND (
            agent_code=$1
            OR lower(trim(agent_name))=lower(trim($2))
            OR lower(trim(agent_name))=lower(trim($1))
         ) LIMIT 1`,
        [String(v.crm_agent || ''), String(v.crm_agent_name || '')]);
      if (a.rows.length) { chatId = a.rows[0].chat_id; sentTo = 'agent'; }
    }
    if (!chatId) chatId = process.env.TELEGRAM_DEFAULT_CHAT_ID;
    if (!chatId) return res.status(400).json({ error: 'Нет получателя: агент не привязан и не задан TELEGRAM_DEFAULT_CHAT_ID' });

    const img = await invoiceImageBuffer(v);
    if (img) { const ext = (img.mtype || '').includes('png') ? 'png' : 'jpg'; await tgSendDoc(chatId, img.buffer, img.mtype, text, 'SF_' + v.invoice_number + '.' + ext); }
    else await tgSend(chatId, text);
    res.json({ ok: true, sentTo });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

/* ============================================================
   4. База данных накладных — сохранение, поиск, получение скана
   ============================================================ */
app.post('/api/invoices', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена (DATABASE_URL).' });
  try {
    const b = req.body || {};
    if (!b.doc_key) return res.status(400).json({ error: 'Нет doc_key' });

    // Скан: если есть R2 — грузим туда; иначе (или при сбое) — храним в базе
    let imageKey = null, base64ToStore = null;
    if (b.image_base64) {
      if (r2) {
        try { imageKey = await r2Upload(b.doc_key, b.image_base64, b.image_media_type); }
        catch (e) { console.error('R2 upload error:', e.message); }
      }
      if (!imageKey) base64ToStore = b.image_base64;
    }

    await pool.query(`
      INSERT INTO invoices
        (doc_key, invoice_number, invoice_date, invoice_date_iso, customer_name, inn, delivery_point, order_number,
         total_amount, vat_amount, manual_correction, correction_comment, recognition_status, confidence_score,
         crm_found, crm_sd_id, crm_invoice_number, crm_total, crm_diff, crm_match, crm_agent,
         file_name, page_number, image_base64, image_media_type, operator, uploaded_at, image_key, crm_agent_name, saved_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27,$28,$29, NOW())
      ON CONFLICT (doc_key) DO UPDATE SET
        invoice_number=$2, invoice_date=$3, invoice_date_iso=$4, customer_name=$5, inn=$6, delivery_point=$7, order_number=$8,
        total_amount=$9, vat_amount=$10, manual_correction=$11, correction_comment=$12, recognition_status=$13, confidence_score=$14,
        crm_found=$15, crm_sd_id=$16, crm_invoice_number=$17, crm_total=$18, crm_diff=$19, crm_match=$20, crm_agent=$21,
        file_name=$22, page_number=$23, image_base64=COALESCE($24, invoices.image_base64), image_media_type=$25, operator=$26, uploaded_at=$27,
        image_key=COALESCE($28, invoices.image_key), crm_agent_name=$29, saved_at=NOW()
    `, [
      b.doc_key, b.invoice_number || null, b.invoice_date || null, dateToIso(b.invoice_date), b.customer_name || null, b.inn || null,
      b.delivery_point || null, b.order_number || null,
      num(b.total_amount), num(b.vat_amount), b.manual_correction || null, b.correction_comment || null, b.recognition_status || null, num(b.confidence_score),
      b.crm_found ?? null, b.crm_sd_id || null, b.crm_invoice_number || null, num(b.crm_total), num(b.crm_diff), b.crm_match ?? null, b.crm_agent || null,
      b.file_name || null, b.page_number || null, base64ToStore, b.image_media_type || null, b.operator || null, b.uploaded_at || null, imageKey, b.crm_agent_name || null
    ]);
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена.' });
  try {
    const q = (req.query.q || '').toString().trim();
    const inn = (req.query.inn || '').toString().trim();
    const from = (req.query.from || '').toString().trim();
    const to = (req.query.to || '').toString().trim();
    const status = (req.query.status || '').toString().trim();   // ok | review | mismatch | corr
    const where = []; const p = [];
    if (q) { p.push('%' + q + '%'); const i = p.length; where.push(`(invoice_number ILIKE $${i} OR customer_name ILIKE $${i} OR delivery_point ILIKE $${i} OR order_number ILIKE $${i})`); }
    if (inn) { p.push(inn + '%'); where.push(`inn ILIKE $${p.length}`); }
    if (from) { p.push(from); where.push(`invoice_date_iso >= $${p.length}`); }
    if (to) { p.push(to); where.push(`invoice_date_iso <= $${p.length}`); }
    if (status === 'mismatch') where.push(`crm_match = false`);
    if (status === 'corr') where.push(`manual_correction = 'Да'`);
    if (status === 'ok') where.push(`recognition_status = 'OK'`);
    if (status === 'review') where.push(`recognition_status <> 'OK'`);
    const sql = `SELECT invoices.id, invoice_number, invoice_date, customer_name, inn, delivery_point, order_number,
      total_amount, vat_amount, manual_correction, recognition_status, crm_found, crm_total, crm_diff, crm_match, crm_agent, crm_agent_name,
      ca.login AS agent_login, file_name, page_number, saved_at
      FROM invoices LEFT JOIN crm_agents ca ON ca.sd_id = invoices.crm_agent
      ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY invoice_date_iso DESC NULLS LAST, saved_at DESC LIMIT 500`;
    const r = await pool.query(sql, p);
    res.json({ count: r.rows.length, rows: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices/:id/image', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена.' });
  try {
    const r = await pool.query('SELECT image_base64, image_media_type, image_key FROM invoices WHERE id=$1', [req.params.id]);
    if (!r.rows.length) return res.status(404).json({ error: 'Скан не найден' });
    const row = r.rows[0];
    if (row.image_key && r2) {
      try { const dataUrl = await r2GetDataUrl(row.image_key, row.image_media_type); if (dataUrl) return res.json({ dataUrl }); }
      catch (e) { console.error('R2 get error:', e.message); }
    }
    if (row.image_base64) return res.json({ dataUrl: 'data:' + (row.image_media_type || 'image/jpeg') + ';base64,' + row.image_base64 });
    return res.status(404).json({ error: 'Скан не найден' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* небольшой помощник для чисел */
function num(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return isNaN(n) ? null : n; }

app.post('/api/invoices/delete', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена.' });
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Не переданы id' });
  try {
    // сначала забираем ключи R2, чтобы удалить файлы из хранилища
    const keys = await pool.query('SELECT image_key FROM invoices WHERE id = ANY($1::bigint[]) AND image_key IS NOT NULL', [ids]);
    const r = await pool.query('DELETE FROM invoices WHERE id = ANY($1::bigint[])', [ids]);
    for (const row of keys.rows) await r2Delete(row.image_key);
    res.json({ ok: true, deleted: r.rowCount });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* Перенос старых сканов из базы в R2: открыть /api/migrate-to-r2 */
app.get('/api/migrate-to-r2', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена.' });
  if (!r2) return res.status(400).json({ error: 'R2 не настроен — добавьте переменные R2_* в Railway.' });
  try {
    const r = await pool.query("SELECT id, doc_key, image_base64, image_media_type FROM invoices WHERE image_base64 IS NOT NULL AND image_key IS NULL LIMIT 500");
    let moved = 0, failed = 0;
    for (const row of r.rows) {
      try {
        const key = await r2Upload(row.doc_key, row.image_base64, row.image_media_type);
        if (key) { await pool.query('UPDATE invoices SET image_key=$1, image_base64=NULL WHERE id=$2', [key, row.id]); moved++; }
        else failed++;
      } catch (e) { failed++; }
    }
    res.json({ ok: true, moved, failed, remaining_checked: r.rows.length });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ============================================================
   5. Статус конфигурации — что включено на сервере
   ============================================================ */
app.get('/api/config', (req, res) => {
  res.json({
    sd:       !!(process.env.SD_DOMAIN && process.env.SD_LOGIN && process.env.SD_PASSWORD),
    telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    db:       !!pool,
    r2:       !!r2,
    auth:     AUTH_ON,
    sdIdType: process.env.SD_ID_TYPE || 'code_1C'
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
