const express = require('express');
const path = require('path');
const { registerRoutes: registerAuthRoutes } = require('./auth');
const { registerRoutes: registerVendorRoutes } = require('./vendor-routes');
const { registerRoutes: registerSchoolRoutes } = require('./school-routes');
const { registerRoutes: registerInsurerRoutes } = require('./insurer-routes');
const { registerRoutes: registerProjectRoutes } = require('./project-routes');

const PORT = process.env.PORT || 4141;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(express.static(path.join(__dirname, '../public')));
  registerAuthRoutes(app);
  registerVendorRoutes(app);
  registerSchoolRoutes(app);
  registerInsurerRoutes(app);
  registerProjectRoutes(app);

  // 未匹配的 /api 路徑回 JSON 404(避免掉進 SPA fallback)
  app.use('/api/', (req, res) => res.status(404).json({ error: 'Not found' }));
  // 其餘一律回 SPA 進入點
  app.get('*', (req, res) => res.sendFile(path.join(__dirname, '../public/index.html')));
  return app;
}

if (require.main === module) {
  const { migrate } = require('./db');
  const app = createApp();
  migrate()
    .then(() => {
      app.listen(PORT, () => console.log(`PMIS http://localhost:${PORT}`));
    })
    .catch((err) => {
      console.error('DB migration failed:', err);
      process.exit(1);
    });
}

module.exports = { createApp };
