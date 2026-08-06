/**
 * check-parser.test.js — 讀取器交付關卡的「名稱形狀健檢」
 *
 * 為什麼需要這關:既有的完整性關卡只看「單位/契約數量/契約單價是否為 null」,
 * 而名稱被切錯不會讓任何欄位變 null;跨層驗證又是拿日誌自己的第一次出現值當契約
 * 基準,讀取器若每天都用同樣方式讀錯,自我比對永遠一致。富森讀取器把長名稱跨行
 * 重組錯位(項次4 開頭被切掉、項次5 混進項次4 的尾巴),三道關卡全過,直到接上
 * 真實契約表跑 pipeline 才現形——六成的項目名稱是錯的。
 *
 * 這裡的規則都不需要外部基準,單看名稱本身的形狀就能抓到錯位。
 */
const { detectNameAnomalies } = require('../scripts/check-parser');

// 單位/單價/數量三者皆空會被 isCategoryRow 判成大類列而跳過,故明細列的 fixture 必須帶著。
const rows = (...names) => names.map((n, i) => ({
  項次: String(i + 1), 工程項目: n, 單位: '式', 契約單價: 100, 契約數量: 1,
}));

describe('detectNameAnomalies', () => {
  test('正常的項目名稱不該被標記', () => {
    const r = detectNameAnomalies(rows(
      '乙種施工圍籬、警示帶、安全警示燈等安全措施(租用)',
      '工程告示牌與職安衛告示牌(租用)',
      '施工動線開闢與損壞復原，既有設備管線遷移與復原；測量與放樣',
      '職業安全衛生管理費(壹*1%)',
    ));
    expect(r).toEqual([]);
  });

  // 富森實際讀出來的樣子:項次4 的名稱開頭被切掉,只剩尾巴
  test('以標點符號開頭 = 名稱前段被切掉', () => {
    const r = detectNameAnomalies(rows('、搗擺及天花板等拆除(含切割)及運棄(含'));
    expect(r.map((x) => x.code)).toContain('標點開頭');
  });

  // 同一列:左括號比右括號多,代表名稱在括號中間被截斷
  test('括號不對稱 = 名稱在中途被截斷', () => {
    const r = detectNameAnomalies(rows('、搗擺及天花板等拆除(含切割)及運棄(含'));
    expect(r.map((x) => x.code)).toContain('括號不對稱');
  });

  // 富森項次5:開頭是上一列的尾巴,右括號沒有對應的左括號
  test('右括號多於左括號也算不對稱', () => {
    const r = detectNameAnomalies(rows('合法證明);環境保護與清潔既有污水處理設施抽水肥'));
    expect(r.map((x) => x.code)).toContain('括號不對稱');
  });

  test('全形括號一併計入,不可只認半形', () => {
    const r = detectNameAnomalies(rows('地坪整修（含清潔'));
    expect(r.map((x) => x.code)).toContain('括號不對稱');
  });

  // 名稱只剩一兩個字,通常是被切到只剩殘骸
  test('名稱過短', () => {
    const r = detectNameAnomalies(rows('復原'));
    expect(r.map((x) => x.code)).toContain('名稱過短');
  });

  // 大類列(壹/貳…)本來就只有類別名,不是明細,不該被當異常
  test('大類列不檢查', () => {
    const r = detectNameAnomalies([{ 項次: '壹', 工程項目: '直接工程費' }]);
    expect(r).toEqual([]);
  });

  test('名稱為空的列交給既有的必填檢查,這裡不重複報', () => {
    expect(detectNameAnomalies([{ 項次: '1', 工程項目: '' }])).toEqual([]);
    expect(detectNameAnomalies([{ 項次: '1', 工程項目: null }])).toEqual([]);
  });

  // 同一個項次每天都出現,重複報 119 次沒有意義,只會把輸出淹掉
  test('同一項次的相同異常只回報一次', () => {
    const bad = { 項次: '4', 工程項目: '、搗擺及天花板等拆除(含', 單位: '式', 契約單價: 100, 契約數量: 1 };
    const r = detectNameAnomalies([bad, { ...bad }, { ...bad }]);
    expect(r.filter((x) => x.code === '標點開頭')).toHaveLength(1);
  });
});
