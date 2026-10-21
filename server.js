/////////////////////////////////////////
// IMPORTACIÓN DE MÓDULOS
/////////////////////////////////////////
import express from 'express';
import path from 'path';
import { spawn } from 'child_process';
import { promisify } from 'util';
import { Mutex } from 'async-mutex';
import { exec as execCallback } from 'child_process';
import fs from 'fs/promises';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';
import pino from 'pino';
import * as db from './db/sqlite.js';

/////////////////////////////////////////
// CONFIGURACIÓN DE ENTORNO
/////////////////////////////////////////
dotenv.config();

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

/////////////////////////////////////////
// CONFIGURACIÓN DE LOGGING
/////////////////////////////////////////
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

/////////////////////////////////////////
// CONSTANTES Y CONFIGURACIÓN
/////////////////////////////////////////
const CONFIG = {
    PORT: parseInt(process.env.PORT) || 3000,
    VIDEOS_DIR: process.env.VIDEOS_DIR || path.join(__dirname, 'VIDEOS'),
    VIDEO_EXTENSIONS: ['mp4', 'webm', 'mkv', 'mov'],
    VIDEO_ID_REGEX: /^[\w-]{11}$/,
    USER_AGENTS: [
        'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0',
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
        'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36'
    ]
};

function getRandomUserAgent() {
    const ua = CONFIG.USER_AGENTS;
    return ua[Math.floor(Math.random() * ua.length)];
}

/////////////////////////////////////////
// ESTADO GLOBAL
/////////////////////////////////////////
const activeDownloads = new Map();
let clients = [];
let ytDlpAvailable = false;
const downloadSemaphore = new Mutex(); // Reemplazado por simple queue logic

/////////////////////////////////////////
// FUNCIONES AUXILIARES
/////////////////////////////////////////

async function checkYtDlpAvailable() {
    const exec = promisify(execCallback);
    try {
        await exec('yt-dlp --version');
        return true;
    } catch {
        return false;
    }
}

function validateVideoId(videoId) {
    return CONFIG.VIDEO_ID_REGEX.test(videoId);
}

/**
 * Evita que un nombre de canal recibido por HTTP escape de VIDEOS_DIR
 * (por ejemplo con "../../etc").
 */
function sanitizeChannelName(channel) {
    const clean = path.basename(String(channel)).replace(/[^\w .-]/g, '_').trim();
    return clean || 'canal';
}

async function getCookiesArgs() {
    const cookiesFile = process.env.COOKIES_FILE || path.join(__dirname, 'cookies.txt');
    try {
        await fs.access(cookiesFile);
        logger.info({ cookiesFile }, 'Usando archivo de cookies');
        return ['--cookies', cookiesFile];
    } catch {
        if (process.env.COOKIES_FROM_BROWSER) {
            logger.info({ browser: process.env.COOKIES_FROM_BROWSER }, 'Usando cookies desde el navegador');
            return ['--cookies-from-browser', process.env.COOKIES_FROM_BROWSER];
        }
        logger.info('Sin cookies configuradas');
        return [];
    }
}

async function refreshCookies() {
    const scriptPath = process.env.COOKIES_REFRESH_SCRIPT;
    if (!scriptPath) {
        logger.warn('COOKIES_REFRESH_SCRIPT no configurado: no se pueden refrescar las cookies');
        return false;
    }

    logger.info('🔄 Refrescando cookies automáticamente...');
    try {
        const { exec } = await import('child_process');
        const promisify = await import('util');
        const execPromisified = promisify.default.promisify(exec);

        await execPromisified(`/bin/bash "${scriptPath}"`);
        logger.info('✅ Cookies refrescadas exitosamente');
        return true;
    } catch (error) {
        logger.error({ error }, '❌ Error al refrescar cookies automáticamente');
        return false;
    }
}

/**
 * Verifica si existe un archivo de video descargado
 * @param {string} channel - Nombre del canal
 * @param {string} videoId - ID del video
 * @returns {Promise<{exists: boolean, path?: string}>}
 */
