/////////////////////////////////////////
// IMPORTACIÓN DE MÓDULOS
/////////////////////////////////////////
import fs from 'fs/promises';
import path from 'path';
import { chromium } from 'playwright';
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
    VIDEOS_DIR: process.env.VIDEOS_DIR || path.join(__dirname, 'VIDEOS'),
    SCRAPING: {
        MAX_SCROLLS: parseInt(process.env.MAX_SCROLLS) || 20,
        SCROLL_WAIT_MS: parseInt(process.env.SCROLL_WAIT_MS) || 400,
        SCROLL_LOAD_WAIT_MS: parseInt(process.env.SCROLL_LOAD_WAIT_MS) || 1200,
        THUMBNAIL_MAX_ROUNDS: parseInt(process.env.THUMBNAIL_MAX_ROUNDS) || 6,
        THUMBNAIL_WAIT_MS: parseInt(process.env.THUMBNAIL_WAIT_MS) || 600,
        IMAGE_LOAD_TIMEOUT_MS: parseInt(process.env.IMAGE_LOAD_TIMEOUT_MS) || 3000,
        PAGE_TIMEOUT_MS: 30000,
        SELECTOR_TIMEOUT_MS: 10000
    },
    RETRY: {
        MAX_RETRIES: parseInt(process.env.MAX_RETRIES) || 3,
        DELAY_MS: parseInt(process.env.RETRY_DELAY_MS) || 2000
    },
    // Canales predefinidos para scrape-all
    DEFAULT_CHANNELS: [
        'https://www.youtube.com/@elrubius/videos',
        'https://www.youtube.com/@auron/videos',
        'https://www.youtube.com/@TheGrefg/videos'
    ]
};

/////////////////////////////////////////
// FUNCIONES AUXILIARES
/////////////////////////////////////////

/**
 * Asegura que un video tenga una thumbnail válida
 * @param {Object} video - Objeto video a procesar
 * @returns {Object} - Video con thumbnail asegurada
 */
function ensureThumbnail(video) {
    // Validar que el video tenga un ID válido
    if (!video.id || typeof video.id !== 'string') {
        logger.warn({ videoId: video.id }, 'Video sin ID válido, no se puede generar thumbnail');
        return video;
    }
    
    // Verificar si la thumbnail es válida
    const isValidThumbnail = video.thumbnailUrl && 
        /^https?:\/\//.test(video.thumbnailUrl) &&
        !video.thumbnailUrl.includes('undefined') &&
        !video.thumbnailUrl.includes('null');
    
    if (!isValidThumbnail) {
        video.thumbnailUrl = `https://i.ytimg.com/vi/${video.id}/hqdefault.jpg`;
    }
    
    return video;
}

/**
 * Navega a una URL con reintentos y backoff exponencial
 * @param {import('playwright').Page} page - Página de Playwright
 * @param {string} url - URL a navegar
 * @param {number} maxRetries - Máximo de reintentos
 */
async function gotoWithRetry(page, url, maxRetries = CONFIG.RETRY.MAX_RETRIES) {
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            await page.goto(url, { 
                waitUntil: 'networkidle',
                timeout: CONFIG.SCRAPING.PAGE_TIMEOUT_MS 
            });
            logger.debug({ url, attempt }, 'Navegación exitosa');
            return;
        } catch (err) {
            const delay = CONFIG.RETRY.DELAY_MS * (attempt + 1);
            logger.warn({ url, attempt, delay, err: err.message }, 'Reintentando navegación');
            
            if (attempt === maxRetries - 1) {
                throw new Error(`Falló navegación a ${url} después de ${maxRetries} intentos: ${err.message}`);
            }
            
            await page.waitForTimeout(delay);
        }
    }
}

/////////////////////////////////////////
// FUNCIONES DE SCRAPING
/////////////////////////////////////////

/**
 * Navega a la página del canal
 * @param {import('playwright').Page} page - Página de Playwright
 * @param {string} channelUrl - URL del canal
 */
async function navigateToChannel(page, channelUrl) {
    await gotoWithRetry(page, channelUrl);
    await page.waitForSelector('ytd-rich-grid-renderer', { 
        timeout: CONFIG.SCRAPING.SELECTOR_TIMEOUT_MS 
    });
    // Esperar a que YouTube renderice el layout completo (incluidos VODs)
    await page.waitForTimeout(5000);
    logger.info({ channelUrl }, 'Navegación al canal completada');
}

/**
 * Espera a que los metadatos de los primeros renderizados sean visibles
 * @param {import('playwright').Page} page - Página de Playwright
 */
