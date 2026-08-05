/**
 * daily-logs.js — 施工日誌區塊(SP3)
 *
 * 獨立成一個檔案的理由同 contract-items.js:projects.js 已 46KB。
 * 對外只露出 DailyLogs.card(projectId)。
 */
const DailyLogs = (() => {
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString());

  function card(projectId) {
    let file = null;

    const fileI = el('input', { class: 'form-control', type: 'file', accept: '.pdf,.xls,.xlsx,.docx' });
    const parseBtn = el('button', { class: 'btn', type: 'button' }, '驗證施工日誌');
    const confirmBtn = el('button', { class: 'btn btn-primary', type: 'button', style: 'display:none' },
      '確認並寫入監造報表');
    const err = el('div', { class: 'error-msg', style: 'display:none' });
    const summary = el('div', { class: 'hint', style: 'display:none' });
    const skipBox = el('div', { class: 'hint', style: 'display:none' });
    const listBox = el('div', { class: 'table-wrap' });
    const diffBox = el('div', { class: 'table-wrap' });
    const hint = el('div', { class: 'hint' },
      '上傳廠商提供的施工日誌,系統依 39 條規則檢查後才寫入監造報表。' +
      '有硬錯時整份不寫入——只寫沒問題的那幾天,累計金額與完成百分比會算出錯的數字卻看起來正常。');

    const showErr = (m) => { err.textContent = m; err.style.display = ''; };

    // 硬錯與軟警告一次列全:逐條修正會讓承辦人與廠商來回好幾趟
    function renderFindings(errors, warnings) {
      listBox.innerHTML = '';
      const all = [
        ...(errors || []).map((e) => ({ ...e, 級別: '硬錯' })),
        ...(warnings || []).map((e) => ({ ...e, 級別: '警告' })),
      ];
      if (!all.length) return;
      const trs = all.map((f) => el('tr', {}, [
        el('td', {}, el('span', { class: f.級別 === '硬錯' ? 'error-msg' : 'hint' }, f.級別)),
        el('td', {}, f.code),
        el('td', {}, f.日期 || '—'),
        el('td', {}, f.項次 || '—'),
        el('td', {}, f.訊息),
      ]));
      listBox.appendChild(el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { style: 'width:56px' }, '級別'), el('th', { style: 'width:48px' }, '代碼'),
          el('th', { style: 'width:110px' }, '日期'), el('th', { style: 'width:60px' }, '項次'),
          el('th', {}, '說明'),
        ])),
        el('tbody', {}, trs),
      ]));
    }

    // 沒驗到什麼一定要講——靜默跳過會讓承辦人以為全部都驗過了
    function renderSkipped(skipped) {
      skipBox.style.display = 'none';
      if (!skipped || !skipped.length) return;
      skipBox.textContent = `本次未檢查的項目(${skipped.length}):` +
        skipped.map((s) => `${s.code}(${s.原因})`).join('；');
      skipBox.style.display = '';
    }

    // 「後面才發現前面錯了」是真實流程:覆蓋前要看得到哪一天的哪一項改成多少
    function renderDiff(diff) {
      diffBox.innerHTML = '';
      if (!diff) return;
      const { added = [], changed = [], removed = [] } = diff;
      if (!changed.length && !removed.length) {
        diffBox.appendChild(el('div', { class: 'hint' }, `新增 ${added.length} 筆逐日資料。`));
        return;
      }
      const trs = [
        ...changed.map((c) => el('tr', {}, [
          el('td', {}, el('span', { class: 'error-msg' }, '修改')),
          el('td', {}, c.日期), el('td', {}, c.項次),
          el('td', {}, num(c.舊)), el('td', {}, num(c.新)),
        ])),
        ...removed.map((r) => el('tr', {}, [
          el('td', {}, el('span', { class: 'error-msg' }, '清除')),
          el('td', {}, r.日期), el('td', {}, r.項次),
          el('td', {}, num(r.本日完成數量)), el('td', {}, '—'),
        ])),
      ];
      diffBox.appendChild(el('div', { class: 'error-msg' },
        `這份會覆蓋既有資料:修改 ${changed.length} 筆、清除 ${removed.length} 筆、新增 ${added.length} 筆。`));
      diffBox.appendChild(el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { style: 'width:56px' }, ''), el('th', {}, '日期'), el('th', {}, '項次'),
          el('th', {}, '原本'), el('th', {}, '新的'),
        ])),
        el('tbody', {}, trs),
      ]));
    }

    const fd = () => { const f = new FormData(); f.append('daily_log', file); return f; };

    parseBtn.addEventListener('click', async () => {
      err.style.display = 'none';
      summary.style.display = 'none';
      confirmBtn.style.display = 'none';
      listBox.innerHTML = '';
      diffBox.innerHTML = '';
      skipBox.style.display = 'none';
      if (!fileI.files[0]) { showErr('請先選擇施工日誌'); return; }
      file = fileI.files[0];
      parseBtn.disabled = true;
      parseBtn.textContent = '驗證中…';
      try {
        const d = await Api.upload(`projects/${projectId}/daily-logs/parse`, fd());
        const 範圍 = d.日期範圍 && d.日期範圍[0] ? `${d.日期範圍[0]} ~ ${d.日期範圍[1]}` : '';
        summary.textContent = `共 ${d.天數} 天 ${範圍}:硬錯 ${d.errors.length} 項、` +
          `警告 ${d.warnings.length} 項。`;
        summary.className = d.errors.length ? 'error-msg' : 'hint';
        summary.style.display = '';
        renderFindings(d.errors, d.warnings);
        renderSkipped(d.skipped);
        renderDiff(d.diff);
        // 有硬錯就不給寫:整份擋下是裁決,前端不另開後門
        confirmBtn.style.display = d.errors.length ? 'none' : '';
      } catch (e) {
        showErr(e.message);
      } finally {
        parseBtn.disabled = false;
        parseBtn.textContent = '驗證施工日誌';
      }
    });

    confirmBtn.addEventListener('click', async () => {
      err.style.display = 'none';
      confirmBtn.disabled = true;
      confirmBtn.textContent = '寫入中(Excel 需數秒)…';
      try {
        const r = await Api.upload(`projects/${projectId}/daily-logs/confirm`, fd());
        showToast(`已寫入 ${r.天數} 天、${r.筆數} 筆逐日資料`, 'success');
        confirmBtn.style.display = 'none';
        diffBox.innerHTML = '';
      } catch (e) {
        showErr(e.message);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '確認並寫入監造報表';
      }
    });

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '施工日誌'),
      hint,
      el('div', { class: 'form-group' }, [el('label', {}, '施工日誌檔案'), fileI]),
      el('div', { class: 'form-actions' }, [parseBtn, confirmBtn]),
      err,
      summary,
      skipBox,
      diffBox,
      listBox,
    ]);
  }

  return { card };
})();
