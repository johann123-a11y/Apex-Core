'use strict';

const express = require('express');
const fs      = require('fs');
const tdb     = require('./transcript-db');

function start(port) {
  const app = express();

  app.get('/transcripts/:key', (req, res) => {
    const meta = tdb.get(req.params.key);
    if (!meta) {
      return res.status(404).send('<h1>404 — Transcript not found or expired</h1>');
    }
    if (!fs.existsSync(meta.path)) {
      return res.status(404).send('<h1>404 — Transcript file missing</h1>');
    }
    res.setHeader('Content-Type', 'text/html; charset=utf-8');
    res.sendFile(meta.path);
  });

  app.use((_req, res) => res.status(404).send('Not found'));

  app.listen(port, () => console.log(`[transcripts] HTTP server listening on port ${port}`));
}

module.exports = { start };
