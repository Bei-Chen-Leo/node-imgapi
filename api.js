const express = require('express');
const fs = require('fs');
const path = require('path');
const { createClient } = require('redis');

module.exports = (config) => {
  const router = express.Router();
  const IMG_DIR = config.imgDir;

  const redisEnable = config.Redis?.enable === true;
  const redisHost = config.Redis?.host || '127.0.0.1';
  const redisPort = config.Redis?.port || 6379;
  const redisPassword = config.Redis?.password || '';
  const redisTTL = config.Redis?.ttl || 3600;

  let redisClient = null;

  if (redisEnable) {
    redisClient = createClient({
      socket: { host: redisHost, port: redisPort },
      password: redisPassword || undefined,
    });
    redisClient.connect().catch(console.error);
  }

  function isImageFile(filename) {
    return /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
  }

  function formatShanghaiTime(date) {
    return new Intl.DateTimeFormat('zh-CN', {
      timeZone: 'Asia/Shanghai',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: false,
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
    const key = `imgcache:${filePath}`;
    if (redisEnable && redisClient) {
      try {
        const cached = await redisClient.get(key);
        if (cached) {
          return JSON.parse(cached);
        }
      } catch (e) {
        console.error('Redis get error:', e);
      }
    }

    const stats = fs.statSync(filePath);
    const info = {
      filename: path.basename(filePath),
      size: stats.size,
      mtime: formatShanghaiTime(stats.mtime),
      path: `/${path.relative(IMG_DIR, filePath).replace(/\\/g, '/')}`
    };

    if (redisEnable && redisClient) {
      try {
        await redisClient.setEx(key, redisTTL, JSON.stringify(info));
      } catch (e) {
        console.error('Redis set error:', e);
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
        const targetFile = path.join(IMG_DIR, dir, file);
        if (!fs.existsSync(targetFile) || !fs.statSync(targetFile).isFile()) {
          return res.status(404).send('图片不存在');
        }
        if (wantJson) {
          return res.json(await getFileInfo(targetFile));
        }
        return res.sendFile(targetFile);
      }

      let images = [];

      if (!dir) {
        images = getAllImages(IMG_DIR);
      } else {
        const targetDir = path.join(IMG_DIR, dir);
        if (!fs.existsSync(targetDir) || !fs.statSync(targetDir).isDirectory()) {
          return res.status(404).send('目录不存在');
        }
        images = getImagesInDir(targetDir);
      }

      if (images.length === 0) {
        return res.status(404).send('该目录无图片');
      }

      const randomImage = images[Math.floor(Math.random() * images.length)];

      if (wantJson) {
        return res.json(await getFileInfo(randomImage));
      }
      return res.sendFile(randomImage);
    } catch (e) {
      console.error(e);
      res.status(500).send('服务器错误');
    }
  });

  return router;
};
