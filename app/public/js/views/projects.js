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
    let vendors = [], schools = [], insurers = [], firms = {};
    try {
      // 系統預設的監造/設計單位另外接 .catch:projects.supervisor_firm 在第一次成功
      // 寫報表前恆為 NULL,少了這份 fallback 每個工程第一次寫監造報表都會被後端
      // REQUIRED 擋下、逼承辦人手打;但「設定讀不到」不該嚴重到讓整頁進不去,
      // 故取不到就退回 {},由下面的 || '' 收尾。
      [vendors, schools, insurers, firms] = await Promise.all([
        Api.get('vendors'), Api.get('schools'), Api.get('insurers'),
        Api.get('settings/firms').catch(() => ({}))
      ]);
      if (!isNew) p = await Api.get('projects/' + id);
    } catch (e) { showToast(e.message, 'error'); window.location.hash = '/projects'; return; }

    content.appendChild(el('div', { class: 'page-title' }, isNew ? '新增工程' : '編輯工程'));

    // 決標公告區塊只在新增模式出現:既有工程要重新裁決仍走原本的逐欄比對流程。
    // 沿用 vendors.js:172 的 if (!isNew) 分岔慣例。
    let awardFile = null;
    if (isNew) {
      const fileI = el('input', { class: 'form-control', type: 'file', accept: '.pdf' });
      const parseBtn = el('button', { class: 'btn', type: 'button' }, '解析決標公告');
      const awardMsg = el('div', { class: 'hint' },
        '上傳決標公告可自動帶入工程名稱、編號、金額、主辦機關與承包廠商;也可略過直接手動填寫。');
      const awardErr = el('div', { class: 'error-msg', style: 'display:none' });

      parseBtn.addEventListener('click', async () => {
        awardErr.style.display = 'none';
        if (!fileI.files[0]) { showToast('請先選擇決標公告 PDF', 'warn'); return; }
        parseBtn.disabled = true;
        try {
          const fd = new FormData();
          fd.append('award_notice', fileI.files[0]);
          const data = await Api.upload('award-notice/parse', fd);
          applyParsed(data);
          awardFile = fileI.files[0];
          showToast('已帶入決標公告內容,請確認後儲存', 'success');
        } catch (e) {
          awardErr.textContent = e.message;
          awardErr.style.display = '';
        } finally { parseBtn.disabled = false; }
      });

      content.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, '決標公告'),
        awardMsg,
        el('div', { class: 'form-group' }, [fileI]),
        el('div', { class: 'form-actions' }, [parseBtn]),
        awardErr,
      ]));
    }

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

    // 寫監造報表要開 Excel COM、可能重試失敗,比一般存檔重得多。
    // 故必須是獨立按鈕——否則改個保險到期日也會去開一次 Excel。
    if (!isNew) {
      const 工期I = el('input', { class: 'form-control', type: 'number', step: '1', min: '1' });
      const 開工I = el('input', { class: 'form-control', type: 'date',
        value: p.start_date ? String(p.start_date).slice(0, 10) : '' });
      // 工程層的值優先,沒有才吊系統預設(沿用已刪的 project-basics.js 既有行為)
      const supI = el('input', { class: 'form-control', type: 'text', value: p.supervisor_firm || firms.supervisor_firm || '' });
      const desI = el('input', { class: 'form-control', type: 'text', value: p.designer_firm || firms.designer_firm || '' });
      const basicsErr = el('div', { class: 'error-msg', style: 'display:none' });
      const writeBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '寫入監造報表');

      writeBtn.addEventListener('click', async () => {
        basicsErr.style.display = 'none';
        writeBtn.disabled = true;
        try {
          // 下拉的 value 是資料庫 id、placeholder(「(未選學校)」等)的 value 是空字串——
          // 只有真的選了才取 textContent(名稱)當值,否則送空字串讓後端 REQUIRED 擋下,
          // 不可用「selectedIndex 一定有值」判斷有沒有選,那樣永遠會拿到 placeholder 文字。
          const 契約金額raw = awardI.value.trim();
          const 契約工期raw = 工期I.value.trim();
          const values = {
            工程名稱: nameI.value.trim(), 監造單位: supI.value.trim(),
            主辦機關: schoolI.value ? schoolI.options[schoolI.selectedIndex].textContent : '',
            設計單位: desI.value.trim(),
            承包廠商: vendorI.value ? vendorI.options[vendorI.selectedIndex].textContent : '',
            // Excel COM 的 Value2 保留呼叫端傳入的原生型別,字串會讓儲存格存成文字而非數值,
            // 故能轉數字就轉——空值/非數字仍留字串,讓後端 REQUIRED/FORMAT_OK 照常擋下並列出缺項。
            契約金額: (契約金額raw !== '' && Number.isFinite(Number(契約金額raw))) ? Number(契約金額raw) : 契約金額raw,
            契約工期: (契約工期raw !== '' && Number.isFinite(Number(契約工期raw))) ? Number(契約工期raw) : 契約工期raw,
            開工日期: 開工I.value, 工程編號: noI.value.trim(),
          };
          const r = await Api.post('projects/' + id + '/basics', { values });
          // 這支已經把開工日期與範本算出的完工期限寫進 DB 了。主表單的開工日/契約竣工日
          // 若還停在舊值,承辦人接著按「儲存」時 PUT 會用陳舊值覆蓋回去,靜默抹掉剛算出
          // 的完工期限——所以寫入成功後必須把畫面同步到 DB 現況。
          startI.value = 開工I.value;
          if (r.完工期限) contractI.value = String(r.完工期限).slice(0, 10);
          showToast(`已寫入監造報表,完工期限 ${r.完工期限 || '—'}`, 'success');
        } catch (e) {
          const suffix = e.fields && e.fields.length ? '：' + e.fields.join('、') : '';
          basicsErr.textContent = e.message + suffix;
          basicsErr.style.display = '';
        } finally { writeBtn.disabled = false; }
      });

      content.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, '監造報表基本資料'),
        el('div', { class: 'hint', style: 'margin-top:0' },
          '契約工期與開工日期須對照開工報告表填寫,系統不會自動帶入。完工期限由範本公式算出。'),
        el('div', { class: 'form-group' }, [el('label', {}, '監造單位'), supI]),
        el('div', { class: 'form-group' }, [el('label', {}, '設計單位'), desI]),
        el('div', { class: 'form-group' }, [el('label', {}, '契約工期(日曆天)'), 工期I]),
        el('div', { class: 'form-group' }, [el('label', {}, '開工日期'), 開工I]),
        el('div', { class: 'form-actions' }, [writeBtn]),
        basicsErr,
      ]));

      // ── 開工報告表(SP1B 階段二)────────────────────────────
      // OCR 只作預填不作裁決:逐欄辨識率 77%、契約工期僅 46%,
      // 讓 OCR 下裁決會每三欄產生一個假警報,承辦人幾次之後就學會忽略警告。
      let kickoffFile = null;
      let kickoffValues = null;
      // r.欄位(比對表中文標籤)→ resultSpan 元素,供 confirm 失敗後用後端回傳的
      // 最新 fields 清單回頭標紅——每次 renderKickoffRows 重繪時整批換新。
      let koResultCells = {};
      const koFileI = el('input', { class: 'form-control', type: 'file', accept: '.pdf' });
      const koParseBtn = el('button', { class: 'btn', type: 'button' }, '解析並比對');
      const koConfirmBtn = el('button', { class: 'btn btn-primary', type: 'button', style: 'display:none' }, '確認無誤並歸檔');
      const koErr = el('div', { class: 'error-msg', style: 'display:none' });
      // 工作天案例的專屬警示:與 koErr 分開,因為 koErr 是「這次操作失敗」,
      // 這個是「操作成功但有一格刻意不填」——同時顯示不衝突,語意也不同。
      const koDurationWarn = el('div', { class: 'error-msg', style: 'display:none' });
      const koHint = el('div', { class: 'hint' },
        '上傳後系統以 OCR 預填候選值並與已歸檔的決標公告比對。讀不到的欄位留空,請對照 PDF 自行填寫。' +
        '「開工報告表」欄可直接編輯(如 OCR 讀錯字),改完按「確認無誤並歸檔」由後端重新比對。');
      const koBox = el('div', { class: 'table-wrap' });

      const 狀態文字 = { match: '相符', diff: '不符', missing: '未讀到', no_award: '無決標公告可比' };

      // 比對表中文標籤 → extractFields 的實際鍵名(兩邊命名不完全相同,
      // 如「決標日」對應 kickoffValues.決標日期、「學校」對應 .主辦機關)。
      const FIELD_KEY = {
        工程名稱: '工程名稱', 契約編號: '契約編號', 契約金額: '契約金額',
        決標日: '決標日期', 學校: '主辦機關', 縣市: '縣市',
        契約工期: '契約工期', 契約規定開工日: '契約規定開工日', 契約規定竣工日: '契約規定竣工日',
      };
      const DATE_FIELDS = new Set(['決標日', '契約規定開工日', '契約規定竣工日']);
      const NUMBER_FIELDS = new Set(['契約金額', '契約工期']);

      function renderKickoffRows(rows) {
        koBox.innerHTML = '';
        koResultCells = {};
        if (!rows || !rows.length) return;
        const trs = rows.map((r) => {
          // 級別與狀態一起決定顯示:提示級的 diff 不是錯,是「決標公告寫的是預估值」
          let 標記 = 狀態文字[r.狀態] || r.狀態;
          // 配色一律走 app.css 的 CSS 變數,不寫死淺色底(深色模式會讓文字翻白＝隱形)
          let cls = r.狀態 === 'diff' && r.級別 === 'hard' ? 'error-msg' : 'hint';
          if (r.狀態 === 'diff' && r.級別 === 'hint') {
            標記 = `提示:差 ${r.差異天數 == null ? '?' : r.差異天數} 天`;
          } else if (r.欄位 === '契約工期' && r.狀態 === 'missing' &&
            typeof r.開工報告表值 === 'string' && r.開工報告表值.includes('工作天')) {
            // 這格「有讀到值」(如 160 工作天),只是工作天無法跟日曆天比較——
            // 灰色「未讀到」會讓承辦人以為這格是空的而略過核對,實際上工期I
            // 被刻意留空正是因為讀到了這個工作天數字,兩者要分開強調。
            標記 = '工作天,單位不同無法比對,請自行核對填寫';
            cls = 'error-msg';
          }
          const resultSpan = el('span', { class: cls }, 標記);
          koResultCells[r.欄位] = resultSpan;

          // 開工報告表值改為可編輯輸入框:元長案例(OCR 把「-」讀成「—」)證明
          // 唯讀比對表在真的遇到 OCR 誤讀時,承辦人無計可施,合法文件永遠歸不了檔。
          // 讀不到的欄位維持留空(不預先填東西進去),沿用 spec §5.1 的「確認或修正」。
          const key = FIELD_KEY[r.欄位];
          const isDate = DATE_FIELDS.has(r.欄位);
          const isNumber = NUMBER_FIELDS.has(r.欄位);
          const type = isDate ? 'date' : (isNumber ? 'number' : 'text');
          const initVal = r.欄位 === '契約工期'
            ? (kickoffValues.契約工期 && kickoffValues.契約工期.天數 != null ? kickoffValues.契約工期.天數 : '')
            : (kickoffValues[key] == null ? '' : kickoffValues[key]);
          const valInput = el('input', {
            class: 'form-control', type, value: String(initVal),
            ...(isNumber ? { step: '1' } : {}),
          });
          valInput.addEventListener('input', () => {
            // 舊的 match/diff 是上一輪解析值的判定,編輯後繼續掛著會誤導承辦人
            // 以為「還是原本那個結果」——改採中性提示,真正的裁決留給後端在
            // 「確認無誤並歸檔」時用 kickoff-compare.js 重新決定(前端不重造一份
            // 判斷邏輯,避免兩邊規則漂走)。
            resultSpan.className = 'hint';
            resultSpan.textContent = '已修改,尚未送出確認';

            if (r.欄位 === '契約工期') {
              const n = valInput.value.trim();
              const 基準 = (kickoffValues.契約工期 && kickoffValues.契約工期.基準) || null;
              kickoffValues.契約工期 = {
                天數: n !== '' && Number.isFinite(Number(n)) ? Number(n) : null,
                基準,
              };
              // 「工期I」是「寫入監造報表」實際會用的值,兩邊沒同步的話,承辦人
              // 會以為改好了,結果寫進 Excel 的還是舊值(commit a0cef03 抓過的型態)。
              // 工作天不是日曆天,不可互填,維持既有警示與空白,不同步。
              if (基準 !== '工作天') {
                工期I.value = kickoffValues.契約工期.天數 != null ? kickoffValues.契約工期.天數 : '';
              }
            } else if (r.欄位 === '契約規定開工日') {
              kickoffValues.契約規定開工日 = valInput.value || null;
              開工I.value = valInput.value || '';
            } else if (isNumber) {
              const n = valInput.value.trim();
              kickoffValues[key] = n !== '' && Number.isFinite(Number(n)) ? Number(n) : null;
            } else if (isDate) {
              kickoffValues[key] = valInput.value || null;
            } else {
              const t = valInput.value.trim();
              kickoffValues[key] = t === '' ? null : t;
            }
          });

          return el('tr', {}, [
            el('td', {}, r.欄位),
            el('td', {}, valInput),
            el('td', {}, r.決標公告值 == null ? '—' : String(r.決標公告值)),
            el('td', {}, resultSpan),
          ]);
        });
        koBox.appendChild(el('table', { class: 'data' }, [
          el('thead', {}, el('tr', {}, [
            el('th', {}, '欄位'), el('th', {}, '開工報告表(可編輯)'),
            el('th', {}, '決標公告'), el('th', {}, '結果'),
          ])),
          el('tbody', {}, trs),
        ]));
      }

      koParseBtn.addEventListener('click', async () => {
        koErr.style.display = 'none';
        koDurationWarn.style.display = 'none';
        if (!koFileI.files[0]) {
          koErr.textContent = '請先選擇開工報告表 PDF';
          koErr.style.display = '';
          return;
        }
        koParseBtn.disabled = true;
        koParseBtn.textContent = '解析中(OCR 需數秒)…';
        try {
          const fd = new FormData();
          fd.append('kickoff_report', koFileI.files[0]);
          const data = await Api.upload('projects/' + id + '/kickoff-report/parse', fd);
          kickoffFile = koFileI.files[0];
          kickoffValues = data.kickoff;
          renderKickoffRows(data.rows);
          // 預填既有的兩格。**只在讀到值時覆蓋**——讀不到就留著承辦人已填的內容,
          // 用 null 蓋掉會把他剛打好的字清空。
          const 工期 = data.kickoff.契約工期;
          if (工期 && 工期.基準 === '工作天') {
            // 「工期I」標示的是日曆天,工作天不是同一單位,不可直接互填——
            // 硬塞會產生「數字看起來正常、單位卻是錯的」這種最難察覺的資料損壞。
            // 寧可留空讓承辦人自己核對 PDF 換算,也要用明顯的警示說明「為什麼沒填」,
            // 靜默跳過跟靜默填錯一樣糟。
            koDurationWarn.textContent =
              `開工報告表上的工期是「${工期.天數 == null ? '?' : 工期.天數} 工作天」,` +
              '而此欄位要的是日曆天,兩者不可直接互填,請對照 PDF 自行換算後填入(系統不自動預填)。';
            koDurationWarn.style.display = '';
          } else if (工期 && 工期.天數 != null) {
            工期I.value = 工期.天數;
          }
          if (data.kickoff.契約規定開工日) 開工I.value = data.kickoff.契約規定開工日;
          if (!data.hasAward) {
            // 這是「未執行到比對」的限制提示,不是成功動作——用 success(綠)
            // 會讓承辦人誤以為比對已經做完。
            showToast('此工程未歸檔決標公告,僅做預填、未進行比對', 'warn');
          }
          koConfirmBtn.style.display = '';
        } catch (e) {
          koErr.textContent = e.message;
          koErr.style.display = '';
          koConfirmBtn.style.display = 'none';
        } finally {
          koParseBtn.disabled = false;
          koParseBtn.textContent = '解析並比對';
        }
      });

      koConfirmBtn.addEventListener('click', async () => {
        koErr.style.display = 'none';
        if (!kickoffFile || !kickoffValues) return;
        koConfirmBtn.disabled = true;
        try {
          // 送出承辦人確認後的值:工期與開工日以畫面上的為準(他可能修正過 OCR 的錯讀),
          // 其餘欄位沿用解析值。
          const 工期raw = 工期I.value.trim();
          const values = {
            ...kickoffValues,
            契約工期: {
              天數: 工期raw !== '' && Number.isFinite(Number(工期raw)) ? Number(工期raw) : null,
              基準: (kickoffValues.契約工期 && kickoffValues.契約工期.基準) || null,
            },
            契約規定開工日: 開工I.value || null,
          };
          const fd = new FormData();
          fd.append('kickoff_report', kickoffFile);
          fd.append('values', JSON.stringify(values));
          const r = await Api.upload('projects/' + id + '/kickoff-report/confirm', fd);
          renderKickoffRows(r.rows);
          showToast('開工報告表已核對並歸檔', 'success');
          koConfirmBtn.style.display = 'none';
          await loadAttachments();
        } catch (e) {
          // 硬錯清單一次列全,逐條修正會讓承辦人來回發文
          const suffix = e.fields && e.fields.length ? '：' + e.fields.join('、') : '';
          koErr.textContent = e.message + suffix;
          koErr.style.display = '';
          // 後端已用這次送出的 values 重新跑過 compareKickoff,e.fields 就是
          // 最新的硬錯清單——藉此把表格上「這次仍不符」的那幾列標紅,不讓
          // 承辦人誤以為畫面上的中性提示代表已經沒事。api.js 的 apiError()
          // 只透傳 fields、不傳 rows(跨檔案限制,見 task-8-report),故只能
          // 標記出「哪幾欄還錯」,無法整表用新結果重繪。
          if (e.fields && e.fields.length) {
            for (const f of e.fields) {
              const span = koResultCells[f];
              if (span) { span.className = 'error-msg'; span.textContent = '與決標公告不符,請確認後修正'; }
            }
          }
        } finally { koConfirmBtn.disabled = false; }
      });

      content.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, '開工報告表'),
        koHint,
        el('div', { class: 'form-group' }, [el('label', {}, '開工報告表 PDF'), koFileI]),
        el('div', { class: 'form-actions' }, [koParseBtn, koConfirmBtn]),
        koErr,
        koDurationWarn,
        koBox,
      ]));

      const attBox = el('div', { class: 'table-wrap' });
      const attCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, '附件'),
        attBox,
      ]);
      content.appendChild(attCard);

      const KIND_LABEL = { award_notice: '決標公告', kickoff_report: '開工報告表' };

      async function loadAttachments() {
        attBox.innerHTML = '';
        let list = [];
        try { list = await Api.get('projects/' + id + '/attachments'); }
        catch (e) { showToast(e.message, 'error'); return; }
        if (!list.length) {
          attBox.appendChild(el('div', { class: 'hint' }, '尚無附件。'));
          return;
        }
        const rows = list.map((a) => {
          const dl = el('button', { class: 'btn', type: 'button' }, '下載');
          dl.addEventListener('click', () => Api.download('attachments/' + a.id + '/download')
            .catch((e) => showToast(e.message, 'error')));
          const rm = el('button', { class: 'btn btn-danger', type: 'button', style: 'margin-left:6px' }, '刪除');
          rm.addEventListener('click', async () => {
            const ok = await confirmDialog({
              title: '刪除附件', message: `確定刪除「${a.original_name || ''}」?`, danger: true,
            });
            if (!ok) return;
            try { await Api.delete('attachments/' + a.id); await loadAttachments(); }
            catch (e) { showToast(e.message, 'error'); }
          });
          return el('tr', {}, [
            el('td', {}, KIND_LABEL[a.kind] || a.kind),
            el('td', {}, a.original_name || ''),
            el('td', {}, String(a.uploaded_at || '').slice(0, 10)),
            el('td', {}, [dl, rm]),
          ]);
        });
        attBox.appendChild(el('table', { class: 'data' }, [
          el('thead', {}, [el('tr', {}, [
            el('th', {}, '類型'), el('th', {}, '檔名'), el('th', {}, '上傳日'), el('th', {}, ''),
          ])]),
          el('tbody', {}, rows),
        ]));
      }
      loadAttachments();
    }

    // 決標公告解析結果 → 表單。廠商/學校對不到時當場提供建立鈕,
    // 因為 vendors 只有 name 一欄、schools 只有 name + county,沒有其他要填的。
    function applyParsed(data) {
      const p = data.parsed || {};
      // 先清空再填:連續解析兩份公告時,若第二份某欄解析失敗(回 null),「有值才覆蓋」
      // 會讓第一份的殘值留在表單上——結果歸檔的是 B 的 PDF、存下的卻是 A 的欄位。
      nameI.value = '';
      noI.value = '';
      awardI.value = '';
      if (p.工程名稱) nameI.value = p.工程名稱;
      if (p.工程編號) noI.value = p.工程編號;
      if (p.契約金額 != null) awardI.value = p.契約金額;
      bindOrCreate(vendorI, data.vendorMatch, 'vendors', '廠商', null);
      bindOrCreate(schoolI, data.schoolMatch, 'schools', '學校', (data.schoolMatch || {}).county);
    }

    // match.id 有值就直接選起來;沒有就長出一顆「建立並綁定」,
    // 建立成功後把新選項插進下拉並選取。
    function bindOrCreate(select, match, apiPath, label, county) {
      const holder = select.parentNode;
      const old = holder.querySelector('.org-create');
      if (old) old.remove();
      if (!match || !match.name) return;
      if (match.id) { select.value = String(match.id); return; }

      select.value = '';
      const btn = el('button', { class: 'btn', type: 'button' }, `建立「${match.name}」並綁定`);
      const box = el('div', { class: 'org-create hint' }, [
        `找不到${label}「${match.name}」。`, btn,
      ]);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const body = county ? { name: match.name, county } : { name: match.name };
          const created = await Api.post(apiPath, body);
          const opt = el('option', { value: String(created.id) }, created.name);
          select.appendChild(opt);
          select.value = String(created.id);
          box.remove();
          showToast(`已建立${label}「${created.name}」`, 'success');
        } catch (e) { showToast(e.message, 'error'); btn.disabled = false; }
      });
      holder.appendChild(box);
    }

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
        if (isNew && awardFile) {
          // 有決標公告就走 multipart,讓後端在建檔的同一個請求裡歸檔。
          const fd = new FormData();
          Object.keys(body).forEach((k) => {
            // null 不 append:FormData 會把 null 變成字串 'null',後端的空值判斷就失效。
            if (body[k] != null) fd.append(k, body[k]);
          });
          fd.append('award_notice', awardFile);
          const created = await Api.upload('projects', fd);
          if (created.attachment_warning) showToast(created.attachment_warning, 'warn');
          else showToast('已儲存', 'success');
        } else if (isNew) {
          await Api.post('projects', body);
          showToast('已儲存', 'success');
        } else {
          await Api.put('projects/' + id, body);
          showToast('已儲存', 'success');
        }
        window.location.hash = '/projects';
      } catch (e) {
        // 後端硬擋會帶 fields;照後端訊息呈現,再把欄位名接在後面。
        const names = { project_no: '工程編號', name: '工程名稱', award_amount: '決標金額',
          school_id: '主辦機關', vendor_id: '承包廠商' };
        const suffix = e.fields && e.fields.length
          ? '：' + e.fields.map((f) => names[f] || f).join('、') : '';
        showToast(e.message + suffix, 'error');
      }
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
