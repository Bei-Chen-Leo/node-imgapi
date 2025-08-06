const fs = require('fs-extra');
const path = require('path');
const cluster = require('cluster');
const os = require('os');

// 立即输出启动信息
console.log(`[DEBUG] Starting app.js at ${new Date().toISOString()}`);
console.log(`[DEBUG] Node.js version: ${process.version}`);
console.log(`[DEBUG] Is master: ${cluster.isMaster || cluster.isPrimary}`);
console.log(`[DEBUG] Worker ID: ${cluster.worker ? cluster.worker.id : 'master'}`);

// 临时的简单日志函数（在utils加载之前使用）
function debugLog(message) {
    console.log(`[${new Date().toISOString()}] [DEBUG] ${message}`);
}

debugLog('Loading utils module...');

// 尝试加载utils，看看是否卡在这里
let utils;
try {
    utils = require('./utils');
    debugLog('Utils loaded successfully');
} catch (error) {
    console.error(`[ERROR] Failed to load utils: ${error.message}`);
    console.error(error.stack);
    process.exit(1);
}

const { setConfig, log, getCurrentTimestamp } = utils;

debugLog('Utils functions extracted');

// 全局状态管理
let isShuttingDown = false;
let workerRestartCount = new Map();
const MAX_WORKER_RESTARTS = 3;
const RESTART_WINDOW = 60000;

debugLog('Global variables initialized');

// 加载配置
async function loadConfig() {
    try {
        debugLog('Loading configuration...');
        const configPath = path.join(__dirname, 'config', 'config.json');
        debugLog(`Config path: ${configPath}`);
        
        const config = await fs.readJson(configPath);
        debugLog('Configuration file read successfully');
        
        // 设置工具函数的配置
        setConfig(config);
        debugLog('Configuration set in utils');
        
        log('Configuration loaded successfully', 'INFO', 'APP');
        return config;
    } catch (error) {
        console.log(`[${getCurrentTimestamp()}] [ERROR] [APP] Failed to load configuration: ${error.message}`);
        console.error(error.stack);
        process.exit(1);
    }
}

// 初始化必要的文件
async function initializeFiles() {
    try {
        debugLog('Initializing files...');
        
        // 确保必要的JSON文件存在且有效
        const files = [
            { path: path.join(__dirname, 'list.json'), content: {} },
            { path: path.join(__dirname, 'images-details.json'), content: [] },
            { path: path.join(__dirname, 'list.stats.json'), content: { 
                generated: new Date().toISOString(), 
                stats: { totalImages: 0 },
                timezone: 'Asia/Shanghai'
            }}
        ];
        
        debugLog(`Checking ${files.length} files...`);
        
        for (const file of files) {
            debugLog(`Checking file: ${path.basename(file.path)}`);
            
            if (!await fs.pathExists(file.path)) {
                debugLog(`Creating missing file: ${path.basename(file.path)}`);
                await fs.writeJson(file.path, file.content, { spaces: 2 });
                log(`Created missing file: ${path.basename(file.path)}`, 'INFO', 'APP');
            } else {
                // 验证文件内容
                try {
                    debugLog(`Validating file: ${path.basename(file.path)}`);
                    const content = await fs.readFile(file.path, 'utf-8');
                    if (!content.trim()) {
                        throw new Error('Empty file');
                    }
                    JSON.parse(content);
                    debugLog(`File ${path.basename(file.path)} is valid`);
                } catch (parseError) {
                    debugLog(`File ${path.basename(file.path)} is corrupted, recreating...`);
                    log(`File ${path.basename(file.path)} is corrupted, recreating...`, 'WARN', 'APP');
                    await fs.writeJson(file.path, file.content, { spaces: 2 });
                }
            }
        }
        
        debugLog('File initialization completed');
        
        // 清理可能的锁文件和临时文件
        try {
            debugLog('Cleaning up lock and temp files...');
            const lockFiles = await fs.readdir(__dirname);
            for (const file of lockFiles) {
                if (file.endsWith('.lock') || file.endsWith('.tmp')) {
                    try {
                        await fs.unlink(path.join(__dirname, file));
                        debugLog(`Cleaned up: ${file}`);
                        log(`Cleaned up: ${file}`, 'DEBUG', 'APP');
                    } catch (e) {
                        // 忽略清理错误
                    }
                }
            }
            debugLog('Cleanup completed');
        } catch (e) {
            debugLog('Cleanup failed, but continuing...');
        }
        
    } catch (error) {
        debugLog(`Failed to initialize files: ${error.message}`);
        log(`Failed to initialize files: ${error.message}`, 'ERROR', 'APP');
        throw error;
    }
}

