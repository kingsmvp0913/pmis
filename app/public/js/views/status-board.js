/**
 * status-board.js — 施工中工程的狀態總表
 *
 * 為什麼不直接在工程列表上加欄位:工程列表是為了「找到某一案然後進去做事」而做的,
 * 每一列都掛著五個流程關卡按鈕,一頁看不了幾案。承辦人手上同時有十幾案時要的是
 * 另一種東西——「哪幾案還在施工、各自的工期到哪了」一次看完。兩者的資訊密度需求
 * 相反,硬塞在一起兩邊都難用。
 *
 * 預設只列施工中(那才是每天要盯的),可切到未開工/已竣工/全部。
 *
 * 編輯**留在這一頁**(彈窗改完就地更新那一列),不跳去工程頁:承辦人來這裡是為了
 * 一次巡十幾案,跳走等於每改一案就要重新找回原本看到哪裡。
 */
const StatusBoard = (() => {
  const TABS = ['施工中', '未開工', '已竣工', '全部'];

  // 竣工日進入這個天數內就整列標色。使用者要的是「剩下 10 天」。
  const DUE_SOON_DAYS = 10;

  const fmtDate = (v) => (v ? String(v).slice(0, 10) : '—');
  const dateValue = (v) => (v ? String(v).slice(0, 10) : '');

  /** 剩餘工期。過期回負數,呼叫端自己決定怎麼標。 */
  function daysLeft(contractEnd) {
    if (!contractEnd) return null;
    const end = new Date(String(contractEnd).slice(0, 10) + 'T00:00:00');
    if (isNaN(end.getTime())) return null;
    const today = new Date();
    today.setHours(0, 0, 0, 0);
    return Math.round((end - today) / 86400000);
  }

  function render(content) {
    content.innerHTML = '';
    let status = '施工中';

    const err = el('div', { class: 'error-msg', style: 'display:none' });
    const summary = el('div', { class: 'hint' });
    const box = el('div', { class: 'table-wrap' });

    const tabs = el('div', { class: 'form-actions' }, TABS.map((t) => {
      const b = el('button', {
        class: t === status ? 'btn btn-primary' : 'btn btn-outline', type: 'button',
      }, t);
      b.addEventListener('click', () => {
        status = t;
        for (const other of tabs.querySelectorAll('button')) {
          other.className = other.textContent === t ? 'btn btn-primary' : 'btn btn-outline';
        }
        load();
      });
      return b;
    }));

    function statusCell(s) {
      // 顏色一律走 CSS 變數(深色模式下寫死淺色會讓文字色吃 var(--text) 翻白)
      const color = s === '施工中' ? 'var(--info)' : (s === '已竣工' ? 'var(--success)' : 'var(--text-muted)');
      return el('span', { style: `color:${color};font-weight:600` }, s);
    }

    function 工期Cell(p) {
      const n = daysLeft(p.contract_completion_date);
      if (p.status !== '施工中' || n == null) return el('span', {}, fmtDate(p.contract_completion_date));
      // 逾期是承辦人最需要一眼看到的事,不能跟正常的日期長一樣
      if (n < 0) {
        return el('span', { class: 'error-msg', style: 'padding:2px 6px' },
          `${fmtDate(p.contract_completion_date)}(逾期 ${-n} 天)`);
      }
      return el('span', {}, `${fmtDate(p.contract_completion_date)}(剩 ${n} 天)`);
    }

    // 剩 10 天內/已逾期的整列標色。只對施工中的案子標——未開工的案子契約竣工日
    // 當然也會逼近,但那不是「快到期了要盯」的意思;已竣工的更不用。
    function rowClass(p) {
      if (p.status !== '施工中') return '';
      const n = daysLeft(p.contract_completion_date);
      if (n == null) return '';
      if (n < 0) return 'row-overdue';
      return n <= DUE_SOON_DAYS ? 'row-due' : '';
    }

    /**
     * 就地編輯。**只開放這張表上看得到、而且承辦人真的會邊巡邊改的四欄**
     * (事務所編號與三個日期);廠商/機關/金額要下拉與千分位輸入,那是工程頁的事。
     *
     * PUT /projects/:id 是**整筆取代**,只送這四欄會把其餘欄位全部清成 null。
     * 故先 GET 單筆再合併送出——這也順便帶上 insurance_type_ids,不然險種會被清掉。
     */
    async function openEdit(p, onSaved) {
      let full;
      try { full = await Api.get(`projects/${p.id}`); }
      catch (e) { showToast(e.message, 'error'); return; }

      const firmNoI = el('input', { class: 'form-control', type: 'text', value: full.firm_doc_no || '' });
      const startI = el('input', { class: 'form-control', type: 'date', value: dateValue(full.start_date) });
      const dueI = el('input', { class: 'form-control', type: 'date', value: dateValue(full.contract_completion_date) });
      const doneI = el('input', { class: 'form-control', type: 'date', value: dateValue(full.actual_completion_date) });
      const dlgErr = el('div', { class: 'error-msg', style: 'display:none' });
      const saveBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '儲存');
      const cancelBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '取消');

      const body = el('div', {}, [
        el('div', { class: 'hint' }, '改完會留在狀態總表,可以接著改下一案。'),
        el('div', { class: 'form-group' }, [el('label', {}, '事務所編號'), firmNoI]),
        el('div', { class: 'form-group' }, [el('label', {}, '開工日期'), startI]),
        el('div', { class: 'form-group' }, [el('label', {}, '契約竣工日期'), dueI]),
        el('div', { class: 'form-group' }, [
          el('label', {}, '實際竣工日期'), doneI,
          el('div', { class: 'hint' }, '填了就算已竣工——狀態是由這三個日期推導的,沒有另外一個狀態欄可改。'),
        ]),
        dlgErr,
        el('div', { class: 'form-actions' }, [cancelBtn, saveBtn]),
      ]);
      const dlg = modalDialog({ title: `編輯—${p.name}`, content: body });
      cancelBtn.addEventListener('click', () => dlg.close());
      saveBtn.addEventListener('click', async () => {
        dlgErr.style.display = 'none';
        saveBtn.disabled = true;
        try {
          await Api.put(`projects/${p.id}`, {
            ...full,
            firm_doc_no: firmNoI.value.trim() || null,
            start_date: startI.value || null,
            contract_completion_date: dueI.value || null,
            actual_completion_date: doneI.value || null,
          });
          dlg.close();
          showToast('已更新', 'success');
          onSaved();
        } catch (e) {
          dlgErr.textContent = e.message;
          dlgErr.style.display = '';
        } finally {
          saveBtn.disabled = false;
        }
      });
    }

    async function load() {
      err.style.display = 'none';
      box.innerHTML = '';
      summary.textContent = '載入中…';
      try {
        const d = await Api.get(`projects/status-board?status=${encodeURIComponent(status)}`);
        summary.textContent = `${status}:共 ${d.筆數} 件`;
        if (!d.projects.length) {
          box.appendChild(el('div', { class: 'empty-row' }, '沒有符合的工程'));
          return;
        }
        const trs = d.projects.map((p) => el('tr', { class: rowClass(p) }, [
          el('td', {}, p.firm_doc_no || '—'),
          // 一張決標含多個標的時,兩列看起來像兩個不相干的案子。標一下,
          // 承辦人才知道這一列只是其中一個標的(金額也只是該標的的金額)。
          el('td', {}, p.同決標標的數 > 1
            ? [el('a', { href: `#/projects/${p.id}` }, p.name),
              el('span', { class: 'hint' }, `（同一張決標 ${p.同決標標的數} 個標的之一）`)]
            : el('a', { href: `#/projects/${p.id}` }, p.name)),
          el('td', {}, p.vendor_name || '—'),
          el('td', {}, p.school_name || '—'),
          el('td', {}, fmtDate(p.start_date)),
          el('td', {}, 工期Cell(p)),
          el('td', {}, p.award_amount != null ? PmisApp.formatAmount(p.award_amount) : '—'),
          el('td', {}, statusCell(p.status)),
          el('td', { class: 'actions' }, el('button', {
            class: 'btn btn-outline', type: 'button', onClick: () => openEdit(p, load),
          }, '編輯')),
        ]));
        box.appendChild(el('table', { class: 'data' }, [
          el('thead', {}, el('tr', {}, [
            el('th', { style: 'width:130px' }, '事務所編號'),
            el('th', {}, '工程名稱'),
            el('th', {}, '承攬廠商'),
            el('th', {}, '主辦機關'),
            el('th', { style: 'width:110px' }, '開工日期'),
            el('th', { style: 'width:200px' }, '竣工日期'),
            el('th', { style: 'width:110px' }, '契約金額'),
            el('th', { style: 'width:80px' }, '狀態'),
            el('th', { style: 'width:70px' }, ''),
          ])),
          el('tbody', {}, trs),
        ]));
      } catch (e) {
        summary.textContent = '';
        err.textContent = e.message;
        err.style.display = '';
      }
    }

    content.appendChild(el('div', { class: 'page-title' }, '狀態總表'));
    content.appendChild(tabs);
    content.appendChild(err);
    content.appendChild(summary);
    content.appendChild(box);
    load();
  }

  PmisApp.registerRoute('#/status-board', (content) => render(content));
})();
