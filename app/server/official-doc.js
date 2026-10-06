/**
 * official-doc.js — 我方公文(.docx)套版
 *
 * Exports:
 *   PLACEHOLDERS            — 範本的 15 個佔位符名稱
 *   fillTemplate(values, templatePath?, seal?) → Promise<Buffer>  seal:事務所用印 data URL,null = 不蓋印
 *   parseSeal(buf)          — 驗證用印圖檔(PNG/JPEG),回 {mime, width, height};不合法回 null
 *   templateSealDataUrl()   — 範本原本寫死的用印(呂罡銘)轉 data URL,升級補資料用
 *   TEMPLATE_PATH           — 範本檔絕對路徑
 *   toIsoDate(v)            — 轉為 YYYY-MM-DD(pg DATE 物件 / 字串皆可),無值回 null
 *   toRocDate(v)            — 西元轉民國中文日期,無效日期回空字串
 *   buildLogDescription(period, startDate, completionDate) — 組公文主旨的日誌期間描述
 *
 * .docx 是 zip + xml,故不需要 Word:jszip 解開 → 換掉 word/document.xml 的佔位符
 * → 重新打包。範本(app/templates/公文_空白範本.docx)產生時已把每個佔位符壓成
 * 單一 <w:r>,所以這裡只需純字串替換。Word 原本會把一段文字切成很多 run
 * (「呂罡銘/建築師事務所/函」是三個 run、日期切成 11/5/年/7/月/1/日),
 * 佔位符若跨 run 就比對不到——那是 docx 套版最常見的失敗原因。
 */
const fs = require('fs');
const path = require('path');
const JSZip = require('jszip');

// 範本相對本檔求出,不寫死絕對路徑。
const TEMPLATE_PATH = path.resolve(__dirname, '../templates/公文_空白範本.docx');

const PLACEHOLDERS = [
  '發文單位', '發文地址', '電話', '傳真', '聯絡人', '電子信箱',
  '受文者', '發文日期', '發文字號',
  '工程名稱', '日誌描述', '份數',
  '廠商名稱', '廠商公文日期', '廠商文號',
];

// 值會被塞進 XML,學校/廠商名稱含 & < > 時不跳脫會讓 document.xml 不合法、Word 開不起來。
function escapeXml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// pg 的 DATE 欄位回傳「伺服器在地時區午夜」的 Date 物件,toISOString() 轉 UTC
// 會讓台北時間整批日期退一天(SP3 踩過,見 memory sp3-daily-log-findings)。
// 純 YYYY-MM-DD 字串沒有時區資訊,原樣截斷即可。
function toIsoDate(v) {
  if (v == null || v === '') return null;
  if (v instanceof Date) {
    const p = (n) => String(n).padStart(2, '0');
    return `${v.getFullYear()}-${p(v.getMonth() + 1)}-${p(v.getDate())}`;
  }
  return String(v).slice(0, 10);
}

// 西元 → 民國。月/日不補零:三份樣本都是「115年7月1日」而非「115年07月01日」。
function toRocDate(v) {
  const iso = toIsoDate(v);
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || ''));
  if (!m) return '';
  return `${Number(m[1]) - 1911}年${Number(m[2])}月${Number(m[3])}日`;
}

/**
 * 主旨裡的日誌期間。一律用起迄(spec §8「一條被推翻的推論」:樣本的兩種句構
 * 與整月與否無關,不猜)。起迄取日曆期間而非日誌實際首尾——廠商假日不填,
 * 用首尾會寫出「6月2日至6月29日」這種與樣本不符的期間。
 * 首月自開工日起、末月至竣工日止,否則公文會宣稱檢送了不存在的日期區間。
 */
function buildLogDescription(period, startDate, completionDate) {
  const m = /^(\d{4})-(\d{2})$/.exec(String(period || ''));
  if (!m) throw new Error(`period 格式須為 YYYY-MM,收到:${period}`);
  const year = Number(m[1]);
  const month = Number(m[2]);
  const first = `${m[1]}-${m[2]}-01`;
  // Date.UTC(y, month, 0) = 該月最後一天(month 已是 1-based,故不減一)
  const lastDay = String(new Date(Date.UTC(year, month, 0)).getUTCDate()).padStart(2, '0');
  const last = `${m[1]}-${m[2]}-${lastDay}`;

  const start = toIsoDate(startDate);
  const done = toIsoDate(completionDate);
  const from = start && start > first ? start : first;
  const to = done && done < last ? done : last;
  return `施工日誌(${toRocDate(from)}至${toRocDate(to)})`;
}