async function waitForMetadata(page) {
    try {
        await page.waitForFunction(() => {
            const metas = document.querySelectorAll('ytd-rich-item-renderer div#metadata-line');
            return metas.length > 5;
        }, { timeout: 10000 });
        logger.debug('Metadatos renderizados');
    } catch {
        logger.warn('Timeout esperando metadatos, continuando...');
    }
}

/**
 * Extrae el nombre del canal de la página
 * @param {import('playwright').Page} page - Página de Playwright
 * @returns {Promise<string>} - Nombre del canal
 */
async function extractChannelName(page) {
    let channelName = 'canal_desconocido';
    
    try {
        await page.waitForSelector('yt-dynamic-text-view-model h1.dynamicTextViewModelH1 > span', { 
            timeout: 5000 
        });
        const nameElement = await page.locator('yt-dynamic-text-view-model h1.dynamicTextViewModelH1 > span').first();
        channelName = (await nameElement.textContent())?.trim() || channelName;
    } catch {
        // Fallback: intentar con h1 solo
        try {
            const h1Element = await page.locator('yt-dynamic-text-view-model h1.dynamicTextViewModelH1').first();
            const h1Text = (await h1Element.textContent())?.trim();
            if (h1Text && h1Text.length > 2) {
                channelName = h1Text;
            }
        } catch {
            logger.warn('No se pudo extraer el nombre del canal');
        }
    }
    
    logger.info({ channelName }, 'Nombre del canal extraído');
    return channelName;
}

/**
 * Hace scroll agresivo con detección de estabilidad por items renderizados
 * @param {import('playwright').Page} page - Página de Playwright
 */
async function scrollToLoadVideos(page) {
    const { MAX_SCROLLS, SCROLL_WAIT_MS, SCROLL_LOAD_WAIT_MS } = CONFIG.SCRAPING;
    let stableCount = 0;
    let lastItemCount = 0;
    
    for (let i = 0; i < MAX_SCROLLS; i++) {
        await page.evaluate('window.scrollTo(0, document.documentElement.scrollHeight)');
        await page.waitForTimeout(SCROLL_WAIT_MS);
        
        // Pequeños scrolls intermedios para disparar lazy-load
        await page.evaluate(() => {
            const step = Math.floor(window.innerHeight * 0.6);
            for (let y = window.scrollY; y < document.documentElement.scrollHeight; y += step) {
                window.scrollTo(0, y);
            }
        });
        await page.waitForTimeout(SCROLL_LOAD_WAIT_MS);
        
        // Contar items totales y items con metadata
        const { total, withMeta } = await page.evaluate(() => {
            const items = document.querySelectorAll('ytd-rich-item-renderer');
            let metaCount = 0;
            items.forEach(el => {
                const metaLine = el.querySelector('div#metadata-line');
                if (metaLine && metaLine.querySelector('span')) metaCount++;
            });
            return { total: items.length, withMeta: metaCount };
        });
        
        if (total === lastItemCount) {
            stableCount++;
            if (stableCount >= 2) {
                logger.debug({ scrolls: i, totalItems: total, withMeta }, 'Scroll completado - sin más contenido');
                break;
            }
        } else {
            stableCount = 0;
            lastItemCount = total;
        }
    }
    
    logger.debug({ totalItems: lastItemCount }, 'Scroll para cargar videos completado');
}

/**
 * Fuerza el renderizado de metadatos escroleando cada item sin metadata
 * @param {import('playwright').Page} page - Página de Playwright
 */
async function forceMetadataLoad(page) {
    let attempts = 0;
    const maxAttempts = 5;
    
    while (attempts < maxAttempts) {
        const missingMeta = await page.evaluate(() => {
            const items = Array.from(document.querySelectorAll('ytd-rich-item-renderer'));
            return items
                .map((el, idx) => ({ idx, hasMeta: !!el.querySelector('div#metadata-line span') }))
                .filter(x => !x.hasMeta)
                .map(x => x.idx);
        });
        
        if (missingMeta.length === 0) {
            logger.debug('Todos los metadatos renderizados');
            break;
        }
        
        logger.warn({ count: missingMeta.length, attempt: attempts + 1 }, 'Items sin metadata, forzando scroll...');
        
        // Hacer scroll a cada item sin metadata
        for (const idx of missingMeta.slice(0, 20)) {
            await page.evaluate((index) => {
                const items = document.querySelectorAll('ytd-rich-item-renderer');
                if (items[index]) items[index].scrollIntoView({ behavior: 'instant', block: 'center' });
            }, idx);
            await page.waitForTimeout(150);
        }
        
        await page.waitForTimeout(2000);
        attempts++;
    }
}

