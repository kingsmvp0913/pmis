/**
 * official-doc.js — 我方公文(.docx)套版
 *
 * Exports:
 *   PLACEHOLDERS            — 範本的 15 個佔位符名稱
 *   fillTemplate(values, templatePath?) → Promise<Buffer>
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

async function fillTemplate(values, templatePath = TEMPLATE_PATH) {
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

  zip.file('word/document.xml', xml);
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
}

module.exports = { PLACEHOLDERS, fillTemplate, TEMPLATE_PATH };
