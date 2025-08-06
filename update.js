const fs = require('fs-extra');
const path = require('path');
const { log, formatTime, safeReadJson, safeWriteJson } = require('./utils');

let config;
let updateInterval;
const UPDATE_TOKEN = process.env.UPDATE_TOKEN || 'default_update_token_change_me';

// 扫描图片文件
async function scanImages(directory) {
    const imagesByDirectory = {};
    const imageDetails = [];
    const supportedExtensions = config.update.supportedExtensions || ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.bmp', '.svg'];
    let scannedDirs = 0;
    let scannedFiles = 0;
    const baseImagePath = path.resolve(config.paths.images);
    
    async function scanDirectory(dir, relativePath = '') {
        try {
            if (!(await fs.pathExists(dir))) {
                log(`Directory does not exist: ${dir}`, 'WARN', 'UPDATE');
                return;
            }
            
            const items = await fs.readdir(dir);
            scannedDirs++;
            
            for (const item of items) {
                const fullPath = path.join(dir, item);
                
                try {
                    const stats = await fs.stat(fullPath);
                    
                    if (stats.isDirectory()) {
                        await scanDirectory(fullPath, path.join(relativePath, item));
                    } else if (stats.isFile()) {
                        scannedFiles++;
                        const ext = path.extname(item).toLowerCase();
                        if (supportedExtensions.includes(ext)) {
                            const dirKey = relativePath ? relativePath.replace(/\\/g, '/') : '_root';
                            
                            if (!imagesByDirectory[dirKey]) {
                                imagesByDirectory[dirKey] = {};
                            }
                            
                            // list.json格式 - 使用本地时区格式
                            imagesByDirectory[dirKey][item] = formatTime(stats.mtime);
                            
                            // API详细信息格式
                            const relativeToImages = path.relative(baseImagePath, fullPath).replace(/\\/g, '/');
                            imageDetails.push({
                                name: item,
                                size: stats.size,
                                uploadtime: formatTime(stats.mtime),
                                path: relativeToImages,
                                _fullPath: fullPath,
                                _directory: dirKey,
                                _extension: ext,
                                _mimeType: require('mime-types').lookup(fullPath) || 'application/octet-stream'
                            });
                        }
                    }
                } catch (statError) {
                    log(`Error reading file stats ${fullPath}: ${statError.message}`, 'WARN', 'UPDATE');
                }
            }
        } catch (error) {
            log(`Error scanning directory ${dir}: ${error.message}`, 'ERROR', 'UPDATE');
        }
    }
    
    const startTime = Date.now();
    await scanDirectory(directory);
    const duration = Date.now() - startTime;
    
    log(`Scan completed: ${imageDetails.length} images found in ${scannedDirs} directories (${scannedFiles} files scanned, ${duration}ms)`, 'INFO', 'UPDATE');
    
    return {
        listJson: imagesByDirectory,
        imageDetails: imageDetails,
        stats: {
            totalImages: imageDetails.length,
            totalDirectories: scannedDirs,
            totalFiles: scannedFiles,
            scanDuration: duration,
            supportedExtensions,
            directories: Object.keys(imagesByDirectory).sort()
        }
    };
}

// 更新图片列表
async function updateImageList() {
    try {
        log('Starting image list update...', 'INFO', 'UPDATE');
        const imagePath = path.resolve(config.paths.images);
        
        if (!(await fs.pathExists(imagePath))) {
            log(`Image directory does not exist: ${imagePath}`, 'ERROR', 'UPDATE');
            return { 
                success: false, 
                error: 'Image directory does not exist',
                path: imagePath 
            };
        }
        
        const scanResult = await scanImages(imagePath);
        const listPath = path.join(__dirname, 'list.json');
        const detailsPath = path.join(__dirname, 'images-details.json');
        
        // 备份旧的列表文件
        try {
            const backupPath = path.join(__dirname, 'list.json.backup');
            if (await fs.pathExists(listPath)) {
                await fs.copy(listPath, backupPath);
                log('Created backup of existing list.json', 'DEBUG', 'UPDATE');
            }
        } catch (backupError) {
            log(`Failed to create backup: ${backupError.message}`, 'WARN', 'UPDATE');
        }
        
        // 使用安全写入方法
        try {
            await safeWriteJson(listPath, scanResult.listJson);
            log('Successfully wrote list.json', 'INFO', 'UPDATE');
        } catch (error) {
            log(`Failed to write list.json: ${error.message}`, 'ERROR', 'UPDATE');
            throw error;
        }
        
        try {
            await safeWriteJson(detailsPath, scanResult.imageDetails);
            log('Successfully wrote images-details.json', 'INFO', 'UPDATE');
        } catch (error) {
            log(`Failed to write images-details.json: ${error.message}`, 'ERROR', 'UPDATE');
            throw error;
        }
        
        // 写入详细统计信息
        try {
            const statsPath = path.join(__dirname, 'list.stats.json');
            const outputData = {
                generated: formatTime(),
                basePath: imagePath,
                stats: scanResult.stats,
                listFormat: 'directory-based',
                totalImages: scanResult.imageDetails.length,
                timezone: config.timezone
            };
            await safeWriteJson(statsPath, outputData);
            log('Successfully wrote list.stats.json', 'INFO', 'UPDATE');
        } catch (error) {
            log(`Failed to write stats: ${error.message}`, 'WARN', 'UPDATE');
            // 统计信息写入失败不影响主要功能
        }
        
        log(`Updated image list with ${scanResult.imageDetails.length} images`, 'INFO', 'UPDATE');
        log(`List.json format: directory-based structure`, 'DEBUG', 'UPDATE');
        log(`Details saved to images-details.json for API use`, 'DEBUG', 'UPDATE');
        
        return { 
            success: true, 
            count: scanResult.imageDetails.length,
            stats: scanResult.stats,
            path: imagePath
        };
        
    } catch (error) {
        log(`Failed to update image list: ${error.message}`, 'ERROR', 'UPDATE');
        log(`Error stack: ${error.stack}`, 'DEBUG', 'UPDATE');
        return { 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        };
    }
}