/**
 * Espera a que las miniaturas se carguen completamente
 * @param {import('playwright').Page} page - Página de Playwright
 */
async function waitForThumbnails(page) {
    const { THUMBNAIL_MAX_ROUNDS, THUMBNAIL_WAIT_MS } = CONFIG.SCRAPING;
    let lastCount = -1;
    let stableRounds = 0;
    
    for (let round = 0; round < THUMBNAIL_MAX_ROUNDS; round++) {
        const { loaded, total, complete } = await page.evaluate(() => {
            const imgs = Array.from(document.querySelectorAll(
                'ytd-rich-item-renderer ytd-thumbnail img, ytd-rich-item-renderer yt-image img'
            ));
            let loadedReal = 0;
            let completeCount = 0;
            
            for (const img of imgs) {
                const src = img.getAttribute('src');
                if (src && !src.startsWith('data:')) {
                    loadedReal++;
                    // Verificar si la imagen está completamente cargada
                    if (img.complete && img.naturalHeight > 0) {
                        completeCount++;
                    }
                }
            }
            
            return { loaded: loadedReal, total: imgs.length, complete: completeCount };
        });
        
        // Verificar estabilidad: mismo conteo por 2 rondas consecutivas
        if (loaded === lastCount && loaded > 0) {
            stableRounds++;
            if (stableRounds >= 2 || complete >= loaded * 0.9) {
                logger.debug({ loaded, total, complete }, 'Thumbnails completamente cargadas');
                return;
            }
        } else {
            stableRounds = 0;
        }
        
        lastCount = loaded;
        await page.waitForTimeout(THUMBNAIL_WAIT_MS);
    }
    
    logger.warn('Timeout esperando thumbnails completas');
}

/**
 * Espera a que todas las imágenes visibles se carguen
 * @param {import('playwright').Page} page - Página de Playwright
 */
async function waitForImagesToLoad(page) {
    const { IMAGE_LOAD_TIMEOUT_MS } = CONFIG.SCRAPING;
    
    await page.evaluate(async (timeoutMs) => {
        const images = Array.from(document.querySelectorAll('ytd-thumbnail img'));
        
        function waitForImage(img, timeout) {
            return new Promise(resolve => {
                if (img.complete && img.src && !img.src.startsWith('data:')) {
                    resolve();
                    return;
                }
                
                let settled = false;
                const done = () => {
                    if (!settled) {
                        settled = true;
                        resolve();
                    }
                };
                
                img.addEventListener('load', done, { once: true });
                img.addEventListener('error', done, { once: true });
                setTimeout(done, timeout);
            });
        }
        
        await Promise.all(images.map(img => waitForImage(img, timeoutMs)));
    }, IMAGE_LOAD_TIMEOUT_MS);
}

/**
 * Extrae los datos de los videos de la página
 * @param {import('playwright').Page} page - Página de Playwright
 * @returns {Promise<Array>} - Lista de videos extraídos
 */
