/**
 * Word → PDF 轉檔。
 *
 * 副檔名判定是純函式,一律跑;真正的轉檔要 Word COM,與 SP0 的 Excel 測試同樣
 * 用 `SP0_SKIP_EXCEL=1` 略過(那個旗標的實際語意是「這台機器沒有 Office COM」,
 * 不只 Excel)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { isWordFile, convertToPdf } = require('../server/doc-convert');

describe('isWordFile', () => {
  test('認得 .doc 與 .docx(大小寫皆可)', () => {
    expect(isWordFile('開工報告表.doc')).toBe(true);
    expect(isWordFile('開工報告書.docx')).toBe(true);
    expect(isWordFile('A.DOC')).toBe(true);
  });

  // .odt 是 LibreOffice 存的 OpenDocument,承辦人手上真的有(DEBUG專用 14 份裡 2 份)。
  // 不認的話會被當成 PDF 直接餵給 OCR,回「OCR 全部解析度皆失敗」——訊息在騙人,
  // 承辦人會以為是掃描品質問題。Word COM 開得了 .odt,兩份實測轉檔後讀到 5 欄與 8 欄。
  test('認得 .odt', () => {
    expect(isWordFile('1150729開工報告書.odt')).toBe(true);
    expect(isWordFile('宜梧國中老舊廁所整修工程_開工報告表.ODT')).toBe(true);
  });

  // PDF 不可被誤判成 Word——那會讓每一份 PDF 都白跑一次 Word COM(數秒)後失敗
  test('PDF 與其他格式不算', () => {
    expect(isWordFile('開工報告表.pdf')).toBe(false);
    expect(isWordFile('經費總表.xls')).toBe(false);
    expect(isWordFile('')).toBe(false);
    expect(isWordFile(null)).toBe(false);
  });

  // 「.doc」出現在檔名中間不算(「工程.doc備份.pdf」是 PDF)
  test('只看結尾', () => {
    expect(isWordFile('工程.doc備份.pdf')).toBe(false);
  });
});

const d = process.env.SP0_SKIP_EXCEL ? describe.skip : describe;

// Word COM 一趟實測 5~7 秒,遠超 Jest 預設的 5 秒。
const COM_TIMEOUT = 120000;

d('convertToPdf(Word COM)', () => {
  const 範本 = path.join(__dirname, '..', 'templates', '公文_空白範本.docx');
  const 數暫存 = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('pmis-doc-')).length;

  test('真的轉得出 PDF', async () => {
    if (!fs.existsSync(範本)) return;     // 範本不在就跳過,不讓測試綁死檔案佈局
    const pdf = await convertToPdf(fs.readFileSync(範本), '公文_空白範本.docx');
    expect(pdf.slice(0, 5).toString()).toBe('%PDF-');
    expect(pdf.length).toBeGreaterThan(1000);
  }, COM_TIMEOUT);

  // 輸入與輸出兩個暫存檔都要清。不清的話每轉一次就留兩份在 temp,
  // 而這條路徑是承辦人每次上傳 Word 檔都會走的。
  test('轉完不留暫存檔', async () => {
    if (!fs.existsSync(範本)) return;
    const before = 數暫存();
    await convertToPdf(fs.readFileSync(範本), '公文_空白範本.docx');
    expect(數暫存()).toBe(before);
  }, COM_TIMEOUT);

  // ⚠️ 刻意不測「壞內容要 reject」:Word 會把任意位元組當**純文字文件**開啟並
  // 成功轉出 PDF,所以那個前提不成立(第一版這樣寫,測試紅了才發現)。
  // 這對產品其實是好的容錯——真的不是開工報告表時,下游 readKickoffReport 會以
  // 「此檔無法辨識為開工報告表」擋下,那一層才是該負責判斷的地方。
});