// Worker进程
async function startWorker() {
    try {
        debugLog('Starting worker process...');
        
        const config = await loadConfig();
        debugLog('Config loaded in worker');
        
        // 设置工作进程ID
        process.env.WORKER_ID = cluster.worker ? cluster.worker.id : '1';
        debugLog(`Worker ID set to: ${process.env.WORKER_ID}`);
        
        // 初始化文件
        await initializeFiles();
        debugLog('Files initialized in worker');
        
        // 只有第一个worker初始化缓存管理器和Redis连接
        let cacheManager = null;
        if (cluster.worker && cluster.worker.id === 1) {
            debugLog('Loading cache-manager for primary worker...');
            try {
                cacheManager = require('./cache-manager');
                debugLog('cache-manager loaded');
                
                await cacheManager.initialize(config);
                debugLog('cache-manager initialized');
                
                // 启动更新服务
                debugLog('Loading update service...');
                const updateService = require('./update');
                debugLog('update service loaded');
                
                await updateService.start(config);
                debugLog('update service started');
                
                log('Primary worker initialized with cache and update services', 'INFO', 'APP');
            } catch (error) {
                debugLog(`Error initializing primary worker services: ${error.message}`);
                throw error;
            }
        } else {
            debugLog('Loading simple-cache-manager for secondary worker...');
            try {
                cacheManager = require('./simple-cache-manager');
                debugLog('simple-cache-manager loaded');
                
                await cacheManager.initialize(config);
                debugLog('simple-cache-manager initialized');
                
                log('Secondary worker initialized with simple cache', 'INFO', 'APP');
            } catch (error) {
                debugLog(`Error initializing secondary worker services: ${error.message}`);
                throw error;
            }
        }
        
        // 启动Web服务
        debugLog('Loading web service...');
        try {
            const webService = require('./web');
            debugLog('web service loaded');
            
            await webService.start(config, cacheManager);
            debugLog('web service started');
        } catch (error) {
            debugLog(`Error starting web service: ${error.message}`);
            throw error;
        }
        
        log('Worker started successfully', 'INFO', 'APP');
        debugLog('Worker startup completed');
        
        // 优雅关闭
        const shutdown = async (signal) => {
            log(`Received ${signal}, shutting down worker...`, 'INFO', 'APP');
            try {
                if (cacheManager && typeof cacheManager.close === 'function') {
                    await cacheManager.close();
                }
                process.exit(0);
            } catch (error) {
                log(`Error during shutdown: ${error.message}`, 'ERROR', 'APP');
                process.exit(1);
            }
        };
        
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        process.on('message', (msg) => {
            if (msg === 'shutdown') {
                shutdown('MESSAGE');
            }
        });
        
        // 处理未捕获的异常
        process.on('uncaughtException', (error) => {
            debugLog(`Uncaught exception: ${error.message}`);
            log(`Uncaught exception in worker: ${error.message}`, 'ERROR', 'APP');
            log(`Stack: ${error.stack}`, 'DEBUG', 'APP');
            process.exit(1);
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            debugLog(`Unhandled rejection: ${reason}`);
            log(`Unhandled rejection in worker: ${reason}`, 'ERROR', 'APP');
            process.exit(1);
        });
        
    } catch (error) {
        debugLog(`Failed to start worker: ${error.message}`);
        debugLog(`Error stack: ${error.stack}`);
        log(`Failed to start worker: ${error.message}`, 'ERROR', 'APP');
        log(`Error stack: ${error.stack}`, 'DEBUG', 'APP');
        process.exit(1);
    }
}

