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
