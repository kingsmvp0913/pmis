// app.js — 原生 hash router SPA 骨架
// 路由:#/login(登入或首次建管理員)、#/(登入後主框架)
// 日後主檔 view 以 PmisApp.registerRoute('#/vendors', renderFn) 掛入。

const routes = {};
function registerRoute(hash, renderFn) { routes[hash] = renderFn; }

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

// 主選單項目(第二階段只掛這四項 + 首頁)
const NAV = [
  { hash: '#/', label: '🏠 首頁' },
  { hash: '#/vendors', label: '🏗️ 廠商' },
  { hash: '#/schools', label: '🏫 學校' },
  { hash: '#/insurers', label: '🛡️ 保險公司' },
  { hash: '#/projects', label: '📋 工程' },
  { hash: '#/settings', label: '⚙️ 系統設定' }
];

// ── 登入後主框架:sidebar + content;主檔 view 以 registerRoute 掛入並 dispatch 至 content ──
async function renderShell(activeHash) {
  let me;
  try { me = await Api.get('auth/me'); }
  catch { Api.clearToken(); window.location.hash = '/login'; return null; }

  root.innerHTML = '';
  const content = el('div', { class: 'content', id: 'view-root' });

  const sidebar = el('aside', { class: 'sidebar' }, [
    el('div', { class: 'sidebar-header' }, [
      el('strong', {}, 'PMIS'),
      el('span', {}, '營建監造管理')
    ]),
    el('nav', {}, NAV.map(n =>
      el('a', { class: n.hash === activeHash ? 'active' : '', href: n.hash }, n.label)
    )),
    el('div', { class: 'sidebar-footer' }, [
      el('div', { style: 'font-size:12px;margin-bottom:8px;color:var(--sidebar-text)' }, me.display_name || me.username),
      el('a', { onClick: () => { Api.clearToken(); window.location.hash = '/login'; } }, '登出')
    ])
  ]);
  const main = el('div', { class: 'main' }, [content]);
  root.appendChild(sidebar);
  root.appendChild(main);
  return content;
}

// ── router ──
async function route() {
  const hash = window.location.hash.replace(/^#/, '') || '/';
  if (!Api.isLoggedIn() && hash !== '/login') { window.location.hash = '/login'; return; }
  if (Api.isLoggedIn() && hash === '/login') { window.location.hash = '/'; return; }

  if (hash === '/login') return renderLogin();

  // 掛在對應 nav 的 active(取 hash 第一段,如 #/vendors、#/vendors/3 皆對應 #/vendors)
  const seg = '#/' + (hash.replace(/^\//, '').split('/')[0] || '');
  const activeHash = NAV.some(n => n.hash === seg) ? seg : '#/';
  const content = await renderShell(activeHash);
  if (!content) return; // 已導向登入

  const renderFn = routes['#' + hash] || routes[seg];
  if (renderFn) return renderFn(content, hash);

  // 首頁歡迎(其餘未註冊 hash 也回首頁)
  content.appendChild(el('div', { class: 'page-title' }, '歡迎'));
  content.appendChild(el('p', { style: 'color:var(--text-muted)' }, '請由左側選單選擇主檔。'));
}

// 對外:view 檔用 PmisApp.el 建 DOM、registerRoute 掛路由
window.PmisApp = { registerRoute, el };

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