async function findDownloadedVideo(channel, videoId) {
    const safeChannel = sanitizeChannelName(channel);

    for (const ext of CONFIG.VIDEO_EXTENSIONS) {
        const filePath = path.join(CONFIG.VIDEOS_DIR, safeChannel, `${videoId}.${ext}`);
        try {
            await fs.access(filePath);
            return { exists: true, path: filePath };
        } catch {
            continue;
        }
    }
    return { exists: false };
}

/**
 * Crea la carpeta de destino si no existe
 * @param {string} channel - Nombre del canal
 * @returns {Promise<string>} - Ruta de la carpeta
 */
async function ensureChannelFolder(channel) {
    const channelDir = path.join(CONFIG.VIDEOS_DIR, sanitizeChannelName(channel));
    await fs.mkdir(channelDir, { recursive: true });
    return channelDir;
}

/**
 * Broadcast a todos los clientes SSE
 * @param {Object} data - Datos a enviar
 */
function broadcast(data) {
    const message = `data: ${JSON.stringify(data)}\n\n`;
    clients.forEach(client => {
        try {
            client.res.write(message);
        } catch {
            // Cliente desconectado
        }
    });
}

/////////////////////////////////////////
// INICIALIZACIÓN DE EXPRESS
/////////////////////////////////////////
const app = express();

app.get('/status', async (req, res) => {
    const diskSpace = await fs.statfs('/').catch(() => ({ bavail: 0, blocksize: 0 }));
    const freeGB = Math.round((diskSpace.bavail * diskSpace.bsize) / (1024**3));
    
    const cookiesExist = await fs.access(path.join(__dirname, 'cookies.txt')).then(() => true).catch(() => false);
    
    res.json({
        status: 'online',
        system: {
            ytDlp: ytDlpAvailable,
            cookiesFile: cookiesExist,
            freeDiskGB: freeGB
        },
        downloads: activeDownloads.size
    });
});

/////////////////////////////////////////
// ENDPOINT: Página principal
/////////////////////////////////////////
app.get('/', async (_req, res) => {
    logger.info('Petición GET / recibida');
    const index = path.join(__dirname, 'docs', 'index.html');
    
    try {
        await fs.access(index);
        res.sendFile(index, (err) => {
            if (err) {
                logger.error({ err }, 'Error enviando archivo index.html');
                res.status(500).send('Error interno del servidor');
            }
        });
    } catch {
        logger.warn('Archivo index.html no encontrado');
        res.send('<h1>Servidor de Descargas Activo</h1><p>No se encontró la interfaz en docs/index.html.</p>');
    }
});

/////////////////////////////////////////
// ARCHIVOS ESTÁTICOS
/////////////////////////////////////////
app.use(express.static(path.join(__dirname, 'docs')));

/////////////////////////////////////////
// ENDPOINT: Server-Sent Events (SSE)
/////////////////////////////////////////
app.get('/events', (req, res) => {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');

    const clientId = Date.now();
    clients.push({ id: clientId, res });

    req.on('close', () => {
        clients = clients.filter(c => c.id !== clientId);
        logger.debug({ clientId }, 'Cliente SSE desconectado');
    });
});

/////////////////////////////////////////
// ENDPOINT: Descargas activas
/////////////////////////////////////////
app.get('/downloads/active', (_req, res) => {
    const downloads = [];
    for (const [videoId, data] of activeDownloads) {
        downloads.push({
            videoId,
            channel: data.channel,
            percent: data.percent,
            speed: data.speed,
            total: data.total,
            status: data.status
        });
    }
    res.json({ downloads });
});

/////////////////////////////////////////
// ENDPOINT: Listar videos
/////////////////////////////////////////
app.get('/videos', async (_req, res) => {
    try {
        const videos = db.getAllVideos();
        res.json(videos);
    } catch (error) {
        logger.error({ error }, 'Error leyendo base de datos');
        res.status(500).json({ error: 'Error leyendo base de datos' });
    }
});

