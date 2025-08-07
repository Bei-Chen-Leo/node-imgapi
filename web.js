const express = require('express');
const fs = require('fs-extra');
const path = require('path');
const https = require('https');
const { log } = require('./utils');

let config;
let cacheManager;
let app;
let httpServer;
let httpsServer;

// Token 验证中间件
function validateToken(req, res, next) {
    const UPDATE_TOKEN = process.env.UPDATE_TOKEN;
    
    // 如果没有设置环境变量，跳过验证
    if (!UPDATE_TOKEN) {
        log('UPDATE_TOKEN not set, skipping token validation', 'DEBUG', 'WEB', req);
        return next();
    }
    
    const providedToken = req.query.token;
    
    if (!providedToken || providedToken !== UPDATE_TOKEN) {
        log(`Token validation failed. Provided: ${providedToken ? '[REDACTED]' : 'none'}`, 'WARN', 'WEB', req);
        return res.status(401).json({
            error: 'Unauthorized',
            message: 'Valid token required',
            timestamp: require('./utils').getCurrentTimestamp()
        });
    }
    
    log('Token validation successful', 'DEBUG', 'WEB', req);
    next();
}

// 请求日志中间件
function requestLogger(req, res, next) {
    const start = Date.now();
    
    res.on('finish', () => {
        const duration = Date.now() - start;
        const size = res.get('Content-Length') || 0;
        log(`${req.method} ${res.statusCode} ${duration}ms ${size}bytes`, 'INFO', 'WEB', req);
    });
    
    next();
}

// CORS中间件
function corsMiddleware(req, res, next) {
    if (config.server.cors.enabled) {
        res.setHeader('Access-Control-Allow-Origin', config.server.cors.origins);
        res.setHeader('Access-Control-Allow-Methods', config.server.cors.methods);
        res.setHeader('Access-Control-Allow-Headers', config.server.cors.headers);
        res.setHeader('Access-Control-Allow-Credentials', 'true');
        
        if (req.method === 'OPTIONS') {
            return res.status(200).end();
        }
    }
    next();
}

// 安全头中间件
function securityMiddleware(req, res, next) {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('X-XSS-Protection', '1; mode=block');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
}

