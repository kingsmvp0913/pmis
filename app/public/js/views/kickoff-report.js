/**
 * kickoff-report.js — 開工報告表區塊(上傳 → OCR 預填 → 九欄比對 → 歸檔)
 *
 * 從 projects.js 抽出,讓工程詳細頁的頁籤與工程列表頁的彈窗**共用同一份**。
 * 兩邊各寫一份的話,比對表的編輯同步規則遲早漂成兩套行為。
 *
 * 契約工期與開工日有兩種來源,由 opts 決定:
 *   詳細頁 → 傳入「監造報表基本資料」既有的兩個 input,行為與抽出前完全相同
 *            (含「confirm 以該欄為準」與「工作天不預填」的既有語意)
 *   彈窗   → 不傳,元件在比對表下方自建這兩欄
 * confirm 走的是同一段程式碼,差別只在欄位從哪來。
 *
 * Exports: KickoffReport.card(projectId, opts) → HTMLElement
 */
const KickoffReport = (() => {
  const el = PmisApp.el;

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

  function card(projectId, opts = {}) {
    // OCR 只作預填不作裁決:逐欄辨識率 77%、契約工期僅 46%,
    // 讓 OCR 下裁決會每三欄產生一個假警報,承辦人幾次之後就學會忽略警告。
    let kickoffFile = null;
    let kickoffValues = null;
    // r.欄位(比對表中文標籤)→ resultSpan 元素,供 confirm 失敗後用後端回傳的
    // 最新 fields 清單回頭標紅——每次 renderKickoffRows 重繪時整批換新。
    let koResultCells = {};

    // 外部有給就用外部的(詳細頁),沒有就自建(彈窗)。自建的那組要顯示出來,
    // 外部的那組已經在別處顯示,這裡不能重複畫。
    // 兩個都沒傳才算「自建」——只傳其中一個(目前呼叫方不會發生,但元件本身
    // 不該預設呼叫方永遠成對傳)用 || 會誤判為自建,把另一個外部傳入的 input
    // appendChild 進這裡的區塊,等於把它從原本的卡片搬走,原處欄位就消失了。
    const owns = !opts.durationInput && !opts.startDateInput;
    const 工期I = opts.durationInput
      || el('input', { class: 'form-control', type: 'number', step: '1', min: '1' });
    const 開工I = opts.startDateInput
      || el('input', { class: 'form-control', type: 'date' });
    // 工期基準的下拉(在「監造報表基本資料」那張卡上)。解析判得出來就替承辦人選好,
    // 判不出來(表單上兩個選項並列、OCR 分不出勾了哪個)就維持未指定讓他自己挑。
    const 基準Sel = opts.basisSelect || null;

    const koFileI = el('input', { class: 'form-control', type: 'file', accept: '.pdf,.doc,.docx' });
    // 原本是裸 .btn(沒有色彩修飾類別,吃瀏覽器原生按鈕樣式,這是「解析按鈕很醜」的
    // 根因)。移到底部按鈕列與其他按鈕並排後改用既有的 .btn-outline,不新增顏色。
    const koParseBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '解析並比對');
    const koConfirmBtn = el('button', { class: 'btn btn-primary', type: 'button', style: 'display:none' }, '確認無誤並歸檔');
    const koErr = el('div', { class: 'error-msg', style: 'display:none' });
    // 工作天案例的專屬警示:與 koErr 分開,因為 koErr 是「這次操作失敗」,
    // 這個是「操作成功但有一格刻意不填」——同時顯示不衝突,語意也不同。
    const koDurationWarn = el('div', { class: 'error-msg', style: 'display:none' });
    // 歸檔成功但有提示級問題(如決標日晚於開工日)。與 koErr 分開:那是「這次
    // 操作失敗」,這是「已歸檔但有一點要回頭確認」。
    const koWarn = el('div', { class: 'hint', style: 'display:none' });
    // 解析會改到工期/開工日。外部欄位在別的頁籤時那是**看不見的改動**,
    // 故明講改了什麼(自建欄位就在眼前,不需要這條)。
    const koSyncNote = el('div', { class: 'hint', style: 'display:none' });
    const koHint = el('div', { class: 'hint' },
      '上傳後系統以 OCR 預填候選值並與已歸檔的決標公告比對。讀不到的欄位留空,請對照 PDF 自行填寫。' +
      '「開工報告表」欄可直接編輯(如 OCR 讀錯字),改完按「確認無誤並歸檔」由後端重新比對。' +
      '除「學校」與「決標日」外皆為必填,留空無法歸檔。');
    const koBox = el('div', { class: 'table-wrap' });

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
      koSyncNote.style.display = 'none';
      if (!koFileI.files[0]) {
        koErr.textContent = '請先選擇開工報告表(PDF 或 Word)';
        koErr.style.display = '';
        return;
      }
      koParseBtn.disabled = true;
      koParseBtn.textContent = '解析中(OCR 需數秒)…';
      try {
        const fd = new FormData();
        fd.append('kickoff_report', koFileI.files[0]);
        const data = await Api.upload('projects/' + projectId + '/kickoff-report/parse', fd);
        kickoffFile = koFileI.files[0];
        kickoffValues = data.kickoff;
        renderKickoffRows(data.rows);
        // 預填既有的兩格。**只在讀到值時覆蓋**——讀不到就留著承辦人已填的內容,
        // 用 null 蓋掉會把他剛打好的字清空。
        const 工期 = data.kickoff.契約工期;
        const synced = [];
        if (基準Sel) {
          // 有基準欄可存了,工作天不必再換算成日曆天:天數照填,單位存在旁邊那一格。
          // (沒有基準欄的彈窗模式仍走下面的舊路徑——那裡的「契約工期」欄意思是日曆天。)
          if (工期 && 工期.天數 != null) {
            工期I.value = 工期.天數;
            synced.push(`契約工期 ${工期.天數} 天`);
          }
          if (工期 && 工期.基準) {
            基準Sel.value = 工期.基準;
            synced.push(`工期基準 ${工期.基準}`);
          } else {
            // 判不出來要講清楚為什麼,否則承辦人不會知道那一格需要他動手——
            // 靜默留空跟靜默填錯一樣糟。
            koDurationWarn.textContent =
              '開工報告表上「日曆天」與「工作天」是並列的兩個選項,系統分不出勾了哪一個,'
              + '請對照 PDF 於「工期基準」欄自行選擇——這一格會影響完工期限的認定。';
            koDurationWarn.style.display = '';
          }
        } else if (工期 && 工期.基準 === '工作天') {
          // 「工期I」標示的是日曆天,工作天不是同一單位,不可直接互填——
          // 硬塞會產生「數字看起來正常、單位卻是錯的」這種最難察覺的資料損壞。
          // 寧可留空讓承辦人自己核對 PDF 換算,也要用明顯的警示說明「為什麼沒填」,
          // 靜默跳過跟靜默填錯一樣糟。
          koDurationWarn.textContent =
            `開工報告表上的工期是「${工期.天數 == null ? '?' : 工期.天數} 工作天」,` +
            '而此欄位要的是日曆天,兩者不可直接互填,請' +
            (owns ? '對照 PDF 自行換算後填入下方欄位' : '至「基本資料」頁籤自行換算填寫') +
            '(系統不自動預填)。';
          koDurationWarn.style.display = '';
        } else if (工期 && 工期.天數 != null) {
          工期I.value = 工期.天數;
          synced.push(`契約工期 ${工期.天數} 天`);
        }
        if (data.kickoff.契約規定開工日) {
          開工I.value = data.kickoff.契約規定開工日;
          synced.push(`開工日 ${data.kickoff.契約規定開工日}`);
        }
        // 外部欄位在別的頁籤,改了看不見。自建的就在眼前,不必多此一舉。
        if (!owns && synced.length) {
          koSyncNote.textContent = '已同步更新「基本資料」頁籤的' + synced.join('、') + '。';
          koSyncNote.style.display = '';
          if (opts.onSynced) opts.onSynced();
        }
        // 未歸檔決標公告的工程已由後端擋在 parse 之前(要求以決標公告重建工程),
        // 走到這裡必然有比對基準,不再有「僅預填、未比對」這種半套狀態。
        koConfirmBtn.style.display = '';
      } catch (e) {
        koErr.textContent = e.message;
        koErr.style.display = '';
        koConfirmBtn.style.display = 'none';
        // 解析失敗時不能留著「上一份文件」的解析結果——沒清的話,承辦人看到
        // 的會是一句「這個檔認不得」配一整張看起來屬於它的比對表,很容易
        // 誤讀成「雖然有警告,但還是解析出東西了」。這裡清的都是「描述剛才
        // 那份文件解析結果」的畫面元素;工期I/開工I 是承辦人自己的工作區
        // (可能已經手動改過),解析失敗不該動它,故不在清空之列。
        kickoffFile = null;
        kickoffValues = null;
        renderKickoffRows(null);
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
        const r = await Api.upload('projects/' + projectId + '/kickoff-report/confirm', fd);
        renderKickoffRows(r.rows);
        // 提示級不擋歸檔,但用 toast 講會隨著跳轉消失,而這是要承辦人回頭確認的
        // 東西——留在畫面上,與 koDurationWarn 同一種「已完成但有一點要看」的位置。
        if (r.warnings && r.warnings.length) {
          koWarn.textContent = r.warnings.map((w) => `${w.欄位}:${w.訊息}`).join('；');
          koWarn.style.display = '';
        }
        showToast('開工報告表已核對並歸檔', 'success');
        koConfirmBtn.style.display = 'none';
        if (opts.onArchived) opts.onArchived();
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
            if (!span) continue;
            span.className = 'error-msg';
            // 必填/值域的硬擋帶逐欄原因(fieldMessages),直接照用——那類問題是
            // 「這欄沒填或填得不成立」,套下面的跨文件文案會把承辦人指去對決標公告。
            // 契約工期則是開工報告表自身的內部自洽性檢查(表列工期 vs 開工/竣工日
            // 推導值),同樣不可套「與決標公告不符」,那會跟 koErr 頂部訊息自相矛盾
            // (buildHardErrorMessage 已刻意分流,見 kickoff-routes.js)
            const note = e.fieldMessages && e.fieldMessages[f];
            span.textContent = note || (f === '契約工期'
              ? '仍不符,請確認表格填寫'
              : '與決標公告不符,請確認後修正');
          }
        }
      } finally { koConfirmBtn.disabled = false; }
    });

    // 自建的兩欄放在比對表下方——歸檔送出的就是這兩格,不顯示等於要承辦人
    // 對著看不見的值按確認。外部欄位已在別處顯示,這裡不重複畫。
    const ownFields = owns ? el('div', { class: 'form-row', style: 'margin-top:12px' }, [
      el('div', { class: 'form-group' }, [el('label', {}, '契約工期(日曆天)'), 工期I]),
      el('div', { class: 'form-group' }, [el('label', {}, '開工日期'), 開工I]),
    ]) : null;

    // 按鈕列收在卡片最下面(.form-actions,全站統一右對齊)。彈窗情境下
    // openFlow 會把「關閉」插進這個既有的按鈕列最前面,湊成「關閉/解析並比對/
    // 確認無誤並歸檔」三顆並排;詳細頁(非彈窗)沒有「關閉」,這裡兩顆一樣落在
    // 卡片底部,不會退化。
    return el('div', { class: 'card' }, [
      el('div', { class: 'card-title' }, '開工報告表'),
      koHint,
      el('div', { class: 'form-group' }, [el('label', {}, '開工報告表 PDF'), koFileI]),
      koBox,
      ownFields,
      koErr,
      koDurationWarn,
      koSyncNote,
      koWarn,
      el('div', { class: 'form-actions' }, [koParseBtn, koConfirmBtn]),
    ]);
  }

  return { card };
})();
