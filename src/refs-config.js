// refs-config.js — схемы всех справочников (по ТЗ «Справочники» v1.0)
// Один конфиг управляет: созданием таблиц, API, валидацией и интерфейсом.

// Типы полей: text | textarea | number | bool | enum | ref
// listCol: показывать в таблице; searchable: участвует в поиске

const REF_GROUPS = [
  { key: 'nomenclature', label: 'Номенклатура' },
  { key: 'partners', label: 'Контрагенты' },
  { key: 'infrastructure', label: 'Инфраструктура' },
  { key: 'classifiers', label: 'Классификаторы' },
];

const REF_TYPES = {
  units: {
    table: 'ref_units',
    label: 'Единицы измерения',
    icon: '📏',
    group: 'classifiers',
    dedupe: ['name', 'short_name'],
    fields: [
      { key: 'short_name', label: 'Краткое', type: 'text', required: true, listCol: true, searchable: true },
      { key: 'unit_type', label: 'Тип', type: 'enum', options: ['вес', 'штука', 'объём', 'упаковка'], listCol: true },
    ],
  },

  raw_materials: {
    table: 'ref_raw_materials',
    label: 'Номенклатура сырья',
    icon: '🥬',
    group: 'nomenclature',
    dedupe: ['name', 'code'],
    fields: [
      { key: 'category_id', label: 'Категория', type: 'ref', ref: 'categories', listCol: true },
      { key: 'unit_id', label: 'Ед. изм.', type: 'ref', ref: 'units', required: true, listCol: true },
      { key: 'main_supplier_id', label: 'Осн. поставщик', type: 'ref', ref: 'counterparties', listCol: true },
      { key: 'min_stock', label: 'Мин. остаток', type: 'number' },
      { key: 'max_stock', label: 'Макс. остаток', type: 'number' },
      { key: 'storage_temp', label: 'Темп. хранения', type: 'text' },
      { key: 'shelf_life_days', label: 'Срок хранения, дн', type: 'number' },
      { key: 'requires_batch', label: 'Требует партии', type: 'bool' },
      { key: 'requires_expiry', label: 'Требует срока годности', type: 'bool' },
      { key: 'requires_incoming_control', label: 'Входной контроль', type: 'bool' },
      { key: 'waste_norm_pct', label: 'Норма отхода, %', type: 'number', listCol: true },
    ],
  },

  finished_goods: {
    table: 'ref_finished_goods',
    label: 'Готовая продукция',
    icon: '🥗',
    group: 'nomenclature',
    dedupe: ['name', 'code', 'barcode'],
    fields: [
      { key: 'category_id', label: 'Категория', type: 'ref', ref: 'categories', listCol: true },
      { key: 'unit_id', label: 'Ед. изм.', type: 'ref', ref: 'units', required: true },
      { key: 'net_weight', label: 'Вес нетто, г', type: 'number', listCol: true },
      { key: 'gross_weight', label: 'Вес брутто, г', type: 'number' },
      { key: 'barcode', label: 'Штрихкод', type: 'text', listCol: true, searchable: true },
      { key: 'qty_per_box', label: 'Кол-во в коробе', type: 'number' },
      { key: 'package_type', label: 'Тип упаковки', type: 'enum', options: ['пакет', 'лоток', 'дойпак', 'банка', 'короб'], listCol: true },
      { key: 'shelf_life_days', label: 'Срок годности, дн', type: 'number' },
      { key: 'storage_temp', label: 'Темп. хранения', type: 'text' },
      { key: 'trade_direction', label: 'Направление', type: 'enum', options: ['Retail', 'HoReCa', 'Оба'], listCol: true },
    ],
  },

  packaging: {
    table: 'ref_packaging',
    label: 'Упаковка',
    icon: '📦',
    group: 'nomenclature',
    dedupe: ['name', 'code'],
    fields: [
      { key: 'pack_category', label: 'Категория', type: 'enum', options: ['пакет', 'короб', 'этикетка', 'банка', 'плёнка', 'крышка', 'стикер', 'прочее'], listCol: true },
      { key: 'unit_id', label: 'Ед. изм.', type: 'ref', ref: 'units', required: true, listCol: true },
      { key: 'size', label: 'Размер', type: 'text' },
      { key: 'material', label: 'Материал', type: 'text', listCol: true },
      { key: 'thickness', label: 'Толщина', type: 'text' },
      { key: 'color', label: 'Цвет', type: 'text' },
      { key: 'supplier_id', label: 'Поставщик', type: 'ref', ref: 'counterparties' },
      { key: 'min_stock', label: 'Мин. остаток', type: 'number' },
    ],
  },

  counterparties: {
    table: 'ref_counterparties',
    label: 'Контрагенты',
    icon: '🤝',
    group: 'partners',
    dedupe: ['name', 'inn'],
    fields: [
      { key: 'legal_name', label: 'Юр. название', type: 'text', searchable: true },
      { key: 'role_client', label: 'Клиент', type: 'bool', listCol: true },
      { key: 'role_supplier', label: 'Поставщик', type: 'bool', listCol: true },
      { key: 'role_carrier', label: 'Перевозчик', type: 'bool' },
      { key: 'role_services', label: 'Услуги', type: 'bool' },
      { key: 'inn', label: 'ИНН', type: 'text', listCol: true, searchable: true },
      { key: 'pinfl', label: 'ПИНФЛ', type: 'text' },
      { key: 'phone', label: 'Телефон', type: 'text', listCol: true, searchable: true },
      { key: 'email', label: 'Email', type: 'text' },
      { key: 'contact_person', label: 'Контактное лицо', type: 'text' },
      { key: 'address', label: 'Адрес', type: 'text' },
      { key: 'territory', label: 'Территория', type: 'text' },
      { key: 'payment_terms', label: 'Оплата', type: 'enum', options: ['предоплата', 'отсрочка', 'по факту'] },
      { key: 'defer_days', label: 'Дней отсрочки', type: 'number' },
      { key: 'supplier_type', label: 'Тип поставщика', type: 'enum', options: ['сырьё', 'упаковка', 'услуги', '—'] },
      { key: 'quality_rating', label: 'Рейтинг', type: 'enum', options: ['A', 'B', 'C', '—'] },
      { key: 'bank_details', label: 'Банковские реквизиты', type: 'textarea' },
    ],
  },

  warehouses: {
    table: 'ref_warehouses',
    label: 'Склады',
    icon: '🏬',
    group: 'infrastructure',
    dedupe: ['name', 'code'],
    fields: [
      { key: 'wh_type', label: 'Тип склада', type: 'enum', options: ['сырьё', 'упаковка', 'готовая продукция', 'брак', 'карантин', 'возвраты'], required: true, listCol: true },
      { key: 'address', label: 'Адрес / зона', type: 'text' },
      { key: 'responsible', label: 'Ответственный', type: 'text', listCol: true },
      { key: 'temp_mode', label: 'Темп. режим', type: 'text', listCol: true },
    ],
  },

  production_areas: {
    table: 'ref_production_areas',
    label: 'Производственные зоны',
    icon: '🏭',
    group: 'infrastructure',
    dedupe: ['name', 'code'],
    fields: [
      { key: 'zone_type', label: 'Тип зоны', type: 'enum', options: ['производство', 'контроль', 'склад'], required: true, listCol: true },
      { key: 'responsible', label: 'Ответственный', type: 'text', listCol: true },
    ],
  },

  categories: {
    table: 'ref_categories',
    label: 'Категории и группы',
    icon: '🗂️',
    group: 'classifiers',
    dedupe: ['name'],
    fields: [
      { key: 'kind', label: 'Уровень', type: 'enum', options: ['категория', 'группа', 'подкатегория'], required: true, listCol: true },
      { key: 'parent_id', label: 'Родитель', type: 'ref', ref: 'categories', listCol: true },
    ],
  },
};

