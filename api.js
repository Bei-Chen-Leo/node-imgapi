const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

module.exports = (dirConfig, cacheConfig) => {
  const router = express.Router();
  const IMG_DIR = dirConfig.imgDir;
  const USE_REDIS = cacheConfig.redisEnable;

  // —— CORS 中间件 —— 
  router.use((req, res, next) => {
    // 允许所有域名跨域访问
    res.setHeader('Access-Control-Allow-Origin', '*');
    // 如有需要可以限制特定来源：res.setHeader('Access-Control-Allow-Origin', 'https://example.com');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    // 预检请求直接返回
    if (req.method === 'OPTIONS') {
      return res.sendStatus(204);
    }
    next();
  });

  const fileCache = new Map();
  const MAX_CACHE = cacheConfig.mapMaxSize || 100;

  // Redis 客户端初始化
  let redisClient = null;
  if (USE_REDIS) {
    let retryCount = 0;
    const maxRetries = 5;
    redisClient = createClient({
      socket: {
        host: cacheConfig.redisHost,
        port: cacheConfig.redisPort,
        connectTimeout: 5000,
        reconnectStrategy: retries => {
          if (++retryCount > maxRetries) {
            console.error(`[Redis] 超过最大重连次数(${maxRetries})，停止重试`);
            return new Error('Redis 重连失败');
          }
          const delay = Math.min(1000 * retries, 5000);
          console.warn(`[Redis] 第 ${retryCount} 次重连，延迟 ${delay}ms`);
          return delay;
        }
      },
      password: cacheConfig.redisPassword || undefined
    });
    redisClient.on('connect', () => console.log('[Redis] 连接成功'));
    redisClient.on('reconnecting', () => console.log('[Redis] 尝试重连...'));
    redisClient.on('end', () => console.warn('[Redis] 连接已断开'));
    redisClient.on('error', err => console.error('[Redis Error]', err.message));
    redisClient.connect().catch(e => console.error('[Redis Connect Failed]', e.message));
  }

  function isImageFile(filename) {
    return /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(date).replace(/\//g, '-').replace(/,/g, '');
  }

  function getNowTime() {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false
    }).format(new Date()).replace(/\//g, '-').replace(/,/g, '');
  }

  function getAllImages(dir) {
    let images = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      const full = path.join(dir, e.name);
      if (e.isFile() && isImageFile(e.name)) images.push(full);
      else if (e.isDirectory()) images = images.concat(getAllImages(full));
    }
    return images;
  }

  function getImagesInDir(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
      .filter(f => isImageFile(f))
      .map(f => path.join(dir, f));
  }

  async function getFileInfo(filePath, ip = 'unknown') {
    const cacheKey = `img:${filePath}`;
    const now = getNowTime();

    if (USE_REDIS) {
      try {
        const raw = await redisClient.get(cacheKey);
        if (raw) {
          console.log(`${now} ${ip} [Redis Cache Hit] ${filePath}`);
          return JSON.parse(raw);
        }
      } catch (e) {
        console.error(`${now} [Redis Error] ${e.message}`);
      }
    }

    if (!USE_REDIS && fileCache.has(filePath)) {
      const info = fileCache.get(filePath);
      fileCache.delete(filePath);
      fileCache.set(filePath, info);
      console.log(`${now} ${ip} [Map Cache Hit] ${filePath}`);
      return info;
    }

    console.log(`${now} ${ip} [Cache Miss] ${filePath}`);
    const stats = fs.statSync(filePath);
    const info = {
      filename: path.basename(filePath),
      size: stats.size,
      mtime: formatTime(stats.mtime),
      path: '/api/' + path.relative(IMG_DIR, filePath).replace(/\\/g, '/')
    };

    if (USE_REDIS) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(info));
      } catch (e) {
        console.error(`${now} [Redis Set Error] ${e.message}`);
      }
    } else {
      fileCache.set(filePath, info);
      if (fileCache.size > MAX_CACHE) {
        fileCache.delete(fileCache.keys().next().value);
      }
    }

    return info;
  }

  router.get('/*', async (req, res) => {
    try {
      const wantJson = req.query.json === '1';
      const relPath = (req.params[0] || '').replace(/^\/+/, '');
      const ip = req.headers['x-forwarded-for']?.split(',')[0].trim() || req.ip;

      if (!relPath) {
        const all = getAllImages(IMG_DIR);
        if (all.length === 0) return res.status(404).send('该目录无图片');
        const pick = all[Math.floor(Math.random() * all.length)];
        const info = await getFileInfo(pick, ip);
        return wantJson ? res.json(info) : res.sendFile(pick);
      }

      const absPath = path.join(IMG_DIR, relPath);
      if (!fs.existsSync(absPath)) return res.status(404).send('图片不存在／非法路径');
      const stat = fs.statSync(absPath);

      if (stat.isDirectory()) {
        const arr = getImagesInDir(absPath);
        if (arr.length === 0) return res.status(404).send('该目录无图片');
        const pick = arr[Math.floor(Math.random() * arr.length)];
        const info = await getFileInfo(pick, ip);
        return wantJson ? res.json(info) : res.sendFile(pick);
      } else {
        const info = await getFileInfo(absPath, ip);
        return wantJson ? res.json(info) : res.sendFile(absPath);
      }
    } catch (err) {
      console.error('[API Error]', err);
      res.status(500).send('服务器错误');
    }
  });

  return router;
};
