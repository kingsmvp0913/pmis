// vendors.js — 廠商 view:list + 搜尋 + 編輯(多聯絡人)+ 批次匯入
(function () {
  const el = PmisApp.el;

  // 建立一列聯絡人輸入(name/phone/email/line_id + 主要 radio + 移除)
  function contactRow(container, data, radioName) {
    const c = data || {};
    const nameI = el('input', { class: 'form-control', type: 'text', placeholder: '姓名', value: c.name || '' });
    const phoneI = el('input', { class: 'form-control', type: 'text', placeholder: '電話', value: c.phone || '' });
    const emailI = el('input', { class: 'form-control', type: 'text', placeholder: 'Email', value: c.email || '' });
    const lineI = el('input', { class: 'form-control', type: 'text', placeholder: 'LINE ID', value: c.line_id || '' });
    const primaryI = el('input', { type: 'radio', name: radioName });
    if (c.is_primary) primaryI.checked = true;
    const row = el('div', { class: 'subrow' }, [
      nameI, phoneI, emailI, lineI,
      el('label', { class: 'primary-check' }, [primaryI, '主要']),
      el('button', { class: 'btn btn-remove', type: 'button', onClick: () => row.remove() }, '移除')
    ]);
    row._read = () => ({
      name: nameI.value.trim(), phone: phoneI.value.trim(),
      email: emailI.value.trim(), line_id: lineI.value.trim(),
      is_primary: primaryI.checked
    });
    container.appendChild(row);
    return row;
  }

  function contactsEditor(existing) {
    const radioName = 'primary_' + Math.random().toString(36).slice(2);
    const list = el('div', {});
    (existing || []).forEach(c => contactRow(list, c, radioName));
    const addBtn = el('button', { class: 'btn btn-outline', type: 'button', onClick: () => contactRow(list, {}, radioName) }, '＋ 新增聯絡人');
    const wrap = el('div', {}, [list, addBtn]);
    wrap._read = () => Array.from(list.children).map(r => r._read()).filter(c => c.name);
    return wrap;
  }

  // ── 批次匯入畫面 ──
  async function renderImport(content) {
    content.appendChild(el('div', { class: 'page-title' }, '廠商批次匯入'));
    const ta = el('textarea', { class: 'form-control', placeholder: '一行一家廠商名稱;空行與重複會自動忽略' });
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '貼上名單(一行一家)'),
      el('div', { class: 'form-group' }, [ta]),
      el('div', { class: 'hint' }, '系統會去除空行、去除重複、並跳過已存在的名稱。'),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: doImport }, '匯入'),
        el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/vendors'; } }, '返回列表')
      ])
    ]);
    content.appendChild(card);

    async function doImport() {
      try {
        const res = await Api.post('vendors/import', { text: ta.value });
        showToast(`匯入完成:新增 ${res.created} 家、略過 ${res.skipped} 家`, 'success');
        window.location.hash = '/vendors';
      } catch (e) { showToast(e.message, 'error'); }
    }
  }

  // ── 編輯 / 新增 ──
  async function renderEdit(content, id) {
    const isNew = id === 'new';
    let vendor = { name: '', contacts: [] };
    if (!isNew) {
      try { vendor = await Api.get('vendors/' + id); }
      catch (e) { showToast(e.message, 'error'); window.location.hash = '/vendors'; return; }
    }
    content.appendChild(el('div', { class: 'page-title' }, isNew ? '新增廠商' : '編輯廠商'));
    const nameI = el('input', { class: 'form-control', type: 'text', value: vendor.name || '' });
    const contacts = contactsEditor(vendor.contacts);
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'form-group' }, [el('label', {}, '廠商名稱'), nameI]),
      el('div', { class: 'card-title', style: 'margin-top:8px' }, '聯絡人'),
      contacts,
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: save }, '儲存'),
        el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/vendors'; } }, '取消')
      ])
    ]);
    content.appendChild(card);

    async function save() {
      const name = nameI.value.trim();
      if (!name) { showToast('請輸入廠商名稱', 'warn'); return; }
      const body = { name, contacts: contacts._read() };
      try {
        if (isNew) await Api.post('vendors', body);
        else await Api.put('vendors/' + id, body);
        showToast('已儲存', 'success');
        window.location.hash = '/vendors';
      } catch (e) { showToast(e.message, 'error'); }
    }
  }

  // ── list ──
  async function renderList(content) {
    content.appendChild(el('div', { class: 'page-title' }, '廠商'));
    const search = el('input', { class: 'form-control search', type: 'text', placeholder: '搜尋廠商名稱…' });
    content.appendChild(el('div', { class: 'toolbar' }, [
      search,
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/vendors/import'; } }, '批次匯入'),
      el('button', { class: 'btn btn-primary', onClick: () => { window.location.hash = '/vendors/new'; } }, '＋ 新增廠商')
    ]));
    const tbody = el('tbody', {});
    content.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, '名稱'), el('th', { style: 'width:120px' }, '')])]),
        tbody
      ])
    ]));

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

    async function load() {
      const q = search.value.trim();
      let rows;
      try { rows = await Api.get('vendors' + (q ? '?q=' + encodeURIComponent(q) : '')); }
      catch (e) { showToast(e.message, 'error'); return; }
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, [el('td', { class: 'empty-row', colspan: '2' }, '沒有資料')]));
        return;
      }
      for (const v of rows) {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, v.name),
          el('td', { class: 'actions' }, [
            el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/vendors/' + v.id; } }, '編輯'),
            el('button', { class: 'btn btn-danger', style: 'margin-left:6px', onClick: () => remove(v) }, '刪除')
          ])
        ]));
      }
    }

    async function remove(v) {
      const ok = await confirmDialog({ title: '刪除廠商', message: `確定刪除「${v.name}」?`, danger: true });
      if (!ok) return;
      try { await Api.delete('vendors/' + v.id); showToast('已刪除', 'success'); load(); }
      catch (e) { showToast(e.message, 'error'); }
    }

    load();
  }

  // dispatch:#/vendors = list、#/vendors/import、#/vendors/new、#/vendors/:id
  PmisApp.registerRoute('#/vendors', (content, hash) => {
    const parts = hash.replace(/^\//, '').split('/'); // ['vendors', ...]
    const sub = parts[1];
    if (sub === 'import') return renderImport(content);
    if (sub) return renderEdit(content, sub);
    return renderList(content);
  });
})();
