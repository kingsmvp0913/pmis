const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  verifiedProblems, _internal,
} = require('../server/daily-log-annotate');
const { locateExcel } = require('../server/daily-log-source-locator');
const XLSX = require('xlsx');

test('只接受後端重新驗證後完全相同的問題', () => {
  const result = { errors: [{ code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '單位不一致' }], warnings: [] };
  expect(verifiedProblems([{
    級別: '硬錯', code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '單位不一致',
  }], result)).toHaveLength(1);
  expect(verifiedProblems([{
    級別: '硬錯', code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '已被改寫',
  }], result)).toHaveLength(0);
});

test('Excel 依日期、項目列及欄位表頭定位到實際錯誤格', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([
    ['填報日期', '項次', '工程項目', '單位'],
    ['2026-07-15', '1', '混凝土澆置工程', '公尺'],
  ]), '日誌');
  const buffer = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });
  const days = [{ header: { 填報日期: '2026-07-15' }, dailyRows: [{ 項次: '1', 工程項目: '混凝土澆置工程', 單位: '公尺' }] }];
  expect(locateExcel(buffer, { code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '單位不一致' }, days))
    .toEqual({ kind: 'excel', sheet: '日誌', address: 'D2', field: '單位' });
});

test('PDF 唯一命中時畫紅框並附上問題摘要頁', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([595, 842]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  page.drawText('2026-07-15', { x: 40, y: 780, size: 12, font });
  page.drawText('Concrete placement item       M', { x: 40, y: 700, size: 12, font });
  const buffer = Buffer.from(await source.save());
  const problem = { 級別: '硬錯', code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '單位不一致' };
  const days = [{ header: { 填報日期: '2026-07-15' }, dailyRows: [{ 項次: '1', 工程項目: 'Concrete placement item', 單位: 'M' }] }];
  const jobs = [{ problem, days, source: {
    kind: 'pdf', page: 1, x: 218, y: 697, width: 14, height: 16, field: '單位',
  } }];
  const extracted = [{ page: 1, items: [
    { x: 40, y: 780, w: 70, s: '2026-07-15' },
    { x: 40, y: 700, w: 140, s: 'Concrete placement item' },
    { x: 220, y: 700, w: 10, s: 'M' },
  ] }];
  const marked = await _internal.annotatePdf(buffer, jobs, extracted);
  expect(marked.statuses).toEqual(['已畫紅框']);
  expect((await PDFDocument.load(marked.buffer)).getPageCount()).toBe(2);
});
