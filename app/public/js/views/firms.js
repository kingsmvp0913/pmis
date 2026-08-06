// firms.js — 事務所 view:list + 新增/編輯/刪除(只有名稱一個欄位)
// 監造/設計單位共用同一份清單,故只有一頁,沒有分類。
(function () {
  const el = PmisApp.el;

  async function renderEdit(content, id) {
    const isNew = id === 'new';
    let firm = { name: '', address: '', phone: '', fax: '', contact: '', email: '' };
    if (!isNew) {
      try { firm = await Api.get('firms/' + id); }
      catch (e) { showToast(e.message, 'error'); window.location.hash = '/firms'; return; }
    }
    content.appendChild(el('div', { class: 'page-title' }, isNew ? '新增事務所' : '編輯事務所'));
    const nameI = el('input', { class: 'form-control', type: 'text', value: firm.name || '' });
    const addressI = el('input', { class: 'form-control', type: 'text', value: firm.address || '' });
    const phoneI = el('input', { class: 'form-control', type: 'text', value: firm.phone || '' });
    const faxI = el('input', { class: 'form-control', type: 'text', value: firm.fax || '' });
    const contactI = el('input', { class: 'form-control', type: 'text', value: firm.contact || '' });
    const emailI = el('input', { class: 'form-control', type: 'text', value: firm.email || '' });
    content.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'form-group' }, [el('label', {}, '事務所名稱'), nameI]),
      // 以下五欄會直接印在公文上(地址/電話/傳真/聯絡人/信箱),留空則公文該處為空白
      el('div', { class: 'form-group' }, [el('label', {}, '地址(公文用)'), addressI]),
      el('div', { class: 'form-group' }, [el('label', {}, '電話(公文用)'), phoneI]),
      el('div', { class: 'form-group' }, [el('label', {}, '傳真(公文用)'), faxI]),
      el('div', { class: 'form-group' }, [el('label', {}, '聯絡人(公文用)'), contactI]),
      el('div', { class: 'form-group' }, [el('label', {}, '電子信箱(公文用)'), emailI]),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: save }, '儲存'),
        el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/firms'; } }, '取消')
      ])
    ]));

    async function save() {
      const name = nameI.value.trim();
      if (!name) { showToast('請輸入事務所名稱', 'warn'); return; }
      const payload = {
        name,
        address: addressI.value.trim(),
        phone: phoneI.value.trim(),
        fax: faxI.value.trim(),
        contact: contactI.value.trim(),
        email: emailI.value.trim(),
      };
      try {
        if (isNew) await Api.post('firms', payload);
        else await Api.put('firms/' + id, payload);
        showToast('已儲存', 'success');
        window.location.hash = '/firms';
      } catch (e) { showToast(e.message, 'error'); }
    }
  }

  async function renderList(content) {
    content.appendChild(el('div', { class: 'page-title' }, '事務所'));
    const search = el('input', { class: 'form-control search', type: 'text', placeholder: '搜尋事務所…' });
    content.appendChild(el('div', { class: 'toolbar' }, [
      search,
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-primary', onClick: () => { window.location.hash = '/firms/new'; } }, '＋ 新增事務所')
    ]));
    const tbody = el('tbody', {});
    content.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [el('tr', {}, [el('th', {}, '名稱'), el('th', { style: 'width:120px' }, '')])]),
        tbody
      ])
    ]));

    let all = [];

    async function load() {
      try { all = await Api.get('firms'); }
      catch (e) { showToast(e.message, 'error'); return; }
      draw();
    }

    function draw() {
      const q = search.value.trim();
      const rows = q ? all.filter((f) => f.name.includes(q)) : all;
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, [el('td', { class: 'empty-row', colspan: '2' }, '沒有資料')]));
        return;
      }
      for (const f of rows) {
        tbody.appendChild(el('tr', {}, [
          el('td', {}, f.name),
          el('td', { class: 'actions' }, [
            el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/firms/' + f.id; } }, '編輯'),
            el('button', { class: 'btn btn-danger', style: 'margin-left:6px', onClick: () => remove(f) }, '刪除')
          ])
        ]));
      }
    }

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(draw, 250); });

    async function remove(f) {
      const ok = await confirmDialog({ title: '刪除事務所', message: `確定刪除「${f.name}」?`, danger: true });
      if (!ok) return;
      try {
        await Api.delete('firms/' + f.id);
      } catch (e) {
        // 有工程正在使用時後端回 409 附使用中筆數;不靜默失敗,問清楚再決定要不要強制刪除。
        if (e.fields === undefined && typeof e.message === 'string' && e.message.includes('確定仍要刪除')) {
          const force = await confirmDialog({ title: '刪除事務所', message: e.message, danger: true });
          if (!force) return;
          try { await Api.delete('firms/' + f.id + '?force=1'); }
          catch (e2) { showToast(e2.message, 'error'); return; }
        } else {
          showToast(e.message, 'error');
          return;
        }
      }
      showToast('已刪除', 'success');
      load();
    }

    load();
  }

  PmisApp.registerRoute('#/firms', (content, hash) => {
    const sub = hash.replace(/^\//, '').split('/')[1];
    if (sub) return renderEdit(content, sub);
    return renderList(content);
  });
})();
