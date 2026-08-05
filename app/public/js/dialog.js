// dialog.js — 全域確認對話框與 toast(原生 DOM,取代原生 confirm/alert)

// confirmDialog({ title, message, danger, confirmText, cancelText }) → Promise<boolean>
function confirmDialog(opts = {}) {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay';
    const danger = !!opts.danger;
    const confirmText = opts.confirmText || (danger ? '刪除' : '確定');
    const cancelText = opts.cancelText || '取消';

    overlay.innerHTML = `
      <div class="modal" role="dialog" aria-modal="true">
        <div class="modal-title"></div>
        <div class="modal-body"><p style="white-space:pre-wrap;margin:0"></p></div>
        <div class="modal-actions">
          <button class="btn btn-outline" data-act="cancel"></button>
          <button class="btn ${danger ? 'btn-danger' : 'btn-primary'}" data-act="ok"></button>
        </div>
      </div>`;
    overlay.querySelector('.modal-title').textContent = opts.title || '請確認';
    overlay.querySelector('.modal-body p').textContent = opts.message || '';
    overlay.querySelector('[data-act="cancel"]').textContent = cancelText;
    overlay.querySelector('[data-act="ok"]').textContent = confirmText;

    function close(val) {
      window.removeEventListener('keydown', onKey);
      overlay.remove();
      resolve(val);
    }
    function onKey(e) {
      if (e.key === 'Escape') { e.preventDefault(); close(false); }
      else if (e.key === 'Enter') { e.preventDefault(); close(true); }
    }
    overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(false); });
    overlay.querySelector('[data-act="cancel"]').addEventListener('click', () => close(false));
    overlay.querySelector('[data-act="ok"]').addEventListener('click', () => close(true));
    window.addEventListener('keydown', onKey);

    document.body.appendChild(overlay);
    overlay.querySelector('[data-act="ok"]').focus();
  });
}
window.confirmDialog = confirmDialog;

// modalDialog({ title, content, wide, onClose }) → { close }
// 裝任意 DOM 的彈窗。與 confirmDialog 的差別:那支是「一句話 + 是/否」,
// 這支裡面有多個輸入框與多顆按鈕,故**刻意不做 Enter 送出**——那會誤觸。
// 關閉時機由呼叫端自己決定(流程走完才關),所以回傳 close 而不是 Promise。
// onClose 在任何關閉路徑(Escape、點 overlay、呼叫 close)都會觸發一次,
// 讓以 Promise 包裝的呼叫端有機會 resolve——少了它,使用者按 Escape 放棄操作
// 會讓那個 Promise 永遠擱置。
function modalDialog(opts = {}) {
  const overlay = document.createElement('div');
  overlay.className = 'modal-overlay';

  const modal = document.createElement('div');
  modal.className = 'modal' + (opts.wide ? ' modal-wide' : '');
  modal.setAttribute('role', 'dialog');
  modal.setAttribute('aria-modal', 'true');

  const titleEl = document.createElement('div');
  titleEl.className = 'modal-title';
  titleEl.textContent = opts.title || '';

  const body = document.createElement('div');
  body.className = 'modal-body';
  if (opts.content) body.appendChild(opts.content);

  modal.appendChild(titleEl);
  modal.appendChild(body);
  overlay.appendChild(modal);

  let closed = false;
  function close() {
    if (closed) return;          // onClose 只跑一次:呼叫端可能已自行 close 過
    closed = true;
    window.removeEventListener('keydown', onKey);
    overlay.remove();
    if (opts.onClose) opts.onClose();
  }
  function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); close(); } }

  overlay.addEventListener('mousedown', (e) => { if (e.target === overlay) close(); });
  window.addEventListener('keydown', onKey);
  document.body.appendChild(overlay);
  return { close };
}
window.modalDialog = modalDialog;

// showToast(message, level = 'info', duration = 4000)
function showToast(message, level = 'info', duration = 4000) {
  let container = document.querySelector('.toast-container');
  if (!container) {
    container = document.createElement('div');
    container.className = 'toast-container';
    document.body.appendChild(container);
  }
  const el = document.createElement('div');
  el.className = `toast ${level}`;
  el.textContent = message;
  container.appendChild(el);
  setTimeout(() => el.remove(), duration);
}
window.showToast = showToast;
