// 啟動前釋放埠(free-port)的規則測試。
//
// 守的是三件「錯了會很難查」的事:
//   1. 只能認 netstat 的**本地位址**欄。第 3 欄是遠端位址,瀏覽器連到 4141 的
//      那條連線在該欄也是 :4141——比錯欄就會把使用者的瀏覽器/其他程式殺掉。
//   2. 埠號必須整段比對。用字串包含比,啟動在 4141 會順手殺掉 14141 上的東西。
//   3. 非 node.exe 一律不殺,改回報占用者。埠被別的程式占著時,靜靜殺掉它
//      比啟動失敗嚴重得多。
const { parseListenerPids, freePort } = require('../scripts/free-port');

const NETSTAT = [
  '',
  'Active Connections',
  '',
  '  Proto  Local Address          Foreign Address        State           PID',
  '  TCP    0.0.0.0:4141           0.0.0.0:0              LISTENING       4242',
  '  TCP    [::]:4141              [::]:0                 LISTENING       4242',
  '  TCP    0.0.0.0:14141          0.0.0.0:0              LISTENING       7777',
  '  TCP    127.0.0.1:52233        127.0.0.1:4141         ESTABLISHED     8888',
  '  TCP    0.0.0.0:5432           0.0.0.0:0              LISTENING       1234',
  '',
].join('\r\n');

describe('parseListenerPids', () => {
  test('同一進程的 IPv4/IPv6 兩列只回一個 PID', () => {
    expect(parseListenerPids(NETSTAT, 4141)).toEqual([4242]);
  });

  test('不把連到該埠的 client 當成占用者(遠端位址欄不算)', () => {
    expect(parseListenerPids(NETSTAT, 4141)).not.toContain(8888);
  });

  test('埠號整段比對,4141 不吃到 14141', () => {
    expect(parseListenerPids(NETSTAT, 4141)).not.toContain(7777);
    expect(parseListenerPids(NETSTAT, 14141)).toEqual([7777]);
  });

  test('沒人 listen 時回空陣列', () => {
    expect(parseListenerPids(NETSTAT, 9999)).toEqual([]);
  });
});

describe('freePort', () => {
  // run 的假替身:依指令回傳對應輸出,並記錄呼叫過什麼。
  function fakeRun({ image = '"node.exe","4242","Console","1","50,000 K"', freeAfterKill = true } = {}) {
    const calls = [];
    let dead = false;
    const run = (cmd, args) => {
      calls.push([cmd, ...args].join(' '));
      if (cmd === 'netstat') return dead && freeAfterKill ? 'Active Connections\r\n' : NETSTAT;
      if (cmd === 'tasklist') return image;
      if (cmd === 'taskkill') { dead = true; return ''; }
      throw new Error(`未預期的指令 ${cmd}`);
    };
    return { run, calls };
  }

  test('占用者是 node.exe 就關掉,並回報關掉的 PID', () => {
    const { run, calls } = fakeRun();
    expect(freePort(4141, { run, sleep: () => {} })).toEqual({ killed: [4242], blockedBy: [] });
    expect(calls).toContain('taskkill /PID 4242 /F /T');
  });

  test('占用者不是 node.exe 就不殺,改回報是誰占著', () => {
    const { run, calls } = fakeRun({ image: '"iisexpress.exe","4242","Console","1","9,000 K"' });
    const r = freePort(4141, { run, sleep: () => {} });
    expect(r.killed).toEqual([]);
    expect(r.blockedBy).toEqual(['iisexpress.exe(PID 4242)']);
    expect(calls.some((c) => c.startsWith('taskkill'))).toBe(false);
  });

  test('沒人占用時不下任何 taskkill', () => {
    const { run, calls } = fakeRun();
    expect(freePort(9999, { run, sleep: () => {} })).toEqual({ killed: [], blockedBy: [] });
    expect(calls.some((c) => c.startsWith('taskkill'))).toBe(false);
  });

  test('殺完會等到 netstat 查不到才回(socket 不會立刻釋放)', () => {
    const { run, calls } = fakeRun();
    const slept = [];
    freePort(4141, { run, sleep: (ms) => slept.push(ms) });
    expect(slept.length).toBeGreaterThan(0);
    expect(calls.filter((c) => c === 'netstat -ano').length).toBe(2);
  });

  test('埠一直不釋放時會停下來,不無限等', () => {
    const { run } = fakeRun({ freeAfterKill: false });
    const slept = [];
    freePort(4141, { run, sleep: (ms) => slept.push(ms), retries: 3 });
    expect(slept.length).toBe(3);
  });

  test('netstat 本身失敗不擋啟動(當作埠是空的)', () => {
    const run = (cmd) => { if (cmd === 'netstat') throw new Error('netstat 不存在'); return ''; };
    expect(freePort(4141, { run, sleep: () => {} })).toEqual({ killed: [], blockedBy: [] });
  });
});
