'use strict';

// Placeholder. The BE Agent will replace this with real routes.
const express = require('express');
const app = express();
app.use(express.json());
app.get('/health', (_req, res) => res.json({ success: true, data: { status: 'ok' } }));

if (require.main === module) {
  const port = process.env.BE_PORT || 3001;
  app.listen(port, () => console.log('BE listening on', port));
}

module.exports = app;
