// schools.js — 學校 view:list + 搜尋 + 編輯(縣市下拉 + 多聯絡人)
(function () {
  const el = PmisApp.el;

  const COUNTIES = [
    '台北市', '新北市', '桃園市', '台中市', '台南市', '高雄市',
    '基隆市', '新竹市', '新竹縣', '苗栗縣', '彰化縣', '南投縣',
    '雲林縣', '嘉義市', '嘉義縣', '屏東縣', '宜蘭縣', '花蓮縣',
    '台東縣', '澎湖縣', '金門縣', '連江縣'
  ];

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

  function countySelect(selected) {
    const sel = el('select', { class: 'form-control' }, [el('option', { value: '' }, '(未指定)')]);
    COUNTIES.forEach(county => {
      const opt = el('option', { value: county }, county);
      if (county === selected) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  async function renderEdit(content, id) {
    const isNew = id === 'new';
    let school = { name: '', county: '', contacts: [] };
    if (!isNew) {
      try { school = await Api.get('schools/' + id); }
      catch (e) { showToast(e.message, 'error'); window.location.hash = '/schools'; return; }
    }
    content.appendChild(el('div', { class: 'page-title' }, isNew ? '新增學校' : '編輯學校'));
    const nameI = el('input', { class: 'form-control', type: 'text', value: school.name || '' });
    const countyI = countySelect(school.county || '');
    const contacts = contactsEditor(school.contacts);
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [el('label', {}, '學校名稱'), nameI]),
        el('div', { class: 'form-group' }, [el('label', {}, '學區(縣市)'), countyI])
      ]),
      el('div', { class: 'card-title', style: 'margin-top:8px' }, '聯絡人'),
      contacts,
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: save }, '儲存'),
        el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/schools'; } }, '取消')
      ])
    ]);
    content.appendChild(card);

    async function save() {
      const name = nameI.value.trim();
      if (!name) { showToast('請輸入學校名稱', 'warn'); return; }
      const body = { name, county: countyI.value, contacts: contacts._read() };
      try {
        if (isNew) await Api.post('schools', body);
        else await Api.put('schools/' + id, body);
        showToast('已儲存', 'success');
        window.location.hash = '/schools';
      } catch (e) { showToast(e.message, 'error'); }
    }
  }

  async function renderList(content) {
    content.appendChild(el('div', { class: 'page-title' }, '學校'));
    const search = el('input', { class: 'form-control search', type: 'text', placeholder: '搜尋學校名稱…' });
    content.appendChild(el('div', { class: 'toolbar' }, [
      search,
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-primary', onClick: () => { window.location.hash = '/schools/new'; } }, '＋ 新增學校')
    ]));
    const tbody = el('tbody', {});
    content.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', {}, '名稱'), el('th', { style: 'width:120px' }, '學區'), el('th', { style: 'width:120px' }, '')
        ])]),
        tbody
      ])
    ]));

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

    async function load() {
      const q = search.value.trim();
      let rows;
      try { rows = await Api.get('schools' + (q ? '?q=' + encodeURIComponent(q) : '')); }
      catch (e) { showToast(e.message, 'error'); return; }
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, [el('td', { class: 'empty-row', colspan: '3' }, '沒有資料')]));
        return;
      }
      for (const s of rows) {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, s.name),
          el('td', {}, s.county || '—'),
          el('td', { class: 'actions' }, [
            el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/schools/' + s.id; } }, '編輯'),
            el('button', { class: 'btn btn-danger', style: 'margin-left:6px', onClick: () => remove(s) }, '刪除')
          ])
        ]));
      }
    }

    async function remove(s) {
      const ok = await confirmDialog({ title: '刪除學校', message: `確定刪除「${s.name}」?`, danger: true });
      if (!ok) return;
      try { await Api.delete('schools/' + s.id); showToast('已刪除', 'success'); load(); }
      catch (e) { showToast(e.message, 'error'); }
    }

    load();
  }

  PmisApp.registerRoute('#/schools', (content, hash) => {
    const sub = hash.replace(/^\//, '').split('/')[1];
    if (sub) return renderEdit(content, sub);
    return renderList(content);
  });
})();
