const fs = require('fs-extra');
const path = require('path');
const mimeTypes = require('mime-types');
const { log, safeReadJson } = require('./utils');

let config;
let cacheManager;
let imageList = {};
let imageDetails = [];

// 加载图片列表
async function loadImageList() {
    try {
        const listPath = path.join(__dirname, 'list.json');
        imageList = await safeReadJson(listPath, {});
        const detailsPath = path.join(__dirname, 'images-details.json');
        imageDetails = await safeReadJson(detailsPath, []);
        if (imageDetails.length === 0 && Object.keys(imageList).length > 0) {
            imageDetails = convertListToDetails(imageList);
            log(`Converted ${imageDetails.length} images from list.json format`, 'WARN', 'API');
        }
        log(`Image list loaded: ${Object.keys(imageList).length} directories, ${imageDetails.length} total images`, 'INFO', 'API');
    } catch (err) {
        log(`Failed to load image list: ${err.message}`, 'ERROR', 'API');
        imageList = {};
        imageDetails = [];
    }
}

// 从 list.json 转详细信息
function convertListToDetails(listData) {
    const details = [];
    const baseImagePath = path.resolve(config.paths.images);
    for (const [directory, files] of Object.entries(listData)) {
        if (!files || typeof files !== 'object') continue;
        for (const [filename, uploadtime] of Object.entries(files)) {
            try {
                const dirPath = directory === '_root' ? '' : directory;
                const fullPath = path.join(baseImagePath, dirPath, filename);
                details.push({
                    name: filename,
                    size: 0,
                    uploadtime,
                    // 这里是相对路径，用于拼接真实 URL
                    path: path.join(dirPath, filename).replace(/\\/g, '/'),
                    _fullPath: fullPath,
                    _directory: directory,
                    _extension: path.extname(filename).toLowerCase(),
                    _mimeType: mimeTypes.lookup(fullPath) || 'application/octet-stream'
                });
            } catch (itemErr) {
                log(`Error processing item ${filename}: ${itemErr.message}`, 'WARN', 'API');
            }
        }
    }
    return details;
}

