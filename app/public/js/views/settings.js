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

    let firms = { supervisor_firm: '', designer_firm: '' };
    let firmList = [];
    try {
      [firms, firmList] = await Promise.all([
        Api.get('settings/firms'),
        Api.get('firms'), // 事務所主檔清單,供下拉選項用
      ]);
    } catch (e) { showToast(e.message, 'error'); }

    // 監造/設計單位只能下拉選,不能手打(避免同一家事務所出現兩種寫法)。
    // 目前值不在清單裡(例如那家事務所被刪了)不可靜默清空——否則按「儲存」
    // 會把承辦人原本設定的系統預設值洗成空字串,故保留成臨時選項並選起來。
    function firmSelect(current) {
      const sel = el('select', { class: 'form-control' }, [el('option', { value: '' }, '(未設定)')]);
      firmList.forEach((f) => {
        const opt = el('option', { value: f.name }, f.name);
        if (f.name === current) opt.selected = true;
        sel.appendChild(opt);
      });
      if (current && !firmList.some((f) => f.name === current)) {
        const opt = el('option', { value: current }, current + '(不在清單中)');
        opt.selected = true;
        sel.appendChild(opt);
      }
      return sel;
    }

    const supI = firmSelect(firms.supervisor_firm || '');
    const desI = firmSelect(firms.designer_firm || '');

    async function saveFirms() {
      try {
        await Api.put('settings/firms', {
          supervisor_firm: supI.value.trim(),
          designer_firm: desI.value.trim(),
        });
        showToast('已儲存', 'success');
      } catch (e) { showToast(e.message, 'error'); }
    }

    content.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '監造 / 設計單位預設'),
      el('div', { class: 'form-group' }, [el('label', {}, '監造單位'), supI]),
      el('div', { class: 'form-group' }, [
        el('label', {}, '設計單位'), desI,
        el('div', { class: 'hint' }, '填工程基本資料時的預設值;個別工程若不同家,可在該工程頁覆寫。')
      ]),
      firmList.length ? null : el('div', { class: 'hint' }, [
        '尚未建立任何事務所,請先',
        el('a', { href: '#/firms/new' }, '前往新增')
      ]),
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: saveFirms }, '儲存')
      ])
    ]));
  }

  PmisApp.registerRoute('#/settings', (content) => render(content));
})();