// 範本裡用印圖的關聯 id 與檔名(產範本時就只有這一張圖)。
const SEAL_REL = 'rId6';
const SEAL_MEDIA = 'word/media/image1.png';
// 範本原圖 410×103 排成 307.45pt×77.25pt;換印時固定高度、依比例算寬,不超過版心。
const SEAL_HEIGHT_PT = 77.25;
const SEAL_MAX_WIDTH_PT = 420;

/** 只認 PNG/JPEG,並讀出像素尺寸(排版要用比例)。 */
function parseSeal(buf) {
  if (!Buffer.isBuffer(buf) || buf.length < 24) return null;
  if (buf.readUInt32BE(0) === 0x89504e47) {
    return { mime: 'image/png', width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
  }
  if (buf[0] === 0xff && buf[1] === 0xd8) {
    // 走 JPEG 區段找 SOFn(C0~CF,扣掉 C4/C8/CC 這三個不是畫面的)
    let i = 2;
    while (i + 9 < buf.length) {
      if (buf[i] !== 0xff) return null;
      const m = buf[i + 1];
      if (m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc) {
        return { mime: 'image/jpeg', width: buf.readUInt16BE(i + 7), height: buf.readUInt16BE(i + 5) };
      }
      i += 2 + buf.readUInt16BE(i + 2);
    }
  }
  return null;
}

async function templateSealDataUrl(templatePath = TEMPLATE_PATH) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const f = zip.file(SEAL_MEDIA);
  if (!f) return null;
  return 'data:image/png;base64,' + (await f.async('base64'));
}

// 換掉(或拿掉)範本的用印。沒設定用印的事務所寧可不蓋,也不能蓋成別家的章。
async function applySeal(zip, xml, seal) {
  const pict = new RegExp(`<w:pict\\b(?:(?!</w:pict>).)*r:id="${SEAL_REL}"(?:(?!</w:pict>).)*</w:pict>`, 's');
  const m = /^data:(image\/(?:png|jpeg));base64,(.+)$/s.exec(String(seal || ''));
  const buf = m ? Buffer.from(m[2], 'base64') : null;
  const info = buf ? parseSeal(buf) : null;
  if (!info || !info.width || !info.height) return xml.replace(pict, '');

  let h = SEAL_HEIGHT_PT;
  let w = (h * info.width) / info.height;
  if (w > SEAL_MAX_WIDTH_PT) { h = (h * SEAL_MAX_WIDTH_PT) / w; w = SEAL_MAX_WIDTH_PT; }
  const fmt = (n) => Number(n.toFixed(2));
  xml = xml.replace(pict, (s) => s.replace(/width:[\d.]+pt;height:[\d.]+pt/, `width:${fmt(w)}pt;height:${fmt(h)}pt`));

  if (info.mime === 'image/png') {
    zip.file(SEAL_MEDIA, buf);
    return xml;
  }
  // JPEG:副檔名與 Content_Types 要對得上,Word 才開得起來
  const jpg = SEAL_MEDIA.replace(/\.png$/, '.jpeg');
  zip.remove(SEAL_MEDIA);
  zip.file(jpg, buf);
  const relsPath = 'word/_rels/document.xml.rels';
  const rels = await zip.file(relsPath).async('string');
  zip.file(relsPath, rels.replace('media/image1.png', 'media/image1.jpeg'));
  const ctPath = '[Content_Types].xml';
  const ct = await zip.file(ctPath).async('string');
  if (!/Extension="jpeg"/i.test(ct)) {
    zip.file(ctPath, ct.replace('</Types>', '<Default Extension="jpeg" ContentType="image/jpeg"/></Types>'));
  }
  return xml;
}

async function fillTemplate(values, templatePath = TEMPLATE_PATH, seal = null) {
  const zip = await JSZip.loadAsync(fs.readFileSync(templatePath));
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('範本損毀:找不到 word/document.xml');

  let xml = await entry.async('string');
  for (const key of PLACEHOLDERS) {
    xml = xml.split(`{{${key}}}`).join(escapeXml(values[key]));
  }

  // 範本被改動而多出欄位時,寧可當場失敗也不要產出一份印著「{{…}}」的公文寄出去。
  const left = xml.match(/\{\{[^}]*\}\}/g);
  if (left) throw new Error('範本有未知的佔位符:' + [...new Set(left)].join('、'));

  xml = await applySeal(zip, xml, seal);
  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = {
  PLACEHOLDERS, fillTemplate, TEMPLATE_PATH, toIsoDate, toRocDate, buildLogDescription,
  parseSeal, templateSealDataUrl,
};
