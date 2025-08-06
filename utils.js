const fs = require('fs-extra');

let config = null;

const LOG_LEVELS = {
    'ERROR': 0,
    'WARN': 1,
    'INFO': 2,
    'DEBUG': 3
};

function setConfig(appConfig) {
    config = appConfig;
}

function formatTime(date = new Date(), timezone = 'Asia/Shanghai') {
    try {
        const targetTimezone = config?.timezone || timezone;
        const d = new Date(date);
        
        const formatter = new Intl.DateTimeFormat('zh-CN', {
            timeZone: targetTimezone,
            year: 'numeric',
            month: '2-digit',
            day: '2-digit',
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit',
            hour12: false
        });
        
        const parts = formatter.formatToParts(d);
        const year = parts.find(part => part.type === 'year').value;
        const month = parts.find(part => part.type === 'month').value;
        const day = parts.find(part => part.type === 'day').value;
        const hour = parts.find(part => part.type === 'hour').value;
        const minute = parts.find(part => part.type === 'minute').value;
        const second = parts.find(part => part.type === 'second').value;
        
        return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
    } catch (error) {
        const d = new Date(date);
        const year = d.getFullYear();
        const month = String(d.getMonth() + 1).padStart(2, '0');
        const day = String(d.getDate()).padStart(2, '0');
        const hours = String(d.getHours()).padStart(2, '0');
        const minutes = String(d.getMinutes()).padStart(2, '0');
        const seconds = String(d.getSeconds()).padStart(2, '0');
        return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
    }
}

function log(message, type = 'INFO', module = 'APP', req = null) {
    if (!config || !config.logging.enabled) {
        return;
    }
    
    const currentLevel = LOG_LEVELS[config.logging.level] || LOG_LEVELS['INFO'];
    const messageLevel = LOG_LEVELS[type] || LOG_LEVELS['INFO'];
    
    if (messageLevel > currentLevel) {
        return;
    }
    
    const timestamp = formatTime();
    const workerId = process.env.WORKER_ID || (require('cluster').worker ? require('cluster').worker.id : 'master');
    
    let logMessage = `[${timestamp}] [${type}] [${module}] [W${workerId}]`;
    
    if (req) {
        const ip = req.headers['x-forwarded-for'] || req.connection.remoteAddress || 'unknown';
        const url = req.url || '';
        logMessage += ` ${ip} ${url}`;
    }
    
    logMessage += ` ${message}`;
    
    console.log(logMessage);
}

function getCurrentTimestamp() {
    return formatTime();
}

function isoToLocal(isoString) {
    return formatTime(new Date(isoString));
}

async function safeReadJson(filePath, defaultValue = null) {
    try {
        if (!(await fs.pathExists(filePath))) {
            log(`JSON file does not exist: ${filePath}`, 'DEBUG', 'UTILS');
            return defaultValue;
        }
        
        const content = await fs.readFile(filePath, 'utf-8');
        if (!content || content.trim().length === 0) {
            log(`JSON file is empty: ${filePath}`, 'WARN', 'UTILS');
            return defaultValue;
        }
        
        const data = JSON.parse(content);
        log(`Successfully read JSON file: ${filePath}`, 'DEBUG', 'UTILS');
        return data;
        
    } catch (error) {
        log(`Error reading JSON file ${filePath}: ${error.message}`, 'ERROR', 'UTILS');
        return defaultValue;
    }
}

async function safeWriteJson(filePath, data, options = {}) {
    const lockFile = `${filePath}.lock`;
    const tempFile = `${filePath}.tmp`;
    const maxRetries = 5;
    const retryDelay = 100;
    
    for (let i = 0; i < maxRetries; i++) {
        try {
            if (await fs.pathExists(lockFile)) {
                log(`JSON file is locked, waiting... (attempt ${i + 1})`, 'DEBUG', 'UTILS');
                await new Promise(resolve => setTimeout(resolve, retryDelay));
                continue;
            }
            
            await fs.writeFile(lockFile, process.pid.toString());
            
            await fs.writeJson(tempFile, data, { spaces: 2, ...options });
            
            await fs.move(tempFile, filePath, { overwrite: true });
            
            await fs.unlink(lockFile);
            
            log(`Successfully wrote JSON file: ${filePath}`, 'DEBUG', 'UTILS');
            return true;
            
        } catch (error) {
            log(`Error writing JSON file ${filePath} (attempt ${i + 1}): ${error.message}`, 'ERROR', 'UTILS');
            
            try {
                if (await fs.pathExists(tempFile)) {
                    await fs.unlink(tempFile);
                }
                if (await fs.pathExists(lockFile)) {
                    await fs.unlink(lockFile);
                }
            } catch (cleanupError) {
                // 忽略清理错误
            }
            
            if (i === maxRetries - 1) {
                throw error;
            }
            
            await new Promise(resolve => setTimeout(resolve, retryDelay));
        }
    }
    
    return false;
}

module.exports = {
    setConfig,
    formatTime,
    log,
    getCurrentTimestamp,
    isoToLocal,
    safeReadJson,
    safeWriteJson,
    LOG_LEVELS
};