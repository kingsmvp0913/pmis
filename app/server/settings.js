/**
 * settings.js — 系統設定(目前:結算日 settlement_day)
 *
 * Exports:
 *   registerRoutes(app)     — 掛載設定路由(verifyToken)
 *   getSettlementDay()      — 讀出結算日(1–28),未設定回預設 5(可獨立測試)
 *
 * 路由:
 *   GET /api/settings/settlement-day  → { settlement_day }
 *   PUT /api/settings/settlement-day  → { settlement_day }(body.settlement_day 1–28)
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
}

module.exports = { registerRoutes, getSettlementDay, DEFAULT_SETTLEMENT_DAY };
