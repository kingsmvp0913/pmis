/**
 * docx.js — Word `.docx` 的表格讀取(純 Node,不需 Word COM)
 *
 * `.docx` 是 zip + XML,用已在 dependencies 裡的 `jszip` 解開 `word/document.xml` 即可。
 * **只支援 `.docx`,不支援 `.doc`**——後者是 OLE2 二進位,沒有文字流也沒有表格欄界,
 * 既有慣例是先用 Word COM 轉 PDF(見 `data/parser-tools/doc-to-pdf.ps1`)。
 *
 * ## 為什麼回「表格」而不是純文字
 *
 * 施工日誌第一聯整份就是一個大表格,標籤與值是同一列的相鄰儲存格
 * (`本日氣候 | 上午:晴下午:晴`)。抽成純文字後這層關係就沒了,只能靠字串距離猜——
 * 那正是 PDF 那條路最容易錯的地方。docx 的儲存格邊界是明確的,不該丟掉。
 *
 * ## 合併儲存格照 xlsx.js 的慣例填滿
 *
 * `gridSpan`(橫向合併)把值複製到跨到的每一欄、`vMerge`(縱向合併)沿用上一列同欄的值。
 * 讀取器因此可以用固定欄索引取值,不必自己處理合併——與 `gridFromWorksheet` 同一個約定。
 *
 * ## 為什麼不引 XML parser
 *
 * 專案沒有 XML parser 依賴,而這裡只需要三層標籤(tbl/tr/tc)。用**深度掃描**切而不是
 * regex 配對:表格可以巢狀(表中表),regex 的 `<w:tbl>…</w:tbl>` 會在第一個 `</w:tbl>`
 * 就收尾,把外層表格切成兩半。掃描器順便讓「`<w:tblPr>` 開頭也是 `<w:tbl`」這件事
 * 不構成問題。
 */
const fs = require('fs');
const JSZip = require('jszip');

/** XML 實體還原(只有這五個是 XML 規定的)。 */
const unescape = (s) => s
  .replace(/&lt;/g, '<').replace(/&gt;/g, '>')
  .replace(/&quot;/g, '"').replace(/&apos;/g, "'")
  .replace(/&amp;/g, '&');

/**
 * 找出 `tag` 的每一段 `[開始, 結束)`,**只取最外層**(巢狀的內層不另外回報)。
 * 自閉合標籤(`<w:tr/>`)不算。
 */
function outerRanges(xml, tag) {
  const open = new RegExp(`<${tag}(?=[\\s>/])[^>]*>`, 'g');
  const close = `</${tag}>`;
  const out = [];
  let depth = 0;
  let start = -1;
  let i = 0;
  while (i < xml.length) {
    open.lastIndex = i;
    const m = open.exec(xml);
    const c = xml.indexOf(close, i);
    if (m && (c < 0 || m.index < c)) {
      const 自閉合 = m[0].endsWith('/>');
      if (!自閉合) {
        if (depth === 0) start = m.index;
        depth += 1;
      }
      i = m.index + m[0].length;
      continue;
    }
    if (c < 0) break;
    depth -= 1;
    if (depth === 0 && start >= 0) { out.push([start, c + close.length]); start = -1; }
    if (depth < 0) depth = 0;
    i = c + close.length;
  }
  return out;
}

