/**
 * filetypes/docx.js — Word .docx 表格讀取
 *
 * 斷言集中在三個「錯了不會有任何欄位變 null,只會整列錯位」的地方:
 *   ① 巢狀表格 —— regex 配對 `<w:tbl>…</w:tbl>` 會在第一個 `</w:tbl>` 收尾,把外層切兩半
 *   ② gridSpan / vMerge 的合併填充 —— 沒填滿的話固定欄索引全部指到別欄
 *   ③ 段落與表格的**文件順序** —— 施工日誌第一聯的日期印在表格前的段落上
 */
const path = require('path');
const docx = require('../server/parsers/filetypes/docx');

const { blocksFromXml, outerRanges, cellText } = docx._internal;

const p = (t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`;
const tc = (t, pr = '') => `<w:tc><w:tcPr>${pr}</w:tcPr>${p(t)}</w:tc>`;
const tr = (...cells) => `<w:tr>${cells.join('')}</w:tr>`;
const tbl = (...rows) => `<w:tbl><w:tblPr/>${rows.join('')}</w:tbl>`;

test('outerRanges 只取最外層,巢狀表格不會把外層切成兩半', () => {
  const 內 = tbl(tr(tc('內層')));
  const xml = `<w:body>${tbl(tr(`<w:tc><w:tcPr/>${內}</w:tc>`), tr(tc('外層第二列')))}</w:body>`;
  const r = outerRanges(xml, 'w:tbl');
  expect(r.length).toBe(1);
  // 切出來的那一段必須含到外層的第二列,而不是停在內層的 </w:tbl>
  expect(xml.slice(r[0][0], r[0][1])).toContain('外層第二列');
});

test('gridSpan 把值填滿跨到的每一欄', () => {
  const xml = tbl(tr(tc('甲', '<w:gridSpan w:val="3"/>'), tc('乙')));
  expect(blocksFromXml(xml)[0].rows[0]).toEqual(['甲', '甲', '甲', '乙']);
});

test('vMerge 續接沿用上一列同欄的值,restart 則開新的', () => {
  const xml = tbl(
    tr(tc('標題', '<w:vMerge w:val="restart"/>'), tc('第一列')),
    tr(tc('', '<w:vMerge/>'), tc('第二列')),
    tr(tc('新標題', '<w:vMerge w:val="restart"/>'), tc('第三列')),
  );
  const rows = blocksFromXml(xml)[0].rows;
  expect(rows[1][0]).toBe('標題');        // 續接:雖然自己是空的
  expect(rows[2][0]).toBe('新標題');      // restart:不沿用
});

test('blocks 依文件順序,表格外的段落留著', () => {
  const xml = `${p('日期：115年7月21日')}${tbl(tr(tc('內容')))}${p('後記')}`;
  const b = blocksFromXml(xml);
  expect(b.map((x) => x.type)).toEqual(['p', 'tbl', 'p']);
  expect(b[0].text).toBe('日期：115年7月21日');
});

test('儲存格裡的段落不會被當成文件層的段落', () => {
  const b = blocksFromXml(tbl(tr(tc('格內文字'))));
  expect(b.filter((x) => x.type === 'p').length).toBe(0);
  expect(b[0].rows[0][0]).toBe('格內文字');
});

test('cellText 還原 XML 實體與換行', () => {
  const t = '<w:p><w:r><w:t>A&amp;B</w:t><w:br/><w:t>C</w:t><w:tab/><w:t>D</w:t></w:r></w:p>';
  expect(cellText(t)).toBe('A&B\nC D');
});

// .doc 是 OLE2 二進位,沒有文字流也沒有表格欄界。要明確擋掉並指路,
// 不能讓它變成一個看起來像「這份沒資料」的空結果。
test('.doc 明確拒收並指路', async () => {
  await expect(docx.readDocx('x.doc')).rejects.toThrow(/請先另存成 \.docx 或 PDF/);
});

test('不是 docx 的 zip 要明確報錯', async () => {
  const notDocx = Buffer.from('PKnot a real docx');
  await expect(docx.readDocx(notDocx)).rejects.toThrow();
});

describe('真實檔(玉森第一聯,鹿場國小)', () => {
  const FIXTURE = path.join(__dirname, 'fixtures', 'yusen-first.docx');
  let out;
  beforeAll(async () => { out = await docx.readDocx(FIXTURE); }, 60000);

  test('11 個表格 = 11 天,每天一個', () => {
    expect(out.tables.length).toBe(11);
  });

  test('每個表格前面都有一段帶日期的段落', () => {
    const tblIdx = out.blocks.map((b, i) => (b.type === 'tbl' ? i : -1)).filter((i) => i >= 0);
    for (const i of tblIdx) {
      const 前 = out.blocks.slice(0, i).reverse().find((b) => b.type === 'p' && /日期[:：]/.test(b.text));
      expect(前).toBeDefined();
    }
  });

  test('合併填充讓標籤與值落在同一列', () => {
    const r0 = out.tables[0][0];
    expect(r0[0]).toBe('工程名稱');
    expect(r0).toContain('本日氣候');
    expect(r0[r0.length - 1]).toBe('上午：晴下午：晴');
  });
});
