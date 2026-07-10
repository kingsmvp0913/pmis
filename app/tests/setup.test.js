const { buildConfig } = require('../scripts/setup');

describe('buildConfig', () => {
  test('無 overrides 時 PORT 預設 4141', () => {
    const cfg = buildConfig();
    expect(cfg.PORT).toBe(4141);
  });

  test('產生的 JWT_SECRET 為 64 字元 hex(32 bytes)', () => {
    const cfg = buildConfig();
    expect(cfg.JWT_SECRET).toMatch(/^[0-9a-f]{64}$/);
  });

  test('每次產生的 JWT_SECRET 不同', () => {
    expect(buildConfig().JWT_SECRET).not.toBe(buildConfig().JWT_SECRET);
  });

  test('DATABASE_URL 有預設值(本機 postgres,DB 名 pmis)', () => {
    const cfg = buildConfig();
    expect(cfg.DATABASE_URL).toContain('/pmis');
  });

  test('overrides 覆寫預設(PORT / DATABASE_URL / JWT_SECRET)', () => {
    const cfg = buildConfig({ PORT: 5000, DATABASE_URL: 'postgres://x/y', JWT_SECRET: 'fixed' });
    expect(cfg.PORT).toBe(5000);
    expect(cfg.DATABASE_URL).toBe('postgres://x/y');
    expect(cfg.JWT_SECRET).toBe('fixed');
  });
});
