const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const https = require('https');

// 支持外部传入 config 路径
const argConfigPath = process.argv.find(arg => arg.startsWith('--config='))?.split('=')[1];
const envConfigPath = process.env.CONFIG_PATH;
const defaultConfigPath = path.join(__dirname, 'config', 'config.json');

const configPath = path.resolve(argConfigPath || envConfigPath || defaultConfigPath);

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
  Redis: {
    enable: false
  }
};

try {
  if (fs.existsSync(configPath)) {
    const userConfig = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    config = {
      web: {
        httpPort: userConfig.web?.httpPort || config.web.httpPort,
        httpsPort: userConfig.web?.httpsPort ?? config.web.httpsPort,
        host: userConfig.web?.host || config.web.host,
        keyFile: userConfig.web?.keyFile || config.web.keyFile,
        crtFile: userConfig.web?.crtFile || config.web.crtFile,
        forceHttps: userConfig.web?.forceHttps ?? config.web.forceHttps
      },
      dir: {
        imgDir: userConfig.dir?.imgDir ? path.resolve(__dirname, userConfig.dir.imgDir) : config.dir.imgDir,
        webDir: userConfig.dir?.webDir ? path.resolve(__dirname, userConfig.dir.webDir) : config.dir.webDir
      },
      Redis: {
        enable: userConfig.Redis?.enable || false,
        host: userConfig.Redis?.host || '127.0.0.1',
        port: userConfig.Redis?.port || 6379,
        password: userConfig.Redis?.password || '',
        ttl: userConfig.Redis?.ttl || 3600
      }
    };
  }
} catch (e) {
  console.error(`读取配置文件失败（${configPath}），使用默认配置:`, e.message);
}
const app = express();
const apiRouter = require('./api')(config.dir);
const updateRouter = require('./update')(config.dir);
const webApp = require('./web')(config.dir);

app.use(express.static(__dirname));
app.use('/api', apiRouter);
app.use('/update', updateRouter);
app.use('/', webApp);

// 启动 HTTPS 服务（如果启用）
if (config.web.httpsPort && config.web.httpsPort > 0) {
  try {
    const key = fs.readFileSync(path.resolve(__dirname, config.web.keyFile));
    const cert = fs.readFileSync(path.resolve(__dirname, config.web.crtFile));
    const httpsOptions = { key, cert };

    https.createServer(httpsOptions, app).listen(config.web.httpsPort, config.web.host, () => {
      console.log(`HTTPS 服务器已启动：https://${config.web.host}:${config.web.httpsPort}`);
    });
  } catch (e) {
    console.error('HTTPS 启动失败，请检查证书路径:', e);
  }
}

// 启动 HTTP 服务（如启用 forceHttps 则做 301 重定向）
if (config.web.httpPort && config.web.httpPort > 0) {
  if (config.web.forceHttps && config.web.httpsPort > 0) {
    // HTTP -> HTTPS 重定向服务器
    http.createServer((req, res) => {
      const host = req.headers.host?.split(':')[0] || config.web.host;
      const redirectURL = `https://${host}:${config.web.httpsPort}${req.url}`;
      res.writeHead(301, { Location: redirectURL });
      res.end();
    }).listen(config.web.httpPort, config.web.host, () => {
      console.log(`HTTP 重定向服务已启动：http://${config.web.host}:${config.web.httpPort} → https`);
    });
  } else {
    // 普通 HTTP 服务
    http.createServer(app).listen(config.web.httpPort, config.web.host, () => {
      console.log(`HTTP 服务器已启动：http://${config.web.host}:${config.web.httpPort}`);
    });
  }
}