// Общие поля каждой записи (раздел 5 ТЗ)
const COMMON_FIELDS = [
  { key: 'code', label: 'Код / артикул', type: 'text', searchable: true, listCol: true },
  { key: 'code_1c', label: 'Код 1С', type: 'text', searchable: true },
  { key: 'sd_cs_id', label: 'SalesDoctor CS_id', type: 'text', system: true },
  { key: 'sd_sd_id', label: 'SalesDoctor SD_id', type: 'text', system: true },
  { key: 'name', label: 'Наименование', type: 'text', required: true, searchable: true, listCol: true },
  { key: 'comment', label: 'Комментарий', type: 'textarea' },
];

const sqlType = (f) =>
  f.type === 'number' ? 'NUMERIC' : f.type === 'bool' ? 'BOOLEAN DEFAULT FALSE' : f.type === 'ref' ? 'INTEGER' : 'TEXT DEFAULT \'\'';

function createTableSQL(typeKey) {
  const t = REF_TYPES[typeKey];
  const custom = t.fields.map((f) => `  ${f.key} ${sqlType(f)}`).join(',\n');
  return `
CREATE TABLE IF NOT EXISTS ${t.table} (
  id SERIAL PRIMARY KEY,
  code TEXT DEFAULT '',
  code_1c TEXT DEFAULT '',
  sd_cs_id TEXT DEFAULT '',
  sd_sd_id TEXT DEFAULT '',
  name TEXT NOT NULL,
  short_name TEXT DEFAULT '',
  status TEXT DEFAULT 'active',
  sort INTEGER DEFAULT 100,
  comment TEXT DEFAULT '',
  sync_status TEXT DEFAULT 'none',
  last_sync_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now(),
  created_by INTEGER,
  updated_at TIMESTAMPTZ DEFAULT now(),
  updated_by INTEGER,
  archived_at TIMESTAMPTZ,
  archived_by INTEGER${custom ? ',\n' + custom : ''}
);`;
}

function allCreateSQL() {
  return Object.keys(REF_TYPES).map(createTableSQL).join('\n');
}

// Метаданные для клиента (без системной информации о таблицах)
function clientMeta() {
  const types = {};
  for (const [key, t] of Object.entries(REF_TYPES)) {
    types[key] = {
      label: t.label,
      icon: t.icon,
      group: t.group,
      fields: [
        ...COMMON_FIELDS.filter((f) => !f.system || true).map((f) => ({ ...f })),
        ...t.fields.map((f) => ({ ...f })),
      ],
    };
  }
  return { groups: REF_GROUPS, types };
}

module.exports = { REF_TYPES, REF_GROUPS, COMMON_FIELDS, allCreateSQL, clientMeta };
