// projects.js — 工程 view:list + 搜尋 + 編輯(全欄位;險種連動、設計費切換與即時計算)
(function () {
  const el = PmisApp.el;

  // 前端即時預覽用 half-up(與後端 project-routes.roundHalfUp 一致);實際存檔仍以後端計算為準
  function roundHalfUp(v) {
    if (v == null || isNaN(Number(v))) return null;
    const n = Number(v), neg = n < 0, abs = Math.abs(n);
    const r = Math.floor(abs + 0.5 + Number.EPSILON);
    return neg ? -r : r;
  }

  function selectFrom(items, selectedId, placeholder) {
    const sel = el('select', { class: 'form-control' }, [el('option', { value: '' }, placeholder || '(未選)')]);
    items.forEach(it => {
      const opt = el('option', { value: String(it.id) }, it.name);
      if (String(it.id) === String(selectedId)) opt.selected = true;
      sel.appendChild(opt);
    });
    return sel;
  }

  async function renderEdit(content, id) {
    const isNew = id === 'new';
    let p = { design_fee_type: 'lump_sum' };
    let vendors = [], schools = [], insurers = [];
    try {
      [vendors, schools, insurers] = await Promise.all([
        Api.get('vendors'), Api.get('schools'), Api.get('insurers')
      ]);
      if (!isNew) p = await Api.get('projects/' + id);
    } catch (e) { showToast(e.message, 'error'); window.location.hash = '/projects'; return; }

    content.appendChild(el('div', { class: 'page-title' }, isNew ? '新增工程' : '編輯工程'));

    const noI = el('input', { class: 'form-control', type: 'text', value: p.project_no || '' });
    const nameI = el('input', { class: 'form-control', type: 'text', value: p.name || '' });
    const vendorI = selectFrom(vendors, p.vendor_id, '(未選廠商)');
    const schoolI = selectFrom(schools, p.school_id, '(未選學校)');
    const startI = el('input', { class: 'form-control', type: 'date', value: p.start_date ? String(p.start_date).slice(0, 10) : '' });
    const contractI = el('input', { class: 'form-control', type: 'date', value: p.contract_completion_date ? String(p.contract_completion_date).slice(0, 10) : '' });
    const actualI = el('input', { class: 'form-control', type: 'date', value: p.actual_completion_date ? String(p.actual_completion_date).slice(0, 10) : '' });
    const awardI = el('input', { class: 'form-control', type: 'number', step: '1', value: p.award_amount != null ? p.award_amount : '' });

    // 保險公司 → 險種連動
    const insurerI = selectFrom(insurers, p.insurer_id, '(未選保險公司)');
    const typeI = el('select', { class: 'form-control' }, [el('option', { value: '' }, '(未選險種)')]);
    async function loadTypes(insurerId, selectedTypeId) {
      typeI.innerHTML = '';
      typeI.appendChild(el('option', { value: '' }, '(未選險種)'));
      if (!insurerId) return;
      try {
        const types = await Api.get('insurers/' + insurerId + '/types');
        types.forEach(t => {
          const opt = el('option', { value: String(t.id) }, t.name);
          if (String(t.id) === String(selectedTypeId)) opt.selected = true;
          typeI.appendChild(opt);
        });
      } catch (e) { showToast(e.message, 'error'); }
    }
    insurerI.addEventListener('change', () => loadTypes(insurerI.value, null));
    if (p.insurer_id) loadTypes(p.insurer_id, p.insurance_type_id);

    const insStartI = el('input', { class: 'form-control', type: 'date', value: p.insurance_start ? String(p.insurance_start).slice(0, 10) : '' });
    const insEndI = el('input', { class: 'form-control', type: 'date', value: p.insurance_end ? String(p.insurance_end).slice(0, 10) : '' });

    // 設計費:類型切換顯示金額 / %
    const feeTypeI = el('select', { class: 'form-control' }, [
      el('option', { value: 'lump_sum' }, '總包價法(固定金額)'),
      el('option', { value: 'pct' }, '建造費用百分比')
    ]);
    feeTypeI.value = p.design_fee_type || 'lump_sum';
    const feeAmountI = el('input', { class: 'form-control', type: 'number', step: '1', value: p.design_fee_amount != null ? p.design_fee_amount : '' });
    const feePctI = el('input', { class: 'form-control', type: 'number', step: '0.01', value: p.design_fee_pct != null ? p.design_fee_pct : '' });
    const amountGroup = el('div', { class: 'form-group' }, [el('label', {}, '設計費金額'), feeAmountI]);
    const pctGroup = el('div', { class: 'form-group' }, [el('label', {}, '建造費用百分比(%)'), feePctI]);
    const calcBox = el('div', { class: 'calc-box' });

    function refreshFee() {
      const type = feeTypeI.value;
      amountGroup.style.display = type === 'lump_sum' ? '' : 'none';
      pctGroup.style.display = type === 'pct' ? '' : 'none';
      let text = '', warn = false;
      if (type === 'lump_sum') {
        const a = feeAmountI.value.trim();
        text = a ? `實際設計費:${Number(a).toLocaleString()} 元` : '實際設計費:—';
      } else {
        const award = awardI.value.trim();
        const pct = feePctI.value.trim();
        if (!award) { text = '未招標,設計費待補(需先填決標金額)'; warn = true; }
        else if (!pct) { text = '實際設計費:—(請填百分比)'; }
        else {
          const actual = roundHalfUp(Number(award) * Number(pct) / 100);
          text = `實際設計費:${actual.toLocaleString()} 元(${Number(award).toLocaleString()} × ${pct}%)`;
        }
      }
      calcBox.textContent = text;
      calcBox.className = 'calc-box' + (warn ? ' warn' : '');
    }
    feeTypeI.addEventListener('change', refreshFee);
    feeAmountI.addEventListener('input', refreshFee);
    feePctI.addEventListener('input', refreshFee);
    awardI.addEventListener('input', refreshFee);
    refreshFee();

    const card = el('div', { class: 'card' }, [
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [el('label', {}, '工程編號'), noI]),
        el('div', { class: 'form-group' }, [el('label', {}, '工程名稱'), nameI])
      ]),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [el('label', {}, '施工廠商'), vendorI]),
        el('div', { class: 'form-group' }, [el('label', {}, '學校'), schoolI])
      ]),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [el('label', {}, '開工日'), startI]),
        el('div', { class: 'form-group' }, [el('label', {}, '契約竣工日'), contractI]),
        el('div', { class: 'form-group' }, [el('label', {}, '實際竣工日'), actualI])
      ]),
      el('div', { class: 'form-group' }, [el('label', {}, '決標金額(空=未招標)'), awardI]),
      el('div', { class: 'card-title', style: 'margin-top:8px' }, '保險'),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [el('label', {}, '保險公司'), insurerI]),
        el('div', { class: 'form-group' }, [el('label', {}, '險種'), typeI])
      ]),
      el('div', { class: 'form-row' }, [
        el('div', { class: 'form-group' }, [el('label', {}, '保險起日'), insStartI]),
        el('div', { class: 'form-group' }, [el('label', {}, '保險迄日'), insEndI])
      ]),
      el('div', { class: 'card-title', style: 'margin-top:8px' }, '規劃設計費'),
      el('div', { class: 'form-group' }, [el('label', {}, '計費方式'), feeTypeI]),
      amountGroup,
      pctGroup,
      calcBox,
      el('div', { class: 'form-actions' }, [
        el('button', { class: 'btn btn-primary', onClick: save }, '儲存'),
        el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/projects'; } }, '取消')
      ])
    ]);
    content.appendChild(card);

    async function save() {
      const name = nameI.value.trim();
      if (!name) { showToast('請輸入工程名稱', 'warn'); return; }
      const body = {
        project_no: noI.value.trim(),
        name,
        vendor_id: vendorI.value || null,
        school_id: schoolI.value || null,
        start_date: startI.value || null,
        contract_completion_date: contractI.value || null,
        actual_completion_date: actualI.value || null,
        award_amount: awardI.value.trim() || null,
        insurer_id: insurerI.value || null,
        insurance_type_id: typeI.value || null,
        insurance_start: insStartI.value || null,
        insurance_end: insEndI.value || null,
        design_fee_type: feeTypeI.value,
        design_fee_amount: feeAmountI.value.trim() || null,
        design_fee_pct: feePctI.value.trim() || null
      };
      try {
        if (isNew) await Api.post('projects', body);
        else await Api.put('projects/' + id, body);
        showToast('已儲存', 'success');
        window.location.hash = '/projects';
      } catch (e) { showToast(e.message, 'error'); }
    }
  }

  async function renderList(content) {
    content.appendChild(el('div', { class: 'page-title' }, '工程'));
    const search = el('input', { class: 'form-control search', type: 'text', placeholder: '搜尋工程名稱或編號…' });
    content.appendChild(el('div', { class: 'toolbar' }, [
      search,
      el('div', { class: 'spacer' }),
      el('button', { class: 'btn btn-primary', onClick: () => { window.location.hash = '/projects/new'; } }, '＋ 新增工程')
    ]));
    const tbody = el('tbody', {});
    content.appendChild(el('div', { class: 'table-wrap' }, [
      el('table', { class: 'data' }, [
        el('thead', {}, [el('tr', {}, [
          el('th', { style: 'width:110px' }, '編號'),
          el('th', {}, '名稱'),
          el('th', { style: 'width:140px' }, '設計費'),
          el('th', { style: 'width:120px' }, '')
        ])]),
        tbody
      ])
    ]));

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

    async function load() {
      const q = search.value.trim();
      let rows;
      try { rows = await Api.get('projects' + (q ? '?q=' + encodeURIComponent(q) : '')); }
      catch (e) { showToast(e.message, 'error'); return; }
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, [el('td', { class: 'empty-row', colspan: '4' }, '沒有資料')]));
        return;
      }
      for (const p of rows) {
        let feeText;
        if (p.design_fee_unbid) feeText = '未招標,待補';
        else if (p.design_fee_actual != null) feeText = Number(p.design_fee_actual).toLocaleString() + ' 元';
        else feeText = '—';
        tbody.appendChild(el('tr', {}, [
          el('td', {}, p.project_no || '—'),
          el('td', {}, p.name),
          el('td', {}, feeText),
          el('td', { class: 'actions' }, [
            el('button', { class: 'btn btn-outline', onClick: () => { window.location.hash = '/projects/' + p.id; } }, '編輯'),
            el('button', { class: 'btn btn-danger', style: 'margin-left:6px', onClick: () => remove(p) }, '刪除')
          ])
        ]));
      }
    }

    async function remove(p) {
      const ok = await confirmDialog({ title: '刪除工程', message: `確定刪除「${p.name}」?`, danger: true });
      if (!ok) return;
      try { await Api.delete('projects/' + p.id); showToast('已刪除', 'success'); load(); }
      catch (e) { showToast(e.message, 'error'); }
    }

    load();
  }

  PmisApp.registerRoute('#/projects', (content, hash) => {
    const sub = hash.replace(/^\//, '').split('/')[1];
    if (sub) return renderEdit(content, sub);
    return renderList(content);
  });
})();
