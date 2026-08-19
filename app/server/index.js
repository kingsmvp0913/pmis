const express = require('express');
const path = require('path');
const { registerRoutes: registerAuthRoutes } = require('./auth');
const { registerRoutes: registerVendorRoutes } = require('./vendor-routes');
const { registerRoutes: registerSchoolRoutes } = require('./school-routes');
const { registerRoutes: registerInsurerRoutes } = require('./insurer-routes');
const { registerRoutes: registerFirmRoutes } = require('./firm-routes');
const { registerRoutes: registerProjectRoutes } = require('./project-routes');
const { registerRoutes: registerHistoryRoutes } = require('./history-routes');
const { registerRoutes: registerSettingsRoutes } = require('./settings');
const { registerRoutes: registerParserRoutes } = require('./parser-routes');
const { registerRoutes: registerBasicsRoutes } = require('./project-basics-routes');
const { registerRoutes: registerAwardNoticeRoutes } = require('./award-notice-routes');
const { registerRoutes: registerAttachmentRoutes } = require('./project-attachments-routes');
const { registerRoutes: registerKickoffRoutes } = require('./kickoff-routes');
const { registerRoutes: registerContractItemRoutes } = require('./contract-items-routes');
const { registerRoutes: registerDailyLogRoutes } = require('./daily-log-routes');

const PORT = process.env.PORT || 4141;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);
  registerVendorRoutes(app);
  registerSchoolRoutes(app);
  registerInsurerRoutes(app);
  registerFirmRoutes(app);
  registerProjectRoutes(app);
  registerHistoryRoutes(app);
  registerSettingsRoutes(app);
  registerParserRoutes(app);
  registerBasicsRoutes(app);
  registerAwardNoticeRoutes(app);
  registerAttachmentRoutes(app);
  registerKickoffRoutes(app);
  registerContractItemRoutes(app);
  registerDailyLogRoutes(app);

  // 未匹配的 /api 路徑回 JSON 404(避免掉進 SPA fallback)
  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  // 其餘一律回 SPA 進入點
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  // 路由沒接住的錯(multer 的 multipart 解析失敗最常見)原本會掉進 Express 的
  // 預設處理器,回一頁 HTML —— 前端讀不到 `error` 欄位,畫面上只剩「HTTP 500」,
  // 承辦人與我們都不知道發生什麼事。一律轉成 JSON,並把原因寫進 server log。
  // eslint-disable-next-line no-unused-vars
  app.use((err, req, res, next) => {
    console.error('[unhandled]', req.method, req.originalUrl, err && err.stack ? err.stack : err);
    if (res.headersSent) return;
    res.status(err && err.status ? err.status : 500)
      .json({ error: `伺服器處理這個請求時發生錯誤:${(err && err.message) || '未知錯誤'}` });
  });
  return app;
}

if (require.main === module) {
  const { migrate } = require('./db');
  const { runStartupOnboarding } = require('./parser-onboarding');
  const app = createApp();
  migrate()
    .then(async () => {
      // 啟動即掃描安裝讀取器並 upsert 廠商(best-effort,不擋啟動)。
      await runStartupOnboarding().catch((err) =>
        console.warn('[onboarding] 略過:', err.message));
      app.listen(PORT, () => console.log(`PMIS http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('DB migration failed:', err);
      process.exit(1);
    });
}

module.exports = { createApp };
