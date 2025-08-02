const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

const configPath = path.join(__dirname, 'config', 'config.json');
let config = {
  web: {
    httpPort: 3000,
    httpsPort: -1,
    host: '127.0.0.1',
    keyFile: '',
    crtFile: '',
    forceHttps: false
  },
  dir: {
    imgDir: path.join(__dirname, 'img'),
    webDir: path.join(__dirname, 'web')
  },
  cache: {
    redisEnable: false,
    redisHost: '127.0.0.1',
    redisPort: 6379,
    redisPassword: '',
    mapMaxSize: 100
  }
};

try {
  if (fs.existsSync(configPath)) {
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config = {
      web: { ...config.web, ...userConfig.web },
      dir: {
        imgDir: path.resolve(__dirname, userConfig.dir?.imgDir || config.dir.imgDir),
        webDir: path.resolve(__dirname, userConfig.dir?.webDir || config.dir.webDir)
      },
      cache: { ...config.cache, ...userConfig.cache }
    };
  }
} catch (e) {
  console.error('读取 config.json 失败，使用默认配置:', e);
}

const app = express();
const apiRouter = require('./api')(config.dir, config.cache);
const updateRouter = require('./update')(config.dir);
const webApp = require('./web')(config.dir);

app.use(express.static(__dirname));
app.use('/api', apiRouter);
app.use('/update', updateRouter);
app.use('/', webApp);

// HTTPS
if (config.web.httpsPort > 0) {
  try {
    const key = fs.readFileSync(path.resolve(__dirname, config.web.keyFile));
    const cert = fs.readFileSync(path.resolve(__dirname, config.web.crtFile));
    https.createServer({ key, cert }, app).listen(config.web.httpsPort, config.web.host, () => {
      console.log(`HTTPS 服务已启动：https://${config.web.host}:${config.web.httpsPort}`);
    });
  } catch (e) {
    console.error('HTTPS 启动失败:', e);
  }
}

// HTTP + 可选重定向
if (config.web.httpPort > 0) {
  const redirect = config.web.forceHttps && config.web.httpsPort > 0;
  const server = redirect
    ? http.createServer((req, res) => {
        const host = req.headers.host?.split(':')[0] || config.web.host;
        res.writeHead(301, {
          Location: `https://${host}:${config.web.httpsPort}${req.url}`
        });
        res.end();
      })
    : http.createServer(app);

  server.listen(config.web.httpPort, config.web.host, () => {
    const type = redirect ? '重定向' : 'HTTP';
    console.log(`${type} 服务已启动：http://${config.web.host}:${config.web.httpPort}`);
  });
}
