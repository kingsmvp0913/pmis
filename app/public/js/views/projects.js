// projects.js — 工程 view:list + 搜尋 + 編輯(全欄位;險種連動、設計費切換與即時計算)+ 歷史檔案/繳交狀態
(function () {
  const el = PmisApp.el;

  const STATUS_LABEL = { submitted: '已繳', overdue: '未繳', pending: '未到期' };

  // ── 產生監造報表彈窗:選 督導/每月 + 週期 + 上傳施工日誌 ──
  function submissionDialog(defaultPeriod) {
    return new Promise((resolve) => {
      const overlay = el('div', { class: 'modal-overlay' });
      const typeSel = el('select', { class: 'form-control' }, [
        el('option', { value: 'monthly' }, '每月'),
        el('option', { value: 'supervision' }, '督導')
      ]);
      const periodI = el('input', { class: 'form-control', type: 'month', value: defaultPeriod || '' });
      const fileI = el('input', { class: 'form-control', type: 'file' });
      const errBox = el('div', { class: 'error-msg', style: 'display:none' });

      function close(val) { window.removeEventListener('keydown', onKey); overlay.remove(); resolve(val); }
      function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(null); } }

      function submit() {
        const period = periodI.value.trim();
        if (!/^\d{4}-\d{2}$/.test(period)) { errBox.textContent = '請選擇週期(年月)'; errBox.style.display = ''; return; }
        if (!fileI.files || !fileI.files[0]) { errBox.textContent = '請選擇施工日誌檔'; errBox.style.display = ''; return; }
        close({ type: typeSel.value, period, file: fileI.files[0] });
      }

      const modal = el('div', { class: 'modal', role: 'dialog' }, [
        el('div', { class: 'modal-title' }, '產生監造報表'),
        el('div', { class: 'modal-body' }, [
          errBox,
          el('div', { class: 'form-group' }, [el('label', {}, '類型'), typeSel]),
          el('div', { class: 'form-group' }, [el('label', {}, '週期'), periodI]),
          el('div', { class: 'form-group' }, [el('label', {}, '施工日誌檔'), fileI])
        ]),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-outline', onClick: () => close(null) }, '取消'),
          el('button', { class: 'btn btn-primary', onClick: submit }, '送出')
        ])
      ]);
      overlay.appendChild(modal);
      overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(null); });
      window.addEventListener('keydown', onKey);
      document.body.appendChild(overlay);
    });
  }

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
        const panelCell = el('td', { colspan: '4', style: 'padding:0' });
        const panelRow = el('tr', { style: 'display:none' }, [panelCell]);
        const tr = el('tr', {}, [
          el('td', {}, p.project_no || '—'),
          el('td', {}, p.name),
          el('td', {}, feeText),
          el('td', { class: 'actions' }, [
            el('button', { class: 'btn btn-outline', onClick: () => toggleHistory(p, panelRow) }, '歷史'),
            el('button', { class: 'btn btn-outline', style: 'margin-left:6px', onClick: () => { window.location.hash = '/projects/' + p.id; } }, '編輯'),
            el('button', { class: 'btn btn-danger', style: 'margin-left:6px', onClick: () => remove(p) }, '刪除')
          ])
        ]);
        tbody.appendChild(tr);
        tbody.appendChild(panelRow);
      }
    }

    // 展開/收合歷史面板
    async function toggleHistory(p, panelRow) {
      const cell = panelRow.firstChild;
      if (panelRow.style.display !== 'none') { panelRow.style.display = 'none'; return; }
      panelRow.style.display = '';
      cell.innerHTML = '';
      cell.appendChild(el('div', { class: 'history-panel' }, [el('span', { style: 'color:var(--text-muted)' }, '載入中…')]));
      await renderHistory(p, cell);
    }

    // 繳交狀態格 + 紀錄列 + 產生監造報表
    async function renderHistory(p, cell) {
      let data;
      try { data = await Api.get('projects/' + p.id + '/history'); }
      catch (e) { showToast(e.message, 'error'); return; }

      const grid = el('div', { class: 'status-grid' });
      (data.status || []).forEach(s => {
        grid.appendChild(el('div', { class: 'status-pill ' + s.status }, [
          el('span', { class: 'pill-period' }, s.period),
          el('span', { class: 'pill-label' }, STATUS_LABEL[s.status] || '')
        ]));
      });
      if (!(data.status || []).length) grid.appendChild(el('span', { style: 'color:var(--text-muted)' }, '尚無應繳週期'));

      const recWrap = el('div', {});
      (data.records || []).forEach(r => {
        recWrap.appendChild(el('div', { class: 'record-row' }, [
          el('span', { class: 'rec-tag' + (r.type === 'supervision' ? ' supervision' : '') }, r.type === 'supervision' ? '督導' : '每月'),
          el('span', { class: 'rec-main' }, (r.period || '—')),
          el('span', { class: 'spacer' }),
          el('button', { class: 'btn btn-outline', onClick: () => download(r.id, 'official_doc') }, '公文'),
          el('button', { class: 'btn btn-outline', style: 'margin-left:6px', onClick: () => download(r.id, 'report') }, '監造報表'),
          el('button', { class: 'btn btn-outline', style: 'margin-left:6px', onClick: () => download(r.id, 'daily_log') }, '施工日誌'),
          el('button', { class: 'btn btn-danger', style: 'margin-left:6px', onClick: () => removeRec(p, r, cell) }, '刪除')
        ]));
      });

      const head = el('div', { class: 'history-head' }, [
        el('span', { class: 'history-title' }, '歷史檔案(結算日 ' + data.settlement_day + ' 日)'),
        el('span', { class: 'spacer', style: 'flex:1' }),
        el('button', { class: 'btn btn-primary', onClick: () => generate(p, cell) }, '＋ 產生監造報表')
      ]);

      cell.innerHTML = '';
      cell.appendChild(el('div', { class: 'history-panel' }, [head, grid, recWrap]));
    }

    async function download(sid, kind) {
      try { await Api.download('submissions/' + sid + '/download/' + kind); }
      catch (e) {
        // 409 = 尚未產出/尚未產生 → warn;其餘 error
        const soft = e.message.indexOf('尚未產出') >= 0 || e.message.indexOf('尚未產生') >= 0;
        showToast(e.message, soft ? 'warn' : 'error');
      }
    }

    async function generate(p, cell) {
      const now = new Date();
      const dp = now.getFullYear() + '-' + String(now.getMonth() + 1).padStart(2, '0');
      const r = await submissionDialog(dp);
      if (!r) return;
      const fd = new FormData();
      fd.append('type', r.type);
      fd.append('period', r.period);
      fd.append('daily_log', r.file);
      try {
        const resp = await Api.upload('projects/' + p.id + '/submissions', fd);
        if (resp && resp.report_generated) {
          showToast('已產生監造報表', 'success');
        } else if (resp && resp.reason) {
          // 未產生報表:明確告知原因(如尚未安裝讀取器),避免以為成功卻沒東西。
          showToast(resp.reason, 'warn');
        } else {
          showToast('已建立', 'success');
        }
        await renderHistory(p, cell);
      } catch (e) { showToast(e.message, 'error'); }
    }

    async function removeRec(p, r, cell) {
      const ok = await confirmDialog({ title: '刪除紀錄', message: '確定刪除此筆紀錄(連同檔案)?', danger: true });
      if (!ok) return;
      try { await Api.delete('submissions/' + r.id); showToast('已刪除', 'success'); await renderHistory(p, cell); }
      catch (e) { showToast(e.message, 'error'); }
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
