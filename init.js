const fs = require('fs-extra');
const path = require('path');

async function initializeFiles() {
    console.log('Initializing application files...');
    
    // 确保目录存在
    await fs.ensureDir('./ima');
    await fs.ensureDir('./public');
    
    // 初始化空的JSON文件
    const files = [
        { path: './list.json', content: {} },
        { path: './images-details.json', content: [] },
        { path: './list.stats.json', content: { generated: new Date().toISOString(), stats: { totalImages: 0 } } }
    ];
    
    for (const file of files) {
        if (!await fs.pathExists(file.path)) {
            await fs.writeJson(file.path, file.content, { spaces: 2 });
            console.log(`Created ${file.path}`);
        } else {
            // 检查文件是否损坏
            try {
                await fs.readJson(file.path);
                console.log(`${file.path} is valid`);
            } catch (error) {
                console.log(`${file.path} is corrupted, recreating...`);
                await fs.writeJson(file.path, file.content, { spaces: 2 });
            }
        }
    }
    
    console.log('Initialization complete!');
}

initializeFiles().catch(console.error);