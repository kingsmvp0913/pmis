// insurers.js — 保險公司 view:list + 編輯(名稱 + 多險種)
(function () {
  const el = PmisApp.el;

  function typeRow(container, data) {
    const nameI = el('input', { class: 'form-control', type: 'text', placeholder: '險種名稱', value: (data && data.name) || '' });
    const row = el('div', { class: 'subrow' }, [
      nameI,
      el('button', { class: 'btn btn-remove', type: 'button', onClick: () => row.remove() }, '移除')
    ]);
    row._read = () => ({ name: nameI.value.trim() });
    container.appendChild(row);
    return row;
  }

  function typesEditor(existing) {
    const list = el('div', {});
    (existing || []).forEach(t => typeRow(list, t));
    const addBtn = el('button', { class: 'btn btn-outline', type: 'button', onClick: () => typeRow(list, {}) }, '＋ 新增險種');
    const wrap = el('div', {}, [list, addBtn]);
    wrap._read = () => Array.from(list.children).map(r => r._read()).filter(t => t.name);
    return wrap;
  }

  async function renderEdit(content, id) {
    const isNew = id === 'new';
    let insurer = { name: '', types: [] };
    if (!isNew) {
      try { insurer = await Api.get('insurers/' + id); }
      catch (e) { showToast(e.message, 'error'); window.location.hash = '/insurers'; return; }
    }
    content.appendChild(el('div', { class: 'page-title' }, isNew ? '新增保險公司' : '編輯保險公司'));
    const nameI = el('input', { class: 'form-control', type: 'text', value: insurer.name || '' });
    const types = typesEditor(insurer.types);
    const card = el('div', { class: 'card' }, [
      el('div', { class: 'form-group' }, [el('label', {}, '保險公司名稱'), nameI]),
      el('div', { class: 'card-title', style: 'margin-top:8px' }, '險種'),
      types,
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: save }, '儲存'),
        el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/insurers'; } }, '取消')
      ])
    ]);
    content.appendChild(card);

    async function save() {
      const name = nameI.value.trim();
      if (!name) { showToast('請輸入保險公司名稱', 'warn'); return; }
      const body = { name, types: types._read() };
      try {
        if (isNew) await Api.post('insurers', body);
        else await Api.put('insurers/' + id, body);
        showToast('已儲存', 'success');
        window.location.hash = '/insurers';
      } catch (e) { showToast(e.message, 'error'); }
    }
  }

  async function renderList(content) {
    content.appendChild(el('div', { class: 'page-title' }, '保險公司'));
    const search = el('input', { class: 'form-control search', type: 'text', placeholder: '搜尋保險公司…' });
    content.appendChild(el('div', { class: 'toolbar' }, [
      search,
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-primary', onClick: () => { window.location.hash = '/insurers/new'; } }, '＋ 新增保險公司')
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
      try { rows = await Api.get('insurers' + (q ? '?q=' + encodeURIComponent(q) : '')); }
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
            el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/insurers/' + v.id; } }, '編輯'),
            el('button', { class: 'btn btn-danger', style: 'margin-left:6px', onClick: () => remove(v) }, '刪除')
          ])
        ]));
      }
    }

    async function remove(v) {
      const ok = await confirmDialog({ title: '刪除保險公司', message: `確定刪除「${v.name}」?`, danger: true });
      if (!ok) return;
      try { await Api.delete('insurers/' + v.id); showToast('已刪除', 'success'); load(); }
      catch (e) { showToast(e.message, 'error'); }
    }

    load();
  }

  PmisApp.registerRoute('#/insurers', (content, hash) => {
    const sub = hash.replace(/^\//, '').split('/')[1];
    if (sub) return renderEdit(content, sub);
    return renderList(content);
  });
})();
