/**
 * 佇列 repo 的 Actions 收尾:把關以 workflow 自己跑的測試為準,不信 Claude 的自述;
 * 原始檔處理完一定刪掉(使用者要求)。
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { batches, mark, finalize } = require('../scripts/fix-queue-ci');

let q;
const now = new Date('2026-11-11T12:00:00Z');
const read = (b) => JSON.parse(fs.readFileSync(path.join(q, '狀態', `${b}.json`), 'utf8'));
const put = (rel, obj) => {
  fs.mkdirSync(path.dirname(path.join(q, rel)), { recursive: true });
  fs.writeFileSync(path.join(q, rel), typeof obj === 'string' ? obj : JSON.stringify(obj));
};
beforeEach(() => {
  q = fs.mkdtempSync(path.join(os.tmpdir(), 'pmis-queue-'));
  put('待修正/B1/原始檔案/日誌.pdf', 'pdf');
  put('狀態/B1.json', { 批號: 'B1', 工程: '石龜', 狀態: '排隊中', 更新時間: '2026-11-11T10:00:00Z' });
});
afterEach(() => fs.rmSync(q, { recursive: true, force: true }));

test('開工時每一批標成處理中,保留送件時的工程名稱', () => {
  expect(batches(q)).toEqual(['B1']);
  mark(q, '處理中', now);
  expect(read('B1')).toMatchObject({ 狀態: '處理中', 工程: '石龜', 更新時間: now.toISOString() });
});

// 一輪只處理一批:只標那一批,其餘的還在排隊
test('只標指定的那一批成處理中,其餘維持排隊中', () => {
  put('待修正/B2/原始檔案/x.pdf', 'pdf');
  put('狀態/B2.json', { 批號: 'B2', 狀態: '排隊中', 更新時間: '2026-11-11T10:00:00Z' });
  mark(q, '處理中', now, ['B1']);
  expect(read('B1').狀態).toBe('處理中');
  expect(read('B2').狀態).toBe('排隊中');
});

test('修好且全套測試過 → 已修好並記下 commit;原始檔與結果檔都刪掉', () => {
  put('結果/B1.json', { 狀態: '已修好', 摘要: ['久木數量欄界已修正'] });
  finalize(q, ['B1'], { commit: 'abc123', tests: 'pass' }, now);
  expect(read('B1')).toMatchObject({ 狀態: '已修好', commit: 'abc123', 摘要: ['久木數量欄界已修正'] });
  expect(fs.existsSync(path.join(q, '待修正', 'B1'))).toBe(false);
  expect(fs.existsSync(path.join(q, '結果'))).toBe(false);
});

test('Claude 說修好了但全套測試沒過 → 沒修成且不記 commit(標籤不會叫人重啟)', () => {
  put('結果/B1.json', { 狀態: '已修好', 摘要: ['x'] });
  finalize(q, ['B1'], { commit: 'abc123', tests: 'fail' }, now);
  expect(read('B1')).toMatchObject({ 狀態: '沒修成', commit: null });
  expect(read('B1').原因).toMatch(/測試沒過/);
});

test('把關沒過時帶上 workflow 給的原因;放寬的規則照實記下', () => {
  put('結果/B1.json', { 狀態: '已修好', 放寬規則: ['F4 加捨入容差'] });
  finalize(q, ['B1'], { commit: 'abc', tests: 'fail', reason: '那批硬錯沒有變少(9→9)' }, now);
  expect(read('B1')).toMatchObject({ 狀態: '沒修成', commit: null, 放寬規則: ['F4 加捨入容差'] });
  expect(read('B1').原因).toMatch(/9→9/);
});

// 把關那一步自己當掉時 workflow 只會給 commit=- tests=skip;Claude 的「已修好」不可當真,
// 否則標籤會叫使用者重啟,而他重啟拿到的程式根本沒有修正
test('Claude 說已修好但沒有實際推上去的 commit → 沒修成', () => {
  put('結果/B1.json', { 狀態: '已修好', 摘要: ['x'] });
  finalize(q, ['B1'], { commit: '-', tests: 'skip' }, now);
  expect(read('B1')).toMatchObject({ 狀態: '沒修成', commit: null });
  expect(read('B1').原因).toMatch(/沒有推上去/);
});

test('結果檔的文字只收字串並限長度(會顯示在使用者畫面上)', () => {
  put('結果/B1.json', { 狀態: '需要決定', 需要決定: [{ html: '<img>' }, 'x'.repeat(999), ...Array(20).fill('y')], 原因: 42 });
  finalize(q, ['B1'], { commit: '-', tests: 'skip' }, now);
  const s = read('B1');
  expect(s.需要決定).toHaveLength(10);
  expect(s.需要決定[0]).toHaveLength(300);
  expect(s.原因).toBe('');
});

test('只需要裁決、沒有改程式 → 需要決定,沒有 commit', () => {
  put('結果/B1.json', { 狀態: '需要決定', 需要決定: ['E6 要放寬嗎'] });
  finalize(q, ['B1'], { commit: '-', tests: 'skip' }, now);
  expect(read('B1')).toMatchObject({ 狀態: '需要決定', 需要決定: ['E6 要放寬嗎'], commit: null });
});

test('Claude 沒寫結果(逾時或中途失敗)→ 沒修成並說明', () => {
  finalize(q, ['B1'], { commit: '-', tests: 'skip' }, now);
  expect(read('B1').狀態).toBe('沒修成');
  expect(read('B1').原因).toMatch(/沒有寫出處理結果/);
});

test('處理途中才送來的新批次不會被收尾刪掉', () => {
  put('待修正/B2/原始檔案/新.pdf', 'pdf');
  put('結果/B1.json', { 狀態: '已修好' });
  finalize(q, ['B1'], { commit: '-', tests: 'skip' }, now);
  expect(batches(q)).toEqual(['B2']);
});

test('超過 30 天的結案狀態清掉,未結案的不動', () => {
  put('狀態/OLD.json', { 批號: 'OLD', 狀態: '已修好', 更新時間: '2026-09-01T00:00:00Z' });
  put('狀態/WAIT.json', { 批號: 'WAIT', 狀態: '排隊中', 更新時間: '2026-09-01T00:00:00Z' });
  put('結果/B1.json', { 狀態: '已修好' });
  finalize(q, ['B1'], { commit: '-', tests: 'skip' }, now);
  expect(fs.existsSync(path.join(q, '狀態', 'OLD.json'))).toBe(false);
  expect(fs.existsSync(path.join(q, '狀態', 'WAIT.json'))).toBe(true);
});
