const fs = require('fs-extra');
const path = require('path');
const mimeTypes = require('mime-types');
const { log, safeReadJson } = require('./utils');

let config;
let cacheManager;
let imageList = {};
let imageDetails = [];

// 文件存在性缓存
const fileExistsCache = new Map();
const FILE_CACHE_TTL = 300000; // 5分钟缓存
const MAX_FILE_CACHE_SIZE = 10000;

// 请求限流
const requestCounts = new Map();
const REQUEST_LIMIT = 200; // 每秒最大请求数
const WINDOW_SIZE = 1000; // 1秒窗口
const MAX_CLIENTS = 1000; // 最大客户端跟踪数

// 缓存的文件存在性检查
async function cachedPathExists(filePath) {
    const now = Date.now();
    const cached = fileExistsCache.get(filePath);
    
    // 如果缓存存在且未过期，直接返回
    if (cached && (now - cached.timestamp) < FILE_CACHE_TTL) {
        return cached.exists;
    }
    
    // 执行实际的文件系统检查
    const exists = await fs.pathExists(filePath);
    fileExistsCache.set(filePath, { exists, timestamp: now });
    
    // 定期清理过期缓存，避免内存泄漏
    if (fileExistsCache.size > MAX_FILE_CACHE_SIZE) {
        cleanupFileCache();
    }
    
    return exists;
}

// 清理过期的文件缓存
function cleanupFileCache() {
    const now = Date.now();
    let cleanedCount = 0;
    
    for (const [filePath, data] of fileExistsCache.entries()) {
        if (now - data.timestamp > FILE_CACHE_TTL) {
            fileExistsCache.delete(filePath);
            cleanedCount++;
        }
    }
    
    if (cleanedCount > 0) {
        log(`Cleaned up ${cleanedCount} expired file cache entries`, 'DEBUG', 'API');
    }
}

// 请求限流检查
function checkRateLimit(clientIP) {
    const now = Date.now();
    const windowStart = now - WINDOW_SIZE;
    
    // 初始化客户端请求记录
    if (!requestCounts.has(clientIP)) {
        requestCounts.set(clientIP, []);
    }
    
    const requests = requestCounts.get(clientIP);
    
    // 清理过期请求记录
    const validRequests = requests.filter(time => time > windowStart);
    requestCounts.set(clientIP, validRequests);
    
    // 检查是否超过限制
    if (validRequests.length >= REQUEST_LIMIT) {
        return false;
    }
    
    // 记录当前请求
    validRequests.push(now);
    
    // 定期清理客户端记录，防止内存泄漏
    if (requestCounts.size > MAX_CLIENTS) {
        cleanupRequestCounts();
    }
    
    return true;
}

// 清理请求计数器
function cleanupRequestCounts() {
    const now = Date.now();
    const windowStart = now - WINDOW_SIZE;
    let cleanedCount = 0;
    
    for (const [clientIP, requests] of requestCounts.entries()) {
        const validRequests = requests.filter(time => time > windowStart);
        if (validRequests.length === 0) {
            requestCounts.delete(clientIP);
            cleanedCount++;
        } else {
            requestCounts.set(clientIP, validRequests);
        }
    }
    
    if (cleanedCount > 0) {
        log(`Cleaned up ${cleanedCount} inactive client rate limit records`, 'DEBUG', 'API');
    }
}

// 加载图片列表
async function loadImageList() {
    try {
        log('Starting to load image list...', 'DEBUG', 'API');
        
        const listPath = path.join(__dirname, 'list.json');
        const newImageList = await safeReadJson(listPath, {});
        
        const detailsPath = path.join(__dirname, 'images-details.json');
        let newImageDetails = await safeReadJson(detailsPath, []);
        
        // 如果details为空但list不为空，进行转换
        if (newImageDetails.length === 0 && Object.keys(newImageList).length > 0) {
            newImageDetails = convertListToDetails(newImageList);
            log(`Converted ${newImageDetails.length} images from list.json format`, 'WARN', 'API');
        }
        
        // 原子性更新，避免并发访问时数据不一致
        imageList = newImageList;
        imageDetails = newImageDetails;
        
        // 清理文件缓存，因为文件列表可能已更改
        fileExistsCache.clear();
        
        log(`Image list loaded: ${Object.keys(imageList).length} directories, ${imageDetails.length} total images`, 'INFO', 'API');
        
    } catch (err) {
        log(`Failed to load image list: ${err.message}`, 'ERROR', 'API');
        // 不清空现有数据，保持服务可用性
        if (Object.keys(imageList).length === 0 && imageDetails.length === 0) {
            imageList = {};
            imageDetails = [];
        }
    }
}

