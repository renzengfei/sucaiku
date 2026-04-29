#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const ROOT = path.join(__dirname, '..');
const db = new Database(path.join(ROOT, 'database.db'));

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function stripFence(text) {
  return String(text || '')
    .replace(/^\s*```(?:\w+)?\s*\n/, '')
    .replace(/\n```\s*$/g, '\n')
    .trim();
}

function findStorySkeletonSection(content) {
  const text = stripFence(content);
  const startPatterns = [
    /(?:^|\n)\s*#+\s*【故事骨架】\s*/i,
    /(?:^|\n)\s*【故事骨架】\s*/i,
    /(?:^|\n)\s*#*\s*【[^】\n]*事骨架】\s*/i,
    /(?:^|\n)\s*#*\s*[^【\n]*事骨架\s*[:：]?\s*/i,
    /(?:^|\n)\s*#+\s*故事骨架\s*[:：]?\s*/i,
    /(?:^|\n)\s*故事骨架\s*[:：]\s*/i,
    /(?:^|\n)\s*\[故事骨架\]\s*/i,
    /(?:^|\n)\s*Story\s+Skeleton\s*[:：]?\s*/i,
    /(?:^|\n)\s*#\s*Story\s+Skeleton\s*[:：]?\s*/i,
  ];

  let start = -1;
  let matchedLength = 0;
  for (const pattern of startPatterns) {
    const match = pattern.exec(text);
    if (match && (start === -1 || match.index < start)) {
      start = match.index;
      matchedLength = match[0].length;
    }
  }
  if (start === -1) return '';

  const bodyStart = start + matchedLength;
  const rest = text.slice(bodyStart);
  const endPatterns = [
    /\n\s*#+\s*【全局设定】/i,
    /\n\s*#+\s*【逐分镜详细分析】/i,
    /\n\s*【全局设定】/i,
    /\n\s*【逐分镜详细分析】/i,
    /\n\s*#+\s*全局设定/i,
    /\n\s*全局设定\s*[:：]/i,
    /\n\s*\[全局设定\]/i,
    /\n\s*Global\s+Settings\s*[:：]?/i,
    /\n\s*Detailed\s+Analysis\s*[:：]?/i,
    /\n\s*Shot[- ]by[- ]Shot\s+Analysis\s*[:：]?/i,
    /\n\s*逐分镜详细分析\s*[:：]?/i,
  ];

  let end = rest.length;
  for (const pattern of endPatterns) {
    const match = pattern.exec(rest);
    if (match && match.index < end) end = match.index;
  }
  return rest.slice(0, end).trim();
}

function cleanSkeletonLine(line) {
  return String(line || '')
    .replace(/^\s*```(?:\w+)?\s*$/, '')
    .replace(/^\s*(?:[-*]\s*)?(?:\d+|[一二三四五六七八九十百]+)\s*[\.\、\)\]）:：]\s*/, '')
    .replace(/^\s*(?:[-*]\s*)?分镜\s*(?:\d+|[一二三四五六七八九十百]+)\s*[\.\、\)\]）:：]?\s*/i, '')
    .trim();
}

function cleanSkeleton(section) {
  return section
    .split(/\r?\n/)
    .map(cleanSkeletonLine)
    .filter(line => line && !/^```/.test(line))
    .join('\n')
    .trim();
}

function latestAssistantForVideo(videoId) {
  return db.prepare(`
    SELECT c.content, t.id AS task_id
    FROM import_tasks t
    JOIN import_conversations c ON c.task_id = t.id
    WHERE t.source_video_id = ?
      AND t.analysis_status = 'ready'
      AND c.role = 'assistant'
    ORDER BY t.updated_at DESC, t.id DESC, c.id DESC
    LIMIT 1
  `).get(videoId);
}

function main() {
  const videos = db.prepare(`
    SELECT id, name
    FROM videos
    WHERE COALESCE(TRIM(story_structure), '') = ''
    ORDER BY id
  `).all();

  let filled = 0;
  let skippedNoAi = 0;
  let skippedNoSkeleton = 0;
  const missing = [];

  const update = db.prepare(`
    UPDATE videos
    SET story_structure = ?, updated_at = ?
    WHERE id = ? AND COALESCE(TRIM(story_structure), '') = ''
  `);

  const tx = db.transaction(() => {
    for (const video of videos) {
      const ai = latestAssistantForVideo(video.id);
      if (!ai) {
        skippedNoAi++;
        missing.push({ id: video.id, name: video.name, reason: '没有可用的 Gemini 回复' });
        continue;
      }

      const section = findStorySkeletonSection(ai.content);
      const cleaned = cleanSkeleton(section);
      if (!cleaned) {
        skippedNoSkeleton++;
        missing.push({ id: video.id, name: video.name, taskId: ai.task_id, reason: '没找到故事骨架' });
        continue;
      }

      const result = update.run(cleaned, nowSql(), video.id);
      if (result.changes > 0) filled++;
    }
  });
  tx();

  const reportPath = path.join(ROOT, 'scripts_tool', 'fill_story_structure_report.json');
  fs.writeFileSync(reportPath, JSON.stringify({ filled, skippedNoAi, skippedNoSkeleton, missing }, null, 2), 'utf8');

  console.log(JSON.stringify({ filled, skippedNoAi, skippedNoSkeleton, reportPath }, null, 2));
}

main();
