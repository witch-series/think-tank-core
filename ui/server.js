'use strict';

const express = require('express');
const path = require('path');

const PORT = process.env.UI_PORT || 2510;
const API_PORT = process.env.API_PORT || 2500;
const API_URL = process.env.API_URL || '';

const app = express();

app.use(express.static(path.join(__dirname, 'public')));

app.get('/api-url', (req, res) => {
  if (API_URL) {
    res.json({ url: API_URL });
  } else {
    const host = req.hostname;
    const protocol = req.protocol;
    res.json({ url: `${protocol}://${host}:${API_PORT}` });
  }
});

app.listen(PORT, () => {
  console.log(`Think Tank UI running at http://localhost:${PORT}`);
  console.log(`API target: ${API_URL}`);
});
