// server.js — Hub: ядро-лаунчер (Этап 1)
const path = require('path');
const express = require('express');
const cookieParser = require('cookie-parser');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const db = require('./src/db');

const app = express();
const PORT = process.env.PORT || 3000;
const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-railway-variables';
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });

app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'src', 'views'));
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());
app.use('/static', express.static(path.join(__dirname, 'public')));

// ---------- Аутентификация ----------

function signToken(user) {
  return jwt.sign(
    { id: user.id, login: user.login, name: user.full_name, isAdmin: user.is_admin, roles: user.roles },
    JWT_SECRET,
    { expiresIn: '12h' }
  );
}

async function loadUser(req, res, next) {
  const token = req.cookies.hub_token;
  if (token) {
    try {
      req.user = jwt.verify(token, JWT_SECRET);
    } catch (e) {
      res.clearCookie('hub_token');
    }
  }
  next();
}

function requireAuth(req, res, next) {
  if (!req.user) return res.redirect('/login');
  next();
}

function requireAdmin(req, res, next) {
  if (!req.user || !req.user.isAdmin) return res.status(403).send('Доступ только для администратора');
  next();
}

app.use(loadUser);

app.get('/login', async (req, res) => {
  if (req.user) return res.redirect('/');
  const settings = await db.getSettings();
  res.render('login', { settings, error: null });
});

app.post('/login', async (req, res) => {
  const settings = await db.getSettings();
  const { login, password } = req.body;
  const r = await db.pool.query('SELECT * FROM users WHERE login = $1 AND is_active = TRUE', [login]);
  if (r.rows.length === 0) {
    return res.render('login', { settings, error: 'Неверный логин или пароль' });
  }
  const user = r.rows[0];
  const ok = await bcrypt.compare(password || '', user.password_hash);
  if (!ok) {
    return res.render('login', { settings, error: 'Неверный логин или пароль' });
  }
  const rolesQ = await db.pool.query(
    `SELECT r.id, r.name, r.is_admin FROM roles r
     JOIN user_roles ur ON ur.role_id = r.id WHERE ur.user_id = $1`,
    [user.id]
  );
  const roles = rolesQ.rows;
  const token = signToken({
    id: user.id,
    login: user.login,
    full_name: user.full_name,
    is_admin: roles.some((x) => x.is_admin),
    roles: roles.map((x) => x.name),
  });
  res.cookie('hub_token', token, { httpOnly: true, sameSite: 'lax', maxAge: 12 * 3600 * 1000 });
  await db.log(user.id, 'login');
  res.redirect('/');
});

app.post('/logout', (req, res) => {
  res.clearCookie('hub_token');
  res.redirect('/login');
});

// ---------- Лаунчер ----------

app.get('/', requireAuth, async (req, res) => {
  const settings = await db.getSettings();
  let tiles;
  if (req.user.isAdmin) {
    tiles = await db.pool.query('SELECT * FROM tiles WHERE is_visible = TRUE ORDER BY sort_order, id');
  } else {
    tiles = await db.pool.query(
      `SELECT DISTINCT t.* FROM tiles t
       JOIN role_tiles rt ON rt.tile_id = t.id
       JOIN user_roles ur ON ur.role_id = rt.role_id
       WHERE ur.user_id = $1 AND t.is_visible = TRUE
       ORDER BY t.sort_order, t.id`,
      [req.user.id]
    );
  }
  res.render('launcher', { settings, user: req.user, tiles: tiles.rows });
});

// Выдача загруженных файлов (логотип, фон) из базы
app.get('/file/:id', async (req, res) => {
  const r = await db.pool.query('SELECT mime, data FROM files WHERE id = $1', [req.params.id]);
  if (r.rows.length === 0) return res.status(404).end();
  res.set('Content-Type', r.rows[0].mime);
  res.set('Cache-Control', 'public, max-age=3600');
  res.send(r.rows[0].data);
});

// Смена собственного пароля
app.post('/me/password', requireAuth, async (req, res) => {
  const { password } = req.body;
  if (!password || password.length < 6) return res.redirect('/?msg=short');
  const hash = await bcrypt.hash(password, 10);
  await db.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.user.id]);
  await db.log(req.user.id, 'change_own_password');
  res.redirect('/');
});

// ---------- Админ-панель ----------

const admin = express.Router();
admin.use(requireAuth, requireAdmin);

async function adminContext(section) {
  const settings = await db.getSettings();
  return { settings, section };
}

// Пользователи
admin.get('/users', async (req, res) => {
  const users = await db.pool.query(
    `SELECT u.*, COALESCE(string_agg(r.name, ', ' ORDER BY r.name), '—') AS role_names
     FROM users u
     LEFT JOIN user_roles ur ON ur.user_id = u.id
     LEFT JOIN roles r ON r.id = ur.role_id
     GROUP BY u.id ORDER BY u.id`
  );
  const roles = await db.pool.query('SELECT * FROM roles ORDER BY id');
  res.render('admin/users', { ...(await adminContext('users')), user: req.user, users: users.rows, roles: roles.rows });
});

