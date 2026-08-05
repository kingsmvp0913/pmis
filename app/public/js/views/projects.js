// projects.js — 工程 view:list + 搜尋 + 編輯(全欄位;險種連動、設計費切換與即時計算)+ 歷史檔案/繳交狀態
(function () {
  const el = PmisApp.el;

  const STATUS_LABEL = { submitted: '已繳', overdue: '未繳', pending: '未到期' };

  // ⋮ 下拉選單:目前開著的那顆(全域最多一顆)。.table-wrap 是 overflow-x:auto,
  // 依 CSS Overflow 規範另一軸沒設就會被算成 auto,等於雙軸捲動容器,
  // absolute 定位的選單包含塊被它裁掉(實測列表最後一列選單只剩 11px 可見)。
  // 改用:開啟時把選單搬到 document.body、position:fixed 依按鈕的
  // viewport 座標定位,跳出這層裁切邊界;關閉時直接從 DOM 移除(不留殘影,
  // 也不用另外管 display)。
  // 監聽器掛在 document 而非某個 view 節點上,故只能在 IIFE 頂層註冊一次
  // (整支檔案只執行一次)——若放進 renderList,每次進出 #/projects 都會
  // 多掛一個,越滾越多。
  let openMoreMenu = null;
  function closeMoreMenu() {
    if (openMoreMenu) { openMoreMenu.remove(); openMoreMenu = null; }
  }
  document.addEventListener('click', closeMoreMenu);
  // scroll 事件不冒泡,用 capture 監聽 document 才能連 .table-wrap 內部捲動也接到。
  // 捲動時選單位置沒跟著算會飄掉,直接關閉最簡單也不會有殘影。
  document.addEventListener('scroll', closeMoreMenu, true);
  // 下拉選單基本慣例:Escape 也要能關閉(先前只有點畫面其他地方會關)。
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeMoreMenu(); });
  // 選單開啟時會 appendChild 到 document.body,脫離 app.js 的 renderShell()
  // 用 root.innerHTML = '' 清空的範圍——換頁(#/projects → #/projects/3/basics)
  // 若不主動清,選單會孤兒殘留在 body 上、position:fixed 浮在新頁面之上。
  // 選在這裡監聽 hashchange(而非讓 app.js 的 route() 認識 projects.js 的
  // closeMoreMenu)是因為:選單是 projects.js 私有的實作細節,由它自己
  // 負責清理自己掛在 body 上的東西,app.js 不需要、也不該知道有這顆選單存在。
  window.addEventListener('hashchange', closeMoreMenu);

  // ── 登錄繳交彈窗:選 督導/每月 + 週期 + 上傳施工日誌 ──
  // 這裡**只登錄繳交**。產監造報表已於 2026-08-05 收斂到工程頁的施工日誌區塊,
  // 那條路徑會跑 39 條驗證再寫進常駐 .xlsm;兩顆按鈕並存時承辦人看不出差別,
  // 按到舊的就產出一份沒驗證過的報表。
  function submissionDialog(defaultPeriod) {
    return new Promise((resolve) => {
      const typeSel = el('select', { class: 'form-control' }, [
        el('option', { value: 'monthly' }, '每月'),
        el('option', { value: 'supervision' }, '督導')
      ]);
      const periodI = el('input', { class: 'form-control', type: 'month', value: defaultPeriod || '' });
      const fileI = el('input', { class: 'form-control', type: 'file' });
      const errBox = el('div', { class: 'error-msg', style: 'display:none' });

      // 關閉路徑有四條(送出、取消鈕、Escape、點 overlay)。一律由 modalDialog
      // 的 onClose 收斂成一次 resolve,四條各自 resolve 會漏掉後兩條——
      // 使用者按 Escape 放棄操作時,那個 Promise 會永遠擱置。
      let result = null;
      function submit() {
        const period = periodI.value.trim();
        if (!/^\d{4}-\d{2}$/.test(period)) { errBox.textContent = '請選擇週期(年月)'; errBox.style.display = ''; return; }
        if (!fileI.files || !fileI.files[0]) { errBox.textContent = '請選擇施工日誌檔'; errBox.style.display = ''; return; }
        result = { type: typeSel.value, period, file: fileI.files[0] };
        dlg.close();
      }

      const body = el('div', {}, [
        errBox,
        el('div', { class: 'form-group' }, [el('label', {}, '類型'), typeSel]),
        el('div', { class: 'form-group' }, [el('label', {}, '週期'), periodI]),
        el('div', { class: 'form-group' }, [el('label', {}, '施工日誌檔'), fileI]),
        el('div', { class: 'modal-actions' }, [
          el('button', { class: 'btn btn-outline', onClick: () => dlg.close() }, '取消'),
          el('button', { class: 'btn btn-primary', onClick: submit }, '送出')
        ])
      ]);
      const dlg = modalDialog({
        title: '登錄繳交(上傳施工日誌)', content: body,
        onClose: () => resolve(result),
      });
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

    // 頁籤只用於既有工程。新增工程時只有決標公告 + 基本資料兩塊,分頁只是多一次點擊。
    //
    // **一次全建、切換只改 display**:開工報告表解析後會直接改寫「監造報表基本資料」
    // 的工期/開工日,惰性建構會讓那些 DOM 還不存在時就被寫入;切回去若重建,
    // 承辦人未儲存的編輯也會被清掉。全建等於「現狀 + 分堆隱藏」,既有引用完全不動。
    const TABS = [
      { key: 'basics', label: '基本資料' },
      { key: 'kickoff', label: '開工報告表' },
      { key: 'items', label: '契約價目表' },
      { key: 'logs', label: '施工日誌' },
      { key: 'files', label: '附件' },
    ];
    const panes = {};
    const tabBtns = {};
    let tabBar = null;

    function showTab(key) {
      const k = panes[key] ? key : TABS[0].key;
      for (const t of TABS) {
        panes[t.key].style.display = t.key === k ? '' : 'none';
        tabBtns[t.key].className = 'tab' + (t.key === k ? ' active' : '');
      }
      // 看過就把小圓點收掉
      const dot = tabBtns[k].querySelector('.dot');
      if (dot) dot.remove();
      // 網址同步,但**不觸發重建**:路由只讀第二段當 id,第三段在這裡自行解析。
      const target = '/projects/' + id + '/' + k;
      if (window.location.hash.replace(/^#/, '') !== target) {
        history.replaceState(null, '', '#' + target);
      }
    }

    // 在「基本資料」頁籤標籤上點一個小圓點(解析開工報告表改到了那頁的欄位時)
    function markTab(key) {
      const btn = tabBtns[key];
      if (!btn || btn.classList.contains('active') || btn.querySelector('.dot')) return;
      btn.appendChild(el('span', { class: 'dot' }));
    }

    if (!isNew) {
      tabBar = el('div', { class: 'tabs' });
      for (const t of TABS) {
        panes[t.key] = el('div', { style: 'display:none' });
        const btn = el('button', { class: 'tab', type: 'button', onClick: () => showTab(t.key) }, t.label);
        tabBtns[t.key] = btn;
        tabBar.appendChild(btn);
      }
    }

    // 既有工程把區塊放進對應頁籤;新增工程維持直接往 content 疊。
    const into = (key) => (isNew ? content : panes[key]);

    // 決標公告區塊只在新增模式出現:既有工程要重新裁決仍走原本的逐欄比對流程。
    // 沿用 vendors.js:172 的 if (!isNew) 分岔慣例。
    let awardFile = null;
    if (isNew) {
      const fileI = el('input', { class: 'form-control', type: 'file', accept: '.pdf' });
      const parseBtn = el('button', { class: 'btn', type: 'button' }, '解析決標公告');
      const awardMsg = el('div', { class: 'hint' },
        '決標公告為必要:工程一律由決標公告建立,解析後會自動帶入工程名稱、編號、金額、' +
        '主辦機關與承包廠商。沒有決標公告的工程無法核對開工報告表。');
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
    into('basics').appendChild(card);

    // 寫監造報表要開 Excel COM、可能重試失敗,比一般存檔重得多。
    // 故必須是獨立按鈕——否則改個保險到期日也會去開一次 Excel。
    if (!isNew) {
      const 工期I = el('input', { class: 'form-control', type: 'number', step: '1', min: '1' });
      // 「開工日」不再自建:原本這裡與「工程基本資料」的 startI 是兩個外觀相同、
      // 值卻可能不同步的欄位(開工報告表解析只同步到這格,startI 依然是空的,
      // 承辦人按「儲存」時 start_date 照樣送 null)。合併後一律用 startI。
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
            開工日期: startI.value, 工程編號: noI.value.trim(),
          };
          const r = await Api.post('projects/' + id + '/basics', { values });
          // 這支已經把範本算出的完工期限寫進 DB 了。主表單的契約竣工日若還停在舊值,
          // 承辦人接著按「儲存」時 PUT 會用陳舊值覆蓋回去,靜默抹掉剛算出的完工期限——
          // 所以寫入成功後必須把畫面同步到 DB 現況。開工日不必再同步:開工日期欄位
          // 已合併成 startI 本身,值本來就是同一格,沒有「另一格」需要跟著更新。
          if (r.完工期限) contractI.value = String(r.完工期限).slice(0, 10);
          showToast(`已寫入監造報表,完工期限 ${r.完工期限 || '—'}`, 'success');
        } catch (e) {
          const suffix = e.fields && e.fields.length ? '：' + e.fields.join('、') : '';
          basicsErr.textContent = e.message + suffix;
          basicsErr.style.display = '';
        } finally { writeBtn.disabled = false; }
      });

      into('basics').appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, '監造報表基本資料'),
        el('div', { class: 'hint', style: 'margin-top:0' },
          '契約工期須對照開工報告表填寫,系統不會自動帶入;開工日與「工程基本資料」' +
          '的「開工日」是同一欄。完工期限由範本公式算出。'),
        el('div', { class: 'form-group' }, [el('label', {}, '監造單位'), supI]),
        el('div', { class: 'form-group' }, [el('label', {}, '設計單位'), desI]),
        el('div', { class: 'form-group' }, [el('label', {}, '契約工期(日曆天)'), 工期I]),
        el('div', { class: 'form-actions' }, [writeBtn]),
        basicsErr,
      ]));

      // 開工報告表(SP1B 階段二)。已抽成 views/kickoff-report.js,讓這裡的頁籤
      // 與工程列表頁的彈窗共用同一份——兩邊各寫一份的話,比對表的編輯同步規則
      // 遲早漂成兩套行為。
      // 開工日改傳「工程基本資料」的 startI(2026-08-05 合併重複欄位):原本自建
      // 的「監造報表基本資料」開工日期已拿掉,歸檔同步的對象改成 startI,這樣
      // 「儲存」送出的 start_date 才會是開工報告表核對過的值,不再是 null。
      // 工期I 維持自建:「工程基本資料」沒有這個欄位,沒有可合併的對象。
      into('kickoff').appendChild(KickoffReport.card(id, {
        durationInput: 工期I,
        startDateInput: startI,
        onArchived: () => loadAttachments(),
        onSynced: () => markTab('basics'),
      }));

      // 流程狀態列:8 個區塊的順序就是承辦流程,但承辦人得捲到底才知道走到哪,
      // 而各區塊的前置條件又是按下去才知道。這一列先講清楚下一步該做什麼。
      const wfBox = el('div', {});
      (async () => {
        try {
          const [st, atts] = await Promise.all([
            Api.get('projects/' + id + '/workflow-status'),
            Api.get('projects/' + id + '/attachments'),
          ]);
          wfBox.innerHTML = '';
          wfBox.appendChild(WorkflowStatus.bar(p, atts, st.contractItems, st.logDays));
        } catch { /* 狀態列讀不到不該擋住整頁 */ }
      })();

      // 契約詳細價目表(SP2)。整塊流程獨立在 views/contract-items.js——
      // 本檔已 46KB,再塞一段多檔上傳→挑表→差異確認→寫入只會讓兩邊都難改。
      into('items').appendChild(ContractItems.card(id));

      // 施工日誌(SP3)。同樣獨立成檔,理由見上。
      into('logs').appendChild(DailyLogs.card(id));

      const attBox = el('div', { class: 'table-wrap' });
      const attCard = el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, '附件'),
        attBox,
      ]);
      into('files').appendChild(attCard);

      const KIND_LABEL = {
        award_notice: '決標公告', kickoff_report: '開工報告表', budget_sheet: '發包經費總表', daily_log: '施工日誌',
      };

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

      // content 上只有這三件事,順序即畫面由上而下。
      // 流程進度列常駐在頁籤**上方**:它是唯一會講「下一步該做什麼」的區塊,
      // 放進頁籤內容裡等於要承辦人先選對頁籤才看得到,本末倒置。
      content.appendChild(wfBox);
      content.appendChild(tabBar);
      for (const t of TABS) content.appendChild(panes[t.key]);

      // 網址第三段決定預設頁籤;沒有或不認得就回第一頁。
      const wanted = (window.location.hash.replace(/^#/, '').split('/')[3] || '').trim();
      showTab(wanted);
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
      bindOrCreate(vendorI, data.vendorMatch, 'vendors', '廠商');
      bindOrCreate(schoolI, data.schoolMatch, 'schools', '學校');
    }

    // 決標公告帶回來的聯絡人。廠商側只有電話、沒有姓名(公告上就沒有這個欄位),
    // 故兩者任一有值就成立,不能要求姓名必填。
    function contactPayload(match) {
      const c = (match && match.contact) || {};
      const name = (c.name || '').trim();
      const phone = (c.phone || '').trim();
      if (!name && !phone) return null;
      return { name: name || null, phone: phone || null, is_primary: true };
    }

    // match.id 有值就直接選起來,並補上公告帶來的聯絡人/地址(只補空缺);
    // 沒有就長出一顆「建立並綁定」,建立時一併寫入聯絡人與地址。
    function bindOrCreate(select, match, apiPath, label) {
      const holder = select.parentNode;
      const old = holder.querySelector('.org-create');
      if (old) old.remove();
      if (!match || !match.name) return;

      const contact = contactPayload(match);
      const address = (match.address || '').trim() || null;

      if (match.id) {
        select.value = String(match.id);
        seedExisting(match.id, apiPath, label, contact, address);
        return;
      }

      select.value = '';
      const btn = el('button', { class: 'btn', type: 'button' }, `建立「${match.name}」並綁定`);
      const box = el('div', { class: 'org-create hint' }, [
        `找不到${label}「${match.name}」。`, btn,
      ]);
      btn.addEventListener('click', async () => {
        btn.disabled = true;
        try {
          const body = { name: match.name };
          if (match.county) body.county = match.county;
          if (address) body.address = address;
          if (contact) body.contacts = [contact];
          const created = await Api.post(apiPath, body);
          const opt = el('option', { value: String(created.id) }, created.name);
          select.appendChild(opt);
          select.value = String(created.id);
          box.remove();
          showToast(`已建立${label}「${created.name}」${contact ? '(含聯絡人)' : ''}`, 'success');
        } catch (e) { showToast(e.message, 'error'); btn.disabled = false; }
      });
      holder.appendChild(box);
    }

    // 既有學校/廠商:只補「一筆聯絡人都沒有」與「地址是空的」這兩種空缺,
    // 承辦人維護過的值一律不動(公告是決標當下的快照,可能已經過時)。
    // 補不成不該打斷建檔流程,故只提示不 throw;但也不靜默吞掉。
    async function seedExisting(id, apiPath, label, contact, address) {
      if (!contact && !address) return;
      try {
        const body = {};
        if (contact) body.contact = contact;
        if (address) body.address = address;
        const r = await Api.post(`${apiPath}/${id}/seed`, body);
        const done = [];
        if (r.seeded && r.seeded.contact) done.push('聯絡人');
        if (r.seeded && r.seeded.address) done.push('地址');
        if (done.length) showToast(`已為既有${label}補上${done.join('與')}`, 'success');
      } catch (e) {
        showToast(`${label}聯絡人補寫失敗:${e.message}`, 'warn');
      }
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
      // 建案入口只剩決標公告一條。擋在送出前而不是讓後端回 400:承辦人已經填完
      // 一整份表單,到那時才被退回等於白填。
      if (isNew && !awardFile) {
        showToast('請先上傳並解析決標公告,工程一律由決標公告建立', 'warn');
        return;
      }
      try {
        if (isNew) {
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
          el('th', { style: 'width:300px' }, '流程'),
          el('th', { style: 'width:50px' }, '')
        ])]),
        tbody
      ])
    ]));

    let timer;
    search.addEventListener('input', () => { clearTimeout(timer); timer = setTimeout(load, 250); });

    // 流程關卡。判定與 WorkflowStatus.bar 同一套語意(附件種類、契約項目數、
    // 日誌天數),不重寫一份規則——真正的把關仍在各自的後端路由。
    // 「前置未完成」的按鈕 disabled:按了也只會被後端擋下,不如先講清楚缺什麼。
    function flowSteps(p) {
      return [
        { key: 'kickoff', 名: '開工表', 好: !!p.has_kickoff, 缺: '需先建立工程(上傳決標公告)' },
        { key: 'items', 名: '價目表', 好: (p.contract_items || 0) > 0, 缺: '需先有決標金額,再上傳發包經費總表' },
        // 日誌這一關的前置條件不只是「前面幾關都好」:後端 daily-log-routes.js
        // 會擋沒有 start_date 的工程(NO_START)。has_kickoff 只代表有上傳附件,
        // 不代表比對表裡的開工日已確認寫回 projects.start_date——兩者可能不同步,
        // 故用 額外前置 另外檢查,不能只看前面關卡的 好。
        { key: 'logs', 名: '日誌', 好: (p.log_days || 0) > 0, 額外前置: !p.start_date, 缺: '需先建立契約詳細價目表與開工日期' },
        { key: 'submit', 名: '繳交', 好: false, 缺: '需先寫入施工日誌' },
      ];
    }

    // 開對應彈窗。四種都在彈窗內走完整流程,故一律 wide;完成後重載列表
    // 讓狀態標記更新(純關閉不重載——什麼都沒做就不必打 API)。
    function openFlow(p, key) {
      if (key === 'submit') { generate(p, null); return; }
      const title = { kickoff: '開工報告表', items: '契約詳細價目表', logs: '施工日誌' }[key];
      let changed = false;
      const done = () => { changed = true; };
      const body = key === 'kickoff'
        ? KickoffReport.card(p.id, { onArchived: done })
        : (key === 'items' ? ContractItems.card(p.id) : DailyLogs.card(p.id));
      // 重載邏輯放 onClose、不是「關閉」鈕的 onClick:modalDialog 有三條關閉路徑
      // (Escape、點 overlay、呼叫 close()),塞在按鈕上只堵得住第三條——比照
      // submissionDialog 已經在用的模式,把重載收斂到 onClose 統一處理。
      const dlg = modalDialog({
        title: `${title}—${p.name}`, content: body, wide: true,
        onClose: () => { if (changed || key !== 'kickoff') load(); },
      });
      const closeBtn = el('button', { class: 'btn btn-outline', onClick: () => dlg.close() }, '關閉');
      // 三個元件(KickoffReport/ContractItems/DailyLogs)各自的按鈕列都是
      // .form-actions(全站通用 class,不必為了彈窗另外改元件內部)。找最後一個
      // 是防同一個元件裡有多列 .form-actions(目前都只有一列,但比只認第一個
      // 更保險);把「關閉」插到最前面,跟元件自己的按鈕收在同一排、同一種
      // 右對齊。真的找不到(理論上不會發生)才退回舊的「另外附加一列」。
      const rows = body.querySelectorAll ? body.querySelectorAll('.form-actions') : [];
      const actionsRow = rows.length ? rows[rows.length - 1] : null;
      if (actionsRow) {
        actionsRow.insertBefore(closeBtn, actionsRow.firstChild);
      } else {
        body.appendChild(el('div', { class: 'modal-actions' }, [closeBtn]));
      }
    }

    async function load() {
      // 開著的 ⋮ 選單已搬到 document.body(不在即將清空的 tbody 底下)。
      // 打字期間(debounce 未觸發)點開某列選單、debounce 觸發整表重繪的話,
      // 選單會孤兒掛在 body 上、位置停在舊列座標,且閉包指向已被丟棄的
      // panelRow——先關掉,重繪後要開哪列再重新點開。
      closeMoreMenu();
      const q = search.value.trim();
      let rows;
      try { rows = await Api.get('projects' + (q ? '?q=' + encodeURIComponent(q) : '')); }
      catch (e) { showToast(e.message, 'error'); return; }
      tbody.innerHTML = '';
      if (!rows.length) {
        tbody.appendChild(el('tr', {}, [el('td', { class: 'empty-row', colspan: '5' }, '沒有資料')]));
        return;
      }
      for (const p of rows) {
        let feeText;
        if (p.design_fee_unbid) feeText = '未招標,待補';
        else if (p.design_fee_actual != null) feeText = Number(p.design_fee_actual).toLocaleString() + ' 元';
        else feeText = '—';
        const panelCell = el('td', { colspan: '5', style: 'padding:0' });
        const panelRow = el('tr', { style: 'display:none' }, [panelCell]);

        const steps = flowSteps(p);
        // 第一個未完成的關卡就是「下一步」;它之前若還有未完成的,後面按了
        // 也只會被後端擋下,故 disabled 並在 title 說明缺什麼。
        const next = steps.find((s) => !s.好);
        const flowCell = el('div', { class: 'flow-btns' }, steps.map((s, i) => {
          const 前置未完成 = steps.slice(0, i).some((x) => !x.好) || !!s.額外前置;
          const btn = el('button', {
            class: 'btn' + (s.好 ? ' btn-outline done' : (s === next ? ' btn-primary' : ' btn-outline')),
            type: 'button',
            title: 前置未完成 ? s.缺 : '',
            onClick: () => openFlow(p, s.key),
          }, (s.好 ? '✓' : (s === next ? '●' : '')) + s.名);
          if (前置未完成) btn.disabled = true;
          return btn;
        }));

        // 歷史/詳細/刪除收進「⋮」:一列已經有四顆流程按鈕,七顆並排會擠爆。
        // menu 平時不掛在任何父節點上,只在 moreBtn 開啟時 appendChild 到
        // document.body(見檔案頂端 openMoreMenu 的說明);三個項目一律先
        // closeMoreMenu() 再動作,避免「詳細」跳頁後選單還孤兒掛在 body 上。
        // CSS 已把 .more-menu 設為預設 display:none(開啟時 JS 另外設 display:block)——
        // 不能靠這裡的 inline style 補,inline 容易在下次重構時再被弄丟一次,
        // 而這個缺陷的症狀是整頁破版(每列三顆按鈕一開始就全部顯示)。
        const menu = el('div', { class: 'more-menu' }, [
          el('button', { type: 'button', onClick: () => { closeMoreMenu(); toggleHistory(p, panelRow); } }, '歷史'),
          el('button', { type: 'button', onClick: () => { closeMoreMenu(); window.location.hash = '/projects/' + p.id; } }, '詳細'),
          el('button', { class: 'danger', type: 'button', onClick: () => { closeMoreMenu(); remove(p); } }, '刪除'),
        ]);
        const moreBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '⋮');
        moreBtn.addEventListener('click', (e) => {
          e.stopPropagation(); // 擋掉冒泡到 document 的 closeMoreMenu,否則剛開就被自己關掉
          const wasOpen = openMoreMenu === menu;
          closeMoreMenu(); // 先關掉別列已開的選單,否則會同時開好幾個
          if (wasOpen) return; // 這顆本來就開著 → 這次點擊是要收合,關掉就好
          const r = moreBtn.getBoundingClientRect();
          menu.style.position = 'fixed';
          menu.style.top = (r.bottom + 4) + 'px';
          menu.style.right = (window.innerWidth - r.right) + 'px';
          menu.style.display = 'block'; // 覆蓋 CSS 的預設 display:none
          document.body.appendChild(menu);
          openMoreMenu = menu;
        });

        const tr = el('tr', {}, [
          el('td', {}, p.project_no || '—'),
          el('td', {}, p.name),
          el('td', {}, feeText),
          el('td', { class: 'actions' }, [
            flowCell,
          ]),
          el('td', { class: 'actions' }, [
            el('div', { class: 'more-wrap' }, [moreBtn, menu]),
          ]),
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

    // 繳交狀態格 + 紀錄列 + 登錄繳交
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
        el('button', { class: 'btn btn-primary', onClick: () => generate(p, cell) }, '＋ 登錄繳交')
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
        await Api.upload('projects/' + p.id + '/submissions', fd);
        // 這裡只登錄繳交。報表在工程頁的「施工日誌」區塊產,那條路徑會先跑 39 條
        // 驗證——訊息要講清楚去哪產,否則承辦人會以為按完這裡報表就有了。
        showToast('已登錄繳交。要產監造報表請至工程頁的「施工日誌」區塊', 'success');
        if (cell) await renderHistory(p, cell);
        else load();
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