function setCorsHeaders(res) {
    if (config.server.cors.enabled) {
        res.setHeader('Access-Control-Allow-Origin', config.server.cors.origins);
        res.setHeader('Access-Control-Allow-Methods', config.server.cors.methods);
        res.setHeader('Access-Control-Allow-Headers', config.server.cors.headers);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
}

function getRandomImage(directory = null) {
    if (imageDetails.length === 0) return null;
    let filtered = imageDetails;
    if (directory) {
        filtered = filtered.filter(img =>
            directory === '_root'
                ? img._directory === '_root'
                : img._directory === directory || img.path.startsWith(directory + '/')
        );
    }
    if (filtered.length === 0) return null;
    return filtered[Math.floor(Math.random() * filtered.length)];
}

function findSpecificImage(directory, filename) {
    return imageDetails.find(img =>
        directory === '_root'
            ? img._directory === '_root' && img.name === filename
            : img.path === path.join(directory, filename).replace(/\\/g, '/')
    );
}

function isRandomRequest(parts) {
    return parts.length < 2;
}

function generateCacheKey(req, parts) {
    if (isRandomRequest(parts)) return null;
    const base = `api:${req.path}`;
    const suffix = req.query.json === '1' ? ':json' : ':file';
    return base + suffix;
}

async function handleApiRequest(req, res) {
    setCorsHeaders(res);
    if (req.method === 'OPTIONS') return res.status(200).end();

    const isJson = req.query.json === '1';
    const parts = req.path.split('/').filter(p => p);
    parts.shift(); // 去掉 'api'

    let imagePath, imageInfo;
    const isRandom = isRandomRequest(parts);
    const cacheKey = generateCacheKey(req, parts);

    // cleanPath 用于错误返回时指示请求端点
    const cleanPath = req.originalUrl.split('?')[0];

    try {
        // 缓存检查（仅限指定文件请求）
        if (!isRandom && cacheKey) {
            const cached = await cacheManager.get(cacheKey);
            if (cached) {
                log(`Cache hit: ${cacheKey}`, 'DEBUG', 'API', req);
                if (isJson) return res.json(cached);

                const fp = cached._fullPath || cached.fullPath || path.resolve(cached.path);
                if (await fs.pathExists(fp)) {
                    res.setHeader('Content-Type', mimeTypes.lookup(fp) || 'image/jpeg');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    return res.sendFile(fp);
                }
                await cacheManager.del(cacheKey);
                log(`Cleared stale cache: ${cacheKey}`, 'WARN', 'API', req);
            }
        }

        // 路由处理
        let img;
        if (parts.length === 0) {
            img = getRandomImage();
            log('Random all-images', 'DEBUG', 'API', req);
        } else if (parts.length === 1) {
            img = getRandomImage(parts[0]);
            log(`Random directory ${parts[0]}`, 'DEBUG', 'API', req);
        } else {
            img = findSpecificImage(parts[0], parts.slice(1).join('/'));
            if (img && await fs.pathExists(img._fullPath)) {
                log(`Specific image ${parts.join('/')}`, 'DEBUG', 'API', req);
            } else {
                img = null;
            }
        }

        if (!img) {
            log('Image not found', 'WARN', 'API', req);
            return res.status(404).json({
                error: 'Image not found',
                path: cleanPath,
                message: parts.length < 2
                    ? (parts.length === 0 ? 'No images available' : `No images in directory ${parts[0]}`)
                    : `Image not found: ${parts.join('/')}`
            });
        }

        // 真正文件系统路径
        imagePath = img._fullPath;
        // 生成真正对外的 URL path：/api/<relative-path>
        const webPath = '/api/' + img.path;

        imageInfo = {
            name: img.name,
            size: img.size,
            uploadtime: img.uploadtime,
            path: webPath
        };

        // 写缓存
        if (!isRandom && cacheKey) {
            await cacheManager.set(cacheKey, {
                ...imageInfo,
                _fullPath: imagePath,
                cached_at: require('./utils').getCurrentTimestamp()
            });
            log(`Cached ${cacheKey}`, 'DEBUG', 'API', req);
        }

        // JSON 返回
        if (isJson) {
            log('Returning JSON response', 'DEBUG', 'API', req);
            return res.json(imageInfo);
        }

        // 文件返回
        res.setHeader('Content-Type', mimeTypes.lookup(imagePath) || 'image/jpeg');
        res.setHeader('Cache-Control', isRandom ? 'no-cache, no-store, must-revalidate' : 'public, max-age=3600');
        res.setHeader('X-Image-Name', path.basename(imagePath));
        res.setHeader('X-Image-Path', imageInfo.path);
        res.setHeader('X-Is-Random', isRandom.toString());
        log(`Returning file (random=${isRandom})`, 'DEBUG', 'API', req);
        return res.sendFile(path.resolve(imagePath));

    } catch (err) {
        log(`API error: ${err.message}`, 'ERROR', 'API', req);
        log(`Stack: ${err.stack}`, 'DEBUG', 'API');
        return res.status(500).json({
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong'
        });
    }
}

// 获取 API 状态
function getApiStats() {
    return {
        images: { total: imageDetails.length, directories: Object.keys(imageList).length },
        cache: cacheManager.getStatus(),
        caching: {
            randomRequestsCached: false,
            specificImagesCached: true,
            description: 'Only specific image requests are cached to ensure proper randomization'
        }
    };
}

// 启动服务
async function start(appConfig, cacheMgr) {
    config = appConfig;
    cacheManager = cacheMgr;
    process.env.WORKER_ID = process.env.WORKER_ID ||
        (require('cluster').worker ? require('cluster').worker.id : '1');
    await loadImageList();
    setInterval(loadImageList, 60000);
    log(`API started with ${imageDetails.length} images`, 'INFO', 'API');
    log('Cache policy: random ⛔, specific ✅', 'INFO', 'API');
    return { handleApiRequest, loadImageList, getApiStats };
}

module.exports = { start };
