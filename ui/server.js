'use strict';

const express = require('express');
const path = require('path');

const PORT = process.env.UI_PORT || 2510;
const API_URL = process.env.API_URL || 'http://localhost:2500';

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api-url', (req, res) => {
  res.json({ url: API_URL });
});

app.listen(PORT, () => {
  console.log(`Think Tank UI running at http://localhost:${PORT}`);
  console.log(`API target: ${API_URL}`);
});