/** 一個 `<w:tc>` 的文字。段落之間換行,`<w:br/>`/`<w:tab/>` 各自還原。 */
function cellText(tc) {
  const paras = outerRanges(tc, 'w:p');
  const 段 = (paras.length ? paras.map(([a, b]) => tc.slice(a, b)) : [tc]).map((p) => {
    let s = '';
    const re = /<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:br\s*\/>|<w:tab\s*\/>/g;
    let m;
    while ((m = re.exec(p)) !== null) {
      if (m[1] != null) s += unescape(m[1]);
      else if (m[0].startsWith('<w:br')) s += '\n';
      else s += ' ';
    }
    return s;
  });
  return 段.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * `word/document.xml` → **依文件順序**的區塊串:`{type:'p', text}` 與 `{type:'tbl', rows}`。
 *
 * 段落不能丟掉:施工日誌第一聯**一天一個表格,而那天的日期印在表格前面的段落上**
 * (`第一聯  表報編號:  日期:115年7月21日(星期二)`),不在表格裡。只回表格的話
 * 每一天都會沒有日期,而沒有日期的日誌在上游等於整份被當成沒資料。
 */
function blocksFromXml(xml) {
  const tbls = outerRanges(xml, 'w:tbl');
  const 在表格內 = (i) => tbls.some(([a, b]) => i > a && i < b);
  const blocks = tbls.map(([a, b]) => ({ at: a, type: 'tbl', rows: rowsFromTable(xml.slice(a, b)) }));
  for (const [a, b] of outerRanges(xml, 'w:p')) {
    if (在表格內(a)) continue;                 // 表格儲存格裡的段落由 cellText 處理
    const text = cellText(xml.slice(a, b));
    if (text) blocks.push({ at: a, type: 'p', text });
  }
  blocks.sort((x, y) => x.at - y.at);
  return blocks.map(({ at, ...rest }) => rest);
}

/**
 * `word/document.xml` → 表格陣列,每個表格是 `string[][]`。
 * 合併儲存格已填滿(見檔頭)。
 */
function tablesFromXml(xml) {
  return outerRanges(xml, 'w:tbl').map(([a, b]) => rowsFromTable(xml.slice(a, b)));
}

function rowsFromTable(tbl) {
  const rows = [];
  for (const [ra, rb] of outerRanges(tbl, 'w:tr')) {
    const tr = tbl.slice(ra, rb);
    const row = [];
    for (const [ca, cb] of outerRanges(tr, 'w:tc')) {
      const tc = tr.slice(ca, cb);
      // tcPr 只在儲存格開頭,取第一個就好;內層巢狀表格的 tcPr 不會排在它前面。
      const pr = tc.slice(0, tc.indexOf('</w:tcPr>') + 1);
      const span = Number((/<w:gridSpan\s+w:val="(\d+)"/.exec(pr) || [])[1] || 1);
      // vMerge 沒有 val 或 val="continue" = 續接上一列;val="restart" = 這裡開新的
      const vm = /<w:vMerge(\s[^>]*)?\/>|<w:vMerge(\s[^>]*)?>/.exec(pr);
      const 續接 = !!vm && !/w:val="restart"/.test(vm[0]);
      const c0 = row.length;
      const 上 = rows[rows.length - 1];
      const v = 續接 && 上 && 上[c0] != null ? 上[c0] : cellText(tc);
      for (let k = 0; k < Math.max(1, span); k++) row.push(v);
    }
    rows.push(row);
  }
  return rows;
}

/**
 * 讀 .docx → `{ blocks, tables }`。
 * `blocks` 是**依文件順序**的段落與表格(讀取器要靠它把表格外的日期對到那一天);
 * `tables` 是同一批表格的便捷檢視。丟 .doc 進來要明確擋掉。
 */
async function readDocx(fileOrBuffer) {
  if (typeof fileOrBuffer === 'string' && /\.doc$/i.test(fileOrBuffer)) {
    throw new Error('.doc(Word 97-2003)讀不了,請先另存成 .docx 或 PDF');
  }
  const buf = Buffer.isBuffer(fileOrBuffer) ? fileOrBuffer : fs.readFileSync(fileOrBuffer);
  const zip = await JSZip.loadAsync(buf);
  const entry = zip.file('word/document.xml');
  if (!entry) throw new Error('這不是有效的 .docx(找不到 word/document.xml)');
  const blocks = blocksFromXml(await entry.async('string'));
  return { blocks, tables: blocks.filter((b) => b.type === 'tbl').map((b) => b.rows) };
}

module.exports = {
  readDocx,
  _internal: { blocksFromXml, tablesFromXml, rowsFromTable, outerRanges, cellText },
};