/////////////////////////////////////////
// ENDPOINT: Sincronizar estado de descargas
/////////////////////////////////////////
app.post('/sync', async (_req, res) => {
    try {
        const dbData = db.getAllVideos();
        let updatedCount = 0;

        for (const channelName of Object.keys(dbData)) {
            const channelVideos = dbData[channelName];
            
            for (const videoId of Object.keys(channelVideos)) {
                const { exists } = await findDownloadedVideo(channelName, videoId);
                
                if (exists && !channelVideos[videoId].isDownload) {
                    db.setDownloaded(videoId, channelName);
                    updatedCount++;
                }
            }
        }

        if (updatedCount > 0) {
            logger.info({ updatedCount }, 'Base de datos sincronizada');
        }

        res.json({ 
            status: 'ok', 
            updated: updatedCount, 
            message: `Sincronización completada. ${updatedCount} videos actualizados.` 
        });
    } catch (error) {
        logger.error({ error }, 'Error durante la sincronización');
        res.status(500).json({ error: 'Error durante la sincronización' });
    }
});

/////////////////////////////////////////
// ENDPOINT: Descarga de video
/////////////////////////////////////////
app.get('/download', async (req, res) => {
    const { channel, video } = req.query;

    // Validación de parámetros
    if (!channel || !video) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Falta el alias del canal o el ID del video' 
        });
    }

    const safeChannel = sanitizeChannelName(channel);

    if (!validateVideoId(video)) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'ID de video inválido. Debe tener 11 caracteres alfanuméricos.' 
        });
    }

    // Verificar yt-dlp disponible
    if (!ytDlpAvailable) {
        logger.error('Intento de descarga pero yt-dlp no está disponible');
        return res.status(500).json({ 
            status: 'error', 
            message: 'yt-dlp no está instalado o no está en PATH' 
        });
    }

    // Evitar descargas duplicadas del mismo video
    if (activeDownloads.has(video)) {
        return res.json({ 
            status: 'busy', 
            message: 'Descarga ya en progreso para este video.' 
        });
    }

    // Semáforo: máximo 2 descargas simultáneas
    const MAX_PARALLEL = 2;
    if (activeDownloads.size >= MAX_PARALLEL) {
        return res.json({
            status: 'queued',
            message: `Máximo ${MAX_PARALLEL} descargas en paralelo. Este video comenzará cuando haya espacio.`
        });
    }

    activeDownloads.set(video, {
        channel,
        percent: 0,
        speed: null,
        total: null,
        status: 'starting',
        startTime: Date.now()
    });

    logger.info({ channel, video, activeCount: activeDownloads.size }, 'Solicitud de descarga recibida');

    // Delay de 10 segundos entre inicios para no saturar YouTube
    if (activeDownloads.size > 1) {
        logger.info({ video, delay: 10000 }, 'Esperando 10 segundos antes de iniciar segunda descarga...');
        await new Promise(resolve => setTimeout(resolve, 10000));
    }

    // Crear carpeta de destino
    await ensureChannelFolder(safeChannel);

    // Construir argumentos de yt-dlp
    const videoUrl = `https://www.youtube.com/watch?v=${video}`;
    const outputPath = path.join(CONFIG.VIDEOS_DIR, safeChannel, '%(id)s.%(ext)s');

    const cookiesArgs = await getCookiesArgs();
    const userAgent = getRandomUserAgent();

    const ytdlpArgs = [
        videoUrl,
        '-f', 'bestvideo[height>=720]+bestaudio/best[height>=720]/best',
        '--merge-output-format', 'mp4',
        ...cookiesArgs,
        '--js-runtimes', `deno:${process.env.DENO_PATH || path.join(process.env.HOME, '.deno/bin/deno')}`,
        '--remote-components', 'ejs:github',
        '--user-agent', userAgent,
        '-o', outputPath,
        '--newline',
        '--no-cache-dir',
        '--concurrent-fragments', '4'
    ];

    // Iniciar descarga directamente (máximo 2 en paralelo controlado arriba)
    (async () => {
        logger.info({ video }, 'Iniciando descarga');

        // Lanzar yt-dlp
        let ytdlp;
        try {
            const ytdlpEnv = {
                ...process.env,
                PATH: `${path.dirname(process.env.DENO_PATH || path.join(process.env.HOME, '.deno/bin/deno'))}:${process.env.PATH}`
            };
            ytdlp = spawn('yt-dlp', ytdlpArgs, { env: ytdlpEnv });
            logger.info({ videoUrl }, 'yt-dlp iniciado');
        } catch (spawnErr) {
            activeDownloads.delete(video);
            logger.error({ err: spawnErr }, 'Error al iniciar yt-dlp');
            broadcast({ type: 'error', videoId: video, channel, message: 'No se pudo iniciar yt-dlp' });
            return;
        }

        // Variables de progreso
        let totalSize = null;
        let format = null;
        let lastPercent = null;

        // Manejo de errores de spawn
        ytdlp.on('error', (err) => {
            logger.error({ err }, 'Error de proceso yt-dlp');
            activeDownloads.delete(video);
            broadcast({ type: 'error', videoId: video, channel, message: 'Error iniciando yt-dlp' });
        });

        // Progreso en stdout
        ytdlp.stdout.on('data', (data) => {
            process.stdout.write(data.toString());

            const lines = data.toString().split('\n');

            for (const line of lines) {
                // Progreso de descarga - formato: [download] 0.3% of ~ 725.01MiB at 2.64MiB/s
                const progressMatch = line.match(/\[download\]\s+(\d{1,3}(?:\.\d)?)%\s+of\s+~?\s*([\d\.]+[KMGT]?i?B)\s+at\s+([^\s(]+)/);
                if (progressMatch) {
                    lastPercent = progressMatch[1];
                    totalSize = progressMatch[2];
                    const speed = progressMatch[3];

                    // Actualizar estado activo
                    const downloadState = activeDownloads.get(video);
                    if (downloadState) {
                        downloadState.percent = lastPercent;
                        downloadState.speed = speed;
                        downloadState.total = totalSize;
                        downloadState.status = 'downloading';
                    }

                    if (process.stdout.isTTY) {
                        process.stdout.clearLine(0);
                        process.stdout.cursorTo(0);
                        process.stdout.write(`➡️  Progreso: ${lastPercent}% de ${totalSize} | Velocidad: ${speed} `);
                    }

                    broadcast({
                        type: 'progress',
                        videoId: video,
                        channel,
                        percent: lastPercent,
                        total: totalSize,
                        speed
                    });
                    continue;
                }

                // Progreso HLS - formato: [download] 0.3% of ~ 725.01MiB
                const hlsProgressMatch = line.match(/\[download\]\s+(\d{1,3}(?:\.\d)?)%/);
                if (hlsProgressMatch && !progressMatch) {
                    lastPercent = hlsProgressMatch[1];

                    // Actualizar estado activo
                    const downloadState = activeDownloads.get(video);
                    if (downloadState) {
                        downloadState.percent = lastPercent;
                        downloadState.status = 'downloading';
                    }

                    broadcast({
                        type: 'progress',
                        videoId: video,
                        channel,
                        percent: lastPercent,
                        total: totalSize || '?',
                        speed: '?'
                    });
                    continue;
                }

                // Formato detectado
                const formatMatch = line.match(/\[info\] Video format: (\w+)/);
                if (formatMatch) {
                    format = formatMatch[1];
                    if (process.stdout.isTTY) {
                        process.stdout.clearLine(0);
                        process.stdout.cursorTo(0);
                    }
                    logger.info({ format }, 'Formato detectado');
                    continue;
                }

                // Formato alternativo
                const altFormatMatch = line.match(/\[download\] Destination: .+\.(\w+)$/);
                if (altFormatMatch) {
                    format = altFormatMatch[1];
                    if (process.stdout.isTTY) {
                        process.stdout.clearLine(0);
                        process.stdout.cursorTo(0);
                    }
                    logger.info({ format }, 'Formato detectado');
                }
            }
        });

        // Errores en stderr
        ytdlp.stderr.on('data', async (data) => {
            const output = data.toString();
            process.stderr.write(output);

            if (output.includes('403 Forbidden') || output.includes('HTTP Error 403')) {
                logger.warn(' detectada error 403 Forbidden. Intentando refrescar cookies...');
                await refreshCookies();
                broadcast({
                    type: 'error',
                    videoId: video,
                    channel,
                    message: 'Error de autenticación. Cookies refrescadas, reintenta la descarga.'
                });
            }
        });

        // Descarga finalizada
        ytdlp.on('close', async (code) => {
            logger.info({ code }, 'yt-dlp finalizó');

            let downloadSuccess = false;
            const { exists, path: foundPath } = await findDownloadedVideo(channel, video);

            // Verificar éxito de descarga
            if (code === 0 && exists) {
                downloadSuccess = true;
            } else if (lastPercent && parseFloat(lastPercent) === 100) {
                downloadSuccess = true;
            } else if (exists && foundPath) {
                try {
                    const stats = await fs.stat(foundPath);
                    if (stats.size > 1024 * 1024) {
                        downloadSuccess = true;
                        logger.info({ size: stats.size }, 'Archivo encontrado con tamaño válido');
                    }
                } catch {}
            }

            if (downloadSuccess) {
                logger.info({ totalSize, format }, 'Descarga completada');

                broadcast({ type: 'completed', videoId: video, channel });

                try {
                    db.setDownloaded(video, channel);
                    logger.info({ video, channel }, 'Base de datos actualizada');
                } catch (err) {
                    logger.error({ err }, 'Error actualizando la base de datos');
                }
            } else {
                logger.warn({ code }, 'Descarga finalizada sin éxito');
                broadcast({
                    type: 'error',
                    videoId: video,
                    channel,
                    message: 'Descarga fallida o incompleta'
                });
            }

            activeDownloads.delete(video);
        });
    })();

    res.json({ 
        status: 'downloading', 
        message: 'Descarga iniciada, revisa la consola para ver el progreso.' 
    });
});