// 检查worker是否应该重启
function shouldRestartWorker(workerId) {
    debugLog(`Checking if worker ${workerId} should restart`);
    if (isShuttingDown) {
        return false;
    }
    
    const now = Date.now();
    const restarts = workerRestartCount.get(workerId) || [];
    
    // 清理超出时间窗口的重启记录
    const recentRestarts = restarts.filter(time => now - time < RESTART_WINDOW);
    workerRestartCount.set(workerId, recentRestarts);
    
    // 检查是否超过最大重启次数
    if (recentRestarts.length >= MAX_WORKER_RESTARTS) {
        log(`Worker ${workerId} has restarted ${recentRestarts.length} times in the last minute, not restarting`, 'ERROR', 'APP');
        return false;
    }
    
    return true;
}

// 记录worker重启
function recordWorkerRestart(workerId) {
    const restarts = workerRestartCount.get(workerId) || [];
    restarts.push(Date.now());
    workerRestartCount.set(workerId, restarts);
}

// Master进程
async function startMaster() {
    try {
        debugLog('Starting master process...');
        
        const config = await loadConfig();
        debugLog('Config loaded in master');
        
        // 在master进程中也初始化文件
        await initializeFiles();
        debugLog('Files initialized in master');
        
        const numWorkers = config.server.workers || os.cpus().length;
        debugLog(`Will create ${numWorkers} workers`);
        
        log(`Master process started (PID: ${process.pid})`, 'INFO', 'APP');
        log(`Creating ${numWorkers} workers`, 'INFO', 'APP');
        log(`Timezone: ${config.timezone}`, 'INFO', 'APP');
        log(`Logging: ${config.logging.enabled ? 'enabled' : 'disabled'} (level: ${config.logging.level})`, 'INFO', 'APP');
        log(`Cache enabled: ${config.cache.enabled}`, 'INFO', 'APP');
        log(`Redis reconnection: max ${config.redis.reconnect.maxRetries} attempts, ${config.redis.reconnect.retryInterval/1000}s interval`, 'INFO', 'APP');
        log(`Auto update: ${config.update.hours > 0 ? config.update.hours + ' hours' : 'disabled'}`, 'INFO', 'APP');
        log(`HTTPS: ${config.server.ssl.enabled === true || config.server.ssl.enabled === 1 ? 'enabled' : 'disabled'}`, 'INFO', 'APP');
        log(`CORS: ${config.server.cors.enabled ? 'enabled' : 'disabled'}`, 'INFO', 'APP');
        
        // 创建worker进程
        debugLog('Creating workers...');
        for (let i = 0; i < numWorkers; i++) {
            debugLog(`Creating worker ${i + 1}/${numWorkers}`);
            const worker = cluster.fork();
            log(`Worker ${worker.process.pid} started (ID: ${worker.id})`, 'INFO', 'APP');
        }
        
        debugLog('All workers created, setting up event listeners...');
        
        // 监听worker退出
        cluster.on('exit', (worker, code, signal) => {
            if (isShuttingDown) {
                log(`Worker ${worker.process.pid} (ID: ${worker.id}) exited during shutdown`, 'INFO', 'APP');
                return;
            }
            
            log(`Worker ${worker.process.pid} (ID: ${worker.id}) died with code ${code} and signal ${signal}`, 'ERROR', 'APP');
            
            // 检查是否应该重启
            if (shouldRestartWorker(worker.id)) {
                recordWorkerRestart(worker.id);
                
                // 延迟重启，避免快速重启循环
                setTimeout(() => {
                    if (!isShuttingDown) {
                        const newWorker = cluster.fork();
                        log(`New worker ${newWorker.process.pid} (ID: ${newWorker.id}) started to replace ${worker.id}`, 'INFO', 'APP');
                    }
                }, 2000);
            } else {
                log(`Worker ${worker.id} will not be restarted due to restart limits or shutdown`, 'WARN', 'APP');
            }
        });
        
        // 监听worker在线
        cluster.on('online', (worker) => {
            debugLog(`Worker ${worker.id} is online`);
            log(`Worker ${worker.process.pid} (ID: ${worker.id}) is online`, 'DEBUG', 'APP');
        });
        
        // 监听worker断开连接
        cluster.on('disconnect', (worker) => {
            debugLog(`Worker ${worker.id} disconnected`);
            log(`Worker ${worker.process.pid} (ID: ${worker.id}) disconnected`, 'DEBUG', 'APP');
        });
        
        debugLog('Event listeners set up, master initialization complete');
        
        // 优雅关闭
        const shutdown = (signal) => {
            if (isShuttingDown) {
                log('Shutdown already in progress', 'WARN', 'APP');
                return;
            }
            
            isShuttingDown = true;
            log(`Master received ${signal}, shutting down all workers...`, 'INFO', 'APP');
            
            const workers = Object.values(cluster.workers);
            let workersAlive = workers.length;
            
            if (workersAlive === 0) {
                log('No workers to shut down, master exiting', 'INFO', 'APP');
                process.exit(0);
                return;
            }
            
            // 发送关闭信号给所有worker
            workers.forEach(worker => {
                if (worker && !worker.isDead()) {
                    worker.send('shutdown');
                    worker.disconnect();
                }
            });
            
            // 监听worker退出
            const exitHandler = () => {
                workersAlive--;
                log(`Workers remaining: ${workersAlive}`, 'DEBUG', 'APP');
                if (workersAlive === 0) {
                    log('All workers shut down, master exiting', 'INFO', 'APP');
                    process.exit(0);
                }
            };
            
            cluster.on('exit', exitHandler);
            
            // 强制退出超时
            setTimeout(() => {
                log('Force killing remaining workers after timeout', 'WARN', 'APP');
                workers.forEach(worker => {
                    if (worker && !worker.isDead()) {
                        worker.kill('SIGKILL');
                    }
                });
                
                setTimeout(() => {
                    log('Force exit after timeout', 'WARN', 'APP');
                    process.exit(1);
                }, 2000);
            }, 10000);
        };
        
        process.on('SIGINT', () => shutdown('SIGINT'));
        process.on('SIGTERM', () => shutdown('SIGTERM'));
        
        // 处理未捕获的异常
        process.on('uncaughtException', (error) => {
            debugLog(`Master uncaught exception: ${error.message}`);
            log(`Uncaught exception in master: ${error.message}`, 'ERROR', 'APP');
            log(`Stack: ${error.stack}`, 'DEBUG', 'APP');
            shutdown('UNCAUGHT_EXCEPTION');
        });
        
        process.on('unhandledRejection', (reason, promise) => {
            debugLog(`Master unhandled rejection: ${reason}`);
            log(`Unhandled rejection in master: ${reason}`, 'ERROR', 'APP');
            shutdown('UNHANDLED_REJECTION');
        });
        
    } catch (error) {
        debugLog(`Failed to start master: ${error.message}`);
        debugLog(`Error stack: ${error.stack}`);
        log(`Failed to start master: ${error.message}`, 'ERROR', 'APP');
        process.exit(1);
    }
}

// 启动应用
debugLog('Determining process type...');
if (cluster.isMaster || cluster.isPrimary) {
    debugLog('Starting as master process');
    startMaster().catch(error => {
        debugLog(`Master startup failed: ${error.message}`);
        console.error('Master startup failed:', error);
        process.exit(1);
    });
} else {
    debugLog('Starting as worker process');
    startWorker().catch(error => {
        debugLog(`Worker startup failed: ${error.message}`);
        console.error('Worker startup failed:', error);
        process.exit(1);
    });
}

debugLog('App.js initialization complete');