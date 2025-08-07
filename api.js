/**
 * @file API Service
 * @author Bei-Chen-Leo
 * @date 2025-08-06 15:47:11
 * @lastModifiedBy 114514-lang
 */

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

// 限流器实现
const requestLimiter = {
    windows: new Map(),        // 请求计数窗口
    banList: new Map(),        // 封禁列表
    windowSize: 60000,         // 1分钟窗口
    limit: 60,                 // 每分钟请求数
    maxClients: 100,          // 最大客户端数
    enabled: true,            // 是否启用
    cleanupInterval: 60000,   // 清理间隔（1分钟）
    banDuration: 10000,       // 封禁时长（测试用10秒）

    initialize(config) {
        // 设置默认值
        const defaults = {
            window_size: 60000,           // 1分钟窗口
            requests_per_minute: 60,      // 每分钟请求数
            max_clients: 100,             // 最大客户端数
            enabled: true,                // 启用限流
            cleanup_interval: 60000,      // 清理间隔
            ban_duration: 10000           // 封禁时长（测试用10秒）
        };

        // 如果没有配置，使用默认值
        if (!config.rate_limit) {
            log('Rate limit configuration missing, using defaults', 'WARN', 'API');
            config.rate_limit = defaults;
        }

        // 合并配置，确保所有字段都有值
        this.windowSize = config.rate_limit.window_size || defaults.window_size;
        this.limit = config.rate_limit.requests_per_minute || defaults.requests_per_minute;
        this.maxClients = config.rate_limit.max_clients || defaults.max_clients;
        this.enabled = config.rate_limit.enabled !== undefined ? config.rate_limit.enabled : defaults.enabled;
        this.cleanupInterval = config.rate_limit.cleanup_interval || defaults.cleanup_interval;
        this.banDuration = config.rate_limit.ban_duration || defaults.ban_duration;

        // 启动清理定时器
        setInterval(() => this.cleanup(), this.cleanupInterval);

        log(`Rate limiter initialized: ${this.limit} req/min, window: ${this.windowSize}ms, max clients: ${this.maxClients}, ban duration: ${this.banDuration}ms`, 'INFO', 'API');
    },

    isBanned(clientIP) {
        const banInfo = this.banList.get(clientIP);
        if (!banInfo) return false;

        const now = Date.now();
        if (now >= banInfo.endTime) {
            this.banList.delete(clientIP);
            // 重要：解封时清除该IP的请求记录
            this.windows.delete(clientIP);
            log(`Ban expired for client: ${clientIP}, clearing request history`, 'INFO', 'API');
            return false;
        }

        return true;
    },

    getBanStatus(clientIP) {
        const banInfo = this.banList.get(clientIP);
        if (!banInfo) return null;

        const now = Date.now();
        if (now >= banInfo.endTime) {
            this.banList.delete(clientIP);
            this.windows.delete(clientIP);
            return null;
        }

        return {
            remainingTime: Math.ceil((banInfo.endTime - now) / 1000), // 剩余秒数
            banEndTime: new Date(banInfo.endTime).toISOString(),
            reason: banInfo.reason
        };
    },

    banClient(clientIP, reason = 'Rate limit exceeded') {
        // 如果已经被封禁，不要更新封禁时间
        if (this.banList.has(clientIP)) {
            log(`Client ${clientIP} is already banned, skipping new ban`, 'DEBUG', 'API');
            return;
        }

        const now = Date.now();
        this.banList.set(clientIP, {
            startTime: now,
            endTime: now + this.banDuration,
            reason: reason
        });
        log(`Client banned: ${clientIP} (${reason}) for ${this.banDuration/1000} seconds`, 'WARN', 'API');
    },

    isAllowed(clientIP) {
        // 首先检查是否被封禁
        if (this.isBanned(clientIP)) {
            const banStatus = this.getBanStatus(clientIP);
            log(`Request rejected - client is banned: ${clientIP}, remaining time: ${banStatus.remainingTime}s`, 'DEBUG', 'API');
            return false;
        }

        if (!this.enabled) return true;
        
        const now = Date.now();
        
        if (this.windows.size > this.maxClients) {
            this.cleanup();
        }

        let requests = this.windows.get(clientIP);
        if (!requests) {
            if (this.windows.size >= this.maxClients) {
                log(`Max clients limit reached (${this.maxClients}), rejecting new client: ${clientIP}`, 'WARN', 'API');
                return false;
            }
            requests = [];
        }

        const windowStart = now - this.windowSize;
        requests = requests.filter(time => time > windowStart);

        // 记录调试信息
        log(`Rate limit check for ${clientIP}: ${requests.length}/${this.limit} requests in current window`, 'DEBUG', 'API');

        if (requests.length >= this.limit) {
            // 重要：在封禁前清除该IP的请求记录，这样解封后从0开始计数
            this.windows.delete(clientIP);
            // 触发临时封禁
            this.banClient(clientIP);
            return false;
        }

        requests.push(now);
        this.windows.set(clientIP, requests);
        return true;
    },

    cleanup() {
        const now = Date.now();
        const windowStart = now - this.windowSize;
        let cleaned = 0;

        // 清理请求记录
        for (const [ip, requests] of this.windows.entries()) {
            const validRequests = requests.filter(time => time > windowStart);
            
            if (validRequests.length === 0) {
                this.windows.delete(ip);
                cleaned++;
            } else {
                this.windows.set(ip, validRequests);
            }
        }

        // 清理过期的封禁记录
        for (const [ip, banInfo] of this.banList.entries()) {
            if (now >= banInfo.endTime) {
                this.banList.delete(ip);
                this.windows.delete(ip);
                cleaned++;
                log(`Ban expired and removed for client: ${ip}`, 'DEBUG', 'API');
            }
        }

        if (this.windows.size > this.maxClients) {
            const entries = [...this.windows.entries()]
                .sort((a, b) => Math.max(...a[1]) - Math.max(...b[1]));
            
            const toDelete = entries.slice(0, entries.length - this.maxClients);
            toDelete.forEach(([ip]) => this.windows.delete(ip));
            cleaned += toDelete.length;
        }

        if (cleaned > 0) {
            log(`Cleaned up ${cleaned} rate limit and ban records (current clients: ${this.windows.size})`, 'DEBUG', 'API');
        }
    },

    getStatus(clientIP) {
        // 先检查是否被封禁
        const banStatus = this.getBanStatus(clientIP);
        if (banStatus) {
            return {
                banned: true,
                ...banStatus
            };
        }

        const requests = this.windows.get(clientIP);
        if (!requests) return null;

        const now = Date.now();
        const windowStart = now - this.windowSize;
        const activeRequests = requests.filter(time => time > windowStart);

        return {
            banned: false,
            requests: activeRequests.length,
            window: this.windowSize,
            limit: this.limit,
            remaining: Math.max(0, this.limit - activeRequests.length),
            reset: Math.ceil((Math.max(...activeRequests || [now]) + this.windowSize - now) / 1000)
        };
    }
};