admin.post('/users', async (req, res) => {
  const { login, full_name, password } = req.body;
  let roleIds = req.body.role_ids || [];
  if (!Array.isArray(roleIds)) roleIds = [roleIds];
  if (!login || !full_name || !password) return res.redirect('/admin/users');
  const hash = await bcrypt.hash(password, 10);
  try {
    const ins = await db.pool.query(
      'INSERT INTO users (login, full_name, password_hash) VALUES ($1, $2, $3) RETURNING id',
      [login.trim(), full_name.trim(), hash]
    );
    for (const rid of roleIds) {
      await db.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ins.rows[0].id, rid]);
    }
    await db.log(req.user.id, 'create_user', login);
  } catch (e) {
    console.error(e.message);
  }
  res.redirect('/admin/users');
});

admin.post('/users/:id/toggle', async (req, res) => {
  await db.pool.query('UPDATE users SET is_active = NOT is_active WHERE id = $1', [req.params.id]);
  await db.log(req.user.id, 'toggle_user', req.params.id);
  res.redirect('/admin/users');
});

admin.post('/users/:id/password', async (req, res) => {
  const { password } = req.body;
  if (password && password.length >= 6) {
    const hash = await bcrypt.hash(password, 10);
    await db.pool.query('UPDATE users SET password_hash = $1 WHERE id = $2', [hash, req.params.id]);
    await db.log(req.user.id, 'reset_password', req.params.id);
  }
  res.redirect('/admin/users');
});

