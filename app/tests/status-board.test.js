const fs = require('fs');
const path = require('path');
const vm = require('vm');

function node(tag, attrs = {}, children = []) {
  const list = Array.isArray(children) ? children : [children];
  return {
    tag, attrs, children: list, style: {}, textContent: typeof children === 'string' ? children : '',
    listeners: {},
    appendChild(child) { this.children.push(child); },
    addEventListener(type, listener) { this.listeners[type] = listener; },
    querySelectorAll() { return []; },
  };
}

const flatten = (root) => [root, ...(root.children || []).flatMap(flatten)];
const tick = () => new Promise((resolve) => setImmediate(resolve));

test('狀態總表以臺灣日期顯示，編輯欄不會把 DATE 欄位倒退一天', async () => {
  let render;
  let modalContent;
  const project = {
    id: 1,
    name: '日期測試工程',
    status: '未開工',
    start_date: '2026-09-11T16:00:00.000Z',
    contract_completion_date: '2027-02-17T16:00:00.000Z',
    actual_completion_date: null,
    同決標標的數: 1,
  };
  const dateValues = new Map([
    [project.start_date, '2026-09-12'],
    [project.contract_completion_date, '2027-02-18'],
  ]);
  const content = node('main');
  const context = {
    PmisApp: {
      registerRoute: (_route, fn) => { render = fn; },
      toDateInputValue: (value) => value == null ? '' : dateValues.get(value),
      formatAmount: String,
    },
    Api: {
      get: async (url) => url.startsWith('projects/status-board')
        ? { 筆數: 1, projects: [project] }
        : project,
      put: async () => project,
    },
    el: node,
    modalDialog: ({ content: body }) => { modalContent = body; return { close() {} }; },
    showToast() {},
    console,
    Date,
    encodeURIComponent,
  };
  const source = fs.readFileSync(
    path.join(__dirname, '../public/js/views/status-board.js'), 'utf8'
  );
  vm.runInNewContext(source, context);

  render(content);
  await tick();
  const rendered = flatten(content);
  expect(rendered.some((n) => n.tag === 'td' && n.textContent === '2026-09-12')).toBe(true);
  expect(rendered.some((n) => n.textContent === '2027-02-18')).toBe(true);

  const edit = rendered.find((n) => n.tag === 'button' && n.textContent === '編輯');
  edit.attrs.onClick();
  await tick();
  const dateInputs = flatten(modalContent)
    .filter((n) => n.tag === 'input' && n.attrs.type === 'date')
    .map((n) => n.attrs.value);
  expect(dateInputs).toEqual(['2026-09-12', '2027-02-18', '']);
});
