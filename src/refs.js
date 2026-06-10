// refs.js — JSON API справочников (раздел 18 ТЗ): list, get, create, update, archive, restore
const express = require('express');
const multer = require('multer');
const db = require('./db');
const { REF_TYPES, COMMON_FIELDS, clientMeta } = require('./refs-config');

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 8 * 1024 * 1024 } });
const router = express.Router();

function typeOr404(req, res) {
  const t = REF_TYPES[req.params.type];
  if (!t) {
    res.status(404).json({ error: 'Неизвестный справочник' });
    return null;
  }
  return t;
}

function allFields(t) {
  return [...COMMON_FIELDS, ...t.fields, { key: 'short_name', label: 'Краткое название', type: 'text' }];
}

function pickValues(t, body) {
  const out = {};
  for (const f of allFields(t)) {
    if (!(f.key in body)) continue;
    let v = body[f.key];
    if (f.type === 'bool') v = v === true || v === 'true' || v === 'on' || v === 1;
    else if (f.type === 'number') v = v === '' || v === null ? null : Number(v);
    else if (f.type === 'ref') v = v === '' || v === null ? null : parseInt(v);
    else v = v === null || v === undefined ? '' : String(v).trim();
    out[f.key] = v;
  }
  if ('sort' in body) out.sort = parseInt(body.sort) || 100;
  return out;
}

function validate(t, values, isCreate) {
  const errors = [];
  for (const f of allFields(t)) {
    if (f.required) {
      const v = values[f.key];
      const empty = v === undefined || v === null || v === '';
      if (isCreate && empty) errors.push(`Не заполнено обязательное поле: ${f.label}`);
      if (!isCreate && f.key in values && empty) errors.push(`Поле «${f.label}» не может быть пустым`);
    }
  }
  return errors;
}

// Метаданные схем для интерфейса
router.get('/_meta', (req, res) => {
  res.json(clientMeta());
});

// Список с поиском, фильтром, сортировкой, пагинацией
router.get('/:type', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const limit = Math.min(1000, parseInt(req.query.limit) || 100);
  const offset = (page - 1) * limit;
  const status = req.query.status || 'active';
  const q = (req.query.q || '').trim();

  const fields = allFields(t);
  const sortable = new Set(['id', 'name', 'code', 'sort', 'updated_at', ...fields.map((f) => f.key)]);
  const sortField = sortable.has(req.query.sort) ? req.query.sort : 'name';
  const order = req.query.order === 'desc' ? 'DESC' : 'ASC';

  const where = [];
  const params = [];
  if (status !== 'all') {
    params.push(status);
    where.push(`status = $${params.length}`);
  }
  if (q) {
    const searchCols = ['name', 'code', 'code_1c', 'short_name', ...t.fields.filter((f) => f.searchable).map((f) => f.key)];
    params.push('%' + q + '%');
    where.push('(' + searchCols.map((c) => `${c} ILIKE $${params.length}`).join(' OR ') + ')');
  }
  const whereSQL = where.length ? 'WHERE ' + where.join(' AND ') : '';

  const total = await db.pool.query(`SELECT count(*)::int AS n FROM ${t.table} ${whereSQL}`, params);
  const rows = await db.pool.query(
    `SELECT * FROM ${t.table} ${whereSQL} ORDER BY ${sortField} ${order} NULLS LAST, id LIMIT ${limit} OFFSET ${offset}`,
    params
  );
  res.json({ total: total.rows[0].n, page, limit, items: rows.rows });
});

router.get('/:type/:id(\\d+)', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const r = await db.pool.query(`SELECT * FROM ${t.table} WHERE id = $1`, [req.params.id]);
  if (!r.rows.length) return res.status(404).json({ error: 'Запись не найдена' });
  res.json(r.rows[0]);
});