// 启动Web服务
async function start(appConfig, cacheManagerInstance) {
    config = appConfig;
    cacheManager = cacheManagerInstance;
    app = express();
    
    // 设置工作进程ID用于日志
    process.env.WORKER_ID = process.env.WORKER_ID || (require('cluster').worker ? require('cluster').worker.id : '1');
    
    // 信任代理（用于正确获取客户端IP）
    app.set('trust proxy', true);
    
    // 中间件
    app.use(requestLogger);
    app.use(corsMiddleware);
    app.use(securityMiddleware);
    
    // JSON解析中间件
    app.use(express.json({ limit: '1mb' }));
    app.use(express.urlencoded({ extended: true, limit: '1mb' }));
    
    // 静态文件服务
    if (await fs.pathExists(config.paths.html)) {
        app.use(express.static(config.paths.html, {
            maxAge: '1h',
            etag: true,
            lastModified: true
        }));
        log(`Static files served from: ${config.paths.html}`, 'INFO', 'WEB');
    }
    
    // =================== 1. 具体路由定义 ===================
    
    // 根路径API文档
    app.get('/doc', (req, res) => {
        res.json({
            name: 'Random Image API',
            version: '2.1.0',
            description: 'Random Image API with Redis caching, multi-threading and CORS support',
            endpoints: {
                'GET /api': 'Get random image from all directories',
                'GET /api/{directory}': 'Get random image from specific directory', 
                'GET /api/{directory}/{filename}': 'Get specific image',
                'GET /api?json=1': 'Get image info in JSON format',
                'GET /list.json': 'Get all images list',
                'GET /stats': 'Get detailed statistics',
                'GET /update?token={TOKEN}': 'Manual update trigger',
                'GET /health': 'Health check',
                'GET /cache/status': 'Cache status',
                'POST /cache/clear?token={TOKEN}': 'Clear cache (requires token)',
                'POST /cache/reconnect': 'Manual Redis reconnect',
                'POST /cache/reset?token={TOKEN}': 'Reset Redis retry count (requires token)'
            },
            timezone: config.timezone,
            timestamp: require('./utils').getCurrentTimestamp()
        });
    });
    
    // 挂载 list.json 到根目录
    app.get('/list.json', async (req, res) => {
        try {
            const listPath = path.join(__dirname, 'list.json');
            if (await fs.pathExists(listPath)) {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Cache-Control', 'public, max-age=300');
                res.sendFile(path.resolve(listPath));
                log('Served list.json', 'DEBUG', 'WEB', req);
            } else {
                res.status(404).json({ 
                    error: 'List not found',
                    message: 'Image list has not been generated yet. Try triggering an update first.',
                    timestamp: require('./utils').getCurrentTimestamp()
                });
                log('list.json not found', 'WARN', 'WEB', req);
            }
        } catch (error) {
            log(`Error serving list.json: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({ 
                error: 'Internal server error',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 获取统计信息
    app.get('/stats', async (req, res) => {
        try {
            const statsPath = path.join(__dirname, 'list.stats.json');
            if (await fs.pathExists(statsPath)) {
                res.setHeader('Content-Type', 'application/json');
                res.setHeader('Cache-Control', 'public, max-age=300');
                res.sendFile(path.resolve(statsPath));
                log('Served stats', 'DEBUG', 'WEB', req);
            } else {
                res.status(404).json({ 
                    error: 'Stats not found',
                    message: 'Statistics have not been generated yet.',
                    timestamp: require('./utils').getCurrentTimestamp()
                });
            }
        } catch (error) {
            log(`Error serving stats: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({ 
                error: 'Internal server error',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 手动更新API
    app.get('/update', async (req, res) => {
        try {
            const updateService = require('./update');
            const service = await updateService.start(config);
            await service.handleManualUpdate(req, res);
        } catch (error) {
            log(`Update service error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({
                error: 'Update service error',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 缓存状态API
    app.get('/cache/status', async (req, res) => {
        try {
            const status = await cacheManager.getStats();
            res.json({
                ...status,
                timestamp: require('./utils').getCurrentTimestamp()
            });
            log('Cache status requested', 'DEBUG', 'WEB', req);
        } catch (error) {
            log(`Cache status error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({
                error: 'Failed to get cache status',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 手动重连Redis API
    app.post('/cache/reconnect', async (req, res) => {
        try {
            log('Manual Redis reconnection requested', 'INFO', 'WEB', req);
            if (typeof cacheManager.manualReconnect === 'function') {
                await cacheManager.manualReconnect();
            }
            res.json({
                success: true,
                message: 'Redis reconnection triggered',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        } catch (error) {
            log(`Manual reconnect error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({
                success: false,
                error: 'Failed to trigger reconnection',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 重置重试计数器API - 添加 token 验证
    app.post('/cache/reset', validateToken, async (req, res) => {
        try {
            log('Redis retry count reset requested', 'INFO', 'WEB', req);
            if (typeof cacheManager.resetRetryCount === 'function') {
                cacheManager.resetRetryCount();
            }
            res.json({
                success: true,
                message: 'Redis retry count reset successfully',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        } catch (error) {
            log(`Reset retry count error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({
                success: false,
                error: 'Failed to reset retry count',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 缓存TTL查询API
    app.get('/cache/ttl/:key', async (req, res) => {
        try {
            const key = req.params.key;
            const ttl = await cacheManager.getTTL(key);
            res.json({
                key: key,
                ttl: ttl,
                message: ttl === -1 ? 'Key does not exist or has no expiration' : 
                        ttl === -2 ? 'Key does not exist' : 
                        `Key expires in ${ttl} seconds`,
                timestamp: require('./utils').getCurrentTimestamp()
            });
            log(`TTL requested for key: ${key} (TTL: ${ttl})`, 'DEBUG', 'WEB', req);
        } catch (error) {
            log(`TTL query error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({
                error: 'Failed to get TTL',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 设置缓存过期时间API
    app.post('/cache/expire/:key', async (req, res) => {
        try {
            const key = req.params.key;
            const seconds = parseInt(req.body.seconds) || 3600;
            
            const result = await cacheManager.expire(key, seconds);
            res.json({
                success: result,
                key: key,
                seconds: seconds,
                message: result ? `Expiration set for ${seconds} seconds` : 'Failed to set expiration or key does not exist',
                timestamp: require('./utils').getCurrentTimestamp()
            });
            log(`Expire set for key: ${key} (${seconds}s) - ${result ? 'success' : 'failed'}`, 'DEBUG', 'WEB', req);
        } catch (error) {
            log(`Expire set error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({
                error: 'Failed to set expiration',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // 清空缓存API - 添加 token 验证
    app.post('/cache/clear', validateToken, async (req, res) => {
        try {
            await cacheManager.clear();
            res.json({
                success: true,
                message: 'Cache cleared successfully',
                timestamp: require('./utils').getCurrentTimestamp()
            });
            log('Cache cleared via API', 'INFO', 'WEB', req);
        } catch (error) {
            log(`Cache clear error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(500).json({
                success: false,
                error: 'Failed to clear cache',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // =================== 2. API路由处理 ===================
    
    // 初始化API服务（延迟初始化）
    let apiService = null;
    async function getApiService() {
        if (!apiService) {
            try {
                const apiModule = require('./api');
                apiService = await apiModule.start(config, cacheManager);
                log('API service initialized', 'DEBUG', 'WEB');
            } catch (error) {
                log(`Failed to initialize API service: ${error.message}`, 'ERROR', 'WEB');
                throw error;
            }
        }
        return apiService;
    }

    // API路由处理函数
    async function handleApiRoute(req, res) {
        try {
            const service = await getApiService();
            await service.handleApiRequest(req, res);
        } catch (error) {
            log(`API service error on ${req.path}: ${error.message}`, 'ERROR', 'WEB', req);
            log(`Error stack: ${error.stack}`, 'DEBUG', 'WEB');
            res.status(500).json({
                error: 'API service error',
                message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    }

    // 注册API路由 - 替换原来的 app.use('/api*', ...) 部分
    app.get('/api', handleApiRoute);
    app.get('/api/*', handleApiRoute);
    app.post('/api', handleApiRoute);
    app.post('/api/*', handleApiRoute);
    
    // =================== 3. 健康检查路由 ===================
    
    // 健康检查
    app.get('/health', async (req, res) => {
        try {
            const cacheStatus = await cacheManager.getStats();
            const uptime = process.uptime();
            const memUsage = process.memoryUsage();
            
            res.json({
                status: 'OK',
                uptime: {
                    seconds: Math.floor(uptime),
                    human: `${Math.floor(uptime / 3600)}h ${Math.floor((uptime % 3600) / 60)}m ${Math.floor(uptime % 60)}s`
                },
                memory: {
                    rss: `${Math.round(memUsage.rss / 1024 / 1024)}MB`,
                    heapTotal: `${Math.round(memUsage.heapTotal / 1024 / 1024)}MB`,
                    heapUsed: `${Math.round(memUsage.heapUsed / 1024 / 1024)}MB`,
                    external: `${Math.round(memUsage.external / 1024 / 1024)}MB`
                },
                cache: cacheStatus,
                config: {
                    autoUpdate: config.update.hours > 0 ? `${config.update.hours} hours` : 'disabled',
                    https: config.server.ssl.enabled === true || config.server.ssl.enabled === 1 ? 'enabled' : 'disabled',
                    cors: config.server.cors.enabled ? 'enabled' : 'disabled',
                    workers: config.server.workers
                },
                timestamp: require('./utils').getCurrentTimestamp()
            });
        } catch (error) {
            log(`Health check error: ${error.message}`, 'ERROR', 'WEB', req);
            res.status(503).json({
                status: 'ERROR',
                error: 'Health check failed',
                timestamp: require('./utils').getCurrentTimestamp()
            });
        }
    });
    
    // =================== 4. 404和错误处理 ===================
    
    // 404处理（必须放在最后）
    app.use('*', (req, res) => {
        log('404 Not Found', 'WARN', 'WEB', req);
        res.status(404).json({ 
            error: 'Not Found',
            message: 'The requested resource was not found on this server',
            path: req.path,
            timestamp: require('./utils').getCurrentTimestamp()
        });
    });
    
    // 错误处理（必须放在最后）
    app.use((error, req, res, next) => {
        log(`Server error: ${error.message}`, 'ERROR', 'WEB', req);
        res.status(500).json({
            error: 'Internal Server Error',
            message: 'An unexpected error occurred',
            timestamp: require('./utils').getCurrentTimestamp()
        });
    });

    // =================== 5. 启动服务器部分 ===================
    
    // 启动HTTP服务器
    const httpPort = config.server.http_port || 3000;
    httpServer = app.listen(httpPort, () => {
        log(`HTTP Server running on port ${httpPort}`, 'INFO', 'WEB');
    });

    // 启动HTTPS服务器（如果启用）
    if (config.server.ssl.enabled === true || config.server.ssl.enabled === 1) {
        try {
            const httpsPort = config.server.https_port || 3443;
            const certPath = config.server.ssl.cert;
            const keyPath = config.server.ssl.key;
            
            if (await fs.pathExists(certPath) && await fs.pathExists(keyPath)) {
                const sslOptions = {
                    key: await fs.readFile(keyPath),
                    cert: await fs.readFile(certPath)
                };
                
                httpsServer = https.createServer(sslOptions, app);
                httpsServer.listen(httpsPort, () => {
                    log(`HTTPS Server running on port ${httpsPort}`, 'INFO', 'WEB');
                });
                
                httpsServer.on('error', (error) => {
                    log(`HTTPS Server error: ${error.message}`, 'ERROR', 'WEB');
                });
            } else {
                log('SSL certificate or key file not found, HTTPS disabled', 'WARN', 'WEB');
                log(`Cert path: ${certPath}`, 'DEBUG', 'WEB');
                log(`Key path: ${keyPath}`, 'DEBUG', 'WEB');
            }
        } catch (error) {
            log(`Failed to start HTTPS server: ${error.message}`, 'ERROR', 'WEB');
        }
    } else {
        log('HTTPS server disabled by configuration', 'INFO', 'WEB');
    }

    // HTTP服务器错误处理
    httpServer.on('error', (error) => {
        log(`HTTP Server error: ${error.message}`, 'ERROR', 'WEB');
    });

    log(`Web service started successfully (Worker ${process.env.WORKER_ID})`, 'INFO', 'WEB');
}

// 停止Web服务
function stop() {
    return new Promise((resolve) => {
        let pending = 0;
        
        if (httpServer) {
            pending++;
            httpServer.close(() => {
                log('HTTP Server stopped', 'INFO', 'WEB');
                pending--;
                if (pending === 0) resolve();
            });
        }
        
        if (httpsServer) {
            pending++;
            httpsServer.close(() => {
                log('HTTPS Server stopped', 'INFO', 'WEB');
                pending--;
                if (pending === 0) resolve();
            });
        }
        
        if (pending === 0) {
            resolve();
        }
    });
}

module.exports = { start, stop };