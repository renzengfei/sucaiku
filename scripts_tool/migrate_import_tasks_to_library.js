#!/usr/bin/env node
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const db = new Database(path.join(ROOT, 'database.db'));

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function getOrCreateEmptySeries() {
  const existing = db.prepare(`SELECT id FROM series WHERE name = '' LIMIT 1`).get();
  if (existing?.id) return existing.id;
  const result = db.prepare(`
    INSERT INTO series (name, mechanism, created_at, updated_at)
    VALUES ('', '', datetime('now', 'localtime'), datetime('now', 'localtime'))
  `).run();
  return result.lastInsertRowid;
}

function loadTasksToMigrate() {
  return db.prepare(`
    SELECT
      t.*,
      v.id AS linked_video_id
    FROM import_tasks t
    LEFT JOIN videos v ON v.id = t.source_video_id
    WHERE (NULLIF(t.task_type, '') = 'import' OR t.monitor_video_id IS NOT NULL)
      AND (t.source_video_id IS NULL OR t.source_video_id = '' OR v.id IS NULL)
    ORDER BY datetime(t.created_at) DESC, t.id DESC
  `).all();
}

function createVideoFromTask(task, seriesId) {
  const createdAt = task.created_at || nowSql();
  const dateValue = String(createdAt).slice(0, 10);
  const result = db.prepare(`
    INSERT INTO videos
    (name, video_title, duration, publish_date, date, video_link, views, likes, thumb_url, series_id, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    '',
    task.title || '',
    task.duration_seconds ? String(task.duration_seconds) : '',
    task.publish_date || '',
    dateValue,
    task.video_url || '',
    task.views != null ? String(task.views) : '',
    task.likes != null ? String(task.likes) : '',
    task.thumbnail_url || '',
    seriesId,
    createdAt,
    createdAt
  );
  return result.lastInsertRowid;
}

function migrate() {
  const seriesId = getOrCreateEmptySeries();
  const tasks = loadTasksToMigrate();
  let created = 0;
  const migrated = [];

  const tx = db.transaction(() => {
    for (const task of tasks) {
      const videoId = createVideoFromTask(task, seriesId);
      db.prepare(`
        UPDATE import_tasks
        SET source_video_id = ?, updated_at = ?
        WHERE id = ?
      `).run(videoId, nowSql(), task.id);
      migrated.push({ taskId: task.id, videoId, title: task.title, analysisStatus: task.analysis_status });
      created++;
    }
  });

  tx();
  return { created, migrated };
}

const result = migrate();
console.log(JSON.stringify({
  migrated_count: result.created,
  sample: result.migrated.slice(0, 20),
}, null, 2));
