/** 契約項次的共同鍵規則。小寫中文數字與大寫中文數字語意不同，不互相轉換。 */
const squash = (s) => String(s == null ? '' : s).normalize('NFKC').replace(/[\s　]/g, '');

const VARIANTS = {
  参: '參', 叁: '參', 貮: '貳', 贰: '貳', 陆: '陸',
};

const normalizeItemNo = (s) => squash(s)
  .replace(/[。．]/g, '.')
  .replace(/[参叁貮贰陆]/g, (c) => VARIANTS[c]);

const fullItemNo = (item) => {
  const no = normalizeItemNo(item && item.項次);
  const parent = normalizeItemNo(item && item.大類);
  if (!parent || no === parent || no.startsWith(`${parent}.`)) return no;
  return `${parent}.${no}`;
};

const tailItemNo = (s) => normalizeItemNo(s).split('.').pop();
const normalizeName = (s) => squash(s);
const looseName = (s) => normalizeName(s).replace(/[、，,;；:：()（）\[\]【】]/g, '');

const addUnique = (map, key, value) => {
  if (!key) return;
  map.set(key, map.has(key) ? null : value);
};

function contractItemIndex(contract = []) {
  const exact = new Map();
  const tail = new Map();
  const name = new Map();
  const loose = new Map();
  for (const item of contract) {
    addUnique(exact, normalizeItemNo(item.項次), item);
    addUnique(tail, tailItemNo(item.項次), item);
    addUnique(name, normalizeName(item.項目), item);
    addUnique(loose, looseName(item.項目), item);
  }
  return { exact, tail, name, loose };
}

function resolveContractItem(row, index) {
  const no = normalizeItemNo(row && row.項次);
  const rowName = normalizeName(row && (row.工程項目 || row.項目));
  let item = index.exact.get(no) || null;
  const byName = index.name.get(rowName) || index.loose.get(looseName(rowName)) || null;
  if (byName && (!item || normalizeName(item.項目) !== rowName)) item = byName;
  if (!item) item = index.tail.get(tailItemNo(no)) || null;
  return item;
}

module.exports = {
  normalizeItemNo, fullItemNo, tailItemNo, contractItemIndex, resolveContractItem,
};
