const { log } = require('./utils');

class SimpleCacheManager {
    constructor() {
        this.mapCache = new Map();
        this.mapCacheTTL = new Map();
        this.config = null;
        this.cleanupInterval = null;
    }

    // 初始化简单缓存管理器
    async initialize(config) {
        this.config = config;
        
        if (!config.cache.enabled) {
            log('Cache disabled for secondary worker', 'INFO', 'SIMPLE-CACHE');
            return;
        }
        
        // 启动Map缓存清理定时器
        this.startMapCacheCleanup();
        log('Simple cache manager initialized for secondary worker', 'INFO', 'SIMPLE-CACHE');
    }

    // 启动Map缓存清理
    startMapCacheCleanup() {
        const interval = this.config.cache.map_cleanup_interval || 60000;
        this.cleanupInterval = setInterval(() => this.cleanExpiredMapCache(), interval);
        log(`Simple cache cleanup started with ${interval}ms interval`, 'DEBUG', 'SIMPLE-CACHE');
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
            log(`Cleaned ${cleaned} expired cache entries`, 'DEBUG', 'SIMPLE-CACHE');
        }
    }

    // 获取缓存
    async get(key) {
        if (!this.config.cache.enabled) {
            return null;
        }

        if (this.mapCache.has(key)) {
            const expireTime = this.mapCacheTTL.get(key);
            if (!expireTime || Date.now() < expireTime) {
                log(`Cache hit: ${key}`, 'DEBUG', 'SIMPLE-CACHE');
                return this.mapCache.get(key);
            } else {
                this.mapCache.delete(key);
                this.mapCacheTTL.delete(key);
                log(`Cache expired: ${key}`, 'DEBUG', 'SIMPLE-CACHE');
            }
        }

        log(`Cache miss: ${key}`, 'DEBUG', 'SIMPLE-CACHE');
        return null;
    }

    // 设置缓存
    async set(key, value, ttl = null) {
        if (!this.config.cache.enabled) {
            return;
        }

        const cacheTTL = ttl || this.config.cache.ttl;
        
        if (cacheTTL <= 0) {
            return;
        }

        this.mapCache.set(key, value);
        this.mapCacheTTL.set(key, Date.now() + (cacheTTL * 1000));
        log(`Cache set: ${key} (TTL: ${cacheTTL}s)`, 'DEBUG', 'SIMPLE-CACHE');
    }

    // 删除缓存
    async del(key) {
        if (!this.config.cache.enabled) {
            return false;
        }

        const deleted = this.mapCache.delete(key);
        this.mapCacheTTL.delete(key);
        
        if (deleted) {
            log(`Cache deleted: ${key}`, 'DEBUG', 'SIMPLE-CACHE');
        }

        return deleted;
    }

    // TTL相关方法（简单实现）
    async getTTL(key) {
        if (!this.config.cache.enabled || !this.mapCacheTTL.has(key)) {
            return -1;
        }
        
        const expireTime = this.mapCacheTTL.get(key);
        const now = Date.now();
        
        if (expireTime <= now) {
            return -2; // 已过期
        }
        
        return Math.ceil((expireTime - now) / 1000);
    }

    async expire(key, seconds) {
        if (!this.config.cache.enabled || !this.mapCache.has(key)) {
            return false;
        }
        
        this.mapCacheTTL.set(key, Date.now() + (seconds * 1000));
        log(`Cache TTL updated for: ${key} (new TTL: ${seconds}s)`, 'DEBUG', 'SIMPLE-CACHE');
        return true;
    }

    // 清空所有缓存
    async clear() {
        if (!this.config.cache.enabled) {
            return;
        }

        this.mapCache.clear();
        this.mapCacheTTL.clear();
        log('Simple cache cleared', 'INFO', 'SIMPLE-CACHE');
    }

    // 获取缓存状态
    getStatus() {
        return {
            redis: {
                connected: false,
                retryCount: 0,
                maxRetries: 0,
                isReconnecting: false
            },
            map: {
                size: this.mapCache.size,
                ttlSize: this.mapCacheTTL.size
            },
            enabled: this.config ? this.config.cache.enabled : false
        };
    }

    // 获取缓存统计信息
    async getStats() {
        return this.getStatus();
    }

    // 关闭缓存管理器
    async close() {
        if (this.cleanupInterval) {
            clearInterval(this.cleanupInterval);
            this.cleanupInterval = null;
        }
        this.mapCache.clear();
        this.mapCacheTTL.clear();
        log('Simple cache manager closed', 'INFO', 'SIMPLE-CACHE');
    }
}

module.exports = new SimpleCacheManager();