// dicts.js — одностраничный интерфейс модуля «Справочники»
// Левая панель справочников → живая таблица → боковая карточка записи.

(function () {
  const state = {
    meta: null,
    type: null,
    items: [],
    total: 0,
    page: 1,
    q: '',
    status: 'active',
    sort: 'name',
    order: 'asc',
    refOptions: {}, // кэш вариантов для ref-полей
    editing: null, // запись в карточке (null = закрыто, {} = новая)
  };

  const $ = (sel) => document.querySelector(sel);
  const el = (tag, attrs = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
      if (k === 'class') node.className = v;
      else if (k.startsWith('on')) node.addEventListener(k.slice(2), v);
      else if (k === 'html') node.innerHTML = v;
      else node.setAttribute(k, v);
    }
    for (const c of [].concat(children)) {
      if (c === null || c === undefined) continue;
      node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return node;
  };

  async function api(path, opts = {}) {
    const res = await fetch('/api/refs' + path, opts);
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(data.error || 'Ошибка запроса');
    return data;
  }

  function toast(msg, isError) {
    const t = el('div', { class: 'toast' + (isError ? ' toast-err' : '') }, msg);
    document.body.appendChild(t);
    setTimeout(() => t.classList.add('show'), 10);
    setTimeout(() => {
      t.classList.remove('show');
      setTimeout(() => t.remove(), 300);
    }, 3500);
  }

  function fieldsOf(typeKey) {
    return state.meta.types[typeKey].fields;
  }

  function listCols(typeKey) {
    return fieldsOf(typeKey).filter((f) => f.listCol);
  }

  async function refOpts(refType) {
    if (state.refOptions[refType]) return state.refOptions[refType];
    const data = await api(`/${refType}?limit=1000&status=active&sort=name`);
    state.refOptions[refType] = data.items.map((i) => ({ id: i.id, name: i.name }));
    return state.refOptions[refType];
  }

  function refName(refType, id) {
    const opts = state.refOptions[refType] || [];
    const f = opts.find((o) => o.id === id);
    return f ? f.name : id ? '#' + id : '';
  }

  // ---------- Левая панель ----------
  function renderNav() {
    const nav = $('#dict-nav');
    nav.innerHTML = '';
    const search = el('input', {
      class: 'nav-search',
      placeholder: 'Поиск справочника...',
      oninput: (e) => {
        const q = e.target.value.toLowerCase();
        nav.querySelectorAll('.nav-item').forEach((item) => {
          item.style.display = item.textContent.toLowerCase().includes(q) ? '' : 'none';
        });
      },
    });
    nav.appendChild(search);
    for (const g of state.meta.groups) {
      const items = Object.entries(state.meta.types).filter(([, t]) => t.group === g.key);
      if (!items.length) continue;
      nav.appendChild(el('div', { class: 'nav-group' }, g.label));
      for (const [key, t] of items) {
        nav.appendChild(
          el(
            'a',
            {
              class: 'nav-item' + (key === state.type ? ' active' : ''),
              href: '#' + key,
            },
            [el('span', { class: 'nav-icon' }, t.icon + ' '), t.label]
          )
        );
      }
    }
  }

  // ---------- Таблица ----------
  async function loadList() {
    const params = new URLSearchParams({
      page: state.page,
      status: state.status,
      sort: state.sort,
      order: state.order,
    });
    if (state.q) params.set('q', state.q);
    const data = await api(`/${state.type}?` + params.toString());
    state.items = data.items;
    state.total = data.total;
    // подгружаем имена для ref-колонок
    for (const f of fieldsOf(state.type)) {
      if (f.type === 'ref') await refOpts(f.ref);
    }
    renderTable();
  }

  function cellValue(f, row) {
    const v = row[f.key];
    if (f.type === 'bool') return v ? '✓' : '';
    if (f.type === 'ref') return refName(f.ref, v);
    if (v === null || v === undefined) return '';
    return String(v);
  }

  function renderTable() {
    const t = state.meta.types[state.type];
    $('#dict-title').textContent = t.icon + ' ' + t.label;
    $('#dict-count').textContent = state.total + ' зап.';

    const cols = listCols(state.type);
    const thead = el('tr', {}, [
      ...cols.map((f) =>
        el(
          'th',
          {
            class: 'sortable' + (state.sort === f.key ? ' sorted' : ''),
            onclick: () => {
              if (state.sort === f.key) state.order = state.order === 'asc' ? 'desc' : 'asc';
              else {
                state.sort = f.key;
                state.order = 'asc';
              }
              loadList();
            },
          },
          f.label + (state.sort === f.key ? (state.order === 'asc' ? ' ↑' : ' ↓') : '')
        )
      ),
      el('th', {}, 'Статус'),
    ]);

    const rows = state.items.map((row) =>
      el(
        'tr',
        {
          class: row.status === 'archived' ? 'row-archived' : '',
          ondblclick: () => openCard(row),
          onclick: () => openCard(row),
        },
        [
          ...cols.map((f) => el('td', {}, cellValue(f, row))),
          el('td', {}, el('span', { class: 'status-pill status-' + row.status }, row.status === 'active' ? 'Активный' : 'Архив')),
        ]
      )
    );

    const table = el('table', { class: 'dict-table' }, [el('thead', {}, thead), el('tbody', {}, rows)]);
    const wrap = $('#dict-table-wrap');
    wrap.innerHTML = '';
    if (!state.items.length) {
      wrap.appendChild(el('p', { class: 'dict-empty' }, 'Записей нет. Нажмите «Создать», чтобы добавить первую.'));
    } else {
      wrap.appendChild(table);
    }

    // пагинация
    const pages = Math.max(1, Math.ceil(state.total / 100));
    const pag = $('#dict-pagination');
    pag.innerHTML = '';
    if (pages > 1) {
      pag.appendChild(
        el('button', { onclick: () => { if (state.page > 1) { state.page--; loadList(); } } }, '←')
      );
      pag.appendChild(el('span', {}, ` стр. ${state.page} из ${pages} `));
      pag.appendChild(
        el('button', { onclick: () => { if (state.page < pages) { state.page++; loadList(); } } }, '→')
      );
    }
  }

  // ---------- Карточка ----------
  async function openCard(row) {
    state.editing = row || {};
    const t = state.meta.types[state.type];
    const isNew = !row || !row.id;
    const panel = $('#dict-card');
    panel.classList.add('open');
    const body = $('#dict-card-body');
    $('#dict-card-title').textContent = isNew ? 'Новая запись — ' + t.label : row.name;
    body.innerHTML = '';

    const form = el('form', {
      id: 'card-form',
      onsubmit: async (e) => {
        e.preventDefault();
        await saveCard();
      },
    });

    for (const f of fieldsOf(state.type)) {
      if (f.system) continue;
      const val = state.editing[f.key];
      let input;
      if (f.type === 'textarea') {
        input = el('textarea', { name: f.key, rows: 3 });
        input.value = val || '';
      } else if (f.type === 'bool') {
        input = el('input', { type: 'checkbox', name: f.key });
        input.checked = !!val;
      } else if (f.type === 'enum') {
        input = el('select', { name: f.key }, [
          el('option', { value: '' }, '—'),
          ...f.options.map((o) => el('option', { value: o }, o)),
        ]);
        input.value = val || '';
      } else if (f.type === 'ref') {
        const opts = await refOpts(f.ref);
        input = el('select', { name: f.key }, [
          el('option', { value: '' }, '—'),
          ...opts.map((o) => el('option', { value: o.id }, o.name)),
        ]);
        input.value = val || '';
      } else {
        input = el('input', { name: f.key, type: f.type === 'number' ? 'number' : 'text', step: 'any' });
        input.value = val === null || val === undefined ? '' : val;
      }
      const label = el('label', { class: 'card-field' + (f.type === 'bool' ? ' card-field-bool' : '') }, [
        el('span', {}, f.label + (f.required ? ' *' : '')),
        input,
      ]);
      form.appendChild(label);
    }

    form.appendChild(el('button', { type: 'submit', class: 'btn-primary' }, isNew ? 'Создать' : 'Сохранить'));
    body.appendChild(form);

    const actions = el('div', { class: 'card-actions' });
    if (!isNew) {
      if (row.status === 'active') {
        actions.appendChild(
          el(
            'button',
            {
              class: 'btn-danger-link',
              onclick: async () => {
                if (!confirm('Архивировать запись «' + row.name + '»?')) return;
                await api(`/${state.type}/${row.id}/archive`, { method: 'POST' });
                toast('Запись отправлена в архив');
                closeCard();
                loadList();
              },
            },
            'Архивировать'
          )
        );
      } else {
        actions.appendChild(
          el(
            'button',
            {
              onclick: async () => {
                await api(`/${state.type}/${row.id}/restore`, { method: 'POST' });
                toast('Запись восстановлена');
                closeCard();
                loadList();
              },
            },
            'Восстановить из архива'
          )
        );
      }
      const meta = el('p', { class: 'card-meta' },
        `id ${row.id}` + (row.code_1c ? ` · 1С: ${row.code_1c}` : '') + (row.sd_sd_id ? ` · SD: ${row.sd_sd_id}` : '')
      );
      actions.appendChild(meta);
    }
    body.appendChild(actions);
  }

  async function saveCard() {
    const t = state.meta.types[state.type];
    const form = $('#card-form');
    const payload = {};
    for (const f of fieldsOf(state.type)) {
      if (f.system) continue;
      const input = form.elements[f.key];
      if (!input) continue;
      payload[f.key] = f.type === 'bool' ? input.checked : input.value;
    }
    try {
      const isNew = !state.editing.id;
      if (isNew) {
        await api(`/${state.type}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Запись создана');
      } else {
        await api(`/${state.type}/${state.editing.id}`, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload),
        });
        toast('Сохранено');
      }
      delete state.refOptions[state.type]; // обновить кэш ссылок
      closeCard();
      loadList();
    } catch (e) {
      toast(e.message, true);
    }
  }

  function closeCard() {
    state.editing = null;
    $('#dict-card').classList.remove('open');
  }

  // ---------- Импорт ----------
  async function importFile(file) {
    const fd = new FormData();
    fd.append('file', file);
    try {
      const r = await api(`/${state.type}/import-simple`, { method: 'POST', body: fd });
      toast(`Импорт: добавлено ${r.added}, пропущено ${r.skipped}`);
      loadList();
    } catch (e) {
      toast(e.message, true);
    }
  }

  // ---------- Переключение справочника ----------
  function switchType(typeKey) {
    if (!state.meta.types[typeKey]) typeKey = Object.keys(state.meta.types)[0];
    state.type = typeKey;
    state.page = 1;
    state.q = '';
    state.sort = 'name';
    state.order = 'asc';
    $('#dict-search').value = '';
    renderNav();
    closeCard();
    loadList();
  }

  // ---------- Инициализация ----------
  async function init() {
    state.meta = await api('/_meta');
    window.addEventListener('hashchange', () => switchType(location.hash.slice(1)));

    let searchTimer;
    $('#dict-search').addEventListener('input', (e) => {
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        state.q = e.target.value.trim();
        state.page = 1;
        loadList();
      }, 300);
    });
    $('#dict-status').addEventListener('change', (e) => {
      state.status = e.target.value;
      state.page = 1;
      loadList();
    });
    $('#dict-create').addEventListener('click', () => openCard(null));
    $('#dict-card-close').addEventListener('click', closeCard);
    $('#dict-import-input').addEventListener('change', (e) => {
      if (e.target.files[0]) importFile(e.target.files[0]);
      e.target.value = '';
    });
    $('#dict-import').addEventListener('click', () => $('#dict-import-input').click());

    switchType(location.hash.slice(1) || 'raw_materials');
  }

  init().catch((e) => {
    document.body.innerHTML = '<p style="padding:40px">Ошибка загрузки модуля: ' + e.message + '</p>';
  });
})();
