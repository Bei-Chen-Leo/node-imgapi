'use strict'

const path = require('path')
const fs = require('fs/promises')
const fsSync = require('fs')
const express = require('express')
const http = require('http')
const https = require('https')

// 默认配置
const defaultConfig = {
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
  },
  update: {
    updateHours: -1
  }
}

const CONFIG_PATH = path.join(__dirname, 'config', 'config.json')

// 获取当前时间（Asia/Shanghai）
const getNowTime = () =>
  new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false
  })
    .format(new Date())
    .replace(/\//g, '-')
    .replace(/,/g, '')

// 异步加载并合并配置
async function loadConfig() {
  let userConfig = {}
  try {
    if (fsSync.existsSync(CONFIG_PATH)) {
      const raw = await fs.readFile(CONFIG_PATH, 'utf-8')
      userConfig = JSON.parse(raw)
    }
  } catch (e) {
    console.error('读取 config.json 失败，使用默认配置:', e)
  }

  return {
    web: { ...defaultConfig.web, ...userConfig.web },
    dir: {
      imgDir: path.resolve(__dirname, userConfig.dir?.imgDir || defaultConfig.dir.imgDir),
      webDir: path.resolve(__dirname, userConfig.dir?.webDir || defaultConfig.dir.webDir)
    },
    cache: { ...defaultConfig.cache, ...userConfig.cache },
    update: { ...defaultConfig.update, ...userConfig.update }
  }
}

// 根据选项启动 HTTP/HTTPS 服务
function startServer({ port, host, redirectHttps, sslOptions, handler }) {
  return new Promise(resolve => {
    const server = redirectHttps
      ? http.createServer((req, res) => {
          const hostname = (req.headers.host || '').split(':')[0] || host
          const redirectURL = `https://${hostname}:${sslOptions.port}${req.url}`
          res.writeHead(301, { Location: redirectURL })
          res.end()
        })
      : sslOptions
      ? https.createServer(sslOptions, handler)
      : http.createServer(handler)

    server.listen(port, host, () => {
      const label = sslOptions
        ? `HTTPS (${host}:${port})`
        : redirectHttps
        ? `HTTP→HTTPS 重定向 (${host}:${port})`
        : `HTTP (${host}:${port})`
      console.log(`${label} 已启动`)
      resolve()
    })
  })
}

// 主入口
;(async () => {
  const { web, dir, cache, update } = await loadConfig()
  const app = express()

  // 静态目录
  app.use(express.static(__dirname))

  // HTML 访问日志
  app.use((req, res, next) => {
    if (req.path === '/' || req.path.endsWith('.html')) {
      const now = getNowTime()
      const ip = (req.headers['x-forwarded-for'] || req.ip).split(',')[0].trim()
      console.log(`${now} ${ip} [HTML Access] ${req.method} ${req.originalUrl}`)
    }
    next()
  })

  // 挂载路由
  app.use('/api', require('./api')(dir, cache))
  app.use('/update', require('./update')(dir, update))
  app.use('/', require('./web')(dir))

  // 如果启用 HTTPS，读取证书并准备选项
  let sslOptions = null
  if (web.httpsPort > 0) {
    try {
      sslOptions = {
        key: await fs.readFile(path.resolve(__dirname, web.keyFile)),
        cert: await fs.readFile(path.resolve(__dirname, web.crtFile)),
        port: web.httpsPort
      }
    } catch (e) {
      console.error('HTTPS 启动失败，证书读取错误:', e)
      sslOptions = null
    }
  }

  // 启动服务
  await Promise.all([
    web.httpsPort > 0 && startServer({
      port: web.httpsPort,
      host: web.host,
      redirectHttps: false,
      sslOptions,
      handler: app
    }),
    web.httpPort > 0 && startServer({
      port: web.httpPort,
      host: web.host,
      redirectHttps: web.forceHttps && sslOptions != null,
      sslOptions: null,
      handler: app
    })
  ].filter(Boolean))
})()