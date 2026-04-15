const express = require('express');
const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

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
`);

// ==================== 数据库迁移 ====================
// 增量迁移：安全添加新列，已存在则跳过
function safeAddColumn(table, column, type) {
  try {
    db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${type} DEFAULT ''`);
    console.log(`  ✅ 新增列: ${table}.${column}`);
  } catch (e) {
    // 列已存在，跳过
  }
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

// 子表 scenes：新增 function 列（保留旧 description 列不删）
safeAddColumn('scenes', 'function', 'TEXT');

// 子表 props：新增 type 列
safeAddColumn('props', 'type', 'TEXT');

// 子表 characters：新增 abilities / states 列
safeAddColumn('characters', 'abilities', 'TEXT');
safeAddColumn('characters', 'states', 'TEXT');

console.log('✅ 数据库迁移完成');

// 中间件
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ==================== 主表字段列表 ====================
const VIDEO_FIELDS = [
  'name', 'video_title', 'duration', 'publish_date',
  'summary', 'hook', 'hook_tags', 'video_tags', 'technique',
  'mechanism_name', 'mechanism', 'story_structure',
  'adapt_tags', 'adapt_brief', 'source_video_id',
  'date', 'video_link', 'views', 'likes', 'script_path', 'video_type',
  'protagonist', 'protagonist_goal', 'antagonist', 'antagonist_goal',
  'video_path', 'thumb_url', 'preview_path', 'notes', 'is_marked'
];

// ==================== API ====================

// 获取所有视频（含关联数据）
app.get('/api/videos', (req, res) => {
  try {
    const videos = db.prepare('SELECT * FROM videos ORDER BY date DESC, id DESC').all();
    const getScenes = db.prepare('SELECT * FROM scenes WHERE video_id = ?');
    const getProps = db.prepare('SELECT * FROM props WHERE video_id = ?');
    const getCharacters = db.prepare('SELECT * FROM characters WHERE video_id = ?');
    const getTags = db.prepare('SELECT * FROM video_tags_rel WHERE video_id = ?');

    const result = videos.map(v => {
      let tags = getTags.all(v.id);
      // 向下兼容：如果无关联表数据，但主表有数据，则强行平移
      if (tags.length === 0 && v.video_tags) {
         tags = v.video_tags.split(',').map(tag => ({
           name: tag.trim(),
           technique: v.technique || ''
         })).filter(t => t.name);
      }
      return {
        ...v,
        scenes: getScenes.all(v.id),
        props: getProps.all(v.id),
        characters: getCharacters.all(v.id),
        video_tags_rel: tags
      };
    });

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

    video.scenes = db.prepare('SELECT * FROM scenes WHERE video_id = ?').all(video.id);
    video.props = db.prepare('SELECT * FROM props WHERE video_id = ?').all(video.id);
    video.characters = db.prepare('SELECT * FROM characters WHERE video_id = ?').all(video.id);
    
    let tags = db.prepare('SELECT * FROM video_tags_rel WHERE video_id = ?').all(video.id);
    if (tags.length === 0 && video.video_tags) {
       tags = video.video_tags.split(',').map(tag => ({
         name: tag.trim(),
         technique: video.technique || ''
       })).filter(t => t.name);
    }
    video.video_tags_rel = tags;

    res.json(video);
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
    video.scenes = db.prepare('SELECT * FROM scenes WHERE video_id = ?').all(videoId);
    video.props = db.prepare('SELECT * FROM props WHERE video_id = ?').all(videoId);
    video.characters = db.prepare('SELECT * FROM characters WHERE video_id = ?').all(videoId);
    video.video_tags_rel = db.prepare('SELECT * FROM video_tags_rel WHERE video_id = ?').all(videoId);

    res.status(201).json(video);
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
    video.scenes = db.prepare('SELECT * FROM scenes WHERE video_id = ?').all(videoId);
    video.props = db.prepare('SELECT * FROM props WHERE video_id = ?').all(videoId);
    video.characters = db.prepare('SELECT * FROM characters WHERE video_id = ?').all(videoId);
    let tags = db.prepare('SELECT * FROM video_tags_rel WHERE video_id = ?').all(video.id);
    if (tags.length === 0 && video.video_tags) {
       tags = video.video_tags.split(',').map(tag => ({
         name: tag.trim(),
         technique: video.technique || ''
       })).filter(t => t.name);
    }
    video.video_tags_rel = tags;

    res.json(video);
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
    const videos = db.prepare(`SELECT * FROM videos WHERE id IN (${placeholders}) ORDER BY date DESC`).all(...ids);

    const getScenes = db.prepare('SELECT * FROM scenes WHERE video_id = ?');
    const getProps = db.prepare('SELECT * FROM props WHERE video_id = ?');
    const getCharacters = db.prepare('SELECT * FROM characters WHERE video_id = ?');
    const getTags = db.prepare('SELECT * FROM video_tags_rel WHERE video_id = ?');

    const result = videos.map(v => {
      let tags = getTags.all(v.id);
      if (tags.length === 0 && v.video_tags) {
         tags = v.video_tags.split(',').map(tag => ({
           name: tag.trim(),
           technique: v.technique || ''
         })).filter(t => t.name);
      }
      return {
        ...v,
        scenes: getScenes.all(v.id),
        props: getProps.all(v.id),
        characters: getCharacters.all(v.id),
        video_tags_rel: tags
      };
    });

    res.json(result);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 启动服务器
app.listen(PORT, () => {
  console.log(`✅ 素材库已启动: http://localhost:${PORT}`);
  console.log(`📁 数据库: ${dbPath}`);
  console.log(`📂 脚本目录: ${scriptsDir}`);
});
