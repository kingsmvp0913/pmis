const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const fixtureDir = path.resolve(__dirname, '../tests/fixtures');
const desktop = path.join(process.env.USERPROFILE, 'OneDrive', 'Desktop');
const roots = [path.join(desktop, 'PMIS範例'), path.join(desktop, '0825修正項目')];
const supported = new Set(['.pdf', '.xls', '.xlsx', '.xlsm', '.docx']);

function walk(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (supported.has(path.extname(entry.name).toLowerCase())) out.push(full);
  }
  return out;
}

const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const desktopFiles = roots.flatMap((root) => walk(root));
const bySize = new Map();
for (const file of desktopFiles) {
  const size = fs.statSync(file).size;
  if (!bySize.has(size)) bySize.set(size, []);
  bySize.get(size).push(file);
}

const fixtures = fs.readdirSync(fixtureDir)
  .filter((name) => supported.has(path.extname(name).toLowerCase()))
  .map((name) => path.join(fixtureDir, name));
const results = fixtures.map((fixture) => {
  const hash = digest(fixture);
  const matches = (bySize.get(fs.statSync(fixture).size) || []).filter((file) => digest(file) === hash);
  return { fixture: path.basename(fixture), matches: matches.map((file) => path.relative(desktop, file)) };
});
const matched = results.filter((result) => result.matches.length);
const parserKeys = new Set(matched.map((result) => result.fixture.match(/^[a-z]+/i)?.[0]).filter(Boolean));
console.log(JSON.stringify({
  desktopFiles: desktopFiles.length,
  fixtures: fixtures.length,
  matchedFixtures: matched.length,
  matchedParsers: parserKeys.size,
  unmatchedFixtures: results.filter((result) => !result.matches.length).map((result) => result.fixture),
  matches: matched,
}, null, 2));
