// settings.js — 系統設定 view:結算日(1–28)
(function () {
  const el = PmisApp.el;

  async function render(content) {
    content.appendChild(el('div', { class: 'page-title' }, '系統設定'));

    let current = 5;
    try { const s = await Api.get('settings/settlement-day'); current = s.settlement_day; }
    catch (e) { showToast(e.message, 'error'); }

    const dayI = el('input', { class: 'form-control', type: 'number', min: '1', max: '28', step: '1', value: String(current) });

    async function save() {
      const n = parseInt(dayI.value, 10);
      if (!Number.isInteger(n) || n < 1 || n > 28) { showToast('結算日須為 1 到 28', 'warn'); return; }
      try { await Api.put('settings/settlement-day', { settlement_day: n }); showToast('已儲存', 'success'); }
      catch (e) { showToast(e.message, 'error'); }
    }

    content.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '結算日'),
      el('div', { class: 'form-group' }, [
        el('label', {}, '每月繳交截止日(1–28)'),
        dayI,
        el('div', { class: 'hint' }, '各工程每月應繳週期以「該月此日」為截止;逾期未繳顯示紅色。')
      ]),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: save }, '儲存')
      ])
    ]));
  }

  PmisApp.registerRoute('#/settings', (content) => render(content));
})();