/////////////////////////////////////////
// MANEJO DE ERRORES GLOBALES
/////////////////////////////////////////
process.on('uncaughtException', (err) => {
    logger.fatal({ err }, 'Excepción no manejada');
    process.exit(1);
});

process.on('unhandledRejection', (reason) => {
    logger.fatal({ reason }, 'Promesa rechazada no manejada');
    process.exit(1);
});

/////////////////////////////////////////
// INICIALIZACIÓN DEL SERVIDOR
/////////////////////////////////////////
async function updateYtDlp() {
    logger.info('Checking for yt-dlp updates...');
    try {
        const { exec } = await import('child_process');
        const promisify = await import('util');
        const execPromisified = promisify.default.promisify(exec);
        
        await execPromisified('yt-dlp -U');
        logger.info('✅ yt-dlp updated successfully');
    } catch (error) {
        logger.warn({ error }, 'yt-dlp update failed or already up to date');
    }
}

async function startServer() {
    logger.info('🚀 Iniciando servidor...');
    
    // Actualizar yt-dlp al iniciar
    await updateYtDlp();
    
    // Inicializar base de datos SQLite
    db.initDB();
    logger.info('Base de datos SQLite inicializada');
    
    // Verificar yt-dlp
    ytDlpAvailable = await checkYtDlpAvailable();
    logger.info({ ytDlpAvailable }, 'Verificación de yt-dlp');
    
    // Iniciar servidor
    app.listen(CONFIG.PORT, () => {
        logger.info(`✅ Servidor ejecutándose en http://localhost:${CONFIG.PORT}`);
        logger.info({ 
            ytDlpAvailable, 
            videosDir: CONFIG.VIDEOS_DIR,
            dbPath: db.DB_PATH 
        }, 'Configuración del servidor');
    });
}

startServer().catch((err) => {
    logger.fatal({ err }, 'Error al iniciar el servidor');
    process.exit(1);
});
