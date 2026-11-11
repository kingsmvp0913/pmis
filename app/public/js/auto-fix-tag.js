// auto-fix-tag.js — 右上角的自動修正標籤(見 docs/自動修正流程.md)
//
// 平常不顯示;佇列裡有批次才亮出來,點開逐批列出。每 5 分鐘問一次後端,
// 後端自己再快取 5 分鐘才打 GitHub。修好的批次在本機重開、拉到那個 commit 之後就不再提醒。

const AutoFixTag = (() => {
  const POLL_MS = 5 * 60 * 1000;
  // 標籤只顯示一個狀態:最需要承辦人動手的那個優先
  const ORDER = ['請重新啟動', '需要決定', '沒修成', '處理逾時', '處理中', '排隊中'];
  const LABEL = {
    請重新啟動: '🔄 有更新,請重新啟動',
    需要決定: '⚠️ 有事項需要決定',
    沒修成: '❌ 有問題沒修成',
    處理逾時: '⏱️ 自動修正處理逾時',
    處理中: '🔧 自動修正處理中',
    排隊中: '⏳ 辨識問題已送出,等待處理',
  };
  let state = { enabled: false, items: [] };
  let timer = null;
  let host = null;
  let open = false;

  // 「已修好」在本機還沒套用 = 要重開;已套用就不再顯示(git 查不到時當作還沒套用)
  function displayState(item) {
    if (item.狀態 === '已修好') return item.已套用 === true ? null : '請重新啟動';
    if (item.狀態 === '需要決定' && item.commit && item.已套用 !== true) return '請重新啟動';
    return ORDER.includes(item.狀態) ? item.狀態 : null;
  }

  function visibleItems() {
    return state.items.map((i) => ({ ...i, 顯示: displayState(i) })).filter((i) => i.顯示);
  }

  function render() {
    if (!host) return;
    host.innerHTML = '';
    const items = visibleItems();
    if (!items.length) { host.style.display = 'none'; return; }
    host.style.display = '';
    const top = ORDER.find((s) => items.some((i) => i.顯示 === s));
    const tag = el('button', { class: `autofix-tag autofix-${ORDER.indexOf(top) <= 2 ? 'alert' : 'info'}`, type: 'button',
      onClick: () => { open = !open; render(); } }, `${LABEL[top]}${items.length > 1 ? `(${items.length})` : ''}`);
    host.appendChild(tag);
    if (!open) return;
    const rows = items.map((i) => el('div', { class: 'autofix-item' }, [
      el('div', { class: 'autofix-item-title' }, `${LABEL[i.顯示]} — ${i.工程 || i.批號}`),
      ...(i.摘要 || []).map((m) => el('div', { class: 'hint' }, `✅ ${m}`)),
      ...(i.需要決定 || []).map((m) => el('div', { class: 'hint' }, `⚠️ ${m}`)),
      // Claude 自己放寬了驗證規則(降級、加容差)要讓人看得到,不能悄悄少擋錯
      ...(i.放寬規則 || []).map((m) => el('div', { class: 'hint' }, `📏 放寬規則:${m}`)),
      i.原因 ? el('div', { class: 'hint' }, i.原因) : null,
      el('div', { class: 'hint' }, `批號 ${i.批號}`),
    ]));
    if (items.some((i) => i.顯示 === '請重新啟動')) {
      rows.unshift(el('div', { class: 'hint' }, '關掉 PMIS 視窗後,雙擊「啟動.bat」重新開啟,新的讀取器就會生效。'));
    }
    host.appendChild(el('div', { class: 'autofix-panel' }, rows));
  }

  async function refresh() {
    try {
      state = await Api.get('auto-fix/status');
    } catch {
      return; // 查不到就維持上一次的標籤,不讓整個畫面掛掉
    }
    render();
    if (!state.enabled && state.可啟用) promptActivate();
  }

  // 還沒啟用就跳窗請承辦人貼一次啟用碼(管理者用 LINE 傳來的那串)。
  // 按「稍後再說」這次登入就不再跳,下次登入再提醒;sessionStorage 不能用時就每次都跳。
  const LATER_KEY = 'pmis.autofix.later';
  let prompting = false;
  function promptActivate() {
    let later = false;
    try { later = sessionStorage.getItem(LATER_KEY) === '1'; } catch { /* 無痕或封鎖儲存 */ }
    if (later || prompting) return;
    prompting = true;
    const input = el('input', {
      class: 'form-control', type: 'password', autocomplete: 'off', placeholder: 'github_pat_…',
    });
    const err = el('div', { class: 'error-msg', style: 'display:none' });
    const saveBtn = el('button', { class: 'btn btn-primary', type: 'button' }, '啟用');
    const laterBtn = el('button', { class: 'btn btn-outline', type: 'button' }, '稍後再說');
    const box = el('div', {}, [
      el('p', { style: 'margin-top:0' },
        '貼上管理者傳給你的啟用碼,系統就能自動更新,並把辨識問題直接送去修正。只要貼這一次。'),
      el('div', { class: 'form-group' }, [el('label', {}, '啟用碼'), input]),
      err,
      el('div', { class: 'modal-actions' }, [laterBtn, saveBtn]),
    ]);
    const dlg = modalDialog({ title: '啟用自動更新與自動修正', content: box, onClose: () => { prompting = false; } });
    laterBtn.onclick = () => {
      try { sessionStorage.setItem(LATER_KEY, '1'); } catch { /* 同上 */ }
      dlg.close();
    };
    saveBtn.onclick = async () => {
      err.style.display = 'none';
      saveBtn.disabled = true;
      try {
        await Api.put('auto-fix/activate', { token: input.value });
        dlg.close();
        showToast('已啟用,之後會自動更新', 'success');
        refresh();
      } catch (e) {
        err.textContent = e.message;
        err.style.display = '';
      } finally {
        saveBtn.disabled = false;
      }
    };
    input.addEventListener('keydown', (e) => { if (e.key === 'Enter') saveBtn.click(); });
  }

  // renderShell 每次換頁都會重建框架,標籤跟著重掛;輪詢只開一次
  function mount(container) {
    host = el('div', { class: 'autofix-host', style: 'display:none' });
    container.appendChild(host);
    render();
    if (!timer) {
      refresh();
      timer = setInterval(refresh, POLL_MS);
    }
  }

  return { mount, refresh, enabled: () => !!state.enabled, _displayState: displayState };
})();