// 从 list.json 转换为详细信息格式
function convertListToDetails(listData) {
    const details = [];
    const baseImagePath = path.resolve(config.paths.images);
    
    for (const [directory, files] of Object.entries(listData)) {
        if (!files || typeof files !== 'object') {
            continue;
        }
        
        for (const [filename, uploadtime] of Object.entries(files)) {
            try {
                const dirPath = directory === '_root' ? '' : directory;
                const fullPath = path.join(baseImagePath, dirPath, filename);
                const relativePath = path.join(dirPath, filename).replace(/\\/g, '/');
                
                details.push({
                    name: filename,
                    size: 0, // 大小信息在需要时获取
                    uploadtime,
                    path: relativePath, // 相对路径，用于拼接URL
                    _fullPath: fullPath, // 完整文件系统路径
                    _directory: directory,
                    _extension: path.extname(filename).toLowerCase(),
                    _mimeType: mimeTypes.lookup(fullPath) || 'application/octet-stream'
                });
            } catch (itemErr) {
                log(`Error processing item ${filename} in ${directory}: ${itemErr.message}`, 'WARN', 'API');
            }
        }
    }
    
    log(`Converted ${details.length} images from ${Object.keys(listData).length} directories`, 'DEBUG', 'API');
    return details;
}

// 设置CORS头
function setCorsHeaders(res) {
    if (config.server.cors.enabled) {
        res.setHeader('Access-Control-Allow-Origin', config.server.cors.origins);
        res.setHeader('Access-Control-Allow-Methods', config.server.cors.methods);
        res.setHeader('Access-Control-Allow-Headers', config.server.cors.headers);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
    }
}

// 获取随机图片
function getRandomImage(directory = null) {
    if (imageDetails.length === 0) {
        log('No images available for random selection', 'DEBUG', 'API');
        return null;
    }
    
    let filtered = imageDetails;
    
    // 如果指定了目录，进行过滤
    if (directory) {
        filtered = imageDetails.filter(img => {
            if (directory === '_root') {
                return img._directory === '_root';
            } else {
                return img._directory === directory || img.path.startsWith(directory + '/');
            }
        });
        
        if (filtered.length === 0) {
            log(`No images found in directory: ${directory}`, 'DEBUG', 'API');
            return null;
        }
    }
    
    // 随机选择
    const randomIndex = Math.floor(Math.random() * filtered.length);
    const selectedImage = filtered[randomIndex];
    
    log(`Random image selected: ${selectedImage.name} from ${filtered.length} candidates`, 'DEBUG', 'API');
    return selectedImage;
}

// 查找特定图片
function findSpecificImage(directory, filename) {
    const targetPath = path.join(directory, filename).replace(/\\/g, '/');
    
    const found = imageDetails.find(img => {
        if (directory === '_root') {
            return img._directory === '_root' && img.name === filename;
        } else {
            return img.path === targetPath;
        }
    });
    
    if (found) {
        log(`Specific image found: ${found.name} at ${found.path}`, 'DEBUG', 'API');
    } else {
        log(`Specific image not found: ${targetPath}`, 'DEBUG', 'API');
    }
    
    return found;
}

// 判断是否为随机请求
function isRandomRequest(parts) {
    return parts.length < 2;
}

// 生成缓存键
function generateCacheKey(req, parts) {
    if (isRandomRequest(parts)) {
        return null; // 随机请求不缓存
    }
    
    const base = `api:${req.path}`;
    const suffix = req.query.json === '1' ? ':json' : ':file';
    return base + suffix;
}

// 获取客户端IP
function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           req.ip ||
           'unknown';
}

