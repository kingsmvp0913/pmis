const { rocToISO, cnNumToNumber, parseMoney } = require('../server/kickoff-values');

// 決標公告是 115/06/16,開工報告表是「中華民國115年6月16日」。
// 兩種寫法必須落到同一個值,否則決標日這欄永遠判不符。
describe('rocToISO', () => {
  test('斜線式', () => expect(rocToISO('115/06/16')).toBe('2026-06-16'));
  test('個位數月日不補零也要吃', () => expect(rocToISO('115/6/3')).toBe('2026-06-03'));
  test('中文年月日', () => expect(rocToISO('中華民國115年6月16日')).toBe('2026-06-16'));
  test('OCR 逐字空格後的中文年月日', () => expect(rocToISO('115 年 6 月 16 日')).toBe('2026-06-16'));
  // 民國 0 年不存在;三位數以上年份是 OCR 讀錯(如 1150 年),不得編造日期
  test('非法值回 null 不編造', () => {
    expect(rocToISO('0/6/16')).toBeNull();
    expect(rocToISO('_J50_')).toBeNull();
    expect(rocToISO(null)).toBeNull();
  });
  // 2 月 30 日必須擋掉:JS Date 會自動滾到 3 月 2 日,靜默產生一個錯日期
  test('日曆上不存在的日期回 null', () => expect(rocToISO('115/2/30')).toBeNull());
});

describe('cnNumToNumber', () => {
  // 台西:貳佰肆拾伍萬陸仟元整
  test('萬位國字大寫', () => expect(cnNumToNumber('貳佰肆拾伍萬陸仟元整')).toBe(2456000));
  // 鹿場:新台幣:貳佰捌拾壹萬肆仟叁拾貳元整 —— 前綴與「元整」都要能吃掉
  test('帶前綴與元整', () => expect(cnNumToNumber('新台幣:貳佰捌拾壹萬肆仟叁拾貳元整')).toBe(2814032));
  test('小寫國字亦可', () => expect(cnNumToNumber('二百四十五万六千')).toBe(2456000));
  test('非國字回 null', () => expect(cnNumToNumber('3,122,168元')).toBeNull());
});

describe('parseMoney', () => {
  test('阿拉伯數字含千分位', () => expect(parseMoney('3,122,168元')).toBe(3122168));
  test('國字大寫', () => expect(parseMoney('貳佰肆拾伍萬陸仟元整')).toBe(2456000));
  test('純數值', () => expect(parseMoney(3122168)).toBe(3122168));
  test('讀不到回 null', () => expect(parseMoney('__J_?O_')).toBeNull());
});
