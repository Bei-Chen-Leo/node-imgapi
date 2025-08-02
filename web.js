const express = require('express');
const path = require('path');

module.exports = (config) => {
  const web = express();

  web.use(express.static(config.webDir));

  web.get('/', (req, res) => {
    res.sendFile(path.join(config.webDir, 'index.html'));
  });

  return web;
};
