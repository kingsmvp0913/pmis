/**
 * contract-items.js — 契約詳細價目表區塊(SP2)
 *
 * 獨立成一個檔案而不是繼續往 projects.js 疊:那支已經 46KB,再塞一塊完整流程
 * (多檔上傳 → 挑表 → 差異確認 → 寫入)只會讓兩邊都難改。對外只露出一個
 * ContractItems.card(projectId),由 projects.js 掛進工程編輯頁。
 */
const ContractItems = (() => {
  const money = (n) => (n == null ? '—' : Number(n).toLocaleString());

  /**
   * @param {number|string} projectId
   * @returns {HTMLElement} 可直接 append 的卡片
   */
  function card(projectId) {
    let files = [];       // 承辦人選的檔案(confirm 要重送一次,故留著)
    let picks = [];       // [{file, name}] 要採用的分頁
    let 決標金額 = null;

    const fileI = el('input', {
      class: 'form-control', type: 'file', multiple: true, accept: '.xls,.xlsx,.xlsm',
    });
    const parseBtn = el('button', { class: 'btn', type: 'button' }, '解析並比對');
    const confirmBtn = el('button', { class: 'btn btn-primary', type: 'button', style: 'display:none' },
      '確認並寫入監造報表');
    const err = el('div', { class: 'error-msg', style: 'display:none' });
    const summary = el('div', { class: 'hint', style: 'display:none' });
    const box = el('div', { class: 'table-wrap' });
    const diffBox = el('div', { class: 'table-wrap' });
    const hint = el('div', { class: 'hint' },
      '可一次上傳多份(像重興那種廁所、汙水分兩個標的的案子)。系統以決標金額比對,' +
      '自動挑出該用哪一張詳細價目表;對不上時會列出候選讓你自己勾選。');

    const showErr = (msg) => { err.textContent = msg; err.style.display = ''; };
    const clearErr = () => { err.style.display = 'none'; };

    // 勾選候選時即時算合計:承辦人不必按下去才知道湊不湊得出決標金額
    function renderCandidates(candidates) {
      box.innerHTML = '';
      if (!candidates || !candidates.length) return;
      const total = el('div', { class: 'hint' });
      const boxes = [];
      const recalc = () => {
        const sum = boxes.filter((b) => b.input.checked)
          .reduce((s, b) => s + b.合計, 0);
        picks = boxes.filter((b) => b.input.checked).map((b) => ({ file: b.file, name: b.name }));
        const ok = sum === 決標金額;
        total.textContent = `已勾選合計 ${money(sum)} / 決標金額 ${money(決標金額)}` +
          (ok ? '(相符)' : '(不符,無法寫入)');
        total.className = ok ? 'hint' : 'error-msg';
        confirmBtn.style.display = ok ? '' : 'none';
      };
      const trs = candidates.map((c) => {
        const input = el('input', { type: 'checkbox' });
        input.addEventListener('change', recalc);
        boxes.push({ input, file: c.file, name: c.name, 合計: c.合計 });
        return el('tr', {}, [
          el('td', {}, input),
          el('td', {}, c.file),
          el('td', {}, c.name),
          el('td', {}, String(c.項目數)),
          el('td', {}, money(c.合計)),
        ]);
      });
      box.appendChild(el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { style: 'width:40px' }, '採用'), el('th', {}, '檔案'),
          el('th', {}, '分頁'), el('th', {}, '項目數'), el('th', {}, '合計'),
        ])),
        el('tbody', {}, trs),
      ]));
      box.appendChild(total);
      recalc();
    }

    // 廠商會改舊項目,不是只會加新項目。整張覆蓋前把改了什麼攤開——
    // 只說「已更新」的話,承辦人不會知道 30 項裡有 3 項單價變了。
    function renderDiff(diff) {
      diffBox.innerHTML = '';
      if (!diff) return;
      const { added = [], removed = [], changed = [] } = diff;
      if (!removed.length && !changed.length) {
        diffBox.appendChild(el('div', { class: 'hint' },
          `這是第一次建立或內容無異動:新增 ${added.length} 項。`));
        return;
      }
      const rows = [];
      for (const c of changed) {
        rows.push(el('tr', {}, [
          el('td', {}, el('span', { class: 'error-msg' }, '修改')),
          el('td', {}, c.項目),
          el('td', {}, `${c.舊.數量} × ${money(c.舊.單價)}`),
          el('td', {}, `${c.新.數量} × ${money(c.新.單價)}`),
        ]));
      }
      for (const i of removed) {
        rows.push(el('tr', {}, [
          el('td', {}, el('span', { class: 'error-msg' }, '刪除')),
          el('td', {}, i.項目), el('td', {}, `${i.數量} × ${money(i.單價)}`), el('td', {}, '—'),
        ]));
      }
      for (const i of added) {
        rows.push(el('tr', {}, [
          el('td', {}, '新增'), el('td', {}, i.項目),
          el('td', {}, '—'), el('td', {}, `${i.數量} × ${money(i.單價)}`),
        ]));
      }
      diffBox.appendChild(el('div', { class: 'error-msg' },
        `這份會取代現有的契約詳細價目表:修改 ${changed.length} 項、刪除 ${removed.length} 項、新增 ${added.length} 項。`));
      diffBox.appendChild(el('table', { class: 'data' }, [
        el('thead', {}, el('tr', {}, [
          el('th', { style: 'width:60px' }, ''), el('th', {}, '項目'),
          el('th', {}, '原本'), el('th', {}, '新的'),
        ])),
        el('tbody', {}, rows),
      ]));
    }

    const formData = () => {
      const fd = new FormData();
      for (const f of files) fd.append('budget_sheets', f);
      return fd;
    };

    parseBtn.addEventListener('click', async () => {
      clearErr();
      summary.style.display = 'none';
      confirmBtn.style.display = 'none';
      box.innerHTML = '';
      diffBox.innerHTML = '';
      if (!fileI.files.length) { showErr('請先選擇發包經費總表'); return; }
      files = Array.from(fileI.files);
      parseBtn.disabled = true;
      parseBtn.textContent = '解析中…';
      try {
        const data = await Api.upload(`projects/${projectId}/contract-items/parse`, formData());
        決標金額 = data.決標金額;
        if (data.errors && data.errors.length) {
          showErr('詳細價目表內容不成立:' +
            data.errors.map((e) => `項次 ${e.項次}(${e.訊息})`).join('、'));
        }
        if (data.selected) {
          picks = data.selected.matched.map((m) => ({ file: m.file, name: m.name }));
          summary.textContent = `已自動選定:${data.selected.matched
            .map((m) => `${m.file} / ${m.name}(${money(m.合計)})`).join(' + ')}` +
            `,合計 ${money(data.selected.合計)} 與決標金額相符,共 ${data.selected.items.length} 項。`;
          summary.style.display = '';
          confirmBtn.style.display = data.errors && data.errors.length ? 'none' : '';
        } else {
          // 系統挑哪一組都可能是錯的,交回給人:候選一律列出,合計對上才放行
          summary.textContent = `沒有任何一張(或組合)的合計等於決標金額 ${money(決標金額)},` +
            '請確認檔案版本,或自行勾選要採用的分頁。';
          summary.className = 'error-msg';
          summary.style.display = '';
          renderCandidates(data.candidates);
        }
        renderDiff(data.diff);
      } catch (e) {
        showErr(e.message);
      } finally {
        parseBtn.disabled = false;
        parseBtn.textContent = '解析並比對';
      }
    });

    confirmBtn.addEventListener('click', async () => {
      clearErr();
      confirmBtn.disabled = true;
      confirmBtn.textContent = '寫入中(Excel 需數秒)…';
      try {
        const fd = formData();
        fd.append('picks', JSON.stringify(picks));
        const r = await Api.upload(`projects/${projectId}/contract-items/confirm`, fd);
        showToast(`契約詳細價目表已寫入監造報表,共 ${r.count} 項`, 'success');
        confirmBtn.style.display = 'none';
        diffBox.innerHTML = '';
      } catch (e) {
        const detail = e.fields && e.fields.length ? '：' + e.fields.join('、') : '';
        showErr(e.message + detail);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '確認並寫入監造報表';
      }
    });

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '契約詳細價目表'),
      hint,
      el('div', { class: 'form-group' }, [el('label', {}, '發包經費總表(可多選)'), fileI]),
      el('div', { class: 'form-actions' }, [parseBtn, confirmBtn]),
      err,
      summary,
      box,
      diffBox,
    ]);
  }

  return { card };
})();
