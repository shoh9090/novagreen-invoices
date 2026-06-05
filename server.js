const express = require('express');
const path    = require('path');

const app = express();
app.use(express.json({ limit: '50mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* ============================================================
   1. Claude API — распознавание (безопасный прокси)
   ============================================================ */
app.post('/api/claude', async (req, res) => {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) return res.status(500).json({ error: 'ANTHROPIC_API_KEY не задан в настройках Railway.' });
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify(req.body)
    });
    const data = await r.json();
    res.status(r.status).json(data);
  } catch (err) {
    res.status(502).json({ error: 'Ошибка Claude API: ' + err.message });
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
    const orderNumber = (req.body && req.body.orderNumber || '').toString().trim();
    if (!orderNumber) return res.status(400).json({ error: 'Не передан номер заказа.' });
    const idType = (process.env.SD_ID_TYPE || req.body.idType || 'code_1C');
    const field  = ['SD_id', 'CS_id', 'code_1C'].includes(idType) ? idType : 'code_1C';

    const makeBody = (auth) => ({
      method: 'getOrder',
      auth: { userId: auth.userId, token: auth.token },
      params: { limit: 5, filter: { [field]: orderNumber, status: [1, 2, 3, 4, 5] } }
    });

    let auth = await sdLogin(false);
    let r = await fetch(`https://${domain}/api/v2`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makeBody(auth))
    });
    let j = await r.json();
    // Истёк/занят токен → один повторный логин
    if (j.error && (j.error.code === 401)) {
      auth = await sdLogin(true);
      r = await fetch(`https://${domain}/api/v2`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(makeBody(auth))
      });
      j = await r.json();
    }
    if (!j.status) return res.json({ found: false, error: (j.error && j.error.message) || 'Ошибка SalesDoctor' });

    const orders = (j.result && j.result.order) || [];
    if (!orders.length) return res.json({ found: false });

    const o = orders[0];
    res.json({
      found: true,
      order: {
        code_1C: o.code_1C, SD_id: o.SD_id, CS_id: o.CS_id,
        status: o.status, invoiceNumber: o.invoiceNumber, dateDocument: o.dateDocument,
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
   4. Статус конфигурации — что включено на сервере
   ============================================================ */
app.get('/api/config', (req, res) => {
  res.json({
    sd:       !!(process.env.SD_DOMAIN && process.env.SD_LOGIN && process.env.SD_PASSWORD),
    telegram: !!process.env.TELEGRAM_BOT_TOKEN,
    sdIdType: process.env.SD_ID_TYPE || 'code_1C'
  });
});

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`✅ Сервер запущен на порту ${PORT}`));