async function extractVideoDetails(page) {
    return await page.evaluate(() => {
        const mediaElements = Array.from(document.querySelectorAll('ytd-rich-item-renderer'));
        
        return mediaElements.map((media, idx) => {
            // Layout 1 (estándar): a#video-title-link
            const linkEl = media.querySelector('a#video-title-link');
            // Layout 2 (VODs/Shorts): cualquier link a /watch dentro del item
            const fallbackLink = !linkEl ? media.querySelector('a[href*="/watch"]') : null;
            const activeLink = linkEl || fallbackLink;
            
            // Título - Layout 1
            let title = '';
            if (linkEl) {
                const titleNode = linkEl.querySelector('yt-formatted-string#video-title');
                title = titleNode ? titleNode.textContent.trim() : linkEl.textContent.trim();
            } 
            // Título - Layout 2 (VODs)
            else if (fallbackLink) {
                // Buscar en h3
                const h3Title = media.querySelector('h3');
                if (h3Title) {
                    title = h3Title.textContent.trim();
                } else {
                    // Usar aria-label como fallback
                    const ariaEl = media.querySelector('[aria-label]');
                    if (ariaEl) {
                        const ariaLabel = ariaEl.getAttribute('aria-label');
                        // El aria-label suele ser "Título X horas/minutos"
                        title = ariaLabel ? ariaLabel.replace(/\s+\d+\s+(hora|horas|minuto|minutos|segundo|segundos).*/i, '').trim() : '';
                    }
                }
            }
            
            // URL y Video ID
            const url = activeLink ? activeLink.href : '';
            let videoId = null;
            if (url) {
                const match = url.match(/v=([\w-]+)/);
                videoId = match ? match[1] : null;
            }
            
            // Thumbnail
            let thumbnailUrl = '';
            const thumbImg = media.querySelector('ytd-thumbnail img, yt-image img, img.yt-core-image');
            if (thumbImg && thumbImg.getAttribute) {
                let src = thumbImg.getAttribute('src') || thumbImg.getAttribute('data-thumb');
                if (src) {
                    // Manejar URLs relativas que empiezan con '//'
                    if (src.startsWith('//')) {
                        src = 'https:' + src;
                    }
                    // Solo usar URLs válidas
                    if (!src.startsWith('data:') && !src.includes('undefined') && !src.includes('null')) {
                        thumbnailUrl = src.split('?')[0];
                    }
                }
            }
            
            // Fallback: style con background-image
            if (!thumbnailUrl) {
                const styleHost = media.querySelector('ytd-thumbnail yt-image, ytd-thumbnail');
                if (styleHost && styleHost.getAttribute('style')) {
                    const m = styleHost.getAttribute('style').match(/url\(([^)]+)\)/i);
                    if (m && m[1]) {
                        let url = m[1].replace(/['"]/g, '');
                        // Manejar URLs relativas
                        if (url.startsWith('//')) {
                            url = 'https:' + url;
                        }
                        if (!url.startsWith('data:') && !url.includes('undefined')) {
                            thumbnailUrl = url;
                        }
                    }
                }
            }
            
            // Duración
            let duration = '';
            const badgeShape = media.querySelector('ytd-thumbnail-overlay-time-status-renderer badge-shape .ytBadgeShapeText');
            if (badgeShape) {
                duration = badgeShape.textContent.trim();
            }
            // Layout 2: span#text
            if (!duration) {
                const altDuration = media.querySelector('ytd-thumbnail-overlay-time-status-renderer span#text');
                if (altDuration) duration = altDuration.textContent.trim();
            }
            // Fallback: aria-label
            if (!duration) {
                const timeStatus = media.querySelector('ytd-thumbnail-overlay-time-status-renderer');
                if (timeStatus) {
                    const ariaLabel = timeStatus.getAttribute('aria-label');
                    if (ariaLabel) {
                        const durationMatch = ariaLabel.match(/(\d+\s+(hora|horas|minuto|minutos|segundo|segundos)[\s\d\w]*)/i);
                        if (durationMatch) duration = durationMatch[1];
                    }
                }
            }
            
            // Fecha de subida
            let uploadDate = '';
            const metadataLine = media.querySelector('div#metadata-line');
            if (metadataLine) {
                // Cualquier span dentro del metadata-line se considera metadato
                const spans = Array.from(metadataLine.querySelectorAll('span'));
                const texts = spans.map(s => s.textContent.trim()).filter(Boolean);
                // El texto que NO contenga "vistas"/"views" es la fecha
                const dateText = texts.find(t => !/vistas|views|visualizaciones/i.test(t));
                uploadDate = dateText || texts[texts.length - 1] || '';
            }
            // Fallback: extraer fecha relativa del aria-label
            if (!uploadDate) {
                const ariaEl = media.querySelector('[aria-label]');
                if (ariaEl) {
                    const ariaText = ariaEl.getAttribute('aria-label') || '';
                    const dateMatch = ariaText.match(/(hace\s+\d+\s+(día|días|hora|horas|semana|semanas|mes|meses|año|años|minuto|minutos))|(\d+\s+(día|días|hora|horas|semana|semanas|mes|meses|año|años|minuto|minutos)\s+ago)/i);
                    if (dateMatch) {
                        uploadDate = dateMatch[0];
                    }
                }
            }
            
            return videoId ? {
                id: videoId,
                title,
                url,
                thumbnailUrl,
                duration,
                uploadDate,
                orderIndex: idx,
                isDownload: false
            } : null;
        }).filter(Boolean);
    });
}

/**
 * Fuerza la carga de thumbnails para videos sin miniatura válida
 * @param {import('playwright').Page} page - Página de Playwright
 */
async function forceThumbnailLoad(page) {
    await page.evaluate(() => {
        const items = Array.from(document.querySelectorAll('ytd-rich-item-renderer'));
        items.forEach(el => {
            el.scrollIntoView({ behavior: 'instant', block: 'center' });
        });
    });
    
    // Esperar después del scroll para que carguen las imágenes
    await page.waitForTimeout(1500);
}

/////////////////////////////////////////
// FUNCIÓN PRINCIPAL DE SCRAPING
/////////////////////////////////////////

/**
 * Scrapea un canal de YouTube y actualiza la base de datos
 * @param {string} channelUrl - URL del canal
 * @param {boolean} headless - Si se ejecuta en modo headless
 */
async function scrapeChannel(channelUrl, headless = true) {
    logger.info({ channelUrl, headless }, 'Iniciando scraping de canal');
    
    const browser = await chromium.launch({ headless });
    const page = await browser.newPage();
    
    try {
        await navigateToChannel(page, channelUrl);
        
        const channelName = await extractChannelName(page);
        
        const existingVideos = db.getChannelVideos(channelName);
        
        await scrollToLoadVideos(page);
        
        // Fuerza renderizado de metadatos para todos los videos
        await forceMetadataLoad(page);
        
        await waitForThumbnails(page);
        await waitForImagesToLoad(page);
        
        let videos = await extractVideoDetails(page);
        
        const missingThumbs = videos.filter(v => 
            !v.thumbnailUrl || 
            !v.thumbnailUrl.startsWith('http')
        );
        
        if (missingThumbs.length > 0) {
            logger.warn({ count: missingThumbs.length }, 'Videos sin thumbnail válida, forzando carga...');
            await forceThumbnailLoad(page);
            await waitForThumbnails(page);
            videos = await extractVideoDetails(page);
        }
        
        const newById = {};
        for (const video of videos) {
            const prev = existingVideos[video.id];
            newById[video.id] = prev 
                ? { ...prev, ...video, isDownload: prev.isDownload ?? false }
                : video;
        }
        
        for (const videoId of Object.keys(newById)) {
            ensureThumbnail(newById[videoId]);
        }
        
        const channelOrdered = {};
        videos.sort((a, b) => (a.orderIndex ?? 0) - (b.orderIndex ?? 0));
        
        for (const v of videos) {
            channelOrdered[v.id] = newById[v.id];
        }
        
        for (const oldId of Object.keys(existingVideos)) {
            if (!channelOrdered[oldId]) {
                channelOrdered[oldId] = existingVideos[oldId];
            }
        }
        
        for (const videoId of Object.keys(channelOrdered)) {
            const v = channelOrdered[videoId];
            if (v.thumbnailUrl && v.thumbnailUrl.endsWith('/hq720.jpg')) {
                v.thumbnailAlt = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
            }
        }
        
        const videoList = Object.values(channelOrdered);
        db.upsertVideosBatch(channelName, videoList);
        
        logger.info({ channelName, videoCount: videoList.length }, 'Scraping completado');
        
    } catch (error) {
        logger.error({ channelUrl, error: error.message }, 'Error en scraping de canal');
        throw error;
    } finally {
        await browser.close();
    }
}

/////////////////////////////////////////
// FUNCIÓN PRINCIPAL
/////////////////////////////////////////

/**
 * Muestra la ayuda del script
 */
function showHelp() {
    console.log(`
Uso:
  node video_scraper.js scrape <url_del_canal> [--show]
  node video_scraper.js scrape-all [--show]

Comandos:
  scrape      Scrapea un canal específico
  scrape-all  Scrapea todos los canales predefinidos

Opciones:
  --show      Muestra el navegador (modo no headless)

Variables de entorno (.env):
  VIDEOS_DIR          Directorio base para videos
  MAX_SCROLLS         Máximo de scrolls (default: 10)
  SCROLL_WAIT_MS      Espera entre scrolls (default: 400)
  THUMBNAIL_MAX_ROUNDS  Rondas de espera de thumbnails (default: 6)
  LOG_LEVEL           Nivel de logging: debug, info, warn, error
`);
}

/**
 * Orquestador principal
 */
async function main() {
    db.initDB();
    
    const command = process.argv[2];
    const arg1 = process.argv[3];
    const showFlag = process.argv.includes('--show');
    const headless = !showFlag;
    
    if (command === 'scrape') {
        if (!arg1) {
            logger.error('Por favor, proporciona una URL de canal para extraer.');
            showHelp();
            process.exit(1);
        }
        
        try {
            await scrapeChannel(arg1, headless);
        } catch (error) {
            logger.fatal({ error: error.message }, 'Error fatal en scraping');
            process.exit(1);
        }
        
    } else if (command === 'scrape-all') {
        await fs.mkdir(CONFIG.VIDEOS_DIR, { recursive: true });
        
        for (const url of CONFIG.DEFAULT_CHANNELS) {
            try {
                await scrapeChannel(url, headless);
            } catch (error) {
                logger.error({ url, error: error.message }, 'Error en scraping de canal, continuando...');
            }
        }
        
    } else {
        showHelp();
    }
}

/////////////////////////////////////////
// EJECUCIÓN
/////////////////////////////////////////
main().catch((err) => {
    logger.fatal({ err }, 'Error no manejado');
    process.exit(1);
});