// Cache functions
async function cachedPathExists(filePath) {
    const now = Date.now();
    const cached = fileExistsCache.get(filePath);
    
    if (cached && (now - cached.timestamp) < FILE_CACHE_TTL) {
        return cached.exists;
    }
    
    const exists = await fs.pathExists(filePath);
    fileExistsCache.set(filePath, { exists, timestamp: now });
    
    if (fileExistsCache.size > MAX_FILE_CACHE_SIZE) {
        cleanupFileCache();
    }
    
    return exists;
}

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

async function loadImageList() {
    try {
        log('Starting to load image list...', 'DEBUG', 'API');
        
        const [newImageList, newImageDetails] = await Promise.all([
            safeReadJson(path.join(__dirname, 'list.json'), {}),
            safeReadJson(path.join(__dirname, 'images-details.json'), [])
        ]);

        if (newImageDetails.length === 0 && Object.keys(newImageList).length > 0) {
            newImageDetails.push(...convertListToDetails(newImageList));
            log(`Converted ${newImageDetails.length} images from list.json format`, 'WARN', 'API');
        }

        imageList = newImageList;
        imageDetails = newImageDetails;
        fileExistsCache.clear();
        
        log(`Image list loaded: ${Object.keys(imageList).length} directories, ${imageDetails.length} total images`, 'INFO', 'API');
        
    } catch (err) {
        log(`Failed to load image list: ${err.message}`, 'ERROR', 'API');
        log(`Error stack: ${err.stack}`, 'DEBUG', 'API');
    }
}

