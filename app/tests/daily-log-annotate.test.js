const { PDFDocument, StandardFonts } = require('pdf-lib');
const {
  verifiedProblems, locateText, _internal,
} = require('../server/daily-log-annotate');

test('只接受後端重新驗證後完全相同的問題', () => {
  const result = { errors: [{ code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '單位不一致' }], warnings: [] };
  expect(verifiedProblems([{
    級別: '硬錯', code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '單位不一致',
  }], result)).toHaveLength(1);
  expect(verifiedProblems([{
    級別: '硬錯', code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '已被改寫',
  }], result)).toHaveLength(0);
});

test('有唯一工程項目時用名稱定位，否則退回規則欄位名稱', () => {
  const days = [{ header: { 填報日期: '2026-07-15' }, dailyRows: [{ 項次: '1', 工程項目: '混凝土澆置工程' }] }];
  expect(locateText({ code: 'E4', 日期: '2026-07-15', 項次: '1' }, days)).toBe('混凝土澆置工程');
  expect(locateText({ code: 'G1', 日期: '2026-07-15', 項次: null }, days)).toBe('工程名稱');
});

test('PDF 唯一命中時畫紅框並附上問題摘要頁', async () => {
  const source = await PDFDocument.create();
  const page = source.addPage([595, 842]);
  const font = await source.embedFont(StandardFonts.Helvetica);
  page.drawText('2026-07-15', { x: 40, y: 780, size: 12, font });
  page.drawText('Concrete placement item', { x: 40, y: 700, size: 12, font });
  const buffer = Buffer.from(await source.save());
  const problem = { 級別: '硬錯', code: 'E4', 日期: '2026-07-15', 項次: '1', 訊息: '單位不一致' };
  const days = [{ header: { 填報日期: '2026-07-15' }, dailyRows: [{ 項次: '1', 工程項目: 'Concrete placement item' }] }];
  const jobs = [{ problem, relevant: true, searchText: 'Concrete placement item' }];
  const extracted = [{ page: 1, items: [
    { x: 40, y: 780, w: 70, s: '2026-07-15' },
    { x: 40, y: 700, w: 140, s: 'Concrete placement item' },
  ] }];
  const marked = await _internal.annotatePdf(buffer, jobs, extracted);
  expect(marked.statuses).toEqual(['已畫紅框']);
  expect((await PDFDocument.load(marked.buffer)).getPageCount()).toBe(2);
});
