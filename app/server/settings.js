/**
 * settings.js — 系統設定(目前:結算日 settlement_day、監造/設計單位預設)
 *
 * Exports:
 *   registerRoutes(app)     — 掛載設定路由(verifyToken)
 *   getSettlementDay()      — 讀出結算日(1–28),未設定回預設 5(可獨立測試)
 *   getFirmDefaults()       — 讀出監造/設計單位的系統預設,未設定回 null(可獨立測試)
 *
 * 路由:
 *   GET /api/settings/settlement-day  → { settlement_day }
 *   PUT /api/settings/settlement-day  → { settlement_day }(body.settlement_day 1–28)
 *   GET /api/settings/firms           → { supervisor_firm, designer_firm }
 *   PUT /api/settings/firms           → { supervisor_firm, designer_firm }(只更新 body 有的鍵)
 */
const { query } = require('./db');
const { verifyToken } = require('./auth');

const DEFAULT_SETTLEMENT_DAY = 5;

// 讀出結算日;未設定或非法值回預設 5
async function getSettlementDay() {
  const { rows } = await query("SELECT value FROM settings WHERE key = 'settlement_day'");
  if (!rows[0]) return DEFAULT_SETTLEMENT_DAY;
  const n = parseInt(rows[0].value, 10);
  if (!Number.isInteger(n) || n < 1 || n > 28) return DEFAULT_SETTLEMENT_DAY;
  return n;
}

// 監造單位/設計單位的系統預設。專案層(projects.supervisor_firm / designer_firm)
// 有值時以專案值優先,兩者皆空才落到這裡。
const FIRM_KEYS = ['supervisor_firm', 'designer_firm'];

/**
 * 讀出監造/設計單位的系統預設值。
 * @returns {Promise<{supervisor_firm: string|null, designer_firm: string|null}>}
 */
async function getFirmDefaults() {
  const { rows } = await query(
    "SELECT key, value FROM settings WHERE key IN ('supervisor_firm', 'designer_firm')"
  );
  const map = {};
  for (const r of rows) map[r.key] = r.value;
  return {
    supervisor_firm: map.supervisor_firm || null,
    designer_firm: map.designer_firm || null,
  };
}

function registerRoutes(app) {
  app.get('/api/settings/settlement-day', verifyToken, async (req, res) => {
    try {
      const settlement_day = await getSettlementDay();
      res.json({ settlement_day });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/settlement-day', verifyToken, async (req, res) => {
    try {
      const n = parseInt(req.body.settlement_day, 10);
      if (!Number.isInteger(n) || n < 1 || n > 28) {
        return res.status(400).json({ error: '結算日須為 1 到 28 的整數' });
      }
      // upsert(pg-mem 支援 ON CONFLICT)
      await query(
        `INSERT INTO settings (key, value) VALUES ('settlement_day', $1)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [String(n)]
      );
      res.json({ settlement_day: n });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.get('/api/settings/firms', verifyToken, async (req, res) => {
    try {
      res.json(await getFirmDefaults());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  app.put('/api/settings/firms', verifyToken, async (req, res) => {
    try {
      // 只更新 body 內有出現的鍵:承辦人只改一個時不該把另一個洗掉
      for (const key of FIRM_KEYS) {
        if (!(key in req.body)) continue;
        const value = String(req.body[key] == null ? '' : req.body[key]).trim();
        await query(
          `INSERT INTO settings (key, value) VALUES ($1, $2)
           ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
          [key, value]
        );
      }
      res.json(await getFirmDefaults());
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}

module.exports = { registerRoutes, getSettlementDay, getFirmDefaults, DEFAULT_SETTLEMENT_DAY };
