import Database from 'better-sqlite3';
import path from 'path';
import { fileURLToPath } from 'url';
import fs from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'videos.sqlite');
let db = null;

function getDb() {
    if (!db) {
        db = new Database(DB_PATH);
        db.pragma('journal_mode = WAL');
        initTables();
    }
    return db;
}

function initTables() {
    const db = getDb();
    
    db.exec(`
        CREATE TABLE IF NOT EXISTS channels (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            name TEXT UNIQUE NOT NULL,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );

        CREATE TABLE IF NOT EXISTS videos (
            id TEXT PRIMARY KEY,
            channel_id INTEGER NOT NULL,
            title TEXT,
            url TEXT,
            thumbnail_url TEXT,
            thumbnail_alt TEXT,
            duration TEXT,
            upload_date TEXT,
            order_index INTEGER DEFAULT 0,
            is_download INTEGER DEFAULT 0,
            created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
            FOREIGN KEY (channel_id) REFERENCES channels(id) ON DELETE CASCADE
        );

        CREATE INDEX IF NOT EXISTS idx_videos_channel ON videos(channel_id);
        CREATE INDEX IF NOT EXISTS idx_videos_download ON videos(is_download);
    `);
}

export function initDB() {
    getDb();
    return true;
}

export function closeDB() {
    if (db) {
        db.close();
        db = null;
    }
}

export function getAllVideos() {
    const db = getDb();
    const channels = db.prepare('SELECT id, name FROM channels').all();
    const result = {};
    
    for (const channel of channels) {
        const videos = db.prepare(`
            SELECT id, title, url, thumbnail_url, thumbnail_alt, 
                   duration, upload_date, order_index, is_download
            FROM videos 
            WHERE channel_id = ?
            ORDER BY order_index ASC
        `).all(channel.id);
        
        result[channel.name] = {};
        for (const v of videos) {
            result[channel.name][v.id] = {
                id: v.id,
                title: v.title,
                url: v.url,
                thumbnailUrl: v.thumbnail_url,
                thumbnailAlt: v.thumbnail_alt,
                duration: v.duration,
                uploadDate: v.upload_date,
                orderIndex: v.order_index,
                isDownload: v.is_download === 1
            };
        }
    }
    
    return result;
}

export function getChannelVideos(channelName) {
    const db = getDb();
    const channel = db.prepare('SELECT id FROM channels WHERE name = ?').get(channelName);
    
    if (!channel) return {};
    
    const videos = db.prepare(`
        SELECT id, title, url, thumbnail_url, thumbnail_alt,
               duration, upload_date, order_index, is_download
        FROM videos 
        WHERE channel_id = ?
        ORDER BY order_index ASC
    `).all(channel.id);
    
    const result = {};
    for (const v of videos) {
        result[v.id] = {
            id: v.id,
            title: v.title,
            url: v.url,
            thumbnailUrl: v.thumbnail_url,
            thumbnailAlt: v.thumbnail_alt,
            duration: v.duration,
            uploadDate: v.upload_date,
            orderIndex: v.order_index,
            isDownload: v.is_download === 1
        };
    }
    
    return result;
}

export function upsertChannel(channelName) {
    const db = getDb();
    const stmt = db.prepare(`
        INSERT INTO channels (name) VALUES (?)
        ON CONFLICT(name) DO UPDATE SET name = name
    `);
    stmt.run(channelName);
    return db.prepare('SELECT id FROM channels WHERE name = ?').get(channelName).id;
}

export function upsertVideo(channelName, video) {
    const db = getDb();
    const channelId = upsertChannel(channelName);
    
    const stmt = db.prepare(`
        INSERT INTO videos (id, channel_id, title, url, thumbnail_url, thumbnail_alt, 
                           duration, upload_date, order_index, is_download)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            url = excluded.url,
            thumbnail_url = excluded.thumbnail_url,
            thumbnail_alt = excluded.thumbnail_alt,
            duration = excluded.duration,
            upload_date = excluded.upload_date,
            order_index = excluded.order_index,
            is_download = CASE WHEN excluded.is_download = 1 THEN 1 ELSE videos.is_download END
    `);
    
    stmt.run(
        video.id,
        channelId,
        video.title || '',
        video.url || '',
        video.thumbnailUrl || '',
        video.thumbnailAlt || null,
        video.duration || '',
        video.uploadDate || '',
        video.orderIndex || 0,
        video.isDownload ? 1 : 0
    );
}

export function upsertVideosBatch(channelName, videos) {
    const db = getDb();
    const channelId = upsertChannel(channelName);
    
    const insertVideo = db.prepare(`
        INSERT INTO videos (id, channel_id, title, url, thumbnail_url, thumbnail_alt,
                           duration, upload_date, order_index, is_download)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
            title = excluded.title,
            url = excluded.url,
            thumbnail_url = excluded.thumbnail_url,
            thumbnail_alt = excluded.thumbnail_alt,
            duration = excluded.duration,
            upload_date = excluded.upload_date,
            order_index = excluded.order_index,
            is_download = CASE WHEN excluded.is_download = 1 THEN 1 ELSE videos.is_download END
    `);
    
    const upsertMany = db.transaction((videosList) => {
        for (const video of videosList) {
            insertVideo.run(
                video.id,
                channelId,
                video.title || '',
                video.url || '',
                video.thumbnailUrl || '',
                video.thumbnailAlt || null,
                video.duration || '',
                video.uploadDate || '',
                video.orderIndex || 0,
                video.isDownload ? 1 : 0
            );
        }
    });
    
    upsertMany(videos);
}

export function setDownloaded(videoId, channelName) {
    const db = getDb();
    const channel = db.prepare('SELECT id FROM channels WHERE name = ?').get(channelName);
    
    if (!channel) return false;
    
    const stmt = db.prepare(`
        UPDATE videos SET is_download = 1 WHERE id = ? AND channel_id = ?
    `);
    const result = stmt.run(videoId, channel.id);
    return result.changes > 0;
}

export function syncDownloadStatus(channelName, videoId) {
    return setDownloaded(videoId, channelName);
}

export function getVideo(videoId) {
    const db = getDb();
    return db.prepare(`
        SELECT v.*, c.name as channel_name
        FROM videos v
        JOIN channels c ON v.channel_id = c.id
        WHERE v.id = ?
    `).get(videoId);
}

export function deleteVideo(videoId) {
    const db = getDb();
    const stmt = db.prepare('DELETE FROM videos WHERE id = ?');
    const result = stmt.run(videoId);
    return result.changes > 0;
}

export function getStats() {
    const db = getDb();
    return {
        channels: db.prepare('SELECT COUNT(*) as count FROM channels').get().count,
        videos: db.prepare('SELECT COUNT(*) as count FROM videos').get().count,
        downloaded: db.prepare('SELECT COUNT(*) as count FROM videos WHERE is_download = 1').get().count
    };
}

export { DB_PATH };