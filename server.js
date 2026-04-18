const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const https = require('https');
const { spawn } = require('child_process');

// 尝试加载 dotenv（如果 .env 存在）
try { require('dotenv').config(); } catch (e) { /* 忽略 */ }
// 尝试加载 ali-oss（仅在配置时使用）
let OSS = null;
try { OSS = require('ali-oss'); } catch (e) { /* 未安装也可 */ }

const YOUTUBE_API_KEY = process.env.YOUTUBE_API_KEY || '';

// Gemini 中转接口配置
const GEMINI_API_BASE = process.env.GEMINI_API_BASE || 'https://yunwu.ai/v1beta';
const GEMINI_API_KEY = process.env.GEMINI_API_KEY || '';
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-pro-preview';
const GEMINI_PROMPT_PATH = process.env.GEMINI_PROMPT_PATH ||
  '/Users/renzengfei/短视频/垂直频道-资产/提示词/视频反推提示词.md';

// Whisper 转写配置
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'large-v3-turbo';
const WHISPER_PYTHON = process.env.WHISPER_PYTHON || path.join(__dirname, 'scripts_tool/whisper_venv/bin/python');
const WHISPER_SCRIPT = path.join(__dirname, 'scripts_tool/transcribe.py');
const TRANSCRIPT_CACHE_DIR = process.env.TRANSCRIPT_CACHE_DIR || path.join(__dirname, 'transcripts');
const WHISPER_VIDEO_CACHE_DIR = process.env.WHISPER_VIDEO_CACHE_DIR ||
  path.join(__dirname, '.tmp-downloads', 'gemini-rewrite');

// OSS 配置
const OSS_CONFIG = {
  region: process.env.OSS_REGION || '',
  accessKeyId: process.env.OSS_ACCESS_KEY_ID || '',
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET || '',
  bucket: process.env.OSS_BUCKET || '',
  secure: true,        // 强制走 HTTPS，避免中间节点切断 HTTP 长连接
  timeout: 10 * 60 * 1000, // 全局请求 10 分钟超时（大视频上传用）
};
const OSS_ENABLED = OSS && OSS_CONFIG.accessKeyId && OSS_CONFIG.bucket;
let ossClient = null;
if (OSS_ENABLED) {
  try { ossClient = new OSS(OSS_CONFIG); } catch (e) { console.error('OSS 初始化失败:', e.message); }
}

const app = express();
const PORT = 3456;

// 确保 scripts 文件夹存在
const scriptsDir = path.join(__dirname, 'scripts');
if (!fs.existsSync(scriptsDir)) {
  fs.mkdirSync(scriptsDir, { recursive: true });
}

// 初始化数据库
const dbPath = path.join(__dirname, 'database.db');
const db = new Database(dbPath);

// 启用外键约束
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// 创建表（初始结构）
db.exec(`
  CREATE TABLE IF NOT EXISTS videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    date TEXT NOT NULL,
    name TEXT NOT NULL,
    structure TEXT DEFAULT '',
    video_link TEXT DEFAULT '',
    script_path TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS scenes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    description TEXT DEFAULT '',
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS props (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    function TEXT DEFAULT '',
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS characters (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    persona TEXT DEFAULT '',
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS video_tags_rel (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    video_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    technique TEXT DEFAULT '',
    FOREIGN KEY (video_id) REFERENCES videos(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS series (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    mechanism TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );
`);

// ==================== YouTube 监控表 ====================
db.exec(`
  CREATE TABLE IF NOT EXISTS monitor_configs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    keyword TEXT NOT NULL,
    duration TEXT DEFAULT 'any',
    min_views INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS monitor_videos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_video_id TEXT NOT NULL UNIQUE,
    config_id INTEGER,
    keyword TEXT DEFAULT '',
    title TEXT NOT NULL,
    channel_title TEXT DEFAULT '',
    channel_id TEXT DEFAULT '',
    thumbnail_url TEXT DEFAULT '',
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    duration TEXT DEFAULT '',
    duration_seconds INTEGER DEFAULT 0,
    publish_date TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    discovered_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (config_id) REFERENCES monitor_configs(id) ON DELETE SET NULL
  );

  CREATE TABLE IF NOT EXISTS monitor_state (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS import_tasks (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    youtube_video_id TEXT NOT NULL UNIQUE,
    monitor_video_id INTEGER,
    title TEXT NOT NULL,
    channel_id TEXT DEFAULT '',
    channel_title TEXT DEFAULT '',
    thumbnail_url TEXT DEFAULT '',
    video_url TEXT DEFAULT '',
    views INTEGER DEFAULT 0,
    likes INTEGER DEFAULT 0,
    duration_seconds INTEGER DEFAULT 0,
    publish_date TEXT DEFAULT '',
    is_short INTEGER DEFAULT 0,
    status TEXT DEFAULT 'queued',
    error_message TEXT DEFAULT '',
    local_file_path TEXT DEFAULT '',
    oss_video_url TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    updated_at TEXT DEFAULT (datetime('now', 'localtime'))
  );

  CREATE TABLE IF NOT EXISTS import_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task_id INTEGER NOT NULL,
    role TEXT NOT NULL,
    content TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (task_id) REFERENCES import_tasks(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS monitored_channels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    config_id INTEGER NOT NULL,
    channel_id TEXT NOT NULL,
    channel_title TEXT DEFAULT '',
    thumbnail_url TEXT DEFAULT '',
    uploads_playlist_id TEXT DEFAULT '',
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now', 'localtime')),
    FOREIGN KEY (config_id) REFERENCES monitor_configs(id) ON DELETE CASCADE,
    UNIQUE(config_id, channel_id)
  );
`);