// 手动更新API处理函数
async function handleManualUpdate(req, res) {
    const token = req.query.token;
    const clientIp = req.headers['x-forwarded-for'] || req.connection.remoteAddress;
    
    if (token !== UPDATE_TOKEN) {
        log(`Invalid update token from ${clientIp}`, 'WARN', 'UPDATE');
        return res.status(401).json({ 
            error: 'Invalid token',
            message: 'Please provide valid UPDATE_TOKEN',
            timestamp: require('./utils').getCurrentTimestamp()
        });
    }
    
    log(`Manual update requested from ${clientIp}`, 'INFO', 'UPDATE');
    
    try {
        const startTime = Date.now();
        const result = await updateImageList();
        const duration = Date.now() - startTime;
        
        if (result.success) {
            res.json({
                success: true,
                message: `Successfully updated image list`,
                data: {
                    imageCount: result.count,
                    stats: result.stats,
                    duration: duration,
                    basePath: result.path,
                    formats: {
                        'list.json': 'Directory-based structure for web display',
                        'images-details.json': 'Detailed array for API processing'
                    }
                },
                timestamp: require('./utils').getCurrentTimestamp()
            });
            
            log(`Manual update completed successfully in ${duration}ms`, 'INFO', 'UPDATE');
        } else {
            res.status(500).json({
                success: false,
                error: result.error,
                data: result,
                timestamp: require('./utils').getCurrentTimestamp()
            });
            
            log(`Manual update failed: ${result.error}`, 'ERROR', 'UPDATE');
        }
    } catch (error) {
        log(`Manual update error: ${error.message}`, 'ERROR', 'UPDATE');
        res.status(500).json({
            success: false,
            error: 'Internal server error',
            message: process.env.NODE_ENV === 'development' ? error.message : 'Something went wrong',
            timestamp: require('./utils').getCurrentTimestamp()
        });
    }
}

// 启动更新服务
async function start(appConfig) {
    config = appConfig;
    
    process.env.WORKER_ID = process.env.WORKER_ID || (require('cluster').worker ? require('cluster').worker.id : '1');
    
    log(`Update service starting...`, 'INFO', 'UPDATE');
    log(`Update token configured: ${UPDATE_TOKEN.substring(0, 8)}***`, 'DEBUG', 'UPDATE');
    log(`Image path: ${path.resolve(config.paths.images)}`, 'INFO', 'UPDATE');
    log(`Supported extensions: ${config.update.supportedExtensions.join(', ')}`, 'DEBUG', 'UPDATE');
    
    // 立即执行一次更新
    try {
        const initialResult = await updateImageList();
        if (initialResult.success) {
            log(`Initial scan found ${initialResult.count} images`, 'INFO', 'UPDATE');
        } else {
            log(`Initial scan failed: ${initialResult.error}`, 'ERROR', 'UPDATE');
        }
    } catch (error) {
        log(`Initial update error: ${error.message}`, 'ERROR', 'UPDATE');
    }
    
    // 设置定时更新（如果配置了正数小时）
    if (config.update.hours > 0) {
        const updateIntervalMs = config.update.hours * 60 * 60 * 1000;
        updateInterval = setInterval(async () => {
            log('Scheduled update starting...', 'INFO', 'UPDATE');
            try {
                const result = await updateImageList();
                if (result.success) {
                    log(`Scheduled update completed: ${result.count} images`, 'INFO', 'UPDATE');
                } else {
                    log(`Scheduled update failed: ${result.error}`, 'ERROR', 'UPDATE');
                }
            } catch (error) {
                log(`Scheduled update error: ${error.message}`, 'ERROR', 'UPDATE');
            }
        }, updateIntervalMs);
        
        log(`Automatic updates scheduled every ${config.update.hours} hours`, 'INFO', 'UPDATE');
    } else {
        log('Automatic updates disabled (hours set to -1 or 0)', 'INFO', 'UPDATE');
    }
    
    return { 
        handleManualUpdate,
        updateImageList
    };
}

// 停止更新服务
function stop() {
    if (updateInterval) {
        clearInterval(updateInterval);
        log('Scheduled update service stopped', 'INFO', 'UPDATE');
    }
}

module.exports = { 
    start, 
    stop, 
    updateImageList, 
    handleManualUpdate 
};