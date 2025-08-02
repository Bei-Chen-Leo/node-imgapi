const express = require('express');
const fs = require('fs');
const path = require('path');
require('dotenv').config();

module.exports = function createUpdateRouter({ imgDir }) {
  const router = express.Router();
  const LIST_FILE = path.join(__dirname, 'list.json');

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

  // 主更新路由
  router.get('/', (req, res) => {
    const token = req.query.token;
    const validToken = process.env.UPDATE_TOKEN;

    if (!token || token.trim() !== (validToken || '').trim()) {
      return res.status(403).json({ error: '无效或缺失 token' });
    }

    fs.readdir(imgDir, { withFileTypes: true }, (err, entries) => {
      if (err) {
        return res.status(500).json({ error: '读取图片目录失败' });
      }

      const result = { _root: {} };
      let pending = entries.length;

      if (pending === 0) {
        return saveListJson(result, res);
      }

      entries.forEach(entry => {
        if (entry.isFile()) {
          if (isImageFile(entry.name)) {
            const filePath = path.join(imgDir, entry.name);
            const stats = fs.statSync(filePath);
            result._root[entry.name] = formatShanghaiTime(stats.mtime);
          }
          if (--pending === 0) saveListJson(result, res);
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
            if (--pending === 0) saveListJson(result, res);
          });
        } else {
          if (--pending === 0) saveListJson(result, res);
        }
      });
    });
  });

  // 写入 list.json 并返回结果
  function saveListJson(data, res) {
    fs.writeFile(LIST_FILE, JSON.stringify(data, null, 2), err => {
      if (err) {
        return res.status(500).json({ error: '写入 list.json 失败' });
      }

      const total = Object.values(data).reduce((sum, folder) => sum + Object.keys(folder).length, 0);
      res.json({
        message: '图片列表更新成功',
        count: total,
        listFile: 'list.json'
      });
    });
  }

  return router;
};
