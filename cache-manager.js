const redis = require('redis');
const { log } = require('./utils');

class CacheManager {
    constructor() {
        this.redisClient = null;
        this.mapCache = new Map();
        this.mapCacheTTL = new Map();
        this.isRedisConnected = false;
        this.config = null;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.retryInterval = 8000;
        this.retryTimeout = null;
        this.cleanupInterval = null;
        this.isReconnecting = false; // 防止重复重连
        this.connectionAttemptTime = null; // 记录连接尝试时间
    }

    // 初始化缓存管理器
    async initialize(config) {
        this.config = config;
        this.maxRetries = config.redis.reconnect.maxRetries || 5;
        this.retryInterval = config.redis.reconnect.retryInterval || 8000;
        
        if (!config.cache.enabled) {
            log('Cache disabled, using no cache', 'INFO', 'CACHE');
            return;
        }
        
        // 启动Map缓存清理定时器
        this.startMapCacheCleanup();
        
        // 尝试连接Redis
        await this.connectRedis();
    }

    // 启动Map缓存清理
    startMapCacheCleanup() {
        const interval = this.config.cache.map_cleanup_interval || 60000;
        this.cleanupInterval = setInterval(() => this.cleanExpiredMapCache(), interval);
        log(`Map cache cleanup started with ${interval}ms interval`, 'DEBUG', 'CACHE');
    }

    // 连接Redis
    async connectRedis() {
        if (!this.config.cache.enabled) {
            log('Redis disabled, using Map cache', 'INFO', 'CACHE');
            return;
        }

        // 防止并发重连
        if (this.isReconnecting) {
            log('Redis reconnection already in progress, skipping', 'DEBUG', 'CACHE');
            return;
        }

        // 检查重试次数
        if (this.retryCount >= this.maxRetries) {
            log('Max Redis reconnection attempts reached, using Map cache permanently', 'ERROR', 'CACHE');
            return;
        }

        this.isReconnecting = true;
        this.connectionAttemptTime = Date.now();

        try {
            log(`Attempting to connect to Redis (attempt ${this.retryCount + 1}/${this.maxRetries + 1})`, 'INFO', 'CACHE');
            
            // 清理之前的客户端
            if (this.redisClient) {
                try {
                    await this.redisClient.disconnect();
                } catch (e) {
                    // 忽略断开连接的错误
                }
                this.redisClient = null;
            }

            this.redisClient = redis.createClient({
                socket: {
                    host: this.config.redis.host,
                    port: this.config.redis.port,
                    connectTimeout: this.config.redis.reconnect.connectTimeout || 10000,
                    lazyConnect: true,
                    reconnectStrategy: false // 禁用自动重连，我们手动控制
                },
                password: this.config.redis.password || undefined,
                database: this.config.redis.db
            });

            // Redis事件监听
            this.redisClient.on('connect', () => {
                log('Redis connected successfully', 'INFO', 'CACHE');
                this.isRedisConnected = true;
                this.retryCount = 0; // 重置重试次数
                this.isReconnecting = false;
                this.clearMapCache();
                
                // 清除重连定时器
                if (this.retryTimeout) {
                    clearTimeout(this.retryTimeout);
                    this.retryTimeout = null;
                }
            });

            this.redisClient.on('error', (err) => {
                log(`Redis error: ${err.message}`, 'ERROR', 'CACHE');
                this.isReconnecting = false;
                this.handleRedisError();
            });

            this.redisClient.on('end', () => {
                log('Redis connection ended', 'WARN', 'CACHE');
                this.isRedisConnected = false;
                this.isReconnecting = false;
                this.scheduleReconnect();
            });

            this.redisClient.on('reconnecting', () => {
                log('Redis client reconnecting...', 'WARN', 'CACHE');
            });

            // 尝试连接
            await this.redisClient.connect();
            
        } catch (error) {
            log(`Failed to connect to Redis: ${error.message}`, 'ERROR', 'CACHE');
            this.isReconnecting = false;
            this.handleRedisError();
        }
    }

    // 处理Redis错误
    handleRedisError() {
        this.isRedisConnected = false;
        
        // 清理客户端
        if (this.redisClient) {
            try {
                this.redisClient.removeAllListeners();
                this.redisClient.disconnect().catch(() => {});
            } catch (e) {
                // 忽略清理错误
            }
            this.redisClient = null;
        }
        
        log('Falling back to Map cache', 'WARN', 'CACHE');
        this.scheduleReconnect();
    }

