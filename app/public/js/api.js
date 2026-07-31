// api.js — 原生 fetch 包裝 + token 管理
const TOKEN_KEY = 'pmis_token';

// 非 2xx 一律經由此處造 Error。硬擋回應除了訊息還帶一份出問題的欄位清單,
// 只丟 message 會讓 view 沒辦法指出是哪幾欄;三條路徑共用同一個造法,
// 免得日後只補其中一條而靜默分岔。
function apiError(data, status) {
  const err = new Error(data.error || `HTTP ${status}`);
  if (Array.isArray(data.fields)) err.fields = data.fields;
  return err;
}

const Api = {
  getToken() { return localStorage.getItem(TOKEN_KEY); },
  setToken(t) { localStorage.setItem(TOKEN_KEY, t); },
  clearToken() { localStorage.removeItem(TOKEN_KEY); },
  isLoggedIn() { return !!this.getToken(); },

  async _fetch(method, path, body) {
    const token = this.getToken();
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`/api/${path}`, {
        method,
        headers,
        body: body !== undefined ? JSON.stringify(body) : undefined
      });
    } catch (e) {
      throw new Error('伺服器沒回應');
    }
    if (res.status === 401) {
      this.clearToken();
      window.location.hash = '/login';
      throw new Error('Unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(data, res.status);
    return data;
  },

  get(path) { return this._fetch('GET', path); },
  post(path, body) { return this._fetch('POST', path, body); },
  put(path, body) { return this._fetch('PUT', path, body); },
  delete(path) { return this._fetch('DELETE', path); },

  // multipart 上傳(FormData,不設 Content-Type 讓瀏覽器帶 boundary)
  async upload(path, formData) {
    const token = this.getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`/api/${path}`, { method: 'POST', headers, body: formData });
    } catch (e) {
      throw new Error('伺服器沒回應');
    }
    if (res.status === 401) {
      this.clearToken();
      window.location.hash = '/login';
      throw new Error('Unauthorized');
    }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) throw apiError(data, res.status);
    return data;
  },

  // 檔案下載;非 2xx 解析 JSON error 訊息拋出(如 409「尚未產出」)
  async download(path) {
    const token = this.getToken();
    const headers = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    let res;
    try {
      res = await fetch(`/api/${path}`, { method: 'GET', headers });
    } catch (e) {
      throw new Error('伺服器沒回應');
    }
    if (res.status === 401) {
      this.clearToken();
      window.location.hash = '/login';
      throw new Error('Unauthorized');
    }
    if (!res.ok) {
      const data = await res.json().catch(() => ({}));
      throw apiError(data, res.status);
    }
    const blob = await res.blob();
    const cd = res.headers.get('Content-Disposition') || '';
    // RFC 6266:非 ASCII 檔名一定同時帶 filename="????.pdf"(ASCII fallback,中文被
    // 換成問號)與 filename*=UTF-8''<percent-encoded>。header 位元組只能是 Latin1,
    // 所以中文原檔名只存在於 filename* 裡——必須先試它,先命中 fallback 的話
    // 使用者拿到的就是「????.pdf」。後端測試斷言的是解碼後的 filename*,故此處
    // 沒對齊時測試全綠而使用者實際下載到問號檔名。
    const star = /filename\*=UTF-8''([^;]+)/i.exec(cd);
    const m = star || /filename\*?=(?:UTF-8''|")?([^";]+)/i.exec(cd);
    const filename = m ? decodeURIComponent(m[1].replace(/"$/, '')) : 'download';
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    a.remove();
    URL.revokeObjectURL(url);
  }
};

window.Api = Api;
