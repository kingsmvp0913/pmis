const { compareBasics, COMPARABLE } = require('../server/project-basics');

describe('compareBasics — 決標公告值 vs PMIS 專案主檔', () => {
  const award = {
    工程名稱: '115年度宜梧國中老舊廁所整修工程',
    主辦機關: '雲林縣立宜梧國民中學',
    承包廠商: '玉森土木包工業',
    契約金額: 3057698,
    工程編號: 'ywjh11504',
  };

  test('五個可比對欄位全部產出一筆,順序固定', () => {
    const out = compareBasics(award, award);
    expect(out.map((r) => r.欄位)).toEqual(COMPARABLE);
    expect(out.every((r) => r.狀態 === 'match')).toBe(true);
  });

  test('主檔金額是 NUMERIC(pg 可能回字串)須與數字視為相同', () => {
    // 不正規化的話每次都判 diff,承辦人每次都要裁決,硬擋機制形同虛設
    const project = { ...award, 契約金額: '3057698' };
    const hit = compareBasics(award, project).find((r) => r.欄位 === '契約金額');
    expect(hit.狀態).toBe('match');
  });

  test('全形空白與半形空白差異不算不一致', () => {
    const project = { ...award, 工程名稱: '115年度宜梧國中　老舊廁所整修工程' };
    const hit = compareBasics(award, project).find((r) => r.欄位 === '工程名稱');
    expect(hit.狀態).toBe('match');
  });

  test('兩邊都有值但不同 → diff,且原值原樣附上供畫面顯示', () => {
    const project = { ...award, 承包廠商: '晉林土木包工業' };
    const hit = compareBasics(award, project).find((r) => r.欄位 === '承包廠商');
    expect(hit.狀態).toBe('diff');
    expect(hit.決標公告值).toBe('玉森土木包工業');
    expect(hit.主檔值).toBe('晉林土木包工業');
  });

  test('任一邊缺值 → missing,不可跟 diff 混為一談', () => {
    // missing 是「沒得比」、diff 是「比出來不同」,畫面提示與處理方式不同
    const a = compareBasics(award, { ...award, 工程編號: null })
      .find((r) => r.欄位 === '工程編號');
    expect(a.狀態).toBe('missing');
    const b = compareBasics({ ...award, 工程編號: null }, award)
      .find((r) => r.欄位 === '工程編號');
    expect(b.狀態).toBe('missing');
  });

  test('空字串等同缺值', () => {
    const hit = compareBasics(award, { ...award, 主辦機關: '' })
      .find((r) => r.欄位 === '主辦機關');
    expect(hit.狀態).toBe('missing');
  });

  test('工程編號等識別碼不做數值正規化——前導零是不同編號,不可因數值相等被誤判 match', () => {
    // 案號格式各機關自訂,無「不會有前導零」的上界保證;若對識別碼套用數值轉換,
    // '0123' 會被吃掉前導零變成 '123',跟真的是 '123' 的編號誤判為相同
    const a = { ...award, 工程編號: '0123' };
    const b = { ...award, 工程編號: '123' };
    const hit = compareBasics(a, b).find((r) => r.欄位 === '工程編號');
    expect(hit.狀態).toBe('diff');
  });

  test('COMPARABLE 是封閉的五欄——契約工期/開工日期決標公告推不出(人工對照開工報告表填,無從比對),監造/設計單位來自系統設定(無從比對),不可再加', () => {
    expect(COMPARABLE).toEqual(['工程名稱', '主辦機關', '承包廠商', '契約金額', '工程編號']);
  });

  test('契約金額正規化後判 match,但回傳的主檔值仍是正規化前的原始字串,供畫面原樣顯示', () => {
    const project = { ...award, 契約金額: '3057698.00' };
    const hit = compareBasics(award, project).find((r) => r.欄位 === '契約金額');
    expect(hit.狀態).toBe('match');
    expect(hit.主檔值).toBe('3057698.00');
  });
});
