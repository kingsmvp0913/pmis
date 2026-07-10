// app.js — 原生 hash router SPA 骨架
// 路由:#/login(登入或首次建管理員)、#/(登入後主框架)
// 日後主檔 view 以 PmisApp.registerRoute('#/vendors', renderFn) 掛入。

const routes = {};
function registerRoute(hash, renderFn) { routes[hash] = renderFn; }
window.PmisApp = { registerRoute };

const root = document.getElementById('app');

function el(tag, attrs = {}, children = []) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') node.className = v;
    else if (k === 'html') node.innerHTML = v;
    else if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2).toLowerCase(), v);
    else node.setAttribute(k, v);
  }
  for (const c of [].concat(children)) {
    if (c == null) continue;
    node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
  }
  return node;
}

// ── 登入 / 首次建管理員 ──
async function renderLogin() {
  root.innerHTML = '';
  let needsSetup = false;
  try {
    const status = await Api.get('setup/status');
    needsSetup = !!status.needsSetup;
  } catch { /* 後端未起,當作登入頁 */ }

  const errBox = el('div', { class: 'error-msg', style: 'display:none' });
  const userInput = el('input', { class: 'form-control', type: 'text', placeholder: '帳號' });
  const nameInput = el('input', { class: 'form-control', type: 'text', placeholder: '顯示名稱' });
  const pwInput = el('input', { class: 'form-control', type: 'password', placeholder: '密碼(至少 8 字元)' });

  function showErr(msg) { errBox.textContent = msg; errBox.style.display = ''; }

  async function submit() {
    errBox.style.display = 'none';
    try {
      if (needsSetup) {
        const res = await Api.post('auth/setup', {
          username: userInput.value.trim(),
          password: pwInput.value,
          display_name: nameInput.value.trim()
        });
        Api.setToken(res.token);
      } else {
        const res = await Api.post('auth/login', {
          username: userInput.value.trim(),
          password: pwInput.value
        });
        Api.setToken(res.token);
      }
      window.location.hash = '/';
    } catch (e) {
      showErr(e.message);
    }
  }

  const fields = [
    el('div', { class: 'form-group' }, [el('label', {}, '帳號'), userInput])
  ];
  if (needsSetup) {
    fields.push(el('div', { class: 'form-group' }, [el('label', {}, '顯示名稱'), nameInput]));
  }
  fields.push(el('div', { class: 'form-group' }, [el('label', {}, '密碼'), pwInput]));

  pwInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') submit(); });

  const box = el('div', { class: 'login-box' }, [
    el('div', { class: 'login-title' }, needsSetup ? '建立管理員' : 'PMIS 登入'),
    el('div', { class: 'login-sub' }, needsSetup ? '首次啟動,請設定管理員帳號' : '營建監造管理系統'),
    errBox,
    ...fields,
    el('button', { class: 'btn btn-primary', style: 'width:100%;justify-content:center', onClick: submit },
      needsSetup ? '建立並登入' : '登入')
  ]);
  root.appendChild(el('div', { class: 'login-wrap' }, [box]));
}

// ── 登入後主框架(空殼,日後掛主檔 view)──
async function renderShell() {
  let me;
  try { me = await Api.get('auth/me'); }
  catch { Api.clearToken(); window.location.hash = '/login'; return; }

  root.innerHTML = '';
  const content = el('div', { class: 'content', id: 'view-root' });

  const sidebar = el('aside', { class: 'sidebar' }, [
    el('div', { class: 'sidebar-header' }, [
      el('strong', {}, 'PMIS'),
      el('span', {}, '營建監造管理')
    ]),
    el('nav', {}, [
      el('a', { class: 'active', href: '#/' }, '🏠 首頁')
    ]),
    el('div', { class: 'sidebar-footer' }, [
      el('div', { style: 'font-size:12px;margin-bottom:8px;color:var(--sidebar-text)' }, me.display_name || me.username),
      el('a', { onClick: () => { Api.clearToken(); window.location.hash = '/login'; } }, '登出')
    ])
  ]);
  const main = el('div', { class: 'main' }, [content]);
  root.appendChild(sidebar);
  root.appendChild(main);

  // 首頁(空殼歡迎頁);日後主檔 view 以 registerRoute 掛入並在此 dispatch
  content.appendChild(el('div', { class: 'page-title' }, `歡迎,${me.display_name || me.username}`));
  content.appendChild(el('p', { style: 'color:var(--text-muted)' }, '平台基座已就緒。主檔功能將於後續階段掛載。'));
}

// ── router ──
async function route() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (!Api.isLoggedIn() && hash !== '/login') { window.location.hash = '/login'; return; }
  if (Api.isLoggedIn() && hash === '/login') { window.location.hash = '/'; return; }

  if (hash === '/login') return renderLogin();
  if (routes['#' + hash]) return routes['#' + hash](document.getElementById('view-root') || root, {});
  return renderShell();
}

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
