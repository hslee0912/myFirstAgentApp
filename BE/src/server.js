'use strict';

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const authRouter = require('./routes/auth');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Health check endpoint (preserve placeholder behavior)
app.get('/health', (_req, res) => {
  res.json({ success: true, data: { status: 'ok' } });
});

// API routes
app.use('/api/v1/auth', authRouter);

// Start server only if this file is run directly
if (require.main === module) {
  const port = process.env.BE_PORT || 3001;
  app.listen(port, () => {
    console.log('BE listening on', port);
  });
}

module.exports = app;
