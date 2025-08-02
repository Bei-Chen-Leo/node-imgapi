const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

module.exports = (dirConfig, cacheConfig) => {
  const router = express.Router();
  const IMG_DIR = dirConfig.imgDir;
  const USE_REDIS = cacheConfig.redisEnable;

  let redisClient = null;
  if (USE_REDIS) {
    redisClient = createClient({
      socket: { host: cacheConfig.redisHost, port: cacheConfig.redisPort },
      password: cacheConfig.redisPassword || undefined
    });
    redisClient.connect().catch(console.error);
  }

  const fileCache = new Map();
  const MAX_CACHE = cacheConfig.mapMaxSize || 100;

  function isImageFile(filename) {
    return /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
  }

  function formatTime(date) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false
    }).format(date).replace(/\//g, '-').replace(/,/g, '');
  }

  function getAllImages(dir) {
    let images = [];
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name);
      if (entry.isFile() && isImageFile(entry.name)) {
        images.push(fullPath);
      } else if (entry.isDirectory()) {
        images = images.concat(getAllImages(fullPath));
      }
    }
    return images;
  }

  function getImagesInDir(dir) {
    if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) return [];
    return fs.readdirSync(dir)
      .filter(f => isImageFile(f))
      .map(f => path.join(dir, f));
  }

  async function getFileInfo(filePath) {
    const cacheKey = 'img:' + filePath;

    if (USE_REDIS) {
      try {
        const cached = await redisClient.get(cacheKey);
        if (cached) {
          console.log('[Redis Cache Hit]', filePath);
          return JSON.parse(cached);
        }
      } catch (e) {
        console.error('[Redis Error]', e.message);
      }
    } else if (fileCache.has(filePath)) {
      const info = fileCache.get(filePath);
      fileCache.delete(filePath);
      fileCache.set(filePath, info);
      console.log('[Map Cache Hit]', filePath);
      return info;
    }

    // 未命中缓存
    console.log('[Cache Miss]', filePath);
    const stats = fs.statSync(filePath);
    const info = {
      filename: path.basename(filePath),
      size: stats.size,
      mtime: formatTime(stats.mtime),
      path: '/' + path.relative(IMG_DIR, filePath).replace(/\\/g, '/')
    };

    if (USE_REDIS) {
      try {
        await redisClient.set(cacheKey, JSON.stringify(info));
      } catch (e) {
        console.error('[Redis Set Error]', e.message);
      }
    } else {
      fileCache.set(filePath, info);
      if (fileCache.size > MAX_CACHE) {
        fileCache.delete(fileCache.keys().next().value);
      }
    }

    return info;
  }

  router.get('/:dir?/:file?', async (req, res) => {
    try {
      const dir = req.params.dir;
      const file = req.params.file;
      const wantJson = req.query.json === '1';

      if (dir && file) {
        const filePath = path.join(IMG_DIR, dir, file);
        if (!fs.existsSync(filePath)) return res.status(404).send('图片不存在');

        const info = await getFileInfo(filePath);
        if (wantJson) return res.json(info);
        return res.sendFile(filePath);
      }

      const images = dir
        ? getImagesInDir(path.join(IMG_DIR, dir))
        : getAllImages(IMG_DIR);

      if (images.length === 0) return res.status(404).send('该目录无图片');

      const random = images[Math.floor(Math.random() * images.length)];
      const info = await getFileInfo(random);

      if (wantJson) return res.json(info);
      return res.sendFile(random);
    } catch (err) {
      console.error('[API Error]', err);
      res.status(500).send('服务器错误');
    }
  });

  return router;
};
