const express = require('express');
const path    = require('path');
const { Pool } = require('pg');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

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
  console.log('✅ База данных готова (таблица invoices)');
}
initDb().catch(e => console.error('Ошибка инициализации базы:', e.message));

function dateToIso(d) {
  const m = (d || '').toString().match(/(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})/);
  return m ? `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}` : null;
}

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
   4. База данных накладных — сохранение, поиск, получение скана
   ============================================================ */
app.post('/api/invoices', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена (DATABASE_URL).' });
  try {
    const b = req.body || {};
    if (!b.doc_key) return res.status(400).json({ error: 'Нет doc_key' });
    await pool.query(`
      INSERT INTO invoices
        (doc_key, invoice_number, invoice_date, invoice_date_iso, customer_name, inn, delivery_point, order_number,
         total_amount, vat_amount, manual_correction, correction_comment, recognition_status, confidence_score,
         crm_found, crm_sd_id, crm_invoice_number, crm_total, crm_diff, crm_match, crm_agent,
         file_name, page_number, image_base64, image_media_type, operator, uploaded_at, saved_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20,$21,$22,$23,$24,$25,$26,$27, NOW())
      ON CONFLICT (doc_key) DO UPDATE SET
        invoice_number=$2, invoice_date=$3, invoice_date_iso=$4, customer_name=$5, inn=$6, delivery_point=$7, order_number=$8,
        total_amount=$9, vat_amount=$10, manual_correction=$11, correction_comment=$12, recognition_status=$13, confidence_score=$14,
        crm_found=$15, crm_sd_id=$16, crm_invoice_number=$17, crm_total=$18, crm_diff=$19, crm_match=$20, crm_agent=$21,
        file_name=$22, page_number=$23, image_base64=COALESCE($24, invoices.image_base64), image_media_type=$25, operator=$26, uploaded_at=$27, saved_at=NOW()
    `, [
      b.doc_key, b.invoice_number || null, b.invoice_date || null, dateToIso(b.invoice_date), b.customer_name || null, b.inn || null,
      b.delivery_point || null, b.order_number || null,
      num(b.total_amount), num(b.vat_amount), b.manual_correction || null, b.correction_comment || null, b.recognition_status || null, num(b.confidence_score),
      b.crm_found ?? null, b.crm_sd_id || null, b.crm_invoice_number || null, num(b.crm_total), num(b.crm_diff), b.crm_match ?? null, b.crm_agent || null,
      b.file_name || null, b.page_number || null, b.image_base64 || null, b.image_media_type || null, b.operator || null, b.uploaded_at || null
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
    const sql = `SELECT id, invoice_number, invoice_date, customer_name, inn, delivery_point, order_number,
      total_amount, vat_amount, manual_correction, recognition_status, crm_found, crm_total, crm_diff, crm_match, crm_agent, file_name, page_number, saved_at
      FROM invoices ${where.length ? 'WHERE ' + where.join(' AND ') : ''}
      ORDER BY invoice_date_iso DESC NULLS LAST, saved_at DESC LIMIT 500`;
    const r = await pool.query(sql, p);
    res.json({ count: r.rows.length, rows: r.rows });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/api/invoices/:id/image', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена.' });
  try {
    const r = await pool.query('SELECT image_base64, image_media_type FROM invoices WHERE id=$1', [req.params.id]);
    if (!r.rows.length || !r.rows[0].image_base64) return res.status(404).json({ error: 'Скан не найден' });
    res.json({ dataUrl: 'data:' + (r.rows[0].image_media_type || 'image/jpeg') + ';base64,' + r.rows[0].image_base64 });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* небольшой помощник для чисел */
function num(v) { if (v === '' || v === null || v === undefined) return null; const n = Number(v); return isNaN(n) ? null : n; }

app.post('/api/invoices/delete', async (req, res) => {
  if (!pool) return res.status(400).json({ error: 'База не подключена.' });
  const ids = (req.body && req.body.ids) || [];
  if (!Array.isArray(ids) || !ids.length) return res.status(400).json({ error: 'Не переданы id' });
  try {
    const r = await pool.query('DELETE FROM invoices WHERE id = ANY($1::bigint[])', [ids]);
    res.json({ ok: true, deleted: r.rowCount });
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
    sdIdType: process.env.SD_ID_TYPE || 'code_1C'
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
