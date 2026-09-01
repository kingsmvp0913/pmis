const {
  normalizeItemNo, fullItemNo, contractItemIndex, resolveContractItem,
} = require('../server/item-no');

test('中文小寫與大寫項次保持不同，只有真正異體字會統一', () => {
  expect(normalizeItemNo('一二三四')).toBe('一二三四');
  expect(normalizeItemNo('壹貳參肆')).toBe('壹貳參肆');
  expect(normalizeItemNo('一二三四')).not.toBe(normalizeItemNo('壹貳參肆'));
  expect(normalizeItemNo('贰.参.陆')).toBe('貳.參.陸');
});

test('完整項次由大類路徑與本項項次組成且不重複加前綴', () => {
  expect(fullItemNo({ 大類: '壹.一', 項次: '1' })).toBe('壹.一.1');
  expect(fullItemNo({ 大類: '壹.一', 項次: '壹.一.1' })).toBe('壹.一.1');
});

test('尾碼重複時不可猜，名稱唯一才可安全對應', () => {
  const contract = [
    { 項次: '壹.一.1', 項目: '跑道整地' },
    { 項次: '壹.貳.1', 項目: '球場整地' },
  ];
  const index = contractItemIndex(contract);
  expect(resolveContractItem({ 項次: '1' }, index)).toBe(null);
  expect(resolveContractItem({ 項次: '1', 工程項目: '球場整地' }, index)).toBe(contract[1]);
});
