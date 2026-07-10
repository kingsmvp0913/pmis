const { hashPassword, checkPassword } = require('../server/password');

describe('password', () => {
  test('hashPassword 產生 pbkdf2-sha512 格式字串', async () => {
    const h = await hashPassword('secret123');
    expect(h.startsWith('$pbkdf2-sha512$')).toBe(true);
  });

  test('同一密碼每次雜湊不同(salt 隨機)', async () => {
    const a = await hashPassword('secret123');
    const b = await hashPassword('secret123');
    expect(a).not.toBe(b);
  });

  test('checkPassword 正確密碼回 true', async () => {
    const h = await hashPassword('secret123');
    expect(await checkPassword('secret123', h)).toBe(true);
  });

  test('checkPassword 錯誤密碼回 false', async () => {
    const h = await hashPassword('secret123');
    expect(await checkPassword('wrong', h)).toBe(false);
  });

  test('checkPassword 相容既有 bcrypt hash', async () => {
    const bcrypt = require('bcryptjs');
    const bhash = bcrypt.hashSync('legacy-pw', 10);
    expect(await checkPassword('legacy-pw', bhash)).toBe(true);
    expect(await checkPassword('nope', bhash)).toBe(false);
  });

  test('checkPassword 非字串 hash 回 false', async () => {
    expect(await checkPassword('x', null)).toBe(false);
  });
});
