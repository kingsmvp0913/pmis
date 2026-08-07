const { compareBasics, COMPARABLE, basicsToOperations, CELL_OF } = require('../server/project-basics');

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

  // 決標公告的文字在 pdf.js 已做 NFKC(全形標點折成半形),主檔的值卻是承辦人
  // 或人工報表打的,常留全形。兩邊不同層做正規化就會把同一個名稱判成 diff。
  // 49 個舊案對照人工報表抓到的實例:「校園環境安全改善～」vs「～」的半形版。
  // 同型問題 SP3 的 daily-log-validate 已於 454ba35 修過,這層當時漏了。
  test('全形/半形標點差異不算不一致', () => {
    const project = { ...award, 工程名稱: '115年度宜梧國中～老舊廁所整修工程' };
    const a = { ...award, 工程名稱: '115年度宜梧國中~老舊廁所整修工程' };
    const hit = compareBasics(a, project).find((r) => r.欄位 === '工程名稱');
    expect(hit.狀態).toBe('match');
  });

  test('全形英數的工程編號與半形視為相同', () => {
    const project = { ...award, 工程編號: 'ｙｗｊｈ１１５０４' };
    const a = { ...award, 工程編號: 'ywjh11504' };
    const hit = compareBasics(a, project).find((r) => r.欄位 === '工程編號');
    expect(hit.狀態).toBe('match');
  });

  // NFKC 不做數值轉換,所以識別碼的前導零必須原樣保留——'0123' 與 '123'
  // 是兩個不同的案號,折在一起等於把兩個案子當成同一個。
  test('工程編號的前導零不得被正規化吃掉', () => {
    const a = { ...award, 工程編號: '0123' };
    const project = { ...award, 工程編號: '123' };
    const hit = compareBasics(a, project).find((r) => r.欄位 === '工程編號');
    expect(hit.狀態).toBe('diff');
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

describe('basicsToOperations — 組出 SP0 的 setCell 指令', () => {
  const values = {
    工程名稱: '115年度宜梧國中老舊廁所整修工程',
    監造單位: '呂罡銘建築師事務所',
    主辦機關: '雲林縣立宜梧國民中學',
    設計單位: '呂罡銘建築師事務所',
    承包廠商: '玉森土木包工業',
    契約金額: 3057698,
    契約工期: 120,
    開工日期: '2026-06-19',
    工程編號: 'ywjh11504',
  };

  test('絕不寫 B9 — 那是範本公式 =B8+B7-1,寫進去等於把公式換成死值', () => {
    const ops = basicsToOperations(values);
    expect(ops.some((o) => o.addr === 'B9')).toBe(false);
  });

  test('9 值對應 B1..B8 與 B10,全部落在「工程基本資料」分頁', () => {
    const ops = basicsToOperations(values);
    expect(ops.map((o) => o.addr).sort()).toEqual(
      ['B1', 'B10', 'B2', 'B3', 'B4', 'B5', 'B6', 'B7', 'B8']
    );
    expect(ops.every((o) => o.type === 'setCell' && o.sheet === '工程基本資料')).toBe(true);
  });

  test('開工日期寫 Excel 序號而非 ISO 字串,否則 B9 無法做日期算術', () => {
    const b8 = basicsToOperations(values).find((o) => o.addr === 'B8');
    expect(b8.value).toBe(46192);
  });

  test('未提供的欄位不產生指令,以免把既有值清空', () => {
    // SP2/SP3 之後也會往同一份寫;只補一欄時不該連帶把別欄清空
    const ops = basicsToOperations({ 工程名稱: '甲工程' });
    expect(ops).toEqual([
      { type: 'setCell', sheet: '工程基本資料', addr: 'B1', value: '甲工程' },
    ]);
  });

  test('開工日期格式不合法 → 該格寫 null(清空),不寫 NaN', () => {
    const b8 = basicsToOperations({ ...values, 開工日期: '115/06/19' })
      .find((o) => o.addr === 'B8');
    expect(b8.value).toBe(null);
  });
});
