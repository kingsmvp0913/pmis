/**
 * daily-logs.js — 施工日誌區塊(SP3)
 *
 * 獨立成一個檔案的理由同 contract-items.js:projects.js 已 46KB。
 * 對外只露出 DailyLogs.card(projectId)。
 *
 * ## 兩條路:讀取器(文字層)與掃描件(OCR 預填 + 逐格確認)
 *
 * 掃描件那條路的產出**是草稿不是答案**:OCR 的 dailyRows 層實測 62.8% 對、
 * 1.7% 會讀成另一個合法數字,而那 1.7% 值本身自洽、累計也自洽,39 條驗證
 * 一條都攔不住。所以畫面上有三件事不可省:①逐格可編輯 ②沒讀到的格子要
 * 一眼看得出來 ③送出前必須勾「已逐格核對紙本」。少任何一件,這條路就變成
 * 「把 OCR 的猜測直接寫進估驗計價」。
 */
const DailyLogs = (() => {
  const num = (n) => (n == null ? '—' : Number(n).toLocaleString());

  function card(projectId) {
    let files = [];
    let scanned = null;          // scan 回來的草稿(承辦人編輯的對象)

    // 可多選:明德那家的兩聯分在**兩個 PDF 檔**(第一聯有天氣與進度、第二聯有
    // 完整明細含單價金額),只送一個檔不是少了天氣就是少了單價,而 SP3 只會說
    // 「此格式不提供」然後放行——少東西不會有人發現。久木那種一案六份月檔同理。
    // `.xlsm` 也要收:橋頭/許厝那兩案的日誌本來就是 .xlsm(寶嶸,60 天/1980 列),
    // 漏了它承辦人在檔案選擇器裡根本看不到自己的檔。
    // `.docx` 是玉森那六案的第一聯(天氣/星期/實際進度/出工人數只在那裡)。
    const fileI = el('input', {
      class: 'form-control', type: 'file', multiple: true, accept: '.pdf,.xls,.xlsx,.xlsm,.docx',
    });
    const parseBtn = el('button', { class: 'btn', type: 'button' }, '驗證施工日誌');
    const scanBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '辨識掃描件');
    const confirmBtn = el('button', { class: 'btn btn-primary', type: 'button', style: 'display:none' },
      '確認並寫入監造報表');
    // 常駐 .xlsm 是 SP1/SP2/SP3 一路寫進去的同一份,不是「這次上傳」的產物,
    // 所以不隨驗證流程顯示/隱藏——承辦人任何時候都該拿得到目前的報表。
    const downloadBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '下載監造報表');
    // 承辦人手上做到一半的報表:上傳後由系統接著往下填,而**上傳當下已經有值的
    // 格子永遠不再被覆蓋**(以上傳那一刻為界,見 server/report-protect.js)。
    const reportFileI = el('input', {
      class: 'form-control', type: 'file', accept: '.xlsm', style: 'display:none',
    });
    const uploadBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '上傳既有報表');
    const uploadBox = el('div', { class: 'hint', style: 'display:none' });
    const err = el('div', { class: 'error-msg', style: 'display:none' });
    const summary = el('div', { class: 'hint', style: 'display:none' });
    const skipBox = el('div', { class: 'hint', style: 'display:none' });
    const listBox = el('div', { class: 'table-wrap' });
    const diffBox = el('div', { class: 'table-wrap' });
    const scanBox = el('div', {});
    const hint = el('div', { class: 'hint' },
      '上傳廠商提供的施工日誌,系統依 39 條規則檢查後才寫入監造報表。' +
      '有硬錯時整份不寫入——只寫沒問題的那幾天,累計金額與完成百分比會算出錯的數字卻看起來正常。' +
      '沒有文字層的掃描件按「辨識掃描件」,系統會用 OCR 預填讓你逐格核對。');

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

    // 職安衛管理費、營業稅這類費用項目沒有施工實體,施工日誌不會記,每日進度是
    // 系統依契約工期推算的。報表版面刻意不加註記(承辦人的決定),所以「哪幾列
    // 不是工地回報的數字」只剩這裡會講——不講的話報表上完全看不出來。
    function renderFeeNote(fee) {
      if (!fee) return;
      if (!fee.工期天數) {
        diffBox.appendChild(el('div', { class: 'hint' },
          '※ 尚未填竣工日期,職業安全衛生管理費等費用項目算不出每日進度,這幾列維持依施工日誌寫入。'
          + '在工程基本資料補上竣工日期後重新寫入即可。'));
        return;
      }
      if (!fee.項目 || !fee.項目.length) return;
      diffBox.appendChild(el('div', { class: 'hint' },
        `※ ${fee.項目.join('、')} 共 ${fee.項目.length} 項沒有施工實體,施工日誌不會記載,`
        + `每日進度由系統依契約工期 ${fee.工期天數} 天平均推算——不是工地回報的數字。`));
    }

    // 報表上的「預定進度」以前是承辦人依廠商的施工預定進度表逐格填的,系統沒有那份
    // 資料,改由範本公式依契約工期直線推算(與上面的費用項目同一套規則)。算出來的
    // 是一條直線,不是真的預定進度曲線——報表版面看不出差別,只有這裡會講。
    function renderPlanNote(fee) {
      if (!fee || !fee.工期天數) return;
      diffBox.appendChild(el('div', { class: 'hint' },
        `※ 報表的預定進度由系統依契約工期 ${fee.工期天數} 天直線推算`
        + `(每天 ${(100 / fee.工期天數).toFixed(2)}%),不是廠商施工預定進度表上的曲線。`));
    }

    // 後端收 upload.array('daily_log'),同一個欄名 append 多次即可
    const fd = () => { const f = new FormData(); for (const x of files) f.append('daily_log', x); return f; };

    // ── 掃描件:逐格確認 ──

    const 數值欄 = ['本日完成數量', '累計完成數量'];

    function clearScan() {
      scanned = null;
      scanBox.innerHTML = '';
    }

    /**
     * 一天一張表。數量欄是 input,改動直接寫回 scanned.days ——送出時送的就是
     * 這份物件,不另外收集,免得畫面上的值與送出的值有機會不一致。
     */
    function dayTable(day) {
      const rows = (day.dailyRows || []).map((r) => {
        const tds = [
          el('td', {}, String(r.項次 == null ? '—' : r.項次)),
          el('td', {}, String(r.工程項目 || r.名稱 || '')),
          el('td', {}, String(r.單位 || '')),
          el('td', {}, num(r.契約數量)),
        ];
        for (const f of 數值欄) {
          const 讀到 = r[f] != null && r[f] !== '';
          const input = el('input', {
            class: 'form-control cell-num',
            type: 'text',
            inputmode: 'decimal',
            value: 讀到 ? String(r[f]) : '',
            placeholder: 讀到 ? '' : '未讀到',
          });
          input.addEventListener('input', () => {
            r[f] = input.value.trim() === '' ? null : input.value.trim();
            input.classList.toggle('cell-missing', input.value.trim() === '');
            updateScanSummary();
          });
          if (!讀到) input.classList.add('cell-missing');
          tds.push(el('td', {}, input));
        }
        return el('tr', {}, tds);
      });
      return el('div', { class: 'scan-day' }, [
        el('div', { class: 'scan-day-title' },
          `${day.header && day.header.填報日期 ? day.header.填報日期 : '(無日期)'}`
          + `　${(day.header && day.header.天氣_上午) || ''}`),
        el('div', { class: 'table-wrap' }, el('table', { class: 'data' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { style: 'width:60px' }, '項次'),
            el('th', {}, '工程項目'),
            el('th', { style: 'width:60px' }, '單位'),
            el('th', { style: 'width:90px' }, '契約數量'),
            el('th', { style: 'width:120px' }, '本日完成數量'),
            el('th', { style: 'width:120px' }, '累計完成數量'),
          ])),
          el('tbody', {}, rows),
        ])),
      ]);
    }

    let scanCountBox = null;
    function updateScanSummary() {
      if (!scanned || !scanCountBox) return;
      let 有值 = 0;
      let 空 = 0;
      for (const d of scanned.days) {
        for (const r of d.dailyRows || []) {
          for (const f of 數值欄) {
            if (r[f] == null || r[f] === '') 空 += 1; else 有值 += 1;
          }
        }
      }
      scanCountBox.textContent = `共 ${scanned.days.length} 天,已有數字 ${有值} 格、還空著 ${空} 格。`;
    }

    function renderScan(d) {
      scanBox.innerHTML = '';
      if (!d.可預填) {
        // 讀取器整份認不出來(實測 8 份裡有 2 份)。這時涵蓋範圍是唯一還答得出來的
        // 東西——告訴承辦人這份涵蓋幾天要人工補,比丟一句「辨識失敗」有用。
        const cov = d.涵蓋範圍 || {};
        const 日期 = cov.日期 || [];
        // 天數用 scanCoverage 算好的 days,不要拿 日期.length 頂替——後者是
        // 「不重複日期的清單長度」,兩者現在相等純屬巧合,語意不同。
        scanBox.appendChild(el('div', { class: 'error-msg' },
          '這份掃描件的明細表格認不出來,無法預填' + (d.讀取器錯誤 ? `(${d.讀取器錯誤})` : '') + '。'));
        scanBox.appendChild(el('div', { class: 'hint' }, 日期.length
          ? `不過表頭讀得到:這份涵蓋 ${日期[0]} ~ ${日期[日期.length - 1]} 共 ${cov.days} 天`
            + (cov.缺日期頁 && cov.缺日期頁.length ? `(第 ${cov.缺日期頁.join('、')} 頁讀不到日期)` : '')
            + ',內容需要人工登打。'
          : '表頭日期也讀不到,請確認這份檔案是不是施工日誌。'));
        return;
      }

      scanned = { days: d.days };
      scanBox.appendChild(el('div', { class: 'error-msg' }, [
        '⚠️ 以下數字是 OCR 讀的,不是廠商填的。實測每 100 格約有 63 格讀對、'
        + '2 格會讀成「另一個看起來合法的數字」,而系統的 39 條檢查一條都攔不住那種錯'
        + '(值本身自洽、累計也自洽)。',
        el('strong', {}, '請對著紙本逐格核對'),
        '——這些數字會一路流進監造報表與估驗計價。',
      ]));
      scanCountBox = el('div', { class: 'hint' });
      scanBox.appendChild(scanCountBox);
      for (const day of d.days) scanBox.appendChild(dayTable(day));
      updateScanSummary();

      const chk = el('input', { type: 'checkbox', id: 'scan-confirm-chk' });
      const writeBtn = el('button', { class: 'btn btn-primary', type: 'button', disabled: 'disabled' },
        '確認並寫入監造報表');
      chk.addEventListener('change', () => {
        if (chk.checked) writeBtn.removeAttribute('disabled');
        else writeBtn.setAttribute('disabled', 'disabled');
      });
      writeBtn.addEventListener('click', async () => {
        err.style.display = 'none';
        writeBtn.disabled = true;
        writeBtn.textContent = '寫入中(Excel 需數秒)…';
        try {
          const f = fd();
          f.append('confirmed', 'true');
          f.append('days', JSON.stringify(scanned.days));
          const res = await Api.upload(`projects/${projectId}/daily-logs/confirm-scanned`, f);
          showToast(`已寫入 ${res.天數} 天、${res.筆數} 筆逐日資料(來源:OCR + 人工確認)`, 'success');
          clearScan();
          renderFeeNote(res.費用推算);
          renderPlanNote(res.費用推算);
        } catch (e) {
          showErr(e.message);
          // 硬錯要跟文字層那條路一樣列全,不然承辦人不知道哪一天卡住
          if (e.errors) renderFindings(e.errors, e.warnings || []);
        } finally {
          writeBtn.disabled = !chk.checked;
          writeBtn.textContent = '確認並寫入監造報表';
        }
      });
      scanBox.appendChild(el('div', { class: 'scan-actions' }, [
        el('label', { class: 'scan-check', for: 'scan-confirm-chk' },
          [chk, el('span', {}, '我已對著紙本逐格核對過上面的數字')]),
        writeBtn,
      ]));
    }

    scanBtn.addEventListener('click', async () => {
      err.style.display = 'none';
      summary.style.display = 'none';
      confirmBtn.style.display = 'none';
      listBox.innerHTML = '';
      diffBox.innerHTML = '';
      skipBox.style.display = 'none';
      clearScan();
      if (!fileI.files.length) { showErr('請先選擇施工日誌'); return; }
      files = [...fileI.files];
      scanBtn.disabled = true;
      scanBtn.textContent = '辨識中(每頁約數秒)…';
      try {
        const d = await Api.upload(`projects/${projectId}/daily-logs/scan`, fd());
        renderScan(d);
        if (d.可預填) {
          renderFindings(d.errors, d.warnings);
          renderSkipped(d.skipped);
        }
      } catch (e) {
        showErr(e.message);
      } finally {
        scanBtn.disabled = false;
        scanBtn.textContent = '辨識掃描件';
      }
    });

    parseBtn.addEventListener('click', async () => {
      err.style.display = 'none';
      summary.style.display = 'none';
      confirmBtn.style.display = 'none';
      listBox.innerHTML = '';
      diffBox.innerHTML = '';
      skipBox.style.display = 'none';
      clearScan();
      if (!fileI.files.length) { showErr('請先選擇施工日誌'); return; }
      files = [...fileI.files];
      parseBtn.disabled = true;
      parseBtn.textContent = '驗證中…';
      try {
        const d = await Api.upload(`projects/${projectId}/daily-logs/parse`, fd());
        const 範圍 = d.日期範圍 && d.日期範圍[0] ? `${d.日期範圍[0]} ~ ${d.日期範圍[1]}` : '';
        const 檔 = d.檔數 > 1 ? `${d.檔數} 個檔合併後` : '';
        // 同一天同一欄兩個檔給了不同的值 = 這兩份檔可能不是同一案。合併時保留
        // 先出現的,但一定要講——靜默挑一個會讓這件事永遠看不見。
        const 衝突 = (d.衝突 || []).length
          ? ` ⚠️ 兩個檔有 ${d.衝突.length} 處對不起來(如 ${d.衝突[0].日期} 的`
            + `${d.衝突[0].欄位}:「${d.衝突[0].值[0]}」vs「${d.衝突[0].值[1]}」),`
            + '已採先上傳的那份,請確認是否為同一案。'
          : '';
        summary.textContent = `${檔}共 ${d.天數} 天 ${範圍}:硬錯 ${d.errors.length} 項、`
          + `警告 ${d.warnings.length} 項。${衝突}`;
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
        renderFeeNote(r.費用推算);
        renderPlanNote(r.費用推算);
      } catch (e) {
        showErr(e.message);
      } finally {
        confirmBtn.disabled = false;
        confirmBtn.textContent = '確認並寫入監造報表';
      }
    });

    // 走隱藏的 file input:上傳既有報表是偶爾才做一次的動作,常駐一個檔案選擇框
    // 會跟「施工日誌檔案」那個混淆——承辦人把日誌傳進報表欄是很容易發生的事。
    uploadBtn.addEventListener('click', () => reportFileI.click());
    reportFileI.addEventListener('change', async () => {
      if (!reportFileI.files[0]) return;
      err.style.display = 'none';
      uploadBox.style.display = 'none';
      uploadBtn.disabled = true;
      uploadBtn.textContent = '上傳中…';
      try {
        const fd = new FormData();
        fd.append('report', reportFileI.files[0]);
        const r = await Api.upload(`projects/${projectId}/report/upload`, fd);
        const 分頁 = Object.entries(r.分頁 || {}).map(([k, n]) => `${k} ${n} 格`).join('、');
        uploadBox.textContent = `已接手這份報表:${r.保護格數} 個已填的格子會保留不動`
          + (分頁 ? `(${分頁})` : '')
          + '。之後系統只填空白的格子,你填過的內容不會被蓋掉。';
        uploadBox.style.display = '';
        if (r.warnings && r.warnings.length) showToast(r.warnings.join('；'), 'warn');
        else showToast('已接手既有報表', 'success');
      } catch (e) {
        // 版面不符時後端會回逐條 problems,那才是承辦人要看的——只顯示一句
        // 「版面不對」他無從修起。
        showErr(e.message + (e.problems && e.problems.length ? `\n・${e.problems.join('\n・')}` : ''));
        err.style.whiteSpace = 'pre-line';
      } finally {
        uploadBtn.disabled = false;
        uploadBtn.textContent = '上傳既有報表';
        reportFileI.value = '';
      }
    });

    downloadBtn.addEventListener('click', async () => {
      err.style.display = 'none';
      downloadBtn.disabled = true;
      try {
        await Api.download(`projects/${projectId}/report/download`);
      } catch (e) {
        // 尚未建立(409)的訊息本身就寫了該先做什麼,直接照顯示
        showErr(e.message);
      } finally {
        downloadBtn.disabled = false;
      }
    });

    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '施工日誌'),
      hint,
      el('div', { class: 'form-group' }, [el('label', {}, '施工日誌檔案(可多選:兩聯分開的檔、逐月的檔一次全選)'), fileI]),
      el('div', { class: 'form-actions' }, [parseBtn, scanBtn, confirmBtn, downloadBtn, uploadBtn]),
      reportFileI,
      uploadBox,
      err,
      summary,
      skipBox,
      diffBox,
      scanBox,
      listBox,
    ]);
  }

  return { card };
})();
