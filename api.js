const express = require('express');
const fs = require('fs/promises');
const path = require('path');
const { createClient } = require('redis');

// 简化时间格式函数
const formatTime = date =>
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
    .format(date)
    .replace(/\//g, '-')
    .replace(/,/g, '');

module.exports = (dirConfig, cacheConfig) => {
  const router = express.Router();
  const IMG_DIR = dirConfig.imgDir;
  const USE_REDIS = cacheConfig.redisEnable;
  const MAX_CACHE = cacheConfig.mapMaxSize || 100;

  // —— CORS 中间件 —— 
  router.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
    if (req.method === 'OPTIONS') return res.sendStatus(204);
    next();
  });

  // 初始化 Redis 客户端
  let redisClient = null;
  if (USE_REDIS) {
    let retries = 0;
    redisClient = createClient({
      socket: {
        host: cacheConfig.redisHost,
        port: cacheConfig.redisPort,
        connectTimeout: 5000,
        reconnectStrategy: attempt => {
          retries += 1;
          if (retries > 5) return new Error('停止重连');
          return Math.min(1000 * attempt, 5000);
        }
      },
      password: cacheConfig.redisPassword
    });
    redisClient
      .on('connect', () => console.log('[Redis] 连接成功'))
      .on('reconnecting', () => console.log('[Redis] 尝试重连…'))
      .on('end', () => console.warn('[Redis] 已断开'))
      .on('error', err => console.error('[Redis Error]', err.message));
    redisClient.connect().catch(err => console.error('[Redis] 连接失败', err.message));
  }

  // LRU 逻辑替代简单 Map
  const fileCache = new Map();

  // 延迟扫描并缓存所有图片路径
  let allImages = null;
  async function scanAllImages() {
    if (allImages) return allImages;
    const list = [];
    async function walk(dir) {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      await Promise.all(
        entries.map(async e => {
          const full = path.join(dir, e.name);
          if (e.isDirectory()) await walk(full);
          else if (/\.(jpe?g|png|gif|webp)$/i.test(e.name)) list.push(full);
        })
      );
    }
    await walk(IMG_DIR);
    allImages = list;
    return list;
  }

  // 获取指定目录下的图片列表
  async function getImagesInDir(dir) {
    const list = await scanAllImages();
    return list.filter(p => path.dirname(p) === dir);
  }

  // 获取并缓存文件信息
  async function getFileInfo(filePath, ip = 'unknown') {
    const key = `img:${filePath}`;
    const now = formatTime(new Date());

    // Redis 缓存优先
    if (USE_REDIS) {
      try {
        const cached = await redisClient.get(key);
        if (cached) {
          console.log(`${now} ${ip} [Redis Hit] ${filePath}`);
          return JSON.parse(cached);
        }
      } catch (e) {
        console.error(`${now} [Redis Error]`, e.message);
      }
    }

    // 本地 LRU 缓存
    if (!USE_REDIS && fileCache.has(filePath)) {
      const info = fileCache.get(filePath);
      fileCache.delete(filePath);
      fileCache.set(filePath, info);
      console.log(`${now} ${ip} [Map Hit] ${filePath}`);
      return info;
    }

    console.log(`${now} ${ip} [Cache Miss] ${filePath}`);
    const stats = await fs.stat(filePath);
    const info = {
      filename: path.basename(filePath),
      size: stats.size,
      mtime: formatTime(stats.mtime),
      path: '/api/' + path.relative(IMG_DIR, filePath).replace(/\\/g, '/')
    };

    // 回写缓存
    if (USE_REDIS) {
      redisClient.set(key, JSON.stringify(info)).catch(e =>
        console.error(`${now} [Redis Set Error]`, e.message)
      );
    } else {
      fileCache.set(filePath, info);
      if (fileCache.size > MAX_CACHE) {
        fileCache.delete(fileCache.keys().next().value);
      }
    }

    return info;
  }

  // 路由处理
  router.get('/*', async (req, res) => {
    try {
      const wantJson = req.query.json === '1';
      const rel = (req.params[0] || '').replace(/^\/+/, '');
      const ip = (req.headers['x-forwarded-for'] || req.ip).split(',')[0].trim();

      // 根目录随机图片
      if (!rel) {
        const list = await scanAllImages();
        if (!list.length) return res.status(404).send('该目录无图片');
        const pick = list[Math.floor(Math.random() * list.length)];
        const info = await getFileInfo(pick, ip);
        return wantJson ? res.json(info) : res.sendFile(pick);
      }

      const abs = path.join(IMG_DIR, rel);
      let stat;
      try {
        stat = await fs.stat(abs);
      } catch {
        return res.status(404).send('图片不存在／非法路径');
      }

      // 目录下随机图片
      if (stat.isDirectory()) {
        const arr = await getImagesInDir(abs);
        if (!arr.length) return res.status(404).send('该目录无图片');
        const pick = arr[Math.floor(Math.random() * arr.length)];
        const info = await getFileInfo(pick, ip);
        return wantJson ? res.json(info) : res.sendFile(pick);
      }

      // 单个文件
      const info = await getFileInfo(abs, ip);
      return wantJson ? res.json(info) : res.sendFile(abs);
    } catch (err) {
      console.error('[API Error]', err);
      res.status(500).send('服务器错误');
    }
  });

  return router;
};