router.post('/:type', express.json(), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const values = pickValues(t, req.body || {});
  const errors = validate(t, values, true);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });

  // Проверка дублей
  for (const dk of t.dedupe || []) {
    const v = values[dk];
    if (!v) continue;
    const dup = await db.pool.query(`SELECT id, name FROM ${t.table} WHERE lower(${dk}::text) = lower($1) LIMIT 1`, [String(v)]);
    if (dup.rows.length) {
      return res.status(409).json({ error: `Дубль по полю «${dk}»: уже существует запись «${dup.rows[0].name}» (id ${dup.rows[0].id})` });
    }
  }

  const keys = Object.keys(values);
  keys.push('created_by', 'updated_by');
  const vals = [...Object.values(values), req.user.id, req.user.id];
  const placeholders = keys.map((_, i) => `$${i + 1}`).join(', ');
  const r = await db.pool.query(
    `INSERT INTO ${t.table} (${keys.join(', ')}) VALUES (${placeholders}) RETURNING *`,
    vals
  );
  await db.log(req.user.id, `ref_create_${req.params.type}`, r.rows[0].name);
  res.json(r.rows[0]);
});

router.put('/:type/:id(\\d+)', express.json(), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  const values = pickValues(t, req.body || {});
  const errors = validate(t, values, false);
  if (errors.length) return res.status(400).json({ error: errors.join('; ') });
  const keys = Object.keys(values);
  if (!keys.length) return res.status(400).json({ error: 'Нет данных для сохранения' });
  const sets = keys.map((k, i) => `${k} = $${i + 1}`);
  const vals = Object.values(values);
  vals.push(req.user.id, req.params.id);
  const r = await db.pool.query(
    `UPDATE ${t.table} SET ${sets.join(', ')}, updated_at = now(), updated_by = $${vals.length - 1} WHERE id = $${vals.length} RETURNING *`,
    vals
  );
  if (!r.rows.length) return res.status(404).json({ error: 'Запись не найдена' });
  await db.log(req.user.id, `ref_update_${req.params.type}`, String(req.params.id));
  res.json(r.rows[0]);
});

router.post('/:type/:id(\\d+)/archive', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  await db.pool.query(
    `UPDATE ${t.table} SET status = 'archived', archived_at = now(), archived_by = $1 WHERE id = $2`,
    [req.user.id, req.params.id]
  );
  await db.log(req.user.id, `ref_archive_${req.params.type}`, String(req.params.id));
  res.json({ ok: true });
});

router.post('/:type/:id(\\d+)/restore', async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  await db.pool.query(
    `UPDATE ${t.table} SET status = 'active', archived_at = NULL, archived_by = NULL WHERE id = $1`,
    [req.params.id]
  );
  await db.log(req.user.id, `ref_restore_${req.params.type}`, String(req.params.id));
  res.json({ ok: true });
});

// Простой импорт (полный мастер импорта — Итерация 3): колонка A — название, B — код
router.post('/:type/import-simple', upload.single('file'), async (req, res) => {
  const t = typeOr404(req, res);
  if (!t) return;
  if (!req.file) return res.status(400).json({ error: 'Файл не получен' });
  let rows = [];
  try {
    const XLSX = require('xlsx');
    const wb = XLSX.read(req.file.buffer, { type: 'buffer' });
    rows = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, defval: '' });
  } catch (e) {
    return res.status(400).json({ error: 'Не удалось прочитать файл: ' + e.message });
  }
  let added = 0;
  let skipped = 0;
  for (const row of rows) {
    const name = String(row[0] || '').trim();
    const code = String(row[1] || '').trim();
    if (!name || /^(название|наименование)$/i.test(name)) continue;
    const dup = await db.pool.query(`SELECT 1 FROM ${t.table} WHERE lower(name) = lower($1)`, [name]);
    if (dup.rows.length) {
      skipped++;
      continue;
    }
    try {
      // Заполняем обязательные ref-поля значением по умолчанию нельзя — пропускаем их проверку на импорте
      await db.pool.query(`INSERT INTO ${t.table} (name, code, created_by, updated_by) VALUES ($1, $2, $3, $3)`, [
        name,
        code,
        req.user.id,
      ]);
      added++;
    } catch (e) {
      skipped++;
    }
  }
  await db.log(req.user.id, `ref_import_${req.params.type}`, `added=${added} skipped=${skipped}`);
  res.json({ added, skipped });
});

module.exports = router;