// 处理API请求
async function handleApiRequest(req, res) {
    const startTime = Date.now();
    
    // 设置CORS头
    setCorsHeaders(res);
    
    // 处理OPTIONS请求
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }
    
    // 请求限流检查
    const clientIP = getClientIP(req);
    if (!checkRateLimit(clientIP)) {
        log(`Rate limit exceeded for client: ${clientIP}`, 'WARN', 'API', req);
        return res.status(429).json({
            error: 'Too Many Requests',
            message: 'Rate limit exceeded. Please slow down your requests.',
            retryAfter: Math.ceil(WINDOW_SIZE / 1000)
        });
    }
    
    // 解析请求路径
    const isJson = req.query.json === '1';
    const parts = req.path.split('/').filter(p => p && p.trim());
    parts.shift(); // 移除 'api'
    
    const isRandom = isRandomRequest(parts);
    const cacheKey = generateCacheKey(req, parts);
    const cleanPath = req.originalUrl.split('?')[0];
    
    try {
        // 缓存检查（仅限指定文件请求）
        if (!isRandom && cacheKey) {
            const cached = await cacheManager.get(cacheKey);
            if (cached) {
                log(`Cache hit: ${cacheKey} (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
                
                if (isJson) {
                    return res.json(cached);
                }
                
                // 验证缓存的文件是否仍然存在
                const filePath = cached._fullPath || cached.fullPath || path.resolve(cached.path);
                if (await cachedPathExists(filePath)) {
                    res.setHeader('Content-Type', mimeTypes.lookup(filePath) || 'image/jpeg');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    res.setHeader('X-Cache', 'HIT');
                    return res.sendFile(filePath);
                } else {
                    // 文件不存在，清理缓存
                    await cacheManager.del(cacheKey);
                    log(`Cleared stale cache for missing file: ${cacheKey}`, 'WARN', 'API', req);
                }
            }
        }
        
        // 图片选择逻辑
        let selectedImage;
        if (parts.length === 0) {
            // 全部图片中随机选择
            selectedImage = getRandomImage();
            log(`Random selection from all images (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
        } else if (parts.length === 1) {
            // 指定目录中随机选择
            selectedImage = getRandomImage(parts[0]);
            log(`Random selection from directory: ${parts[0]} (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
        } else {
            // 查找特定图片
            selectedImage = findSpecificImage(parts[0], parts.slice(1).join('/'));
            if (selectedImage) {
                // 验证文件是否存在
                const exists = await cachedPathExists(selectedImage._fullPath);
                if (!exists) {
                    log(`Specific image file not found: ${selectedImage._fullPath}`, 'WARN', 'API', req);
                    selectedImage = null;
                } else {
                    log(`Specific image found: ${parts.join('/')} (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
                }
            }
        }
        
        // 图片未找到
        if (!selectedImage) {
            const processingTime = Date.now() - startTime;
            log(`Image not found (${processingTime}ms)`, 'WARN', 'API', req);
            
            return res.status(404).json({
                error: 'Image not found',
                path: cleanPath,
                message: getNotFoundMessage(parts),
                processingTime
            });
        }
        
        // 构建响应数据
        const imagePath = selectedImage._fullPath;
        const webPath = '/api/' + selectedImage.path;
        
        const imageInfo = {
            name: selectedImage.name,
            size: selectedImage.size,
            uploadtime: selectedImage.uploadtime,
            path: webPath,
            processingTime: Date.now() - startTime
        };
        
        // 写入缓存（仅限特定图片请求）
        if (!isRandom && cacheKey) {
            const cacheData = {
                ...imageInfo,
                _fullPath: imagePath,
                cached_at: require('./utils').getCurrentTimestamp()
            };
            
            try {
                await cacheManager.set(cacheKey, cacheData);
                log(`Cached: ${cacheKey}`, 'DEBUG', 'API', req);
            } catch (cacheErr) {
                log(`Failed to cache ${cacheKey}: ${cacheErr.message}`, 'WARN', 'API', req);
            }
        }
        
        // JSON响应
        if (isJson) {
            log(`JSON response returned (${imageInfo.processingTime}ms)`, 'DEBUG', 'API', req);
            return res.json(imageInfo);
        }
        
        // 文件响应
        const mimeType = selectedImage._mimeType || mimeTypes.lookup(imagePath) || 'image/jpeg';
        
        res.setHeader('Content-Type', mimeType);
        res.setHeader('Cache-Control', isRandom ? 
            'no-cache, no-store, must-revalidate' : 
            'public, max-age=3600'
        );
        res.setHeader('X-Image-Name', selectedImage.name);
        res.setHeader('X-Image-Path', imageInfo.path);
        res.setHeader('X-Is-Random', isRandom.toString());
        res.setHeader('X-Processing-Time', imageInfo.processingTime.toString());
        res.setHeader('X-Cache', 'MISS');
        
        log(`File response sent: ${selectedImage.name} (${imageInfo.processingTime}ms)`, 'DEBUG', 'API', req);
        return res.sendFile(path.resolve(imagePath));
        
    } catch (err) {
        const processingTime = Date.now() - startTime;
        log(`API error: ${err.message} (${processingTime}ms)`, 'ERROR', 'API', req);
        log(`Error stack: ${err.stack}`, 'DEBUG', 'API');
        
        return res.status(500).json({
            error: 'Internal server error',
            path: cleanPath,
            message: process.env.NODE_ENV === 'development' ? err.message : 'Something went wrong',
            processingTime
        });
    }
}

// 生成404错误消息
function getNotFoundMessage(parts) {
    if (parts.length === 0) {
        return 'No images available';
    } else if (parts.length === 1) {
        return `No images found in directory: ${parts[0]}`;
    } else {
        return `Image not found: ${parts.join('/')}`;
    }
}

// 获取API统计信息
function getApiStats() {
    return {
        images: {
            total: imageDetails.length,
            directories: Object.keys(imageList).length
        },
        cache: cacheManager.getStatus(),
        performance: {
            fileExistsCacheSize: fileExistsCache.size,
            rateLimitClientsTracked: requestCounts.size,
            fileCacheTTL: FILE_CACHE_TTL / 1000 + 's',
            requestLimit: REQUEST_LIMIT + '/s'
        },
        caching: {
            randomRequestsCached: false,
            specificImagesCached: true,
            description: 'Only specific image requests are cached to ensure proper randomization'
        }
    };
}

// 清理函数，定期调用以防止内存泄漏
function performMaintenance() {
    cleanupFileCache();
    cleanupRequestCounts();
    log('Performed maintenance cleanup', 'DEBUG', 'API');
}

// 启动API服务
async function start(appConfig, cacheMgr) {
    try {
        config = appConfig;
        cacheManager = cacheMgr;
        
        // 设置工作进程ID
        process.env.WORKER_ID = process.env.WORKER_ID ||
            (require('cluster').worker ? require('cluster').worker.id : '1');
        
        // 初始加载图片列表
        await loadImageList();
        
        // 定时重新加载图片列表（降低频率到5分钟）
        const reloadInterval = setInterval(async () => {
            try {
                await loadImageList();
            } catch (err) {
                log(`Scheduled reload failed: ${err.message}`, 'ERROR', 'API');
            }
        }, 300000); // 5分钟
        
        // 定时维护清理（每10分钟）
        const maintenanceInterval = setInterval(performMaintenance, 600000);
        
        // 优雅关闭时清理定时器
        const originalExit = process.exit;
        process.exit = function(code) {
            clearInterval(reloadInterval);
            clearInterval(maintenanceInterval);
            originalExit.call(process, code);
        };
        
        log(`API started with ${imageDetails.length} images`, 'INFO', 'API');
        log('Cache policy: random ⛔, specific ✅', 'INFO', 'API');
        log(`File exists cache TTL: ${FILE_CACHE_TTL/1000}s, Request limit: ${REQUEST_LIMIT}/s`, 'INFO', 'API');
        
        return {
            handleApiRequest,
            loadImageList,
            getApiStats,
            performMaintenance
        };
        
    } catch (err) {
        log(`Failed to start API: ${err.message}`, 'ERROR', 'API');
        throw err;
    }
}

module.exports = { start };