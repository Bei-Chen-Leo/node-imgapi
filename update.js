const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

module.exports = function createUpdateRouter({ imgDir }, updateConfig = {}) {
  const router = express.Router();
  const LIST_FILE = path.join(__dirname, 'list.json');
  const UPDATE_INTERVAL_HOURS = updateConfig.updateHours ?? -1;

  // 判断是否为图片文件
  function isImageFile(filename) {
    return /\.(jpg|jpeg|png|gif|webp)$/i.test(filename);
  }

  // 格式化时间为 Asia/Shanghai
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

  // 主更新逻辑封装成函数，供手动和定时调用
  function generateListJson(callback = () => {}) {
    fs.readdir(imgDir, { withFileTypes: true }, (err, entries) => {
      if (err) return callback({ error: '读取图片目录失败' });

      const result = { _root: {} };
      let pending = entries.length;

      if (pending === 0) return callback(null, result);

      entries.forEach(entry => {
        if (entry.isFile()) {
          if (isImageFile(entry.name)) {
            const filePath = path.join(imgDir, entry.name);
            const stats = fs.statSync(filePath);
            result._root[entry.name] = formatShanghaiTime(stats.mtime);
          }
          if (--pending === 0) callback(null, result);
        } else if (entry.isDirectory()) {
          const subdir = entry.name;
          const subdirPath = path.join(imgDir, subdir);

          fs.readdir(subdirPath, (err, files) => {
            if (!err) {
              result[subdir] = {};
              files.forEach(file => {
                if (isImageFile(file)) {
                  const filePath = path.join(subdirPath, file);
                  const stats = fs.statSync(filePath);
                  result[subdir][file] = formatShanghaiTime(stats.mtime);
                }
              });
            }
            if (--pending === 0) callback(null, result);
          });
        } else {
          if (--pending === 0) callback(null, result);
        }
      });
    });
  }

  // 定期自动更新
  if (UPDATE_INTERVAL_HOURS > 0) {
    const intervalMs = UPDATE_INTERVAL_HOURS * 3600 * 1000;
    setInterval(() => {
      console.log(`[update] 自动刷新 list.json...`);
      generateListJson((err, data) => {
        if (err) return console.error('[update] 更新失败:', err);
        fs.writeFile(LIST_FILE, JSON.stringify(data, null, 2), e => {
          if (e) return console.error('[update] 写入失败:', e);
          console.log(`[update] list.json 自动更新成功`);
        });
      });
    }, intervalMs);
  }

  // 路由：手动触发更新
  router.get('/', (req, res) => {
    const token = req.query.token;
    const validToken = process.env.UPDATE_TOKEN;

    if (!token || token.trim() !== (validToken || '').trim()) {
      return res.status(403).json({ error: '无效或缺失 token' });
    }

    generateListJson((err, data) => {
      if (err) {
        return res.status(500).json(err);
      }
      fs.writeFile(LIST_FILE, JSON.stringify(data, null, 2), writeErr => {
        if (writeErr) {
          return res.status(500).json({ error: '写入 list.json 失败' });
        }
        const total = Object.values(data).reduce((sum, group) => sum + Object.keys(group).length, 0);
        res.json({
          message: '图片列表更新成功',
          count: total,
          listFile: 'list.json'
        });
      });
    });
  });

  return router;
};