    // 安排重连
    scheduleReconnect() {
        // 如果已经在重连中或达到最大重试次数，不再安排重连
        if (this.isReconnecting || this.retryCount >= this.maxRetries) {
            if (this.retryCount >= this.maxRetries) {
                log('Max Redis reconnection attempts reached', 'ERROR', 'CACHE');
            }
            return;
        }

        // 如果已有重连定时器，清除它
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
        }
        
        this.retryCount++;
        
        this.retryTimeout = setTimeout(() => {
            this.retryTimeout = null;
            this.connectRedis();
        }, this.retryInterval);
        
        log(`Redis reconnection scheduled in ${this.retryInterval/1000}s (attempt ${this.retryCount + 1}/${this.maxRetries + 1})`, 'WARN', 'CACHE');
    }

    // 清理过期的Map缓存
    cleanExpiredMapCache() {
        const now = Date.now();
        let cleaned = 0;
        
        for (const [key, expireTime] of this.mapCacheTTL.entries()) {
            if (now > expireTime) {
                this.mapCache.delete(key);
                this.mapCacheTTL.delete(key);
                cleaned++;
            }
        }
        
        if (cleaned > 0) {
            log(`Cleaned ${cleaned} expired Map cache entries`, 'DEBUG', 'CACHE');
        }
    }

    // 清空Map缓存
    clearMapCache() {
        const size = this.mapCache.size;
        this.mapCache.clear();
        this.mapCacheTTL.clear();
        if (size > 0) {
            log(`Map cache cleared (${size} entries)`, 'INFO', 'CACHE');
        }
    }

    // 获取缓存
    async get(key) {
        if (!this.config.cache.enabled) {
            return null;
        }

        // 优先使用Redis（只有在真正连接时才尝试）
        if (this.isRedisConnected && this.redisClient && !this.isReconnecting) {
            try {
                const result = await this.redisClient.get(key);
                if (result !== null) {
                    log(`Redis cache hit: ${key}`, 'DEBUG', 'CACHE');
                    return JSON.parse(result);
                }
            } catch (error) {
                log(`Redis get error: ${error.message}`, 'ERROR', 'CACHE');
                this.handleRedisError();
            }
        }

        // 使用Map缓存
        if (this.mapCache.has(key)) {
            const expireTime = this.mapCacheTTL.get(key);
            if (!expireTime || Date.now() < expireTime) {
                log(`Map cache hit: ${key}`, 'DEBUG', 'CACHE');
                return this.mapCache.get(key);
            } else {
                this.mapCache.delete(key);
                this.mapCacheTTL.delete(key);
                log(`Map cache expired: ${key}`, 'DEBUG', 'CACHE');
            }
        }

        log(`Cache miss: ${key}`, 'DEBUG', 'CACHE');
        return null;
    }

    // 设置缓存
    async set(key, value, ttl = null) {
        if (!this.config.cache.enabled) {
            return;
        }

        const cacheTTL = ttl || this.config.cache.ttl;
        const redisTTL = ttl || this.config.cache.redis_ttl || this.config.cache.ttl;
        
        if (cacheTTL <= 0) {
            return;
        }

        // 优先使用Redis（只有在真正连接时才尝试）
        if (this.isRedisConnected && this.redisClient && !this.isReconnecting) {
            try {
                await this.redisClient.setEx(key, redisTTL, JSON.stringify(value));
                log(`Redis cache set: ${key} (TTL: ${redisTTL}s)`, 'DEBUG', 'CACHE');
                return;
            } catch (error) {
                log(`Redis set error: ${error.message}`, 'ERROR', 'CACHE');
                this.handleRedisError();
            }
        }

        // 使用Map缓存
        this.mapCache.set(key, value);
        this.mapCacheTTL.set(key, Date.now() + (cacheTTL * 1000));
        log(`Map cache set: ${key} (TTL: ${cacheTTL}s)`, 'DEBUG', 'CACHE');
    }

    // 删除缓存
    async del(key) {
        if (!this.config.cache.enabled) {
            return;
        }

        let deleted = false;

        if (this.isRedisConnected && this.redisClient && !this.isReconnecting) {
            try {
                const result = await this.redisClient.del(key);
                deleted = result > 0;
                log(`Redis cache deleted: ${key} (${result > 0 ? 'found' : 'not found'})`, 'DEBUG', 'CACHE');
            } catch (error) {
                log(`Redis del error: ${error.message}`, 'ERROR', 'CACHE');
                this.handleRedisError();
            }
        }

        const mapDeleted = this.mapCache.delete(key);
        this.mapCacheTTL.delete(key);
        
        if (mapDeleted) {
            log(`Map cache deleted: ${key}`, 'DEBUG', 'CACHE');
            deleted = true;
        }

        return deleted;
    }

    // 检查Redis TTL
    async getTTL(key) {
        if (!this.config.cache.enabled || !this.isRedisConnected || !this.redisClient || this.isReconnecting) {
            return -1;
        }

        try {
            const ttl = await this.redisClient.ttl(key);
            return ttl;
        } catch (error) {
            log(`Redis TTL error: ${error.message}`, 'ERROR', 'CACHE');
            return -1;
        }
    }

    // 设置Redis过期时间
    async expire(key, seconds) {
        if (!this.config.cache.enabled || !this.isRedisConnected || !this.redisClient || this.isReconnecting) {
            return false;
        }

        try {
            const result = await this.redisClient.expire(key, seconds);
            log(`Redis expire set: ${key} (${seconds}s)`, 'DEBUG', 'CACHE');
            return result;
        } catch (error) {
            log(`Redis expire error: ${error.message}`, 'ERROR', 'CACHE');
            return false;
        }
    }

    // 清空所有缓存
    async clear() {
        if (!this.config.cache.enabled) {
            return;
        }

        if (this.isRedisConnected && this.redisClient && !this.isReconnecting) {
            try {
                await this.redisClient.flushDb();
                log('Redis cache cleared', 'INFO', 'CACHE');
            } catch (error) {
                log(`Redis clear error: ${error.message}`, 'ERROR', 'CACHE');
                this.handleRedisError();
            }
        }

        this.clearMapCache();
    }

    // 手动重置重连计数器（用于管理接口）
    resetRetryCount() {
        this.retryCount = 0;
        this.isReconnecting = false;
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        log('Redis retry count reset', 'INFO', 'CACHE');
    }

    // 手动触发重连（用于管理接口）
    async manualReconnect() {
        log('Manual Redis reconnection triggered', 'INFO', 'CACHE');
        this.resetRetryCount();
        await this.connectRedis();
    }

    // 获取缓存统计信息
    async getStats() {
        const stats = {
            redis: {
                connected: this.isRedisConnected,
                retryCount: this.retryCount,
                maxRetries: this.maxRetries,
                isReconnecting: this.isReconnecting,
                connectionAttemptTime: this.connectionAttemptTime,
                nextRetryIn: this.retryTimeout ? Math.ceil((this.retryInterval - (Date.now() - (this.connectionAttemptTime || 0))) / 1000) : null
            },
            map: {
                size: this.mapCache.size,
                ttlSize: this.mapCacheTTL.size
            },
            enabled: this.config ? this.config.cache.enabled : false,
            config: this.config ? {
                ttl: this.config.cache.ttl,
                redis_ttl: this.config.cache.redis_ttl || this.config.cache.ttl,
                cleanup_interval: this.config.cache.map_cleanup_interval
            } : null
        };

        if (this.isRedisConnected && this.redisClient && !this.isReconnecting) {
            try {
                const info = await this.redisClient.info('memory');
                const dbsize = await this.redisClient.dbSize();
                stats.redis.memory = info;
                stats.redis.dbsize = dbsize;
            } catch (error) {
                log(`Error getting Redis stats: ${error.message}`, 'ERROR', 'CACHE');
            }
        }

        return stats;
    }

    // 获取缓存状态
    getStatus() {
        return {
            redis: {
                connected: this.isRedisConnected,
                retryCount: this.retryCount,
                maxRetries: this.maxRetries,
                isReconnecting: this.isReconnecting
            },
            map: {
                size: this.mapCache.size,
                ttlSize: this.mapCacheTTL.size
            },
            enabled: this.config ? this.config.cache.enabled : false
        };
    }

    // 关闭连接
    async close() {
        log('Closing cache manager...', 'INFO', 'CACHE');
        
        // 清除重连定时器
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        
        // 停止清理定时器
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            log('Map cache cleanup stopped', 'INFO', 'CACHE');
        }
        
        // 关闭Redis连接
        if (this.redisClient) {
            try {
                this.redisClient.removeAllListeners();
                if (this.isRedisConnected) {
                    await this.redisClient.quit();
                } else {
                    await this.redisClient.disconnect();
                }
                log('Redis connection closed', 'INFO', 'CACHE');
            } catch (error) {
                log(`Error closing Redis connection: ${error.message}`, 'ERROR', 'CACHE');
            }
            this.redisClient = null;
        }
        
        // 清空状态
        this.isRedisConnected = false;
        this.isReconnecting = false;
        this.retryCount = 0;
        
        // 清空Map缓存
        this.clearMapCache();
        log('Cache manager closed', 'INFO', 'CACHE');
    }
}

const cacheManager = new CacheManager();
module.exports = cacheManager;