admin.post('/users/:id/roles', async (req, res) => {
  let roleIds = req.body.role_ids || [];
  if (!Array.isArray(roleIds)) roleIds = [roleIds];
  await db.pool.query('DELETE FROM user_roles WHERE user_id = $1', [req.params.id]);
  for (const rid of roleIds) {
    await db.pool.query('INSERT INTO user_roles (user_id, role_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, rid]);
  }
  await db.log(req.user.id, 'set_user_roles', req.params.id);
  res.redirect('/admin/users');
});

// Роли
admin.get('/roles', async (req, res) => {
  const roles = await db.pool.query(
    `SELECT r.*, COALESCE(string_agg(t.title, ', ' ORDER BY t.title), '—') AS tile_names
     FROM roles r
     LEFT JOIN role_tiles rt ON rt.role_id = r.id
     LEFT JOIN tiles t ON t.id = rt.tile_id
     GROUP BY r.id ORDER BY r.id`
  );
  const tiles = await db.pool.query('SELECT * FROM tiles ORDER BY sort_order, id');
  const roleTiles = await db.pool.query('SELECT * FROM role_tiles');
  res.render('admin/roles', {
    ...(await adminContext('roles')),
    user: req.user,
    roles: roles.rows,
    tiles: tiles.rows,
    roleTiles: roleTiles.rows,
  });
});

admin.post('/roles', async (req, res) => {
  const { name } = req.body;
  if (name && name.trim()) {
    try {
      await db.pool.query('INSERT INTO roles (name) VALUES ($1)', [name.trim()]);
      await db.log(req.user.id, 'create_role', name);
    } catch (e) {
      console.error(e.message);
    }
  }
  res.redirect('/admin/roles');
});

admin.post('/roles/:id/tiles', async (req, res) => {
  let tileIds = req.body.tile_ids || [];
  if (!Array.isArray(tileIds)) tileIds = [tileIds];
  await db.pool.query('DELETE FROM role_tiles WHERE role_id = $1', [req.params.id]);
  for (const tid of tileIds) {
    await db.pool.query('INSERT INTO role_tiles (role_id, tile_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [req.params.id, tid]);
  }
  await db.log(req.user.id, 'set_role_tiles', req.params.id);
  res.redirect('/admin/roles');
});

admin.post('/roles/:id/delete', async (req, res) => {
  const r = await db.pool.query('SELECT is_admin FROM roles WHERE id = $1', [req.params.id]);
  if (r.rows.length && !r.rows[0].is_admin) {
    await db.pool.query('DELETE FROM roles WHERE id = $1', [req.params.id]);
    await db.log(req.user.id, 'delete_role', req.params.id);
  }
  res.redirect('/admin/roles');
});

// Плитки
admin.get('/tiles', async (req, res) => {
  const tiles = await db.pool.query('SELECT * FROM tiles ORDER BY sort_order, id');
  res.render('admin/tiles', { ...(await adminContext('tiles')), user: req.user, tiles: tiles.rows });
});

admin.post('/tiles', async (req, res) => {
  const { title, description, icon, url, sort_order } = req.body;
  if (title && url) {
    await db.pool.query(
      `INSERT INTO tiles (title, description, icon, url, open_new_tab, sort_order)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      [title.trim(), description || '', icon || '🧩', url.trim(), !!req.body.open_new_tab, parseInt(sort_order) || 100]
    );
    await db.log(req.user.id, 'create_tile', title);
  }
  res.redirect('/admin/tiles');
});

admin.post('/tiles/:id', async (req, res) => {
  const { title, description, icon, url, sort_order } = req.body;
  await db.pool.query(
    `UPDATE tiles SET title=$1, description=$2, icon=$3, url=$4, open_new_tab=$5, sort_order=$6 WHERE id=$7`,
    [title.trim(), description || '', icon || '🧩', url.trim(), !!req.body.open_new_tab, parseInt(sort_order) || 100, req.params.id]
  );
  await db.log(req.user.id, 'update_tile', req.params.id);
  res.redirect('/admin/tiles');
});

admin.post('/tiles/:id/toggle', async (req, res) => {
  await db.pool.query('UPDATE tiles SET is_visible = NOT is_visible WHERE id = $1', [req.params.id]);
  res.redirect('/admin/tiles');
});

admin.post('/tiles/:id/delete', async (req, res) => {
  await db.pool.query('DELETE FROM tiles WHERE id = $1', [req.params.id]);
  await db.log(req.user.id, 'delete_tile', req.params.id);
  res.redirect('/admin/tiles');
});

// Оформление
admin.get('/appearance', async (req, res) => {
  res.render('admin/appearance', { ...(await adminContext('appearance')), user: req.user });
});

admin.post('/appearance', upload.fields([{ name: 'logo' }, { name: 'bg' }]), async (req, res) => {
  const { company_name, brand_color, bg_dim } = req.body;
  if (company_name) await db.setSetting('company_name', company_name.trim());
  if (brand_color) await db.setSetting('brand_color', brand_color);
  if (bg_dim !== undefined) await db.setSetting('bg_dim', String(Math.min(85, Math.max(0, parseInt(bg_dim) || 0))));

  async function saveFile(field, settingKey) {
    const f = req.files && req.files[field] && req.files[field][0];
    if (!f) return;
    if (!f.mimetype.startsWith('image/')) return;
    const ins = await db.pool.query(
      'INSERT INTO files (name, mime, data) VALUES ($1, $2, $3) RETURNING id',
      [f.originalname, f.mimetype, f.buffer]
    );
    await db.setSetting(settingKey, String(ins.rows[0].id));
  }
  await saveFile('logo', 'logo_file_id');
  await saveFile('bg', 'bg_file_id');

  if (req.body.remove_bg) await db.setSetting('bg_file_id', '');
  if (req.body.remove_logo) await db.setSetting('logo_file_id', '');

  await db.log(req.user.id, 'update_appearance');
  res.redirect('/admin/appearance');
});

app.use('/admin', admin);

// ---------- Блок «Справочники» (отдельный модуль ядра) ----------
// Доступ: администратор — всегда; сотрудник — если его роли назначена плитка с адресом /dictionaries

async function requireDictAccess(req, res, next) {
  if (!req.user) return res.redirect('/login');
  if (req.user.isAdmin) return next();
  const r = await db.pool.query(
    `SELECT 1 FROM tiles t
     JOIN role_tiles rt ON rt.tile_id = t.id
     JOIN user_roles ur ON ur.role_id = rt.role_id
     WHERE ur.user_id = $1 AND t.url = '/dictionaries' LIMIT 1`,
    [req.user.id]
  );
  if (r.rows.length === 0) return res.status(403).send('Нет доступа к справочникам. Обратитесь к администратору.');
  next();
}

const dict = express.Router();
dict.use(requireDictAccess);

dict.get('/', async (req, res) => {
  const settings = await db.getSettings();
  res.render('dictionaries_spa', { settings, user: req.user });
});

app.use('/dictionaries', dict);

// JSON API справочников (раздел 18 ТЗ) — те же права доступа, что и у модуля
const refsRouter = require('./src/refs');
app.use('/api/refs', requireDictAccess, refsRouter);

app.get('/admin', (req, res) => res.redirect('/admin/users'));

// Здоровье сервиса (для Railway)
app.get('/health', (req, res) => res.json({ ok: true }));

// ---------- Запуск ----------
(async () => {
  try {
    await db.migrate();
    await db.seed();
    await db.migrateLegacyDicts();
    app.listen(PORT, () => console.log(`Hub запущен на порту ${PORT}`));
  } catch (e) {
    console.error('Ошибка запуска:', e);
    process.exit(1);
  }
})();