// ==================== 数据库迁移 ====================
// 增量迁移：安全添加新列，已存在则跳过
function safeAddColumn(table, column, type) {
  try {
    // INTEGER/REAL 列不加默认空字符串（否则老行拿到 '' 文本，与数字/NULL 比较会出奇怪结果）
    const isNumeric = /^(INTEGER|REAL|NUMERIC)$/i.test(type);
    const defaultClause = isNumeric ? '' : ` DEFAULT ''`;
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type}${defaultClause}`);
    console.log(`  ✅ 新增列: ${table}.${column}`);
  } catch (e) {
    // 列已存在，跳过
  }
}

function normalizeSeriesName(name) {
  const value = String(name || '').trim();
  return value || '未分类';
}

function getOrCreateSeries(name, mechanism = '') {
  const seriesName = normalizeSeriesName(name);
  const mechanismText = String(mechanism || '').trim();
  const existing = db.prepare('SELECT * FROM series WHERE name = ?').get(seriesName);
  if (existing) {
    if (!existing.mechanism && mechanismText) {
      db.prepare("UPDATE series SET mechanism = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
        .run(mechanismText, existing.id);
    }
    return existing.id;
  }
  const result = db.prepare('INSERT INTO series (name, mechanism) VALUES (?, ?)').run(seriesName, mechanismText);
  return result.lastInsertRowid;
}

function backfillSeries() {
  const rows = db.prepare(`
    SELECT
      COALESCE(NULLIF(TRIM(mechanism_name), ''), '未分类') AS name,
      MAX(CASE WHEN NULLIF(TRIM(mechanism), '') IS NOT NULL THEN mechanism ELSE '' END) AS mechanism
    FROM videos
    GROUP BY COALESCE(NULLIF(TRIM(mechanism_name), ''), '未分类')
    ORDER BY MIN(id)
  `).all();

  const videos = db.prepare('SELECT id, mechanism_name, mechanism, series_id FROM videos').all();
  const updateVideoSeries = db.prepare(`
    UPDATE videos
    SET series_id = ?, updated_at = datetime('now', 'localtime')
    WHERE id = ? AND (series_id IS NULL OR series_id = '' OR series_id != ?)
  `);

  const tx = db.transaction(() => {
    for (const row of rows) getOrCreateSeries(row.name, row.mechanism);
    for (const video of videos) {
      const seriesId = getOrCreateSeries(video.mechanism_name, video.mechanism);
      updateVideoSeries.run(seriesId, video.id, seriesId);
    }
  });
  tx();
}

console.log('🔄 检查数据库迁移...');

// 主表 videos 新增列
safeAddColumn('videos', 'video_title', 'TEXT');
safeAddColumn('videos', 'duration', 'TEXT');
safeAddColumn('videos', 'publish_date', 'TEXT');
safeAddColumn('videos', 'summary', 'TEXT');
safeAddColumn('videos', 'hook', 'TEXT');
safeAddColumn('videos', 'hook_tags', 'TEXT');
safeAddColumn('videos', 'video_tags', 'TEXT');
safeAddColumn('videos', 'technique', 'TEXT');
safeAddColumn('videos', 'mechanism_name', 'TEXT');
safeAddColumn('videos', 'mechanism', 'TEXT');
safeAddColumn('videos', 'series_id', 'INTEGER');
safeAddColumn('videos', 'story_structure', 'TEXT');
safeAddColumn('videos', 'adapt_tags', 'TEXT');
safeAddColumn('videos', 'adapt_brief', 'TEXT');
safeAddColumn('videos', 'source_video_id', 'INTEGER');
safeAddColumn('videos', 'views', 'TEXT');
safeAddColumn('videos', 'likes', 'TEXT');
safeAddColumn('videos', 'video_type', 'TEXT');
safeAddColumn('videos', 'protagonist', 'TEXT');
safeAddColumn('videos', 'protagonist_goal', 'TEXT');
safeAddColumn('videos', 'antagonist', 'TEXT');
safeAddColumn('videos', 'antagonist_goal', 'TEXT');
safeAddColumn('videos', 'video_path', 'TEXT');
safeAddColumn('videos', 'thumb_url', 'TEXT');
safeAddColumn('videos', 'preview_path', 'TEXT');
safeAddColumn('videos', 'notes', 'TEXT');
safeAddColumn('videos', 'is_marked', 'INTEGER');

// monitor_configs 新增列
safeAddColumn('monitor_configs', 'status', 'TEXT');
safeAddColumn('monitor_configs', 'pulled_months', 'TEXT');

// monitor_videos 新增列
safeAddColumn('monitor_videos', 'is_short', 'INTEGER');

// import_tasks 新增列
safeAddColumn('import_tasks', 'backup_status', 'TEXT');
safeAddColumn('import_tasks', 'backup_error', 'TEXT');
safeAddColumn('import_tasks', 'analysis_status', 'TEXT');
safeAddColumn('import_tasks', 'analysis_error', 'TEXT');
safeAddColumn('import_tasks', 'suggested_name', 'TEXT');
safeAddColumn('import_tasks', 'script_path', 'TEXT');
safeAddColumn('import_tasks', 'source_video_id', 'INTEGER');  // 素材库重写脚本时指向 videos.id
safeAddColumn('import_tasks', 'task_type', 'TEXT');
safeAddColumn('import_tasks', 'download_status', 'TEXT');
safeAddColumn('import_tasks', 'download_error', 'TEXT');
safeAddColumn('import_tasks', 'upload_status', 'TEXT');
safeAddColumn('import_tasks', 'upload_error', 'TEXT');
safeAddColumn('import_tasks', 'transcript_status', 'TEXT');
safeAddColumn('import_tasks', 'transcript_error', 'TEXT');
safeAddColumn('import_tasks', 'preview_status', 'TEXT');
safeAddColumn('import_tasks', 'preview_error', 'TEXT');

// 子表 scenes：新增 function 列（保留旧 description 列不删）
safeAddColumn('scenes', 'function', 'TEXT');

// 子表 props：新增 type 列
safeAddColumn('props', 'type', 'TEXT');

// 子表 characters：新增 abilities / states 列
safeAddColumn('characters', 'abilities', 'TEXT');
safeAddColumn('characters', 'states', 'TEXT');

backfillSeries();

console.log('✅ 数据库迁移完成');

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public'), {
  // 禁用前端静态资源缓存，避免开发期间浏览器拿到老版 app.js/style.css
  etag: false,
  lastModified: false,
  setHeaders: (res) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
    res.setHeader('Pragma', 'no-cache');
    res.setHeader('Expires', '0');
  },
}));

// ==================== 主表字段列表 ====================
const VIDEO_FIELDS = [
  'name', 'video_title', 'duration', 'publish_date',
  'summary', 'hook', 'hook_tags', 'video_tags', 'technique',
  'mechanism_name', 'mechanism', 'series_id', 'story_structure',
  'adapt_tags', 'adapt_brief', 'source_video_id',
  'date', 'video_link', 'views', 'likes', 'script_path', 'video_type',
  'protagonist', 'protagonist_goal', 'antagonist', 'antagonist_goal',
  'video_path', 'thumb_url', 'preview_path', 'notes', 'is_marked'
];

function getVideoAiTask(videoId) {
  return db.prepare(`
    SELECT id, task_type, monitor_video_id, source_video_id,
           backup_status, download_status, upload_status, transcript_status,
           preview_status, analysis_status, backup_error, download_error,
           upload_error, transcript_error, preview_error, analysis_error,
           suggested_name, local_file_path, oss_video_url, updated_at
    FROM import_tasks
    WHERE source_video_id = ?
    ORDER BY id DESC
    LIMIT 1
  `).get(videoId) || null;
}

function attachVideoRelations(video, statements) {
  const series = video.series_id ? statements.getSeries.get(video.series_id) : null;
  const seriesName = series?.name || normalizeSeriesName(video.mechanism_name);
  let tags = statements.getTags.all(video.id);
  // 向下兼容：如果无关联表数据，但主表有数据，则强行平移
  if (tags.length === 0 && video.video_tags) {
     tags = video.video_tags.split(',').map(tag => ({
       name: tag.trim(),
       technique: video.technique || ''
     })).filter(t => t.name);
  }
  return {
    ...video,
    series_id: series?.id || video.series_id || null,
    series_name: seriesName,
    series_mechanism: series?.mechanism || video.mechanism || '',
    scenes: statements.getScenes.all(video.id),
    props: statements.getProps.all(video.id),
    characters: statements.getCharacters.all(video.id),
    video_tags_rel: tags,
    ai_task: getVideoAiTask(video.id)
  };
}

function videoRelationStatements() {
  return {
    getScenes: db.prepare('SELECT * FROM scenes WHERE video_id = ?'),
    getProps: db.prepare('SELECT * FROM props WHERE video_id = ?'),
    getCharacters: db.prepare('SELECT * FROM characters WHERE video_id = ?'),
    getTags: db.prepare('SELECT * FROM video_tags_rel WHERE video_id = ?'),
    getSeries: db.prepare('SELECT * FROM series WHERE id = ?')
  };
}

// ==================== API ====================

// 获取所有视频（含关联数据）
app.get('/api/videos', (req, res) => {
  try {
    const videos = db.prepare('SELECT * FROM videos ORDER BY date DESC, id DESC').all();
    const statements = videoRelationStatements();
    const result = videos.map(v => attachVideoRelations(v, statements));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单个视频详情
app.get('/api/videos/:id', (req, res) => {
  try {
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!video) return res.status(404).json({ error: '视频不存在' });

    res.json(attachVideoRelations(video, videoRelationStatements()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 新增视频
app.post('/api/videos', (req, res) => {
  const { scenes, props, characters, video_tags_rel } = req.body;

  try {
    // 兼容：将第一条 tag 写回旧文本域便于搜索
    if (video_tags_rel && video_tags_rel.length > 0) {
      req.body.video_tags = video_tags_rel.map(t => t.name).join(', ');
      req.body.technique = video_tags_rel[0].technique || '';
    }
    req.body.series_id = getOrCreateSeries(req.body.mechanism_name, req.body.mechanism);

    const columns = VIDEO_FIELDS.join(', ');
    const placeholders = VIDEO_FIELDS.map(() => '?').join(', ');
    const insertVideo = db.prepare(`INSERT INTO videos (${columns}) VALUES (${placeholders})`);

    const insertScene = db.prepare('INSERT INTO scenes (video_id, name, function) VALUES (?, ?, ?)');
    const insertProp = db.prepare('INSERT INTO props (video_id, name, type, function) VALUES (?, ?, ?, ?)');
    const insertChar = db.prepare('INSERT INTO characters (video_id, name, persona, abilities, states) VALUES (?, ?, ?, ?, ?)');
    const insertTag = db.prepare('INSERT INTO video_tags_rel (video_id, name, technique) VALUES (?, ?, ?)');

    const transaction = db.transaction(() => {
      const values = VIDEO_FIELDS.map(f => req.body[f] || '');
      const result = insertVideo.run(...values);
      const videoId = result.lastInsertRowid;

      if (scenes && scenes.length > 0) {
        for (const s of scenes) {
          if (s.name && s.name.trim()) insertScene.run(videoId, s.name.trim(), s.function || '');
        }
      }
      if (props && props.length > 0) {
        for (const p of props) {
          if (p.name && p.name.trim()) insertProp.run(videoId, p.name.trim(), p.type || '', p.function || '');
        }
      }
      if (characters && characters.length > 0) {
        for (const c of characters) {
          if (c.name && c.name.trim()) insertChar.run(videoId, c.name.trim(), c.persona || '', c.abilities || '', c.states || '');
        }
      }
      if (video_tags_rel && video_tags_rel.length > 0) {
        for (const t of video_tags_rel) {
          if (t.name && t.name.trim()) insertTag.run(videoId, t.name.trim(), t.technique || '');
        }
      }

      return videoId;
    });

    const videoId = transaction();
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    res.status(201).json(attachVideoRelations(video, videoRelationStatements()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新视频（增量更新：只更新请求中传入的字段）
app.put('/api/videos/:id', (req, res) => {
  const { scenes, props, characters, video_tags_rel } = req.body;
  const videoId = req.params.id;

  try {
    const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!existing) return res.status(404).json({ error: '视频不存在' });

    // 兼容：写回主表
    if (req.body.hasOwnProperty('video_tags_rel')) {
       if (video_tags_rel && video_tags_rel.length > 0) {
         req.body.video_tags = video_tags_rel.map(t => t.name).join(', ');
         req.body.technique = video_tags_rel[0].technique || '';
       } else {
         req.body.video_tags = '';
         req.body.technique = '';
       }
    }

    if (req.body.hasOwnProperty('mechanism_name') || req.body.hasOwnProperty('mechanism')) {
      const seriesName = req.body.hasOwnProperty('mechanism_name') ? req.body.mechanism_name : existing.mechanism_name;
      const seriesMechanism = req.body.hasOwnProperty('mechanism') ? req.body.mechanism : existing.mechanism;
      req.body.series_id = getOrCreateSeries(seriesName, seriesMechanism);
    }

    // 只更新请求中明确传入的字段
    const fieldsToUpdate = VIDEO_FIELDS.filter(f => req.body.hasOwnProperty(f));

    const transaction = db.transaction(() => {
      if (fieldsToUpdate.length > 0) {
        const setClause = fieldsToUpdate.map(f => `${f}=?`).join(', ');
        const values = fieldsToUpdate.map(f => req.body[f] ?? '');
        db.prepare(`UPDATE videos SET ${setClause}, updated_at=datetime('now','localtime') WHERE id=?`).run(...values, videoId);
      }

      // 子表只在明确传入时才重建
      if (req.body.hasOwnProperty('scenes')) {
        db.prepare('DELETE FROM scenes WHERE video_id = ?').run(videoId);
        const insertScene = db.prepare('INSERT INTO scenes (video_id, name, function) VALUES (?, ?, ?)');
        if (scenes && scenes.length > 0) {
          for (const s of scenes) {
            if (s.name && s.name.trim()) insertScene.run(videoId, s.name.trim(), s.function || '');
          }
        }
      }
      if (req.body.hasOwnProperty('props')) {
        db.prepare('DELETE FROM props WHERE video_id = ?').run(videoId);
        const insertProp = db.prepare('INSERT INTO props (video_id, name, type, function) VALUES (?, ?, ?, ?)');
        if (props && props.length > 0) {
          for (const p of props) {
            if (p.name && p.name.trim()) insertProp.run(videoId, p.name.trim(), p.type || '', p.function || '');
          }
        }
      }
      if (req.body.hasOwnProperty('characters')) {
        db.prepare('DELETE FROM characters WHERE video_id = ?').run(videoId);
        const insertChar = db.prepare('INSERT INTO characters (video_id, name, persona, abilities, states) VALUES (?, ?, ?, ?, ?)');
        if (characters && characters.length > 0) {
          for (const c of characters) {
            if (c.name && c.name.trim()) insertChar.run(videoId, c.name.trim(), c.persona || '', c.abilities || '', c.states || '');
          }
        }
      }
      if (req.body.hasOwnProperty('video_tags_rel')) {
        db.prepare('DELETE FROM video_tags_rel WHERE video_id = ?').run(videoId);
        const insertTag = db.prepare('INSERT INTO video_tags_rel (video_id, name, technique) VALUES (?, ?, ?)');
        if (video_tags_rel && video_tags_rel.length > 0) {
          for (const t of video_tags_rel) {
            if (t.name && t.name.trim()) insertTag.run(videoId, t.name.trim(), t.technique || '');
          }
        }
      }
    });

    transaction();

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    res.json(attachVideoRelations(video, videoRelationStatements()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除视频
app.delete('/api/videos/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM videos WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '视频不存在' });

    db.prepare('DELETE FROM videos WHERE id = ?').run(req.params.id);
    res.json({ message: '已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 辅助：为一个素材库 video 创建重写任务，返回新 task.id
function createRewriteTask(videoId, video, youtubeId) {
  const durationSeconds = parseInt(video.duration || 0) || 0;
  const isShort = video.video_link?.includes('/shorts/') || (durationSeconds > 0 && durationSeconds <= 60) ? 1 : 0;
  const result = db.prepare(`
    INSERT INTO import_tasks
    (youtube_video_id, monitor_video_id, title, channel_id, channel_title, thumbnail_url,
     video_url, views, likes, duration_seconds, publish_date, is_short,
     backup_status, analysis_status, local_file_path, oss_video_url,
     source_video_id, script_path, task_type,
     download_status, upload_status, transcript_status, preview_status)
    VALUES (?, NULL, ?, '', '(素材库重写)', ?, ?, ?, ?, ?, ?, ?, 'uploaded', 'queued', '', ?, ?, ?, 'library_analysis',
            'skipped', 'skipped', 'queued', 'skipped')
  `).run(
    youtubeId,
    video.name || '',
    video.thumb_url || '',
    video.video_link,
    parseInt(video.views || 0) || 0,
    parseInt(video.likes || 0) || 0,
    durationSeconds,
    video.publish_date || '',
    isShort,
    video.video_path || '',
    videoId,
    ''
  );
  return result.lastInsertRowid;
}

// 辅助：从 YouTube URL 提取 11 位 video id
function extractYouTubeId(link) {
  if (!link) return '';
  if (link.includes('youtube.com/shorts/')) return link.split('youtube.com/shorts/')[1].split(/[?&]/)[0];
  if (link.includes('v=')) {
    try { return new URLSearchParams(link.split('?')[1]).get('v') || ''; } catch (e) { return ''; }
  }
  if (link.includes('youtu.be/')) return link.split('youtu.be/')[1].split(/[?&]/)[0];
  return '';
}

function findAiTaskForVideo(video) {
  let task = db.prepare('SELECT * FROM import_tasks WHERE source_video_id = ? ORDER BY id DESC LIMIT 1').get(video.id);
  if (task) return task;

  const youtubeId = extractYouTubeId(video.video_link || '');
  if (!youtubeId) return null;
  return db.prepare('SELECT * FROM import_tasks WHERE youtube_video_id = ? ORDER BY id DESC LIMIT 1').get(youtubeId) || null;
}

// 批量重写：挑下 N 个还没创建重写任务的 videos，创建 + 入队
app.post('/api/videos/batch-rewrite', (req, res) => {
  try {
    const raw = req.body.limit;
    const all = raw === 'all' || raw === -1;
    const limit = all ? 10000 : (parseInt(raw) || 10);
    // 选出还没重写任务、且有 YouTube 链接的 videos（按 id 升序）
    const candidates = db.prepare(`
      SELECT v.* FROM videos v
      LEFT JOIN import_tasks t ON t.source_video_id = v.id AND COALESCE(NULLIF(t.task_type, ''), 'library_analysis') = 'library_analysis'
      WHERE t.id IS NULL AND v.video_link IS NOT NULL AND v.video_link != ''
      ORDER BY v.id ASC
      LIMIT ?
    `).all(limit);

    const taskIds = [];
    const skipped = [];
    for (const video of candidates) {
      const ytId = extractYouTubeId(video.video_link);
      if (!ytId) { skipped.push({ id: video.id, name: video.name, reason: '无法提取 YouTube ID' }); continue; }
      const taskId = createRewriteTask(video.id, video, ytId);
      if (GEMINI_API_KEY) enqueueAnalysis(taskId);
      taskIds.push(taskId);
    }

    // 统计还剩多少个没建重写任务
    const remaining = db.prepare(`
      SELECT COUNT(*) as c FROM videos v
      LEFT JOIN import_tasks t ON t.source_video_id = v.id AND COALESCE(NULLIF(t.task_type, ''), 'library_analysis') = 'library_analysis'
      WHERE t.id IS NULL AND v.video_link IS NOT NULL AND v.video_link != ''
    `).get().c;

    console.log(`🤖 批量重写启动：创建 ${taskIds.length} 个任务，跳过 ${skipped.length} 个，还剩 ${remaining} 个未处理`);
    res.json({
      created: taskIds.length,
      taskIds,
      skipped,
      remaining,
      inFlight: geminiInFlight,
      queuedInMemory: geminiQueue.length,
    });
  } catch (err) {
    console.error('批量重写失败:', err);
    res.status(500).json({ error: err.message });
  }
});

// 重写脚本：为指定素材库视频创建/复用一个"重写任务"，立即触发 Gemini
app.post('/api/videos/:id/rewrite-script', async (req, res) => {
  try {
    const shouldTrigger = req.body?.trigger !== false;
    const useTranscript = req.body?.useTranscript !== false;
    const videoId = parseInt(req.params.id);
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) return res.status(404).json({ error: '视频不存在' });
    if (!video.video_link) return res.status(400).json({ error: '该视频无 YouTube 链接，无法由 Gemini 分析' });

    const youtubeId = extractYouTubeId(video.video_link);
    if (!youtubeId) return res.status(400).json({ error: '无法从 video_link 提取 YouTube ID: ' + video.video_link });

    // 已有重写任务就复用（按 source_video_id + task_type 查）
    let task = db.prepare(`
      SELECT * FROM import_tasks
      WHERE source_video_id = ? AND COALESCE(NULLIF(task_type, ''), 'library_analysis') = 'library_analysis'
      ORDER BY id DESC LIMIT 1
    `).get(videoId);
    let didTriggerGemini = false;

    if (!task) {
      // 新建
      const taskId = createRewriteTask(videoId, video, youtubeId);
      task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
      console.log(`📝 创建重写任务 #${task.id} for video #${videoId} (${video.name})`);
      if (shouldTrigger && GEMINI_API_KEY) {
        if (useTranscript) enqueueAnalysis(task.id);
        else callGeminiForTask(task.id, null, { useTranscript: false }).catch(e => console.error('分析异常:', e.message));
        didTriggerGemini = true;
      }
    } else if (task.analysis_status === 'failed' ||
               (task.analysis_status === 'queued' &&
                db.prepare('SELECT COUNT(*) as c FROM import_conversations WHERE task_id = ?').get(task.id).c === 0)) {
      // 失败 / 从未分析过 → 入队触发
      db.prepare("DELETE FROM import_conversations WHERE task_id = ?").run(task.id);
      db.prepare("UPDATE import_tasks SET analysis_status = 'queued', analysis_error = '' WHERE id = ?").run(task.id);
      console.log(`📝 重新触发重写任务 #${task.id} for video #${videoId}`);
      if (shouldTrigger && GEMINI_API_KEY) {
        if (useTranscript) enqueueAnalysis(task.id);
        else callGeminiForTask(task.id, null, { useTranscript: false }).catch(e => console.error('分析异常:', e.message));
        didTriggerGemini = true;
      }
    } else {
      // 已有对话（analyzing/ready）→ 直接复用，不动数据（避免误清）
      console.log(`📝 复用已有重写任务 #${task.id}（${task.analysis_status}）`);
    }

    res.json({ taskId: task.id, triggered: didTriggerGemini });
  } catch (err) {
    console.error('重写脚本失败:', err);
    res.status(500).json({ error: err.message });
  }
});

