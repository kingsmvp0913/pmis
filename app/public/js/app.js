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
      window.location.hash = '/projects'; // 首頁已移除,直接導向工程列表,省掉 '/' → fallback 的二次 hashchange
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

// 主選單項目。首頁已移除(2026-08-05):登入後直接落在工程列表,
// 未註冊的 hash 也一律導向工程列表,見下方 route() 結尾。
const NAV = [
  { hash: '#/vendors', label: '🏗️ 廠商' },
  { hash: '#/schools', label: '🏫 學校' },
  { hash: '#/insurers', label: '🛡️ 保險公司' },
  { hash: '#/firms', label: '🏢 事務所' },
  { hash: '#/projects', label: '📋 工程' },
  { hash: '#/parsers', label: '🧩 讀取器' },
  { hash: '#/settings', label: '⚙️ 系統設定' }
];

// ── 登入後主框架:sidebar + content;主檔 view 以 registerRoute 掛入並 dispatch 至 content ──
async function renderShell(activeHash) {
  let me;
  try { me = await Api.get('auth/me'); }
  catch { Api.clearToken(); window.location.hash = '/login'; return null; }
  PmisApp.currentUser = me; // 供 view 判斷權限(如讀取檔安裝限 admin)

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
  if (Api.isLoggedIn() && hash === '/login') { window.location.hash = '/projects'; return; }

  if (hash === '/login') return renderLogin();

  // 掛在對應 nav 的 active(取 hash 第一段,如 #/vendors、#/vendors/3 皆對應 #/vendors)
  const seg = '#/' + (hash.replace(/^\//, '').split('/')[0] || '');
  const activeHash = NAV.some(n => n.hash === seg) ? seg : '#/projects';
  const content = await renderShell(activeHash);
  if (!content) return; // 已導向登入

  const renderFn = routes['#' + hash] || routes[seg];
  if (renderFn) return renderFn(content, hash);

  // 首頁已移除:未註冊的 hash 一律導向工程列表,不再顯示歡迎頁(避免白畫面)。
  window.location.hash = '/projects';
}

// 任意日期值 → <input type=date> 用的 YYYY-MM-DD。
//
// 為什麼不能直接 String(v).slice(0, 10):
// 後端兩類日期欄位序列化成 JSON 後都是 UTC ISO 字串,前 10 碼是 UTC 日期而非在地日期。
//   1. DATE 欄(projects.start_date 等五欄):node-pg 把 DATE 解析成「伺服器在地時區的
//      午夜 Date 物件」,JSON.stringify 再轉成 UTC——台北的 2026-01-26 變
//      "2026-01-25T16:00:00.000Z"。實測 GET /api/projects 回的就是這個值。
//   2. TIMESTAMPTZ 欄(attachments.uploaded_at 等):本來就是 UTC 瞬時,台北時間當日
//      08:00 之後的上傳,UTC 日期就會落在前一天。
// 若直接 slice(0, 10) 填進 <input type=date>,畫面會顯示 01-25;更嚴重的是使用者只要在
// 這頁按「儲存」,畫面上錯誤的 01-25 就會被送回後端覆蓋掉正確的 01-26——每存一次就少
// 一天,而且沒有任何錯誤訊息。
//
// 純 YYYY-MM-DD 字串(不含 T,如某些路由本來就回純日期字串)沒有時區資訊,不能套用
// 下面的 Date 轉換──那樣反而會被瀏覽器目前所在時區誤轉一天,必須原樣截斷返回。
function toDateInputValue(v) {
  if (v == null || v === '') return '';
  if (v instanceof Date) return localDateParts(v);
  const s = String(v);
  if (!s.includes('T')) return s.slice(0, 10); // 純日期字串,沒有時區可轉,原樣截斷
  const d = new Date(s);
  if (isNaN(d.getTime())) return s.slice(0, 10); // 防禦:解析失敗就退回舊行為,不讓整頁掛掉
  return localDateParts(d); // 帶時間的 ISO 字串一律用「瀏覽器在地時區」重新取年月日
}
function localDateParts(d) {
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// 對外:view 檔用 PmisApp.el 建 DOM、registerRoute 掛路由、toDateInputValue 轉日期輸入框值
window.PmisApp = { registerRoute, el, toDateInputValue };

window.addEventListener('hashchange', route);
window.addEventListener('DOMContentLoaded', route);
