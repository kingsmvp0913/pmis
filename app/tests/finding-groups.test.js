const {
  groupFindings, formatFindingDates, recognitionProblems, vendorProblems, nameApprovals,
} = require('../public/js/finding-groups');

test('相同規則、項次與說明合併，日期連續時顯示範圍', () => {
  const errors = ['01', '02', '03'].map((d) => ({
    code: 'E4', 日期: `2026-08-${d}`, 項次: '壹.一.1', 訊息: '單位與契約表不一致',
  }));
  const groups = groupFindings(errors, []);
  expect(groups).toHaveLength(1);
  expect(groups[0].日期).toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
  expect(groups[0].日期顯示).toBe('2026-08-01～2026-08-03（3 天）');
  expect(groups[0].findings).toHaveLength(3);
});

test('不同訊息或不同項次不合併', () => {
  const groups = groupFindings([
    { code: 'B2', 日期: '2026-08-01', 項次: '1', 訊息: '累計為 2' },
    { code: 'B2', 日期: '2026-08-02', 項次: '1', 訊息: '累計為 3' },
    { code: 'B2', 日期: '2026-08-03', 項次: '2', 訊息: '累計為 2' },
  ], []);
  expect(groups).toHaveLength(3);
});

test('日期有缺口時分段列出，無日期問題不互相合併', () => {
  expect(formatFindingDates(['2026-08-01', '2026-08-02', '2026-08-05']))
    .toBe('2026-08-01～2026-08-02（2 天）、2026-08-05');
  const groups = groupFindings([
    { code: 'F4', 日期: null, 項次: '1', 訊息: '全期累計不符' },
    { code: 'F4', 日期: null, 項次: '1', 訊息: '全期累計不符' },
  ], []);
  expect(groups).toHaveLength(2);
});

test('整組標成辨識問題時，ZIP 問題列表展開回每個原始日期', () => {
  const errors = ['01', '02', '03'].map((d) => ({
    code: 'E4', 日期: `2026-08-${d}`, 項次: '1', 訊息: '單位不一致',
  }));
  const groups = groupFindings(errors, []);
  groups[0].問題歸屬 = '辨識問題';
  expect(recognitionProblems(groups).map((p) => p.日期))
    .toEqual(['2026-08-01', '2026-08-02', '2026-08-03']);
});

test('只把標成廠商問題的群組送去產生標註檔', () => {
  const groups = groupFindings([
    { code: 'E4', 日期: '2026-08-01', 項次: '1', 訊息: '單位不一致' },
    { code: 'E6', 日期: '2026-08-01', 項次: '2', 訊息: '單價不一致' },
  ], []);
  groups[0].問題歸屬 = '廠商問題';
  groups[1].問題歸屬 = '辨識問題';
  expect(vendorProblems(groups)).toEqual([{
    級別: '硬錯', code: 'E4', 日期: '2026-08-01', 項次: '1', 訊息: '單位不一致',
  }]);
});

test('只有 E3 被指定通過時才產生名稱核准資料', () => {
  const groups = groupFindings([], [{
    code: 'E3', 日期: '2026-08-01', 項次: '1', 訊息: '名稱不同',
    契約項次: '壹.1', 契約名稱: '契約名稱', 日誌原名稱: '日誌名稱',
  }]);
  groups[0].問題歸屬 = '通過';
  expect(nameApprovals(groups)).toEqual([
    { 契約項次: '壹.1', 契約名稱: '契約名稱', 日誌原名稱: '日誌名稱' },
  ]);
});