function buildAiTaskPayload(task, extra = {}) {
  if (!task) {
    return {
      ...extra,
      task: null,
      conversations: [],
      latestScript: '',
      latestAssistantAt: '',
      source: extra.source || 'none',
    };
  }

  const conversations = db.prepare('SELECT * FROM import_conversations WHERE task_id = ? ORDER BY id ASC')
    .all(task.id);
  const latestAssistant = db.prepare(
    "SELECT content, created_at FROM import_conversations WHERE task_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1"
  ).get(task.id);

  return {
    ...extra,
    task,
    conversations,
    latestScript: latestAssistant?.content || '',
    latestAssistantAt: latestAssistant?.created_at || '',
    source: task.task_type === 'library_analysis' || (!task.monitor_video_id && task.source_video_id) ? 'library' : 'import',
  };
}

// 统一获取 AI 任务与最新脚本文本；录入任务和素材库任务共用
app.get('/api/ai/tasks/:taskId', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(req.params.taskId);
    if (!task) return res.status(404).json({ error: 'AI 任务不存在' });
    res.json(buildAiTaskPayload(task));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取素材库视频对应的 AI 任务与最新脚本文本；不触发 Gemini 分析
app.get('/api/videos/:id/ai-script', (req, res) => {
  try {
    const videoId = parseInt(req.params.id);
    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) return res.status(404).json({ error: '视频不存在' });

    const task = findAiTaskForVideo(video);
    res.json(buildAiTaskPayload(task, { videoId, video }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 显式把某个录入/Gemini 任务绑定到素材库视频，绑定后两处共享同一段 AI 对话
app.post('/api/videos/:id/link-ai-task', (req, res) => {
  try {
    const videoId = parseInt(req.params.id);
    const taskId = parseInt(req.body?.taskId);
    if (!taskId) return res.status(400).json({ error: '缺少 taskId' });

    const video = db.prepare('SELECT * FROM videos WHERE id = ?').get(videoId);
    if (!video) return res.status(404).json({ error: '视频不存在' });

    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
    if (!task) return res.status(404).json({ error: 'AI 任务不存在' });

    db.prepare(`
      UPDATE import_tasks
      SET source_video_id = ?, updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(videoId, taskId);

    const linked = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
    res.json(buildAiTaskPayload(linked, { videoId, video, linked: true }));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有场景（去重汇总）
app.get('/api/scenes', (req, res) => {
  try {
    const scenes = db.prepare(`
      SELECT s.name, s.function, v.name as video_name, v.id as video_id
      FROM scenes s JOIN videos v ON s.video_id = v.id
      ORDER BY s.name
    `).all();
    res.json(scenes);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有道具（去重汇总）
app.get('/api/props', (req, res) => {
  try {
    const props = db.prepare(`
      SELECT p.name, p.type, p.function, v.name as video_name, v.id as video_id
      FROM props p JOIN videos v ON p.video_id = v.id
      ORDER BY p.name
    `).all();
    res.json(props);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取所有角色（去重汇总）
app.get('/api/characters', (req, res) => {
  try {
    const characters = db.prepare(`
      SELECT c.name, c.persona, c.abilities, c.states, v.name as video_name, v.id as video_id
      FROM characters c JOIN videos v ON c.video_id = v.id
      ORDER BY c.name
    `).all();
    res.json(characters);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 开头标签汇总（倒排索引）
app.get('/api/hooks', (req, res) => {
  try {
    const rows = db.prepare(`SELECT id, name, hook_tags FROM videos WHERE hook_tags IS NOT NULL AND hook_tags != ''`).all();
    const tagMap = {};
    rows.forEach(row => {
      (row.hook_tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(tag => {
        if (!tagMap[tag]) tagMap[tag] = { tag, count: 0, videos: [] };
        tagMap[tag].count++;
        tagMap[tag].videos.push({ id: row.id, name: row.name });
      });
    });
    const result = Object.values(tagMap).sort((a, b) => b.count - a.count);
    res.json({ tags: result, totalVideos: rows.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 全局搜索
app.get('/api/search', (req, res) => {
  const q = req.query.q;
  if (!q) return res.json([]);

  try {
    const pattern = `%${q}%`;
    const videoIds = new Set();

    // 如果是 ID 搜索 (例如 "12" 或者 "#12")
    const idMatch = q.trim().match(/^#?(\d+)$/);
    if (idMatch) {
      const parsedId = parseInt(idMatch[1], 10);
      db.prepare(`SELECT id FROM videos WHERE id = ?`).all(parsedId).forEach(r => videoIds.add(r.id));
    }

    const seriesIdMatch = q.trim().match(/^系列\s*#?0*(\d+)$/i);
    if (seriesIdMatch) {
      const parsedSeriesId = parseInt(seriesIdMatch[1], 10);
      db.prepare('SELECT id FROM videos WHERE series_id = ?')
        .all(parsedSeriesId).forEach(r => videoIds.add(r.id));
    }

    db.prepare(`
      SELECT v.id
      FROM videos v
      JOIN series s ON s.id = v.series_id
      WHERE s.name LIKE ? OR CAST(s.id AS TEXT) = ?
    `).all(pattern, q.trim()).forEach(r => videoIds.add(r.id));

    // 搜索主表所有文本字段
    const searchFields = ['name', 'video_title', 'summary', 'hook', 'hook_tags',
      'video_tags', 'technique', 'mechanism_name', 'mechanism',
      'adapt_tags', 'adapt_brief'];
    const whereClauses = searchFields.map(f => `${f} LIKE ?`).join(' OR ');
    const searchParams = searchFields.map(() => pattern);
    db.prepare(`SELECT id FROM videos WHERE ${whereClauses}`)
      .all(...searchParams).forEach(r => videoIds.add(r.id));

    // 搜索场景
    db.prepare('SELECT video_id FROM scenes WHERE name LIKE ? OR function LIKE ?')
      .all(pattern, pattern).forEach(r => videoIds.add(r.video_id));

    // 搜索道具
    db.prepare('SELECT video_id FROM props WHERE name LIKE ? OR type LIKE ? OR function LIKE ?')
      .all(pattern, pattern, pattern).forEach(r => videoIds.add(r.video_id));

    // 搜索角色
    db.prepare('SELECT video_id FROM characters WHERE name LIKE ? OR persona LIKE ? OR abilities LIKE ? OR states LIKE ?')
      .all(pattern, pattern, pattern, pattern).forEach(r => videoIds.add(r.video_id));

    // 搜索新标签关系表
    db.prepare('SELECT video_id FROM video_tags_rel WHERE name LIKE ? OR technique LIKE ?')
      .all(pattern, pattern).forEach(r => videoIds.add(r.video_id));

    if (videoIds.size === 0) return res.json([]);

    const ids = [...videoIds];
    const placeholders = ids.map(() => '?').join(',');
    const videos = db.prepare(`
      SELECT * FROM videos
      WHERE id IN (${placeholders})
      ORDER BY datetime(created_at) DESC, id DESC
    `).all(...ids);

    const statements = videoRelationStatements();
    const result = videos.map(v => attachVideoRelations(v, statements));

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== YouTube API 工具函数 ====================

function ytApiFetchOnce(endpoint, params) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ ...params, key: YOUTUBE_API_KEY }).toString();
    const url = `https://www.googleapis.com/youtube/v3/${endpoint}?${qs}`;
    const req = https.get(url, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) {
            const err = new Error(json.error.message);
            err.code = json.error.code;           // HTTP code (403/400/500...)
            err.reason = (json.error.errors && json.error.errors[0] && json.error.errors[0].reason) || '';
            reject(err);
          } else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(30000, () => { req.destroy(new Error('ytApiFetch timeout')); });
  });
}

async function ytApiFetch(endpoint, params) {
  const maxAttempts = 3;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await ytApiFetchOnce(endpoint, params);
    } catch (err) {
      lastErr = err;
      // 配额耗尽 / Key 无效 / 参数错误 → 不重试
      const nonRetriableReasons = ['quotaExceeded', 'dailyLimitExceeded', 'keyInvalid', 'badRequest', 'forbidden'];
      const isNonRetriable = nonRetriableReasons.includes(err.reason) || err.code === 400 || err.code === 401;
      const isNetworkErr = /ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|socket hang up|timeout/i.test(err.code + ' ' + err.message);
      const is5xx = err.code >= 500 && err.code < 600;
      if (isNonRetriable || (!isNetworkErr && !is5xx) || attempt === maxAttempts) break;
      const waitMs = attempt * 1500; // 1.5s -> 3s
      console.log(`  ⚠️  YouTube API ${endpoint} 失败 (尝试 ${attempt}/${maxAttempts}): ${err.message} — ${waitMs}ms 后重试`);
      await new Promise(r => setTimeout(r, waitMs));
    }
  }
  throw lastErr;
}

// PT1H2M30S → 秒数
function parseDuration(iso) {
  if (!iso) return 0;
  const m = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!m) return 0;
  return (parseInt(m[1] || 0) * 3600) + (parseInt(m[2] || 0) * 60) + parseInt(m[3] || 0);
}

// 格式化时长秒数为 mm:ss 或 h:mm:ss
function formatDuration(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

// 执行一次 YouTube 搜索（单页），返回合并数据
// options: { publishedAfter, publishedBefore, pageToken }
async function youtubeSearchPage(keyword, duration, minViews, options = {}) {
  const searchParams = {
    part: 'snippet',
    q: keyword,
    type: 'video',
    order: 'viewCount',
    maxResults: '50',
  };
  if (options.publishedAfter) searchParams.publishedAfter = options.publishedAfter;
  if (options.publishedBefore) searchParams.publishedBefore = options.publishedBefore;
  if (options.pageToken) searchParams.pageToken = options.pageToken;
  if (duration && duration !== 'any') searchParams.videoDuration = duration;

  const searchResult = await ytApiFetch('search', searchParams);
  const items = searchResult.items || [];
  if (items.length === 0) return { videos: [], nextPageToken: null };

  const videoIds = items.map(i => i.id.videoId).join(',');
  const detailResult = await ytApiFetch('videos', {
    part: 'snippet,statistics,contentDetails',
    id: videoIds,
  });

  const videos = [];
  let belowThreshold = 0;
  for (const item of (detailResult.items || [])) {
    const views = parseInt(item.statistics.viewCount || 0);
    if (minViews && views < minViews) { belowThreshold++; continue; }

    const durationSec = parseDuration(item.contentDetails.duration);
    videos.push({
      youtube_video_id: item.id,
      title: item.snippet.title,
      channel_title: item.snippet.channelTitle,
      channel_id: item.snippet.channelId,
      thumbnail_url: item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : (item.snippet.thumbnails.default || {}).url || '',
      views: views,
      likes: parseInt(item.statistics.likeCount || 0),
      duration: item.contentDetails.duration,
      duration_seconds: durationSec,
      duration_display: formatDuration(durationSec),
      publish_date: (item.snippet.publishedAt || '').slice(0, 10),
      video_url: `https://www.youtube.com/watch?v=${item.id}`,
    });
  }

  return {
    videos,
    nextPageToken: searchResult.nextPageToken || null,
    allBelowThreshold: belowThreshold === (detailResult.items || []).length && belowThreshold > 0,
  };
}

// 多页拉取：翻页直到没有 nextPageToken 或全部低于 minViews
async function youtubeSearchAll(keyword, duration, minViews, options = {}) {
  const allVideos = [];
  let pageToken = null;
  let pageCount = 0;
  const maxPages = options.maxPages || 20; // 安全上限

  do {
    const result = await youtubeSearchPage(keyword, duration, minViews, {
      publishedAfter: options.publishedAfter,
      publishedBefore: options.publishedBefore,
      pageToken,
    });
    allVideos.push(...result.videos);
    pageToken = result.nextPageToken;
    pageCount++;

    console.log(`    📄 第${pageCount}页: 获取 ${result.videos.length} 个视频`);

    // 整页都低于播放量门槛 → 后面的更低，停止
    if (result.allBelowThreshold) {
      console.log(`    ⏹ 播放量已低于门槛，停止翻页`);
      break;
    }
  } while (pageToken && pageCount < maxPages);

  return allVideos;
}

// ==================== 频道相关函数 ====================

// 解析频道输入（URL / @handle / channel ID）→ 频道信息
async function resolveChannel(input) {
  input = input.trim();

  // 提取 handle: @xxx 或 youtube.com/@xxx
  let handle = null;
  let channelId = null;

  if (input.includes('youtube.com/@')) {
    handle = input.split('youtube.com/@')[1].split('/')[0].split('?')[0];
  } else if (input.startsWith('@')) {
    handle = input.slice(1);
  } else if (input.includes('youtube.com/channel/')) {
    channelId = input.split('youtube.com/channel/')[1].split('/')[0].split('?')[0];
  } else if (input.match(/^UC[a-zA-Z0-9_-]{22}$/)) {
    channelId = input;
  } else {
    // 当作 handle 尝试
    handle = input;
  }

  if (handle) {
    const result = await ytApiFetch('channels', {
      part: 'snippet,contentDetails',
      forHandle: handle,
    });
    if (!result.items || result.items.length === 0) throw new Error(`未找到频道: @${handle}`);
    const ch = result.items[0];
    return {
      channel_id: ch.id,
      channel_title: ch.snippet.title,
      thumbnail_url: (ch.snippet.thumbnails.default || {}).url || '',
      uploads_playlist_id: ch.contentDetails.relatedPlaylists.uploads,
    };
  }

  if (channelId) {
    const result = await ytApiFetch('channels', {
      part: 'snippet,contentDetails',
      id: channelId,
    });
    if (!result.items || result.items.length === 0) throw new Error(`未找到频道: ${channelId}`);
    const ch = result.items[0];
    return {
      channel_id: ch.id,
      channel_title: ch.snippet.title,
      thumbnail_url: (ch.snippet.thumbnails.default || {}).url || '',
      uploads_playlist_id: ch.contentDetails.relatedPlaylists.uploads,
    };
  }

  throw new Error('无法解析频道，请输入频道 URL、@handle 或频道 ID');
}

// 拉取频道视频（通过 playlistItems + videos 合并）
// options: { minViews, duration, publishedAfter, maxPages }
async function fetchChannelVideos(uploadsPlaylistId, options = {}) {
  const allVideos = [];
  let pageToken = null;
  let pageCount = 0;
  const maxPages = options.maxPages || 40;

  do {
    // playlistItems.list: 1 unit/页
    const plParams = {
      part: 'snippet',
      playlistId: uploadsPlaylistId,
      maxResults: '50',
    };
    if (pageToken) plParams.pageToken = pageToken;

    const plResult = await ytApiFetch('playlistItems', plParams);
    const items = plResult.items || [];
    if (items.length === 0) break;

    // playlistItems 按上传时间倒序：当某条视频早于 publishedAfter，下面的循环里会设 stopAfterThis 并 break
    const videoIds = items.map(i => i.snippet.resourceId.videoId).join(',');

    // videos.list: 1 unit/页
    const detailResult = await ytApiFetch('videos', {
      part: 'snippet,statistics,contentDetails',
      id: videoIds,
    });

    let stopAfterThis = false;
    for (const item of (detailResult.items || [])) {
      const publishDate = (item.snippet.publishedAt || '').slice(0, 10);

      // 时间范围过滤
      if (options.publishedAfter && new Date(item.snippet.publishedAt) < new Date(options.publishedAfter)) {
        stopAfterThis = true;
        continue;
      }

      // 播放量过滤
      const views = parseInt(item.statistics.viewCount || 0);
      if (options.minViews && views < options.minViews) continue;

      // 时长过滤
      const durationSec = parseDuration(item.contentDetails.duration);
      if (options.duration && options.duration !== 'any') {
        if (options.duration === 'short' && durationSec >= 240) continue;
        if (options.duration === 'medium' && (durationSec < 240 || durationSec > 1200)) continue;
        if (options.duration === 'long' && durationSec <= 1200) continue;
      }

      allVideos.push({
        youtube_video_id: item.id,
        title: item.snippet.title,
        channel_title: item.snippet.channelTitle,
        channel_id: item.snippet.channelId,
        thumbnail_url: item.snippet.thumbnails.high ? item.snippet.thumbnails.high.url : (item.snippet.thumbnails.default || {}).url || '',
        views,
        likes: parseInt(item.statistics.likeCount || 0),
        duration: item.contentDetails.duration,
        duration_seconds: durationSec,
        publish_date: publishDate,
        video_url: `https://www.youtube.com/watch?v=${item.id}`,
      });
    }

    pageToken = plResult.nextPageToken;
    pageCount++;
    console.log(`    📄 频道第${pageCount}页: 获取 ${allVideos.length} 个达标视频`);

    if (stopAfterThis) {
      console.log(`    ⏹ 已超出时间范围，停止`);
      break;
    }
  } while (pageToken && pageCount < maxPages);

  return allVideos;
}

// ==================== 监控引擎 ====================

function getMonitorState(key) {
  const row = db.prepare('SELECT value FROM monitor_state WHERE key = ?').get(key);
  return row ? row.value : null;
}

function setMonitorState(key, value) {
  db.prepare('INSERT OR REPLACE INTO monitor_state (key, value) VALUES (?, ?)').run(key, value);
}

// 将视频列表写入数据库，返回新增数量
function insertMonitorVideos(videos, configId, keyword) {
  const insertVideo = db.prepare(`
    INSERT OR IGNORE INTO monitor_videos
    (youtube_video_id, config_id, keyword, title, channel_title, channel_id,
     thumbnail_url, views, likes, duration, duration_seconds, publish_date, video_url, is_short)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);
  let newCount = 0;
  for (const v of videos) {
    const isShort = v.duration_seconds <= 60 ? 1 : 0;
    const videoUrl = isShort
      ? `https://www.youtube.com/shorts/${v.youtube_video_id}`
      : `https://www.youtube.com/watch?v=${v.youtube_video_id}`;
    const result = insertVideo.run(
      v.youtube_video_id, configId, keyword,
      v.title, v.channel_title, v.channel_id,
      v.thumbnail_url, v.views, v.likes,
      v.duration, v.duration_seconds, v.publish_date, videoUrl, isShort
    );
    if (result.changes > 0) newCount++;
  }
  return newCount;
}

// 按月份拉取（全量拉取时，每次选一个月）
async function runMonthPull(config, year, month) {
  if (!YOUTUBE_API_KEY) return { success: false, error: 'YOUTUBE_API_KEY 未配置' };

  const publishedAfter = new Date(year, month - 1, 1).toISOString();
  const publishedBefore = new Date(year, month, 1).toISOString(); // 下月1号

  console.log(`📥 按月拉取 "${config.keyword}" ${year}-${String(month).padStart(2, '0')}...`);
  try {
    const videos = await youtubeSearchAll(config.keyword, config.duration, config.min_views, {
      publishedAfter,
      publishedBefore,
    });
    const newCount = insertMonitorVideos(videos, config.id, config.keyword);
    console.log(`  ✅ ${year}-${String(month).padStart(2, '0')} 完成: ${videos.length} 个视频，新增 ${newCount} 个`);
    return { success: true, total: videos.length, newCount, year, month };
  } catch (err) {
    if (err.message.includes('quotaExceeded')) {
      return { success: false, error: '配额已用完，明天自动恢复' };
    }
    throw err;
  }
}

// 手动刷新（只处理 ready 状态的关键词，最近30天分4段查）
// 刷新进度状态（内存态，服务重启会清零）
const refreshState = {
  running: false,
  phase: '',           // '搜索' | '频道'
  current: 0,
  total: 0,
  totalNew: 0,
  startedAt: null,
  lastNewCount: 0,     // 上次完成时的新增数
};

async function runRefresh() {
  if (!YOUTUBE_API_KEY) {
    setMonitorState('last_refresh_status', 'error:API_KEY_MISSING');
    return { success: false, error: 'YOUTUBE_API_KEY 未配置' };
  }

  const configs = db.prepare("SELECT * FROM monitor_configs WHERE enabled = 1 AND status = 'ready'").all();
  if (configs.length === 0) {
    return { success: true, newCount: 0, message: '无就绪的监控条件' };
  }

  // 最近30天分4段：0-7天、7-14天、14-21天、21-30天
  const now = Date.now();
  const segments = [
    { after: 7, before: 0 },
    { after: 14, before: 7 },
    { after: 21, before: 14 },
    { after: 30, before: 21 },
  ];

  console.log(`🔄 刷新 ${configs.length} 组监控条件（最近30天 × 4段）...`);
  let totalNew = 0;

  // ---- 第一路：关键词搜索（保持串行，搜索 API 100 units/次，并发容易触发配额） ----
  refreshState.phase = '搜索';
  refreshState.current = 0;
  refreshState.total = configs.length * segments.length;

  for (const config of configs) {
    let configNew = 0;
    for (const seg of segments) {
      refreshState.current++;
      try {
        const publishedAfter = new Date(now - seg.after * 24 * 60 * 60 * 1000).toISOString();
        const publishedBefore = seg.before === 0 ? undefined : new Date(now - seg.before * 24 * 60 * 60 * 1000).toISOString();

        const videos = await youtubeSearchAll(config.keyword, config.duration, config.min_views, {
          publishedAfter,
          publishedBefore,
        });
        const newCount = insertMonitorVideos(videos, config.id, config.keyword);
        configNew += newCount;
        refreshState.totalNew = totalNew + configNew;
        console.log(`    "${config.keyword}" ${seg.after}-${seg.before}天: ${videos.length} 个视频，新增 ${newCount} 个`);
      } catch (err) {
        console.error(`  ❌ "${config.keyword}" 第${seg.after}-${seg.before}天段失败:`, err.message);
        if (err.message.includes('quotaExceeded')) {
          setMonitorState('last_refresh_status', 'error:QUOTA_EXCEEDED');
          setMonitorState('last_refresh_time', new Date().toISOString());
          return { success: false, error: '配额已用完，明天自动恢复', newCount: totalNew };
        }
      }
    }
    totalNew += configNew;
    console.log(`  ✅ "${config.keyword}": 共新增 ${configNew} 个`);
  }

  // ---- 第二路：频道拉取（并发 8 路，频道 API 仅 1 unit/页，并发安全） ----
  const getChannels = db.prepare('SELECT * FROM monitored_channels WHERE config_id = ? AND enabled = 1');
  const CONCURRENCY = 8;

  // 先聚合所有待刷新的 (config, channel) 对，然后并发处理
  const tasks = [];
  for (const config of configs) {
    const channels = getChannels.all(config.id);
    for (const ch of channels) tasks.push({ config, ch });
  }

  const thirtyDaysAgoForChannels = new Date(now - 30 * 24 * 60 * 60 * 1000).toISOString();
  refreshState.phase = '频道';
  refreshState.current = 0;
  refreshState.total = tasks.length;

  async function processOneChannel({ config, ch }) {
    // 脏数据保护：空 uploads_playlist_id 先补
    if (!ch.uploads_playlist_id) {
      try {
        const result = await ytApiFetch('channels', { part: 'contentDetails', id: ch.channel_id });
        const uploads = result.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
        if (uploads) {
          db.prepare('UPDATE monitored_channels SET uploads_playlist_id = ? WHERE id = ?').run(uploads, ch.id);
          ch.uploads_playlist_id = uploads;
          console.log(`    ✅ "${ch.channel_title}" 已补齐 uploads_playlist_id`);
        } else return 0;
      } catch (e) {
        console.error(`    ❌ 补齐 "${ch.channel_title}" 失败:`, e.message);
        return 0;
      }
    }
    try {
      const videos = await fetchChannelVideos(ch.uploads_playlist_id, {
        minViews: config.min_views,
        duration: config.duration,
        publishedAfter: thirtyDaysAgoForChannels,
      });
      const newCount = insertMonitorVideos(videos, config.id, config.keyword);
      console.log(`    📺 频道 "${ch.channel_title}": ${videos.length} 个视频，新增 ${newCount} 个`);
      return newCount;
    } catch (err) {
      console.error(`    ❌ 频道 "${ch.channel_title}" 失败:`, err.message);
      return 0;
    }
  }

  // 并发 worker：每个 worker 从共享下标消费
  let nextIdx = 0;
  async function worker() {
    while (true) {
      const i = nextIdx++;
      if (i >= tasks.length) break;
      const newCount = await processOneChannel(tasks[i]);
      totalNew += newCount;
      refreshState.current++;
      refreshState.totalNew = totalNew;
    }
  }
  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, tasks.length) }, () => worker()));

  setMonitorState('last_refresh_time', new Date().toISOString());
  setMonitorState('last_refresh_status', 'success');
  console.log(`✅ 刷新完成，共新增 ${totalNew} 个视频`);
  return { success: true, newCount: totalNew };
}

