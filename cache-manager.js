const redis = require('redis');
const { log } = require('./utils');

class CacheManager {
    constructor() {
        this.mapCache = new Map();
        this.mapCacheTTL = new Map();
        this.accessCount = new Map();
        this.redisClient = null;
        this.config = null;
        this.isRedisConnected = false;
        this.retryCount = 0;
        this.maxRetries = 5;
        this.retryInterval = 8000;
        this.retryTimeout = null;
        this.cleanupInterval = null;
        this.isReconnecting = false;
        this.connectionAttemptTime = null;
    }

    async initialize(config) {
        this.config = config;
        this.maxRetries = config.redis.reconnect.maxRetries || 5;
        this.retryInterval = config.redis.reconnect.retryInterval || 8000;
        
        if (!config.cache.enabled) {
            log('Cache disabled, using no cache', 'INFO', 'CACHE');
            return;
        }
        
        this.startMapCacheCleanup();
        await this.connectRedis();
    }

    startMapCacheCleanup() {
        const interval = this.config.cache.map_cleanup_interval || 60000;
        this.cleanupInterval = setInterval(() => this.cleanExpiredMapCache(), interval);
        log(`Map cache cleanup started with ${interval}ms interval`, 'DEBUG', 'CACHE');
    }

    async connectRedis() {
        if (!this.config.cache.enabled) {
            return;
        }

        if (this.isReconnecting) {
            log('Redis reconnection already in progress, skipping', 'DEBUG', 'CACHE');
            return;
        }

        if (this.retryCount >= this.maxRetries) {
            log('Max Redis reconnection attempts reached, using Map cache permanently', 'ERROR', 'CACHE');
            return;
        }

        this.isReconnecting = true;
        this.connectionAttemptTime = Date.now();

        try {
            log(`Attempting to connect to Redis (attempt ${this.retryCount + 1}/${this.maxRetries + 1})`, 'INFO', 'CACHE');
            
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
                    reconnectStrategy: false
                },
                password: this.config.redis.password || undefined,
                database: this.config.redis.db
            });

            this.redisClient.on('connect', () => {
                log('Redis connected successfully', 'INFO', 'CACHE');
                this.isRedisConnected = true;
                this.retryCount = 0;
                this.isReconnecting = false;
                this.clearMapCache();
                
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

            await this.redisClient.connect();
            
        } catch (error) {
            log(`Failed to connect to Redis: ${error.message}`, 'ERROR', 'CACHE');
            this.isReconnecting = false;
            this.handleRedisError();
        }
    }

    handleRedisError() {
        this.isRedisConnected = false;
        
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

    scheduleReconnect() {
        if (this.isReconnecting || this.retryCount >= this.maxRetries) {
            if (this.retryCount >= this.maxRetries) {
                log('Max Redis reconnection attempts reached', 'ERROR', 'CACHE');
            }
            return;
        }

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

    cleanExpiredMapCache() {
        const now = Date.now();
        const entries = [...this.mapCacheTTL.entries()];
        const expired = entries.filter(([key, expireTime]) => now > expireTime);
        
        if (expired.length > 0) {
            expired.forEach(([key]) => {
                this.mapCache.delete(key);
                this.mapCacheTTL.delete(key);
                this.accessCount.delete(key);
            });
            log(`Cleaned ${expired.length} expired Map cache entries`, 'DEBUG', 'CACHE');
        }

        // 如果缓存过大，清理最少访问的条目
        if (this.mapCache.size > 10000) { // 可以根据需要调整这个限制
            const entries = [...this.accessCount.entries()];
            entries.sort((a, b) => a[1] - b[1]);
            const toDelete = entries.slice(0, entries.length - 5000); // 保留5000个最常访问的条目
            toDelete.forEach(([key]) => {
                this.mapCache.delete(key);
                this.mapCacheTTL.delete(key);
                this.accessCount.delete(key);
            });
            log(`Cleaned ${toDelete.length} least accessed cache entries`, 'INFO', 'CACHE');
        }
    }

    clearMapCache() {
        const size = this.mapCache.size;
        this.mapCache.clear();
        this.mapCacheTTL.clear();
        this.accessCount.clear();
        if (size > 0) {
            log(`Map cache cleared (${size} entries)`, 'INFO', 'CACHE');
        }
    }

    async get(key) {
        if (!this.config.cache.enabled) {
            return null;
        }

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

        const cached = this.mapCache.get(key);
        if (cached) {
            const expireTime = this.mapCacheTTL.get(key);
            if (!expireTime || Date.now() < expireTime) {
                this.accessCount.set(key, (this.accessCount.get(key) || 0) + 1);
                log(`Map cache hit: ${key}`, 'DEBUG', 'CACHE');
                return cached;
            } else {
                this.mapCache.delete(key);
                this.mapCacheTTL.delete(key);
                this.accessCount.delete(key);
                log(`Map cache expired: ${key}`, 'DEBUG', 'CACHE');
            }
        }

        log(`Cache miss: ${key}`, 'DEBUG', 'CACHE');
        return null;
    }

    async set(key, value, ttl = null) {
        if (!this.config.cache.enabled) {
            return;
        }

        const cacheTTL = ttl || this.config.cache.ttl;
        const redisTTL = ttl || this.config.cache.redis_ttl || this.config.cache.ttl;
        
        if (cacheTTL <= 0) {
            return;
        }

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

        this.mapCache.set(key, value);
        this.mapCacheTTL.set(key, Date.now() + (cacheTTL * 1000));
        this.accessCount.set(key, 0);
        log(`Map cache set: ${key} (TTL: ${cacheTTL}s)`, 'DEBUG', 'CACHE');
    }

    async del(key) {
        if (!this.config.cache.enabled) {
            return false;
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

        if (this.mapCache.delete(key)) {
            this.mapCacheTTL.delete(key);
            this.accessCount.delete(key);
            deleted = true;
            log(`Map cache deleted: ${key}`, 'DEBUG', 'CACHE');
        }

        return deleted;
    }

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

    async close() {
        log('Closing cache manager...', 'INFO', 'CACHE');
        
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
            log('Map cache cleanup stopped', 'INFO', 'CACHE');
        }
        
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
        
        this.isRedisConnected = false;
        this.isReconnecting = false;
        this.retryCount = 0;
        
        this.clearMapCache();
        log('Cache manager closed', 'INFO', 'CACHE');
    }

    getStatus() {
        return {
            redis: {
                connected: this.isRedisConnected,
                retryCount: this.retryCount,
                maxRetries: this.maxRetries,
                isReconnecting: this.isReconnecting,
                nextRetryIn: this.retryTimeout ? 
                    Math.ceil((this.retryInterval - (Date.now() - (this.connectionAttemptTime || 0))) / 1000) : null
            },
            map: {
                size: this.mapCache.size,
                ttlSize: this.mapCacheTTL.size,
                accessCountSize: this.accessCount.size
            },
            enabled: this.config ? this.config.cache.enabled : false,
            config: this.config ? {
                ttl: this.config.cache.ttl,
                redis_ttl: this.config.cache.redis_ttl,
                cleanup_interval: this.config.cache.map_cleanup_interval
            } : null
        };
    }

    resetRetryCount() {
        this.retryCount = 0;
        this.isReconnecting = false;
        if (this.retryTimeout) {
            clearTimeout(this.retryTimeout);
            this.retryTimeout = null;
        }
        log('Redis retry count reset', 'INFO', 'CACHE');
    }

    async manualReconnect() {
        log('Manual Redis reconnection triggered', 'INFO', 'CACHE');
        this.resetRetryCount();
        await this.connectRedis();
    }
}

module.exports = new CacheManager();