import fs from 'fs/promises';
import path from 'path';
import { fileURLToPath } from 'url';
import pino from 'pino';
import * as sqlite from './sqlite.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const LOG_LEVEL = process.env.LOG_LEVEL || 'info';
const logger = pino({
    level: LOG_LEVEL,
    transport: {
        target: 'pino-pretty',
        options: {
            colorize: true,
            translateTime: 'SYS:standard',
            ignore: 'pid,hostname'
        }
    }
});

const JSON_DB_PATH = path.join(__dirname, 'video_database.json');

async function migrate() {
    logger.info('Iniciando migración de JSON a SQLite...');
    
    try {
        const jsonData = await fs.readFile(JSON_DB_PATH, 'utf-8');
        const db = JSON.parse(jsonData);
        
        sqlite.initDB();
        
        let totalVideos = 0;
        let totalChannels = 0;
        
        for (const [channelName, videos] of Object.entries(db)) {
            logger.info({ channel: channelName, videoCount: Object.keys(videos).length }, 'Migrando canal');
            
            const videoList = Object.values(videos).map(v => ({
                id: v.id,
                title: v.title || '',
                url: v.url || '',
                thumbnailUrl: v.thumbnailUrl || '',
                thumbnailAlt: v.thumbnailAlt || null,
                duration: v.duration || '',
                uploadDate: v.uploadDate || '',
                orderIndex: v.orderIndex || 0,
                isDownload: v.isDownload || false
            }));
            
            sqlite.upsertVideosBatch(channelName, videoList);
            
            totalChannels++;
            totalVideos += videoList.length;
        }
        
        const stats = sqlite.getStats();
        logger.info({
            channels: stats.channels,
            videos: stats.videos,
            downloaded: stats.downloaded
        }, 'Migración completada');
        
        await fs.unlink(JSON_DB_PATH);
        logger.info('Archivo JSON eliminado');
        
        console.log('\n========================================');
        console.log('MIGRACIÓN EXITOSA');
        console.log('========================================');
        console.log(`Canales: ${stats.channels}`);
        console.log(`Videos: ${stats.videos}`);
        console.log(`Descargados: ${stats.downloaded}`);
        console.log(`Base de datos: ${sqlite.DB_PATH}`);
        console.log('========================================\n');
        
    } catch (err) {
        if (err.code === 'ENOENT') {
            logger.info('No se encontró archivo JSON para migrar');
            sqlite.initDB();
            logger.info('Base de datos SQLite inicializada');
            return;
        }
        throw err;
    }
}

migrate().catch(err => {
    logger.fatal({ err }, 'Error en migración');
    process.exit(1);
});