// ==================== 监控 API ====================

// 获取监控状态
app.get('/api/monitor/status', (req, res) => {
  res.json({
    lastRefreshTime: getMonitorState('last_refresh_time') || null,
    lastRefreshStatus: getMonitorState('last_refresh_status') || null,
    apiKeyConfigured: !!YOUTUBE_API_KEY,
    refreshing: refreshState.running,
    phase: refreshState.phase,
    progress: refreshState.total > 0 ? { current: refreshState.current, total: refreshState.total } : null,
    runningNewCount: refreshState.totalNew,
    lastNewCount: refreshState.lastNewCount,
  });
});

// 获取所有监控条件
app.get('/api/monitor/configs', (req, res) => {
  try {
    const configs = db.prepare('SELECT * FROM monitor_configs ORDER BY created_at DESC').all();
    res.json(configs);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 添加监控条件
app.post('/api/monitor/configs', (req, res) => {
  const { keyword, duration, min_views } = req.body;
  if (!keyword || !keyword.trim()) return res.status(400).json({ error: '关键词不能为空' });

  try {
    const result = db.prepare(
      "INSERT INTO monitor_configs (keyword, duration, min_views, status) VALUES (?, ?, ?, 'testing')"
    ).run(keyword.trim(), duration || 'any', min_views || 0);

    const config = db.prepare('SELECT * FROM monitor_configs WHERE id = ?').get(result.lastInsertRowid);
    res.status(201).json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新监控条件
app.put('/api/monitor/configs/:id', (req, res) => {
  const { keyword, duration, min_views, enabled } = req.body;
  try {
    const existing = db.prepare('SELECT * FROM monitor_configs WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '监控条件不存在' });

    db.prepare(
      'UPDATE monitor_configs SET keyword=?, duration=?, min_views=?, enabled=? WHERE id=?'
    ).run(
      keyword !== undefined ? keyword : existing.keyword,
      duration !== undefined ? duration : existing.duration,
      min_views !== undefined ? min_views : existing.min_views,
      enabled !== undefined ? enabled : existing.enabled,
      req.params.id
    );

    const config = db.prepare('SELECT * FROM monitor_configs WHERE id = ?').get(req.params.id);
    res.json(config);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除监控条件
app.delete('/api/monitor/configs/:id', (req, res) => {
  try {
    const existing = db.prepare('SELECT * FROM monitor_configs WHERE id = ?').get(req.params.id);
    if (!existing) return res.status(404).json({ error: '监控条件不存在' });

    db.prepare('DELETE FROM monitor_configs WHERE id = ?').run(req.params.id);
    res.json({ message: '已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 按月拉取（全量拉取时，每次选一个月份）
app.post('/api/monitor/configs/:id/month-pull', async (req, res) => {
  const { year, month } = req.body;
  if (!year || !month) return res.status(400).json({ error: '请指定 year 和 month' });

  try {
    const config = db.prepare('SELECT * FROM monitor_configs WHERE id = ?').get(req.params.id);
    if (!config) return res.status(404).json({ error: '监控条件不存在' });

    const result = await runMonthPull(config, parseInt(year), parseInt(month));

    // 记录已拉取的月份
    if (result.success) {
      const monthKey = `${year}-${String(month).padStart(2, '0')}`;
      const existing = (config.pulled_months || '').split(',').filter(Boolean);
      if (!existing.includes(monthKey)) {
        existing.push(monthKey);
        db.prepare('UPDATE monitor_configs SET pulled_months = ? WHERE id = ?')
          .run(existing.join(','), req.params.id);
      }
    }

    res.json(result);
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 标记为就绪（全量拉取完成后）
app.post('/api/monitor/configs/:id/set-ready', (req, res) => {
  try {
    const config = db.prepare('SELECT * FROM monitor_configs WHERE id = ?').get(req.params.id);
    if (!config) return res.status(404).json({ error: '监控条件不存在' });

    db.prepare("UPDATE monitor_configs SET status = 'ready' WHERE id = ?").run(req.params.id);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== 频道 API ====================

// 获取某个关键词配置下的频道
app.get('/api/monitor/configs/:configId/channels', (req, res) => {
  try {
    const channels = db.prepare('SELECT * FROM monitored_channels WHERE config_id = ? ORDER BY created_at DESC')
      .all(req.params.configId);
    res.json(channels);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 添加频道到某个关键词配置下
app.post('/api/monitor/configs/:configId/channels', async (req, res) => {
  const { input } = req.body;
  if (!input || !input.trim()) return res.status(400).json({ error: '请输入频道 URL 或 @handle' });

  const configId = req.params.configId;
  const config = db.prepare('SELECT * FROM monitor_configs WHERE id = ?').get(configId);
  if (!config) return res.status(404).json({ error: '监控条件不存在' });

  try {
    const info = await resolveChannel(input);

    const existing = db.prepare('SELECT * FROM monitored_channels WHERE config_id = ? AND channel_id = ?')
      .get(configId, info.channel_id);
    if (existing) return res.status(400).json({ error: `该配置下已有此频道: ${existing.channel_title}` });

    db.prepare(
      'INSERT INTO monitored_channels (config_id, channel_id, channel_title, thumbnail_url, uploads_playlist_id) VALUES (?, ?, ?, ?, ?)'
    ).run(configId, info.channel_id, info.channel_title, info.thumbnail_url, info.uploads_playlist_id);

    const channel = db.prepare('SELECT * FROM monitored_channels WHERE config_id = ? AND channel_id = ?')
      .get(configId, info.channel_id);
    res.status(201).json(channel);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 删除频道
app.delete('/api/monitor/channels/:id', (req, res) => {
  try {
    db.prepare('DELETE FROM monitored_channels WHERE id = ?').run(req.params.id);
    res.json({ message: '已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 手动触发刷新（后台执行，立刻返回；前端轮询 /status 获取进度）
app.post('/api/monitor/refresh', (req, res) => {
  if (refreshState.running) {
    return res.status(409).json({ success: false, error: '刷新正在进行中', running: true });
  }
  refreshState.running = true;
  refreshState.phase = '初始化';
  refreshState.current = 0;
  refreshState.total = 0;
  refreshState.totalNew = 0;
  refreshState.startedAt = Date.now();

  // 异步执行，不 await
  runRefresh()
    .then(result => {
      refreshState.lastNewCount = result.newCount || 0;
      console.log(`✅ 后台刷新结束: ${JSON.stringify(result)}`);
    })
    .catch(err => {
      console.error('❌ 后台刷新异常:', err);
      setMonitorState('last_refresh_status', 'error:' + err.message.slice(0, 80));
      setMonitorState('last_refresh_time', new Date().toISOString());
    })
    .finally(() => {
      refreshState.running = false;
      refreshState.phase = '';
    });

  res.json({ success: true, started: true });
});

// 获取发现的视频列表
app.get('/api/monitor/videos', (req, res) => {
  try {
    const { keyword, is_short, page, limit, youtube_id } = req.query;
    const pageNum = parseInt(page) || 1;
    const pageSize = parseInt(limit) || 50;
    const offset = (pageNum - 1) * pageSize;

    const conditions = [];
    const params = [];
    if (keyword) {
      conditions.push('mv.keyword = ?');
      params.push(keyword);
    }
    if (is_short !== undefined && is_short !== '') {
      conditions.push('mv.is_short = ?');
      params.push(parseInt(is_short));
    }
    if (youtube_id) {
      conditions.push('mv.youtube_video_id LIKE ?');
      params.push('%' + youtube_id + '%');
    }
    const where = conditions.length > 0 ? 'WHERE ' + conditions.join(' AND ') : '';

    const total = db.prepare(`SELECT COUNT(*) as cnt FROM monitor_videos mv ${where}`).get(...params).cnt;
    const videos = db.prepare(
      `SELECT mv.*,
              CASE WHEN it.id IS NOT NULL OR v.id IS NOT NULL THEN 1 ELSE 0 END as imported
       FROM monitor_videos mv
       LEFT JOIN import_tasks it ON it.youtube_video_id = mv.youtube_video_id
       LEFT JOIN videos v ON v.video_link LIKE '%' || mv.youtube_video_id || '%'
       ${where}
       ORDER BY mv.discovered_at DESC, mv.publish_date DESC LIMIT ? OFFSET ?`
    ).all(...params, pageSize, offset);

    res.json({ videos, total, page: pageNum, pageSize, totalPages: Math.ceil(total / pageSize) });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ==================== 录入功能 ====================

// 确保下载目录存在
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) fs.mkdirSync(downloadsDir, { recursive: true });

function updateTaskStatus(id, status, extra = {}) {
  const fields = ['status', 'updated_at'];
  const values = [status, new Date().toISOString().slice(0, 19).replace('T', ' ')];
  for (const k of Object.keys(extra)) {
    fields.push(k);
    values.push(extra[k]);
  }
  const setClause = fields.map(f => `${f} = ?`).join(', ');
  values.push(id);
  db.prepare(`UPDATE import_tasks SET ${setClause} WHERE id = ?`).run(...values);
}

// 用 yt-dlp 下载视频
function downloadVideo(videoUrl, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-f', 'best[ext=mp4]/best',
      '--merge-output-format', 'mp4',
      '-o', outputPath,
      '--no-playlist',
      // 限流保护
      '--sleep-interval', '3',
      '--max-sleep-interval', '10',
      '--retries', '3',
      '--fragment-retries', '3',
      '--extractor-retries', '3',
      videoUrl,
    ];
    if (process.env.YTDLP_COOKIES_FROM_BROWSER) {
      args.push('--cookies-from-browser', process.env.YTDLP_COOKIES_FROM_BROWSER);
    }
    if (process.env.YTDLP_PROXY) {
      args.push('--proxy', process.env.YTDLP_PROXY);
    }

    console.log(`  ⬇️  yt-dlp ${videoUrl}`);
    const proc = spawn('yt-dlp', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`yt-dlp 退出码 ${code}: ${stderr.slice(-500)}`));
    });
    proc.on('error', reject);
  });
}

// 检测是否限流错误
function isRateLimitError(message) {
  if (!message) return false;
  const lower = message.toLowerCase();
  return lower.includes('sign in to confirm') ||
         lower.includes('429') ||
         lower.includes('too many requests') ||
         lower.includes('rate limit') ||
         lower.includes('bot');
}

// ==================== 下载队列（串行 + 限流保护） ====================
const downloadQueue = [];
let queueProcessing = false;
let queuePausedUntil = 0; // 限流时暂停到什么时候

// 当前队列运行态（内存态，供前端状态条展示）
const queueState = {
  currentTaskId: null,       // 正在处理的任务 id
  phase: 'idle',             // 'idle' | 'downloading' | 'uploading' | 'cooling_down' | 'paused'
  phaseStartedAt: null,      // 当前阶段开始时间戳
  nextResumeAt: 0,           // 冷却/暂停结束时间戳
};

function setQueuePhase(phase, taskId = null) {
  queueState.phase = phase;
  queueState.currentTaskId = taskId;
  queueState.phaseStartedAt = Date.now();
}

function enqueueBackup(taskId) {
  if (!downloadQueue.includes(taskId)) downloadQueue.push(taskId);
  processQueue();
}

async function processQueue() {
  if (queueProcessing) return;
  queueProcessing = true;

  while (downloadQueue.length > 0) {
    // 检查是否在暂停期
    const now = Date.now();
    if (now < queuePausedUntil) {
      const waitMs = queuePausedUntil - now;
      console.log(`⏸  队列暂停中，${Math.round(waitMs / 60000)} 分钟后恢复`);
      setQueuePhase('paused');
      queueState.nextResumeAt = queuePausedUntil;
      await new Promise(r => setTimeout(r, waitMs));
    }

    const taskId = downloadQueue.shift();
    setQueuePhase('downloading', taskId);
    queueState.nextResumeAt = 0;
    const result = await runBackupImpl(taskId);

    if (result && result.rateLimited) {
      // 限流：暂停 10 分钟，并把当前任务重新塞回队列
      queuePausedUntil = Date.now() + 10 * 60 * 1000;
      downloadQueue.unshift(taskId);
      console.log('🚫 触发限流，暂停 10 分钟后重试');
      setQueuePhase('paused');
      queueState.nextResumeAt = queuePausedUntil;
      continue;
    }

    // 正常完成或其他失败：随机等 10-30 秒再下一个
    if (downloadQueue.length > 0) {
      const delay = 10000 + Math.floor(Math.random() * 20000);
      console.log(`  ⏱  等待 ${Math.round(delay / 1000)} 秒后处理下一个任务`);
      setQueuePhase('cooling_down');
      queueState.nextResumeAt = Date.now() + delay;
      await new Promise(r => setTimeout(r, delay));
    }
  }

  setQueuePhase('idle');
  queueState.nextResumeAt = 0;
  queueProcessing = false;
}

// 上传到 OSS（分片上传 + 自动重试，抗网络抖动）
// 针对不稳定网络调优：大分片、串行、长退避
async function uploadToOSS(localPath, ossKey) {
  if (!OSS_ENABLED || !ossClient) throw new Error('OSS 未配置');

  const stat = fs.statSync(localPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);

  // 小于 5MB 用普通 put；否则走分片上传
  const useMultipart = stat.size >= 5 * 1024 * 1024;

  const maxAttempts = 3;
  const backoffSec = [15, 45]; // 两次重试的退避秒数
  let lastErr = null;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      if (useMultipart) {
        const result = await ossClient.multipartUpload(ossKey, localPath, {
          parallel: 1,                  // 串行分片：一次只开一个 TCP 连接，最稳
          partSize: 5 * 1024 * 1024,    // 5MB / 片（OSS 推荐值）：22MB 文件只需 5 片，不是 22 片
          timeout: 180 * 1000,          // 单片 3 分钟超时
        });
        return result.res?.requestUrls?.[0]?.split('?')[0]
          || `https://${OSS_CONFIG.bucket}.${OSS_CONFIG.region}.aliyuncs.com/${ossKey}`;
      } else {
        const result = await ossClient.put(ossKey, localPath, { timeout: 180 * 1000 });
        return result.url;
      }
    } catch (err) {
      lastErr = err;
      const code = err.code || err.name || '';
      const msg = err.message || '';
      const retriable = /EPIPE|ECONN|ETIMEDOUT|ENOTFOUND|socket hang up|RequestTimeout|Timeout|TLS|secure/i.test(code + ' ' + msg);
      console.log(`  ⚠️  OSS 上传失败 (尝试 ${attempt}/${maxAttempts}, ${sizeMB}MB): ${code} ${msg.slice(0, 120)}`);
      if (!retriable || attempt === maxAttempts) break;
      const waitSec = backoffSec[attempt - 1] || 60;
      console.log(`  ⏳ ${waitSec}s 后重试（给网络恢复时间）`);
      await new Promise(r => setTimeout(r, waitSec * 1000));
    }
  }
  throw lastErr;
}

function generateThreeSecondPreview(localPath, outputPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-y',
      '-i', localPath,
      '-t', '3',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-avoid_negative_ts', 'make_zero',
      '-loglevel', 'error',
      outputPath
    ];
    const proc = spawn('ffmpeg', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0 && fs.existsSync(outputPath)) resolve();
      else reject(new Error(`ffmpeg 退出码 ${code}: ${stderr.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

async function uploadTaskVideo(taskId, localPath, filename) {
  const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
  if (!task) return;
  if (task.upload_status === 'uploaded') return;

  if (!OSS_ENABLED || !ossClient) {
    updateTaskStatus(taskId, task.status, { upload_status: 'skipped', upload_error: '' });
    return;
  }

  try {
    updateTaskStatus(taskId, task.status, { upload_status: 'uploading', upload_error: '', backup_status: 'uploading' });
    const ossKey = `videos/${filename}`;
    const ossUrl = await uploadToOSS(localPath, ossKey);
    updateTaskStatus(taskId, task.status, {
      upload_status: 'uploaded',
      upload_error: '',
      backup_status: 'uploaded',
      local_file_path: localPath,
      oss_video_url: ossUrl,
    });
    if (task.source_video_id) {
      db.prepare("UPDATE videos SET video_path = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
        .run(ossUrl, task.source_video_id);
    }
    console.log(`  ✅ 上传完成: ${ossUrl}`);
  } catch (err) {
    console.error(`❌ 上传失败:`, err.message);
    updateTaskStatus(taskId, task.status, {
      upload_status: 'failed',
      upload_error: err.message,
      backup_status: 'failed',
      backup_error: err.message,
    });
  }
}

async function generateTaskPreview(taskId, localPath) {
  const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
  if (!task || !task.source_video_id) return;
  if (task.preview_status === 'ready') return;

  const previewsDir = path.join(__dirname, 'public/previews');
  if (!fs.existsSync(previewsDir)) fs.mkdirSync(previewsDir, { recursive: true });
  const outputFileName = `${task.source_video_id}_preview.mp4`;
  const outputPath = path.join(previewsDir, outputFileName);
  const relativePath = `previews/${outputFileName}`;

  try {
    updateTaskStatus(taskId, task.status, { preview_status: 'generating', preview_error: '' });
    await generateThreeSecondPreview(localPath, outputPath);
    updateTaskStatus(taskId, task.status, { preview_status: 'ready', preview_error: '' });
    db.prepare("UPDATE videos SET preview_path = ?, updated_at = datetime('now', 'localtime') WHERE id = ?")
      .run(relativePath, task.source_video_id);
    console.log(`  ✅ 预览切片完成: ${relativePath}`);
  } catch (err) {
    if (fs.existsSync(outputPath)) {
      try { fs.unlinkSync(outputPath); } catch (e) {}
    }
    console.error(`❌ 预览切片失败:`, err.message);
    updateTaskStatus(taskId, task.status, { preview_status: 'failed', preview_error: err.message });
  }
}

function startPostDownloadTasks(taskId, localPath, filename) {
  const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
  if (!task) return;
  if (!['uploaded', 'uploading'].includes(task.upload_status || '')) {
    uploadTaskVideo(taskId, localPath, filename).catch(e => console.error('上传流程异常:', e.message));
  }
  if (!['ready', 'generating'].includes(task.preview_status || '')) {
    generateTaskPreview(taskId, localPath).catch(e => console.error('预览流程异常:', e.message));
  }
  if (GEMINI_API_KEY && ['queued', 'failed', ''].includes(task.analysis_status || '')) {
    enqueueAnalysis(taskId);
  }
}

// 自动添加频道到该关键词配置下
async function autoAddChannel(configId, channelId, channelTitle) {
  if (!configId || !channelId) return;
  const existing = db.prepare('SELECT id FROM monitored_channels WHERE config_id = ? AND channel_id = ?')
    .get(configId, channelId);
  if (existing) return;

  try {
    const result = await ytApiFetch('channels', { part: 'snippet,contentDetails', id: channelId });
    if (!result.items || result.items.length === 0) return;
    const ch = result.items[0];
    db.prepare(
      'INSERT OR IGNORE INTO monitored_channels (config_id, channel_id, channel_title, thumbnail_url, uploads_playlist_id) VALUES (?, ?, ?, ?, ?)'
    ).run(configId, ch.id, ch.snippet.title, (ch.snippet.thumbnails.default || {}).url || '', ch.contentDetails.relatedPlaylists.uploads);
    console.log(`  📺 已自动关注频道: ${ch.snippet.title}`);
  } catch (e) {
    console.error('自动关注频道失败:', e.message);
    // 不 throw — 频道关注失败不影响录入主流程
  }
}

// 对外接口：把任务加入下载队列
function runBackup(taskId) {
  enqueueBackup(taskId);
}

// 实际执行备份（由队列调用）
async function runBackupImpl(taskId) {
  const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
  if (!task) return;

  try {
    updateTaskStatus(taskId, task.status, {
      backup_status: 'downloading',
      backup_error: '',
      download_status: 'downloading',
      download_error: ''
    });
    console.log(`📥 开始下载 "${task.title}"`);
    const filename = `${task.youtube_video_id}.mp4`;
    const localPath = path.join(downloadsDir, filename);
    await downloadVideo(task.video_url, localPath);
    console.log(`  ✅ 下载完成`);

    updateTaskStatus(taskId, task.status, {
      backup_status: 'downloaded',
      download_status: 'downloaded',
      download_error: '',
      local_file_path: localPath,
    });

    // 下载完成后分叉：上传 OSS、生成预览、Whisper 字幕 + Gemini 分析并行推进。
    startPostDownloadTasks(taskId, localPath, filename);
    return { rateLimited: false };
  } catch (err) {
    console.error(`❌ 备份失败:`, err.message);
    const rateLimited = isRateLimitError(err.message);
    updateTaskStatus(taskId, task.status, {
      backup_status: rateLimited ? 'queued' : 'failed',
      backup_error: err.message,
      download_status: rateLimited ? 'queued' : 'failed',
      download_error: err.message,
    });
    return { rateLimited };
  }
}

// ==================== Gemini 视频理解 ====================

function geminiRequest(endpoint, body) {
  return new Promise((resolve, reject) => {
    const url = new URL(`${GEMINI_API_BASE}/${endpoint}`);
    const options = {
      hostname: url.hostname,
      port: 443,
      path: url.pathname + url.search,
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${GEMINI_API_KEY}`,
        'Content-Type': 'application/json',
      },
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const json = JSON.parse(data);
          if (json.error) reject(new Error(json.error.message || JSON.stringify(json.error)));
          else resolve(json);
        } catch (e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.setTimeout(10 * 60 * 1000, () => {
      req.destroy(new Error('Gemini 请求超时'));
    });
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ==================== Gemini 分析并发队列（批量场景用） ====================
const geminiQueue = [];
let geminiInFlight = 0;
const GEMINI_MAX_PARALLEL = 10;

function enqueueAnalysis(taskId) {
  if (!geminiQueue.includes(taskId)) geminiQueue.push(taskId);
  processGeminiQueue();
}

function processGeminiQueue() {
  while (geminiInFlight < GEMINI_MAX_PARALLEL && geminiQueue.length > 0) {
    const taskId = geminiQueue.shift();
    geminiInFlight++;
    callGeminiForTask(taskId)
      .catch(e => console.error('分析队列异常:', e.message))
      .finally(() => {
        geminiInFlight--;
        processGeminiQueue();
      });
  }
}

// 读取提示词模板
function getVideoAnalysisPrompt() {
  try {
    return fs.readFileSync(GEMINI_PROMPT_PATH, 'utf8');
  } catch (e) {
    console.error('读取提示词失败:', e.message);
    return '请对这条视频进行专业级影视拆解，包括视频元数据、故事骨架、全局设定和逐Clip分析。';
  }
}

// ==================== Whisper 转写工具 ====================
function fmtWhisperTs(sec) {
  const m = Math.floor(sec / 60);
  const s = sec - m * 60;
  return `${String(m).padStart(2, '0')}:${s.toFixed(2).padStart(5, '0')}`;
}

function formatTranscriptCacheText(transcript) {
  if (!transcript || !transcript.segments || transcript.segments.length === 0) return transcript?.text || '';
  return transcript.segments
    .map(s => `${fmtWhisperTs(s.start)}-${fmtWhisperTs(s.end)}: ${s.text}`)
    .join('\n');
}

function runWhisper(localVideoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(WHISPER_PYTHON, [WHISPER_SCRIPT, localVideoPath, WHISPER_MODEL], {
      env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com' },
    });
    let stdout = '', stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper 退出码 ${code}: ${stderr.slice(-300)}`));
      try {
        const data = JSON.parse(stdout);
        if (data.error) return reject(new Error(data.error));
        resolve(data);
      } catch (e) { reject(new Error('whisper 非 JSON: ' + stdout.slice(0, 200))); }
    });
    proc.on('error', reject);
  });
}

function downloadOssToLocal(ossUrl, localPath) {
  return new Promise((resolve, reject) => {
    const args = [
      '-sL', '--fail',
      '--retry', '6', '--retry-delay', '10', '--retry-all-errors',
      '--max-time', '300', '--connect-timeout', '30',
      '-o', localPath, ossUrl,
    ];
    const proc = spawn('curl', args);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`curl 退出码 ${code}: ${stderr.slice(-200)}`));
    });
    proc.on('error', reject);
  });
}

async function getTranscriptForVideo(videoId, ossUrl) {
  if (!ossUrl) return null;
  if (!fs.existsSync(WHISPER_VIDEO_CACHE_DIR)) fs.mkdirSync(WHISPER_VIDEO_CACHE_DIR, { recursive: true });
  if (!fs.existsSync(TRANSCRIPT_CACHE_DIR)) fs.mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });

  const cachePath = path.join(TRANSCRIPT_CACHE_DIR, `${videoId}.json`);
  const textCachePath = path.join(TRANSCRIPT_CACHE_DIR, `${videoId}.txt`);
  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!fs.existsSync(textCachePath)) {
        fs.writeFileSync(textCachePath, formatTranscriptCacheText(cached), 'utf8');
      }
      return cached;
    } catch (e) {}
  }

  const localVideo = path.join(WHISPER_VIDEO_CACHE_DIR, `v${videoId}.mp4`);
  if (!fs.existsSync(localVideo) || fs.statSync(localVideo).size < 1024) {
    console.log(`  📥 OSS 下载: ${ossUrl}`);
    await downloadOssToLocal(ossUrl, localVideo);
  }

  console.log(`  🎤 Whisper 转写 video=${videoId} (model=${WHISPER_MODEL})`);
  const t0 = Date.now();
  const result = await runWhisper(localVideo);
  console.log(`  🎤 转写完成 ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.segments?.length || 0} 段`);
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  fs.writeFileSync(textCachePath, formatTranscriptCacheText(result), 'utf8');
  console.log(`  💾 字幕缓存: ${cachePath}`);
  return result;
}

function safeTranscriptCacheKey(key) {
  return String(key || 'unknown')
    .replace(/[^a-zA-Z0-9_-]/g, '_')
    .slice(0, 100);
}

async function getTranscriptForLocalVideo(cacheKey, localVideoPath) {
  if (!localVideoPath || !fs.existsSync(localVideoPath) || fs.statSync(localVideoPath).size < 1024) return null;
  if (!fs.existsSync(TRANSCRIPT_CACHE_DIR)) fs.mkdirSync(TRANSCRIPT_CACHE_DIR, { recursive: true });

  const safeKey = safeTranscriptCacheKey(cacheKey);
  const cachePath = path.join(TRANSCRIPT_CACHE_DIR, `${safeKey}.json`);
  const textCachePath = path.join(TRANSCRIPT_CACHE_DIR, `${safeKey}.txt`);

  if (fs.existsSync(cachePath)) {
    try {
      const cached = JSON.parse(fs.readFileSync(cachePath, 'utf8'));
      if (!fs.existsSync(textCachePath)) {
        fs.writeFileSync(textCachePath, formatTranscriptCacheText(cached), 'utf8');
      }
      return cached;
    } catch (e) {}
  }

  console.log(`  🎤 Whisper 转写 cache=${safeKey} (model=${WHISPER_MODEL})`);
  const t0 = Date.now();
  const result = await runWhisper(localVideoPath);
  console.log(`  🎤 转写完成 ${((Date.now() - t0) / 1000).toFixed(1)}s, ${result.segments?.length || 0} 段`);
  fs.writeFileSync(cachePath, JSON.stringify(result, null, 2));
  fs.writeFileSync(textCachePath, formatTranscriptCacheText(result), 'utf8');
  console.log(`  💾 字幕缓存: ${cachePath}`);
  return result;
}

function formatTranscriptForPrompt(transcript) {
  if (!transcript || !transcript.segments || transcript.segments.length === 0) return null;
  const lines = [
    '【上游提供的字幕（Whisper 自动转写，带时间戳）】',
    '🔴 这是 ground truth，请在各分镜的 `声音·台词` 字段中**逐句原样保留原文**（双引号包起）。',
    '',
  ];
  for (const s of transcript.segments) {
    lines.push(`${fmtWhisperTs(s.start)}-${fmtWhisperTs(s.end)}: "${s.text}"`);
  }
  return lines.join('\n');
}

// 构造 Gemini 请求（拆分 systemInstruction + contents，更高优先级跟随提示词）
function buildGeminiRequest(task, conversations, initialVideoUrl, transcriptText = null) {
  // 建议视频名规则已在 prompt 文件的【输出要求】第 8 条内，这里不再追加
  const systemText = getVideoAnalysisPrompt();

  // 真实元数据（来自本地数据库），告诉模型"用我提供的这些，不要编"
  const metaLines = [
    '【我提供的视频元数据（请原样照抄到【视频元数据】段，禁止编造）】',
    `视频标题：${task.title || '未知'}`,
    `视频链接：${task.video_url || '未知'}`,
    `发布日期：${task.publish_date || '未知'}`,
    `视频时长：${task.duration_seconds ? task.duration_seconds + '秒' : '未知'}`,
    `播放量：${task.views != null ? task.views : '未知'}`,
    `点赞量：${task.likes != null ? task.likes : '未知'}`,
    `频道：${task.channel_title || '未知'}`,
  ].join('\n');

  const contents = [];

  // 首轮：视频 + 真实元数据 + 可选字幕 + 简短指令（抽帧率 10fps，对快剪短视频更友好）
  const firstTurnText = (transcriptText ? transcriptText + '\n\n' : '') + metaLines +
    '\n\n请按照系统指令对这条视频进行专业级影视拆解。';
  contents.push({
    role: 'user',
    parts: [
      { file_data: { file_uri: initialVideoUrl }, video_metadata: { fps: 10 } },
      { text: firstTurnText },
    ],
  });

  // 后续对话
  for (const turn of conversations) {
    contents.push({
      role: turn.role === 'assistant' ? 'model' : 'user',
      parts: [{ text: turn.content }],
    });
  }

  return {
    systemInstruction: { parts: [{ text: systemText }] },
    contents,
  };
}

// 从 Gemini 输出提取建议的视频名
function extractSuggestedName(output) {
  const m = output.match(/建议视频名[:：]\s*([^\n]+)/);
  if (m) return m[1].trim().replace(/^["']|["']$/g, '');
  return null;
}

// 调用 Gemini 并保存结果
async function callGeminiForTask(taskId, userMessage = null, options = {}) {
  const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
  if (!task) return;

  // 标记为分析中
  updateTaskStatus(taskId, task.status, { analysis_status: 'analyzing', analysis_error: '' });

  const prevConversations = db.prepare('SELECT * FROM import_conversations WHERE task_id = ? ORDER BY id ASC').all(taskId);

  // 如果有新用户消息，先存入
  if (userMessage) {
    db.prepare('INSERT INTO import_conversations (task_id, role, content) VALUES (?, ?, ?)')
      .run(taskId, 'user', userMessage);
    prevConversations.push({ role: 'user', content: userMessage });
  }

  // 首轮：优先使用本地已下载视频做 Whisper 字幕；素材库重分析再回退到 OSS 视频。
  let transcriptText = null;
  const isFirstTurn = prevConversations.length === 0;
  if (options.useTranscript !== false && isFirstTurn) {
    try {
      const localVideoPath = options.localVideoPath || task.local_file_path;
      if (localVideoPath && fs.existsSync(localVideoPath)) {
        updateTaskStatus(taskId, task.status, { transcript_status: 'transcribing', transcript_error: '' });
        const cacheKey = task.youtube_video_id ? `yt-${task.youtube_video_id}` : `task-${task.id}`;
        const transcript = await getTranscriptForLocalVideo(cacheKey, localVideoPath);
        transcriptText = formatTranscriptForPrompt(transcript);
        updateTaskStatus(taskId, task.status, {
          transcript_status: transcriptText ? 'ready' : 'skipped',
          transcript_error: ''
        });
      } else if (task.source_video_id) {
        const video = db.prepare('SELECT video_path FROM videos WHERE id = ?').get(task.source_video_id);
        if (video?.video_path) {
          updateTaskStatus(taskId, task.status, { transcript_status: 'transcribing', transcript_error: '' });
          const transcript = await getTranscriptForVideo(task.source_video_id, video.video_path);
          transcriptText = formatTranscriptForPrompt(transcript);
          updateTaskStatus(taskId, task.status, {
            transcript_status: transcriptText ? 'ready' : 'skipped',
            transcript_error: ''
          });
        }
      }
    } catch (e) {
      console.warn(`  ⚠️ transcript 失败: ${e.message}`);
      updateTaskStatus(taskId, task.status, { transcript_status: 'failed', transcript_error: e.message });
      throw new Error('Whisper 字幕失败: ' + e.message);
    }
  }

  const { systemInstruction, contents } = buildGeminiRequest(task, prevConversations, task.video_url, transcriptText);

  try {
    const requestBody = {
      systemInstruction,
      contents,
      generationConfig: {
        mediaResolution: 'MEDIA_RESOLUTION_HIGH',
        temperature: 0.2,
        thinkingConfig: {
          thinkingLevel: 'high',   // Gemini 3 专用，最高思考强度；flash-lite 默认是 minimal
          includeThoughts: true,   // 打印思考摘要到日志便于诊断
        },
      },
    };
    const result = await geminiRequest(`models/${GEMINI_MODEL}:generateContent`, requestBody);

    // Gemini 3 会返回多个 parts：thought=true 是思考摘要，thought=false/undefined 是答案
    const parts = (result.candidates && result.candidates[0] && result.candidates[0].content &&
      result.candidates[0].content.parts) || [];
    let output = '';
    let thoughtSummary = '';
    for (const p of parts) {
      if (!p.text) continue;
      if (p.thought) thoughtSummary += p.text;
      else output += p.text;
    }

    // 日志打印思考摘要（用于诊断分析为什么漏/错）
    if (thoughtSummary) {
      const usage = result.usageMetadata || {};
      console.log(`  🧠 思考 tokens: ${usage.thoughtsTokenCount || '?'}, 输出 tokens: ${usage.candidatesTokenCount || '?'}`);
      console.log(`  💭 思考摘要:\n${thoughtSummary.split('\n').map(l => '    ' + l).join('\n')}`);
    }

    if (!output) throw new Error('Gemini 返回为空');

    // 保存助手回复
    db.prepare('INSERT INTO import_conversations (task_id, role, content) VALUES (?, ?, ?)')
      .run(taskId, 'assistant', output);

    // 提取建议视频名（只在首轮保存）
    const updates = { analysis_status: 'ready' };
    if (!task.suggested_name) {
      const name = extractSuggestedName(output);
      if (name) updates.suggested_name = name;
    }
    updateTaskStatus(taskId, task.status, updates);
    console.log(`  ✅ Gemini 分析完成`);
  } catch (err) {
    console.error(`❌ Gemini 分析失败:`, err.message);
    updateTaskStatus(taskId, task.status, { analysis_status: 'failed', analysis_error: err.message });
  }
}

// 启动任务处理：先进入下载队列；下载完成后再并行触发 OSS 上传和 Whisper/Gemini 分析。
function launchTaskProcessing(taskId) {
  runBackup(taskId);
}

// ==================== 录入 API ====================

// 获取所有录入任务（后台任务中心；素材库重分析任务不在这里展示）
app.get('/api/import/tasks', (req, res) => {
  try {
    const tasks = db.prepare(`
      SELECT * FROM import_tasks
      WHERE NULLIF(task_type, '') = 'import' OR monitor_video_id IS NOT NULL
      ORDER BY created_at DESC
    `).all();
    res.json(tasks);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取备份队列实时状态（供前端状态条用）
app.get('/api/import/queue-status', (req, res) => {
  const now = Date.now();
  let currentTask = null;
  if (queueState.currentTaskId) {
    const t = db.prepare(`
      SELECT id, title, backup_status, download_status, upload_status, transcript_status, preview_status, analysis_status
      FROM import_tasks WHERE id = ?
    `).get(queueState.currentTaskId);
    if (t) currentTask = t;
  }
  // 统计 DB 里 queued 和 failed 总数
  const queuedCount = db.prepare(`
    SELECT COUNT(*) as c FROM import_tasks
    WHERE COALESCE(NULLIF(download_status, ''), backup_status) = 'queued'
      AND (NULLIF(task_type, '') = 'import' OR monitor_video_id IS NOT NULL)
  `).get().c;
  const failedCount = db.prepare(`
    SELECT COUNT(*) as c FROM import_tasks
    WHERE (COALESCE(download_status, '') = 'failed'
       OR COALESCE(upload_status, '') = 'failed'
       OR COALESCE(transcript_status, '') = 'failed'
       OR COALESCE(preview_status, '') = 'failed'
       OR COALESCE(analysis_status, '') = 'failed'
       OR COALESCE(backup_status, '') = 'failed')
      AND (NULLIF(task_type, '') = 'import' OR monitor_video_id IS NOT NULL)
  `).get().c;

  res.json({
    phase: queueState.phase,
    currentTask,
    phaseElapsedMs: queueState.phaseStartedAt ? now - queueState.phaseStartedAt : 0,
    nextResumeInMs: queueState.nextResumeAt > now ? queueState.nextResumeAt - now : 0,
    queueLength: downloadQueue.length,
    queuedCountInDb: queuedCount,
    failedCount,
  });
});

// 批量重试所有 failed 任务：重置为 queued，然后入队
app.post('/api/import/retry-all-failed', (req, res) => {
  try {
    const failed = db.prepare(`
      SELECT id FROM import_tasks
      WHERE (COALESCE(download_status, '') = 'failed'
         OR COALESCE(upload_status, '') = 'failed'
         OR COALESCE(transcript_status, '') = 'failed'
         OR COALESCE(preview_status, '') = 'failed'
         OR COALESCE(analysis_status, '') = 'failed'
         OR COALESCE(backup_status, '') = 'failed')
        AND (NULLIF(task_type, '') = 'import' OR monitor_video_id IS NOT NULL)
    `).all();
    if (failed.length === 0) {
      return res.json({ success: true, count: 0, message: '没有失败的任务' });
    }
    const reset = db.prepare(`
      UPDATE import_tasks
      SET backup_status = 'queued', backup_error = '',
          download_status = 'queued', download_error = '',
          upload_status = 'queued', upload_error = '',
          transcript_status = 'queued', transcript_error = '',
          preview_status = 'queued', preview_error = '',
          analysis_status = 'queued', analysis_error = '',
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `);
    const tx = db.transaction((rows) => {
      for (const r of rows) reset.run(r.id);
    });
    tx(failed);

    for (const r of failed) enqueueBackup(r.id);
    console.log(`🔁 批量重试 ${failed.length} 个失败任务`);
    res.json({ success: true, count: failed.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取单个任务（含对话历史）
app.get('/api/import/tasks/:id', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    const conversations = db.prepare('SELECT * FROM import_conversations WHERE task_id = ? ORDER BY id ASC')
      .all(req.params.id);
    task.conversations = conversations;
    res.json(task);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 创建录入任务（从监控视频）
app.post('/api/import/tasks', async (req, res) => {
  const { monitor_video_id } = req.body;
  if (!monitor_video_id) return res.status(400).json({ error: '缺少 monitor_video_id' });

  try {
    const video = db.prepare('SELECT * FROM monitor_videos WHERE id = ?').get(monitor_video_id);
    if (!video) return res.status(404).json({ error: '监控视频不存在' });

    const existingVideo = db.prepare("SELECT * FROM videos WHERE video_link LIKE ? LIMIT 1")
      .get(`%${video.youtube_video_id}%`);
    if (existingVideo) {
      return res.status(409).json({
        error: `已有重复素材库视频 #${existingVideo.id}，不会重复录入`,
        duplicate: true,
        duplicateType: 'video',
        video: existingVideo
      });
    }

    const existingTask = db.prepare('SELECT * FROM import_tasks WHERE youtube_video_id = ?').get(video.youtube_video_id);
    if (existingTask) {
      return res.status(409).json({
        error: `已有重复录入任务 #${existingTask.id}，不会重复录入`,
        duplicate: true,
        duplicateType: 'task',
        task: existingTask
      });
    }

    const today = new Date().toISOString().slice(0, 10);
    const createTx = db.transaction(() => {
      const seriesId = getOrCreateSeries('');
      const insertVideo = db.prepare(`
        INSERT INTO videos
        (name, video_title, duration, publish_date, date, video_link, views, likes, thumb_url, series_id)
        VALUES ('', ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      const videoResult = insertVideo.run(
        video.title || '',
        video.duration_seconds ? String(video.duration_seconds) : (video.duration || ''),
        video.publish_date || '',
        today,
        video.video_url || '',
        video.views != null ? String(video.views) : '',
        video.likes != null ? String(video.likes) : '',
        video.thumbnail_url || '',
        seriesId
      );
      const sourceVideoId = videoResult.lastInsertRowid;

      const taskResult = db.prepare(`
        INSERT INTO import_tasks
        (youtube_video_id, monitor_video_id, title, channel_id, channel_title, thumbnail_url,
         video_url, views, likes, duration_seconds, publish_date, is_short,
         backup_status, analysis_status, source_video_id, task_type,
         download_status, upload_status, transcript_status, preview_status)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'queued', 'queued', ?, 'import',
                'queued', 'queued', 'queued', 'queued')
      `).run(
        video.youtube_video_id, video.id, video.title, video.channel_id, video.channel_title,
        video.thumbnail_url, video.video_url, video.views, video.likes,
        video.duration_seconds, video.publish_date, video.is_short || 0,
        sourceVideoId
      );
      return { taskId: taskResult.lastInsertRowid, videoId: sourceVideoId };
    });

    const created = createTx();
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(created.taskId);

    // 自动记录频道（await 确保下次刷新能拉到此频道）
    await autoAddChannel(video.config_id, video.channel_id, video.channel_title);

    // 先进入下载队列；下载完成后再并行上传/预览/字幕/Gemini。
    launchTaskProcessing(task.id);

    res.status(201).json({ ...task, material_video_id: created.videoId });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重试备份
app.post('/api/import/tasks/:id/retry-backup', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    const filename = `${task.youtube_video_id}.mp4`;
    if (task.local_file_path && fs.existsSync(task.local_file_path) && task.download_status === 'downloaded') {
      updateTaskStatus(req.params.id, task.status, {
        backup_error: '',
        upload_status: ['uploaded', 'uploading'].includes(task.upload_status) ? task.upload_status : 'queued',
        upload_error: '',
        transcript_status: ['ready', 'transcribing'].includes(task.transcript_status) ? task.transcript_status : 'queued',
        transcript_error: '',
        preview_status: ['ready', 'generating'].includes(task.preview_status) ? task.preview_status : 'queued',
        preview_error: '',
        analysis_status: ['ready', 'analyzing'].includes(task.analysis_status) ? task.analysis_status : 'queued',
        analysis_error: '',
      });
      startPostDownloadTasks(req.params.id, task.local_file_path, filename);
    } else {
      updateTaskStatus(req.params.id, task.status, {
        backup_status: 'queued',
        backup_error: '',
        download_status: 'queued',
        download_error: '',
        upload_status: 'queued',
        upload_error: '',
        transcript_status: 'queued',
        transcript_error: '',
        preview_status: 'queued',
        preview_error: '',
        analysis_status: 'queued',
        analysis_error: '',
      });
      runBackup(req.params.id);
    }
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重试分析（保留对话历史）
app.post('/api/import/tasks/:id/retry-analysis', (req, res) => {
  try {
    const useTranscript = req.body?.useTranscript !== false;
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    callGeminiForTask(req.params.id, null, { useTranscript }).catch(e => console.error('分析异常:', e.message));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 重启分析（清空对话历史，重新开始）
app.post('/api/import/tasks/:id/restart-analysis', (req, res) => {
  try {
    const useTranscript = req.body?.useTranscript !== false;
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    db.prepare('DELETE FROM import_conversations WHERE task_id = ?').run(req.params.id);
    updateTaskStatus(req.params.id, task.status, { analysis_status: 'queued', analysis_error: '', suggested_name: '' });

    callGeminiForTask(req.params.id, null, { useTranscript }).catch(e => console.error('分析异常:', e.message));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 对话（用户发消息）
app.post('/api/import/tasks/:id/chat', async (req, res) => {
  const { message } = req.body;
  if (!message || !message.trim()) return res.status(400).json({ error: '消息不能为空' });

  try {
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    callGeminiForTask(req.params.id, message.trim()).catch(e => console.error('对话异常:', e.message));
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 脚本文件存储已停用，统一使用数据库里的 AI 对话
app.post('/api/import/tasks/:id/save-script', (req, res) => {
  res.status(410).json({ error: 'scripts 文件存储已停用，请直接使用数据库中的 AI 对话' });
});

// 删除任务
app.delete('/api/import/tasks/:id', (req, res) => {
  try {
    const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(req.params.id);
    if (!task) return res.status(404).json({ error: '任务不存在' });

    // 删除本地文件
    if (task.local_file_path && fs.existsSync(task.local_file_path)) {
      try { fs.unlinkSync(task.local_file_path); } catch (e) { /* ignore */ }
    }

    db.prepare('DELETE FROM import_tasks WHERE id = ?').run(req.params.id);
    res.json({ message: '已删除' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启动时恢复未完成的备份任务（队列在内存中，重启后需要从 DB 重建）
function resumeBackupQueueOnStartup() {
  // downloading / uploading 是中途被打断的，重置为 queued
  const interrupted = db.prepare(
    `SELECT id, backup_status FROM import_tasks
     WHERE COALESCE(NULLIF(download_status, ''), backup_status) = 'downloading'
        OR COALESCE(upload_status, '') = 'uploading'
        OR COALESCE(transcript_status, '') = 'transcribing'
        OR COALESCE(preview_status, '') = 'generating'
        OR COALESCE(analysis_status, '') = 'analyzing'`
  ).all();
  for (const row of interrupted) {
    db.prepare(`
      UPDATE import_tasks
      SET backup_status = CASE WHEN COALESCE(NULLIF(download_status, ''), backup_status) = 'downloading' THEN 'queued' ELSE backup_status END,
          download_status = CASE WHEN COALESCE(NULLIF(download_status, ''), backup_status) = 'downloading' THEN 'queued' ELSE download_status END,
          upload_status = CASE WHEN upload_status = 'uploading' THEN 'queued' ELSE upload_status END,
          transcript_status = CASE WHEN transcript_status = 'transcribing' THEN 'queued' ELSE transcript_status END,
          preview_status = CASE WHEN preview_status = 'generating' THEN 'queued' ELSE preview_status END,
          analysis_status = CASE WHEN analysis_status = 'analyzing' THEN 'queued' ELSE analysis_status END,
          backup_error = CASE WHEN COALESCE(NULLIF(download_status, ''), backup_status) = 'downloading' THEN '[重启时中断，重新入队]' ELSE backup_error END,
          updated_at = datetime('now', 'localtime')
      WHERE id = ?
    `).run(row.id);
  }
  if (interrupted.length > 0) {
    console.log(`🔄 重置 ${interrupted.length} 个中断任务`);
  }

  // 把所有待下载任务入队
  const queued = db.prepare(`
    SELECT id FROM import_tasks
    WHERE COALESCE(NULLIF(download_status, ''), backup_status) = 'queued'
      AND (NULLIF(task_type, '') = 'import' OR monitor_video_id IS NOT NULL)
    ORDER BY id ASC
  `).all();
  if (queued.length > 0) {
    console.log(`📥 恢复 ${queued.length} 个排队中的下载任务`);
    for (const row of queued) enqueueBackup(row.id);
  }

  // 已经下载但后续子任务未完成的，直接恢复分叉任务。
  const postDownload = db.prepare(`
    SELECT id, youtube_video_id, local_file_path FROM import_tasks
    WHERE local_file_path IS NOT NULL AND local_file_path != ''
      AND COALESCE(NULLIF(download_status, ''), backup_status) = 'downloaded'
      AND (COALESCE(upload_status, '') IN ('queued', 'failed')
        OR COALESCE(transcript_status, '') IN ('queued', 'failed')
        OR COALESCE(preview_status, '') IN ('queued', 'failed')
        OR COALESCE(analysis_status, '') IN ('queued', 'failed'))
      AND (NULLIF(task_type, '') = 'import' OR monitor_video_id IS NOT NULL)
  `).all();
  for (const row of postDownload) {
    if (fs.existsSync(row.local_file_path)) {
      startPostDownloadTasks(row.id, row.local_file_path, `${row.youtube_video_id}.mp4`);
    }
  }
  if (postDownload.length > 0) {
    console.log(`🔀 恢复 ${postDownload.length} 个下载后的并行子任务`);
  }
}

// 启动服务器
app.listen(PORT, () => {
  console.log(`✅ 素材库已启动: http://localhost:${PORT}`);
  console.log(`📁 数据库: ${dbPath}`);
  console.log(`📂 脚本目录: ${scriptsDir}`);
  if (!YOUTUBE_API_KEY) {
    console.log('⚠️  YOUTUBE_API_KEY 未配置，YouTube 监控不可用');
  } else {
    console.log('🔍 YouTube 监控已启用（手动刷新模式）');
  }
  // 恢复未完成的备份任务
  resumeBackupQueueOnStartup();
});
