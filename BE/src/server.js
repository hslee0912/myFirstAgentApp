'use strict';

const express = require('express');
const cors = require('cors');
const authRouter = require('./routes/auth_router');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

app.use('/api/v1/auth', authRouter);

app.use((err, _req, res, _next) => {
  console.error(err.stack);
  res.status(500).json({ success: false, error: 'INTERNAL_SERVER_ERROR' });
});

if (require.main === module) {
  const port = process.env.BE_PORT || 3001;
  app.listen(port, () => console.log('BE listening on', port));
}

module.exports = app;
