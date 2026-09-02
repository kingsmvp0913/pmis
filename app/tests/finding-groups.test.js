const { groupFindings, formatFindingDates, recognitionProblems } = require('../public/js/finding-groups');

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
