/**
 * status-board.js — 施工中工程的狀態總表
 *
 * 為什麼不直接在工程列表上加欄位:工程列表是為了「找到某一案然後進去做事」而做的,
 * 每一列都掛著五個流程關卡按鈕,一頁看不了幾案。承辦人手上同時有十幾案時要的是
 * 另一種東西——「哪幾案還在施工、各自的工期到哪了」一次看完。兩者的資訊密度需求
 * 相反,硬塞在一起兩邊都難用。
 *
 * 預設只列施工中(那才是每天要盯的),可切到未開工/已竣工/全部。
 */
const StatusBoard = (() => {
  const TABS = ['施工中', '未開工', '已竣工', '全部'];

  const fmtDate = (v) => (v ? String(v).slice(0, 10) : '—');

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
        const trs = d.projects.map((p) => el('tr', {}, [
          el('td', {}, p.firm_doc_no || '—'),
          el('td', {}, el('a', { href: `#/projects/${p.id}` }, p.name)),
          el('td', {}, p.vendor_name || '—'),
          el('td', {}, p.school_name || '—'),
          el('td', {}, fmtDate(p.start_date)),
          el('td', {}, 工期Cell(p)),
          el('td', {}, p.award_amount != null ? PmisApp.formatAmount(p.award_amount) : '—'),
          el('td', {}, statusCell(p.status)),
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