// Helper functions
function convertListToDetails(listData) {
    const details = [];
    const baseImagePath = path.resolve(config.paths.images);
    
    for (const [directory, files] of Object.entries(listData)) {
        if (!files || typeof files !== 'object') continue;
        
        for (const [filename, uploadtime] of Object.entries(files)) {
            try {
                const dirPath = directory === '_root' ? '' : directory;
                const fullPath = path.join(baseImagePath, dirPath, filename);
                const relativePath = path.join(dirPath, filename).replace(/\\/g, '/');
                
                details.push({
                    name: filename,
                    size: 0,
                    uploadtime,
                    path: relativePath,
                    _fullPath: fullPath,
                    _directory: directory,
                    _extension: path.extname(filename).toLowerCase(),
                    _mimeType: mimeTypes.lookup(fullPath) || 'application/octet-stream'
                });
            } catch (itemErr) {
                log(`Error processing item ${filename} in ${directory}: ${itemErr.message}`, 'WARN', 'API');
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
    if (imageDetails.length === 0) {
        log('No images available for random selection', 'DEBUG', 'API');
        return null;
    }
    
    let filtered = imageDetails;
    
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
    
    const randomIndex = Math.floor(Math.random() * filtered.length);
    const selectedImage = filtered[randomIndex];
    
    log(`Random image selected: ${selectedImage.name} from ${filtered.length} candidates`, 'DEBUG', 'API');
    return selectedImage;
}

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

function isRandomRequest(parts) {
    return parts.length < 2;
}

function generateCacheKey(req, parts) {
    if (isRandomRequest(parts)) {
        return null;
    }
    
    const base = `api:${req.path}`;
    const suffix = req.query.json === '1' ? ':json' : ':file';
    return base + suffix;
}

function getClientIP(req) {
    return req.headers['x-forwarded-for']?.split(',')[0] || 
           req.headers['x-real-ip'] || 
           req.connection.remoteAddress || 
           req.socket.remoteAddress ||
           req.ip ||
           'unknown';
}

function getNotFoundMessage(parts) {
    if (parts.length === 0) {
        return 'No images available';
    } else if (parts.length === 1) {
        return `No images found in directory: ${parts[0]}`;
    } else {
        return `Image not found: ${parts.join('/')}`;
    }
}

// API request handler
async function handleApiRequest(req, res) {
    const startTime = Date.now();
    
    setCorsHeaders(res);
    
    if (req.method === 'OPTIONS') {
        return res.status(200).end();
    }

    const clientIP = getClientIP(req);
    if (!requestLimiter.isAllowed(clientIP)) {
        const status = requestLimiter.getStatus(clientIP);
        log(`Rate limit exceeded or banned client: ${clientIP}`, 'WARN', 'API', req);
        
        const responseData = {
            error: status.banned ? 'Temporarily Banned' : 'Too Many Requests',
            message: status.banned 
                ? `You have been temporarily banned. Please try again later.` 
                : 'Rate limit exceeded. Please slow down your requests.',
            clientIP: clientIP,
            limit: requestLimiter.limit,
            window: requestLimiter.windowSize / 1000,  // 转换为秒
            ...status
        };

        return res.status(status.banned ? 403 : 429).json(responseData);
    }

    const isJson = req.query.json === '1';
    const parts = req.path.split('/').filter(p => p && p.trim());
    parts.shift(); // 移除 'api'
    
    const isRandom = isRandomRequest(parts);
    const cacheKey = generateCacheKey(req, parts);
    const cleanPath = req.originalUrl.split('?')[0];
    
    try {
        if (!isRandom && cacheKey) {
            const cached = await cacheManager.get(cacheKey);
            if (cached) {
                log(`Cache hit: ${cacheKey} (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
                
                if (isJson) {
                    return res.json(cached);
                }
                
                const filePath = cached._fullPath || cached.fullPath || path.resolve(cached.path);
                if (await cachedPathExists(filePath)) {
                    res.setHeader('Content-Type', mimeTypes.lookup(filePath) || 'image/jpeg');
                    res.setHeader('Cache-Control', 'public, max-age=3600');
                    res.setHeader('X-Cache', 'HIT');
                    return res.sendFile(filePath);
                } else {
                    await cacheManager.del(cacheKey);
                    log(`Cleared stale cache for missing file: ${cacheKey}`, 'WARN', 'API', req);
                }
            }
        }
        
        let selectedImage;
        if (parts.length === 0) {
            selectedImage = getRandomImage();
            log(`Random selection from all images (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
        } else if (parts.length === 1) {
            selectedImage = getRandomImage(parts[0]);
            log(`Random selection from directory: ${parts[0]} (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
        } else {
            selectedImage = findSpecificImage(parts[0], parts.slice(1).join('/'));
            if (selectedImage) {
                const exists = await cachedPathExists(selectedImage._fullPath);
                if (!exists) {
                    log(`Specific image file not found: ${selectedImage._fullPath}`, 'WARN', 'API', req);
                    selectedImage = null;
                } else {
                    log(`Specific image found: ${parts.join('/')} (${Date.now() - startTime}ms)`, 'DEBUG', 'API', req);
                }
            }
        }
        
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
        
        const imagePath = selectedImage._fullPath;
        const webPath = '/api/' + selectedImage.path;
        
        const imageInfo = {
            name: selectedImage.name,
            size: selectedImage.size,
            uploadtime: selectedImage.uploadtime,
            path: webPath,
            processingTime: Date.now() - startTime
        };
        
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
        
        if (isJson) {
            log(`JSON response returned (${imageInfo.processingTime}ms)`, 'DEBUG', 'API', req);
            return res.json(imageInfo);
        }
        
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

// Module initialization
async function start(appConfig, cacheMgr) {
    try {
        config = appConfig;
        cacheManager = cacheMgr;
        
        process.env.WORKER_ID = process.env.WORKER_ID ||
            (require('cluster').worker ? require('cluster').worker.id : '1');
        
        await loadImageList();
        
        // 初始化限流器
        requestLimiter.initialize(config);
        
        // 定时重新加载图片列表（5分钟）
        const reloadInterval = setInterval(async () => {
            try {
                await loadImageList();
            } catch (err) {
                log(`Scheduled reload failed: ${err.message}`, 'ERROR', 'API');
            }
        }, 300000);
        
        // 定时维护清理（10分钟）
        const maintenanceInterval = setInterval(cleanupFileCache, 600000);
        
        // 优雅关闭时清理定时器
        const originalExit = process.exit;
        process.exit = function(code) {
            clearInterval(reloadInterval);
            clearInterval(maintenanceInterval);
            originalExit.call(process, code);
        };
        
        log(`API started with ${imageDetails.length} images`, 'INFO', 'API');
        log('Cache policy: random ⛔, specific ✅', 'INFO', 'API');
        log(`File exists cache TTL: ${FILE_CACHE_TTL/1000}s, Request limit: ${requestLimiter.limit}/min`, 'INFO', 'API');
        
        return {
            handleApiRequest,
            loadImageList,
            getApiStats: () => ({
                images: {
                    total: imageDetails.length,
                    directories: Object.keys(imageList).length
                },
                cache: cacheManager.getStatus(),
                rateLimiter: {
                    enabled: requestLimiter.enabled,
                    limit: requestLimiter.limit,
                    windowSize: requestLimiter.windowSize,
                    currentClients: requestLimiter.windows.size,
                    bannedClients: requestLimiter.banList.size
                },
                fileCache: {
                    size: fileExistsCache.size,
                    ttl: FILE_CACHE_TTL / 1000 + 's'
                }
            })
        };
        
    } catch (err) {
        log(`Failed to start API: ${err.message}`, 'ERROR', 'API');
        throw err;
    }
}

module.exports = { start };