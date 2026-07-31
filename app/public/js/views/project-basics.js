// project-basics.js — 工程基本資料 view
// 流程:選工程 → 上傳決標公告 → 逐欄裁決差異 → 補人工欄位 → 一次寫入監造報表。
// 後端硬擋是「9 值全過才落檔」,所以畫面也只有一顆送出鍵,不做逐欄暫存。
(function () {
  const el = PmisApp.el;

  // 決標公告推不出契約工期與開工日期(公告上的履約起日只是預估),一律由承辦人
  // 對照開工報告表填。這兩欄與監造/設計單位都不進比對表,避免承辦人以為系統會自動帶。
  const STATE = {
    match: { text: '一致', cls: 'status-pill submitted' },
    diff: { text: '不一致', cls: 'status-pill overdue' },
    missing: { text: '缺值', cls: 'status-pill pending' },
  };

  // 送出前轉數值的欄位:報表儲存格與主檔欄位都是數值型,送字串會讓 B7 變文字而
  // 影響 B9 的 =B8+B7-1。轉不成有限數(如帶千分位)就原樣送,由後端回報格式不正確。
  const NUMERIC = ['契約金額', '契約工期'];

  async function render(content) {
    content.appendChild(el('div', { class: 'page-title' }, '工程基本資料'));

    const errBox = el('div', { class: 'error-msg', style: 'display:none' });
    const showErr = (msg) => { errBox.textContent = msg; errBox.style.display = ''; };
    const clearErr = () => { errBox.style.display = 'none'; };

    let projects = [];
    try { projects = await Api.get('projects'); }
    catch (e) { showErr('無法讀取工程清單:' + e.message); }

    const projSel = el('select', { class: 'form-control' },
      [el('option', { value: '' }, '請選擇工程')].concat(
        (projects || []).map((p) => el('option', { value: String(p.id) }, p.name))
      ));
    const fileInput = el('input', { class: 'form-control', type: 'file', accept: '.pdf' });
    const analyzeBtn = el('button', { class: 'btn btn-primary', type: 'button',
      onClick: () => analyze() }, '解析並比對');
    const resultBox = el('div', {});

    // 裁決結果綁定的是解析當下凍結的工程,與下拉當前選擇是兩回事。放著不管的話,
    // 「解析 A → 改選 B → 填 B 的工期開工日 → 送出」會把 B 的資料靜默寫進 A 的報表與主檔,
    // 畫面上卻顯示 B,承辦人完全看不出來。故一改選就作廢結果區,強制重新解析。
    projSel.addEventListener('change', () => {
      clearErr();
      resultBox.innerHTML = '';
    });

    async function analyze() {
      clearErr();
      resultBox.innerHTML = '';
      if (!projSel.value) { showErr('請先選擇工程'); return; }
      if (!fileInput.files || !fileInput.files[0]) { showErr('請選擇決標公告 PDF'); return; }
      const fd = new FormData();
      fd.append('award_notice', fileInput.files[0]);
      analyzeBtn.disabled = true;
      try {
        // 解析當下的工程要凍結:送出時一律用這一個,不吃下拉的當前值。
        // 名稱一併凍結並顯示在裁決區與送出鍵上——即使日後 change 監聽被拿掉,
        // 承辦人仍看得到自己正在寫哪一個工程。
        const projectId = projSel.value;
        const projectName = projSel.options[projSel.selectedIndex].textContent;
        const data = await Api.upload(`projects/${projectId}/award-notice`, fd);
        renderDecision(projectId, projectName, data);
      } catch (e) {
        showErr(e.message);
      } finally {
        analyzeBtn.disabled = false;
      }
    }

    function renderDecision(projectId, projectName, data) {
      const inputs = {};

      // ── 可比對的 5 欄:兩邊的值並陳,採用值預設帶決標公告(權威來源)──
      const rows = (data.diffs || []).map((d) => {
        const preset = d.狀態 === 'missing' && d.決標公告值 == null ? d.主檔值 : d.決標公告值;
        const input = el('input', {
          class: 'form-control', type: 'text',
          value: preset == null ? '' : String(preset),
        });
        inputs[d.欄位] = input;
        const st = STATE[d.狀態] || { text: d.狀態, cls: 'status-pill pending' };
        return el('tr', {}, [
          el('td', {}, d.欄位),
          el('td', {}, d.決標公告值 == null ? '—' : String(d.決標公告值)),
          el('td', {}, d.主檔值 == null ? '—' : String(d.主檔值)),
          el('td', {}, [el('span', { class: st.cls }, st.text)]),
          el('td', {}, [input]),
        ]);
      });

      const firms = data.firms || {};
      const supI = el('input', { class: 'form-control', type: 'text',
        value: firms.supervisor_firm || '' });
      const desI = el('input', { class: 'form-control', type: 'text',
        value: firms.designer_firm || '' });
      const 工期I = el('input', { class: 'form-control', type: 'number', min: '1', step: '1' });
      // date input 產出的就是 YYYY-MM-DD,與後端 isoToExcelSerial 期望一致,直接送。
      const 開工I = el('input', { class: 'form-control', type: 'date' });
      inputs.監造單位 = supI;
      inputs.設計單位 = desI;
      inputs.契約工期 = 工期I;
      inputs.開工日期 = 開工I;

      const submitErr = el('div', { class: 'error-msg', style: 'display:none' });
      const submitBtn = el('button', { class: 'btn btn-primary', type: 'button',
        onClick: () => submit() }, `寫入「${projectName}」的監造報表`);

      async function submit() {
        submitErr.style.display = 'none';
        const values = {};
        for (const 欄位 of Object.keys(inputs)) {
          const raw = String(inputs[欄位].value).trim();
          values[欄位] = (NUMERIC.indexOf(欄位) >= 0 && raw !== '' && Number.isFinite(Number(raw)))
            ? Number(raw) : raw;
        }
        submitBtn.disabled = true;
        try {
          const res = await Api.post(`projects/${projectId}/basics`, { values });
          showToast(`已寫入「${projectName}」的監造報表,完工期限 ${res.完工期限 || '—'}`, 'success');
          // 成功後不解除 disabled:這批值已經落檔,再按一次沒有新語意。
          // 要改就重新解析,免得承辦人以為「沒反應」而反覆點擊。
          submitBtn.textContent = `已寫入「${projectName}」`;
        } catch (e) {
          // 後端硬擋會一次列全「未填或格式不正確」的欄位,兩種情形共用同一份 fields,
          // 所以文案不能寫死成「未填」——照後端訊息呈現,再把欄位名接在後面。
          submitErr.textContent = (e.fields && e.fields.length)
            ? `${e.message}:${e.fields.join('、')}`
            : e.message;
          submitErr.style.display = '';
          submitBtn.disabled = false; // 只有失敗才放行,讓承辦人改完重送
        }
      }

      resultBox.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, `逐欄裁決:${projectName}`),
        el('div', { class: 'hint', style: 'margin-top:0' },
          '決標公告 vs 系統主檔;決標公告是權威基準,採用值預設帶公告值,確認無誤或改寫後再送出。'),
        el('div', { class: 'table-wrap' }, [
          el('table', { class: 'data' }, [
            el('thead', {}, [el('tr', {}, [
              el('th', {}, '欄位'), el('th', {}, '決標公告'), el('th', {}, '系統主檔'),
              el('th', {}, '比對'), el('th', {}, '採用值'),
            ])]),
            el('tbody', {}, rows),
          ]),
        ]),
      ]));

      resultBox.appendChild(el('div', { class: 'card' }, [
        el('div', { class: 'card-title' }, '決標公告沒有的欄位'),
        el('div', { class: 'hint', style: 'margin-top:0' },
          '監造單位與設計單位預設帶入系統設定(該工程若已另行指定則以工程為準),兩欄皆可直接覆寫。'),
        el('div', { class: 'form-group' }, [el('label', {}, '監造單位'), supI]),
        el('div', { class: 'form-group' }, [el('label', {}, '設計單位'), desI]),
        el('div', { class: 'form-group' }, [
          el('label', {}, '契約工期(日曆天)'), 工期I,
          el('div', { class: 'hint' }, '決標公告推不出契約工期,須對照開工報告表填寫。'),
        ]),
        el('div', { class: 'form-group' }, [
          el('label', {}, '開工日期'), 開工I,
          el('div', { class: 'hint' },
            '決標公告上的履約起日只是預估,須對照開工報告表填寫實際開工日期。完工期限由報表公式自動算出。'),
        ]),
        submitErr,
        el('div', { class: 'form-actions' }, [submitBtn]),
      ]));
    }

    content.appendChild(el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '上傳決標公告'),
      errBox,
      el('div', { class: 'form-group' }, [el('label', {}, '工程'), projSel]),
      el('div', { class: 'form-group' }, [
        el('label', {}, '決標公告 PDF'), fileInput,
        el('div', { class: 'hint' }, '需為可讀取文字的 PDF;掃描件無法解析,系統會明確告知。'),
      ]),
      el('div', { class: 'form-actions' }, [analyzeBtn]),
    ]));
    content.appendChild(resultBox);
  }

  PmisApp.registerRoute('#/basics', (content) => render(content));
})();
