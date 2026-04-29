#!/usr/bin/env node
// 用 inline_data 方式重试失败任务：下载视频 → base64 内嵌 → 送 Gemini
const fs = require('fs');
const path = require('path');
const https = require('https');
const { execSync } = require('child_process');
const Database = require('better-sqlite3');

require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const DB_PATH = path.join(__dirname, '..', 'database.db');
const PROMPT_PATH = path.join(__dirname, '..', '提示词', '视频反推提示词.md');
const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
const GEMINI_URL = `https://yunwu.ai/v1beta/models/${GEMINI_MODEL}:generateContent`;
const YTDLP_COOKIES = process.env.YTDLP_COOKIES_FROM_BROWSER || 'chrome';

const TEMP_DIR = '/tmp/gemini-rewrite';
if (!fs.existsSync(TEMP_DIR)) fs.mkdirSync(TEMP_DIR, { recursive: true });

const db = new Database(DB_PATH);

function downloadFromOSS(url, outPath) {
  execSync(`curl -sL --fail --retry 6 --retry-delay 10 --retry-all-errors --max-time 300 --connect-timeout 30 -o "${outPath}" "${url}"`, { stdio: 'inherit' });
}

function downloadFromYoutube(link, outPath) {
  const args = [
    '-f', 'bestvideo[height<=720]+bestaudio/best[height<=720]/best',
    '-o', outPath,
    '--merge-output-format', 'mp4',
    '--cookies-from-browser', YTDLP_COOKIES,
    '--no-warnings', '--quiet',
    link,
  ].map(a => `"${String(a).replace(/"/g, '\\"')}"`).join(' ');
  execSync(`yt-dlp ${args}`, { stdio: 'inherit' });
}

function callGemini(reqBody) {
  return new Promise((resolve, reject) => {
    const u = new URL(GEMINI_URL);
    const req = https.request({
      hostname: u.hostname, port: 443, path: u.pathname, method: 'POST',
      headers: { 'Authorization': `Bearer ${GEMINI_API_KEY}`, 'Content-Type': 'application/json' },
    }, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try {
          const j = JSON.parse(data);
          if (j.error) reject(new Error(j.error.message || JSON.stringify(j.error)));
          else resolve(j);
        } catch (e) { reject(new Error('非JSON响应: ' + data.slice(0, 300))); }
      });
    });
    req.setTimeout(10 * 60 * 1000, () => req.destroy(new Error('请求超时')));
    req.on('error', reject);
    req.write(JSON.stringify(reqBody));
    req.end();
  });
}

async function processTask(taskId) {
  const task = db.prepare('SELECT * FROM import_tasks WHERE id = ?').get(taskId);
  if (!task) throw new Error('task 不存在');
  const video = task.source_video_id
    ? db.prepare('SELECT * FROM videos WHERE id = ?').get(task.source_video_id)
    : null;

  const localPath = path.join(TEMP_DIR, `${task.id}.mp4`);
  if (fs.existsSync(localPath)) fs.unlinkSync(localPath);

  // 下载：优先 OSS，否则 yt-dlp
  const ossUrl = video?.video_path;
  const ytLink = video?.video_link || task.video_url;
  if (ossUrl) {
    console.log(`  [${task.id}] 从 OSS 下载: ${ossUrl}`);
    downloadFromOSS(ossUrl, localPath);
  } else if (ytLink) {
    console.log(`  [${task.id}] 从 YouTube 下载: ${ytLink}`);
    downloadFromYoutube(ytLink, localPath);
  } else {
    throw new Error('既无 OSS 也无 YouTube 链接');
  }

  const stat = fs.statSync(localPath);
  const sizeMB = (stat.size / 1024 / 1024).toFixed(1);
  console.log(`  [${task.id}] 下载完成 ${sizeMB} MB`);

  // Base64
  const b64 = fs.readFileSync(localPath).toString('base64');

  // 构造请求
  const systemText = fs.readFileSync(PROMPT_PATH, 'utf8');
  const meta = video || task;
  const metaLines = [
    '【我提供的视频元数据（请原样照抄到【视频元数据】段，禁止编造）】',
    `视频标题：${video?.video_title || video?.name || task.title || '未知'}`,
    `视频链接：${ytLink || '未知'}`,
    `发布日期：${video?.publish_date || task.publish_date || '未知'}`,
    `视频时长：${video?.duration || (task.duration_seconds ? task.duration_seconds + '秒' : '未知')}`,
    `播放量：${video?.views || task.views || '未知'}`,
    `点赞量：${video?.likes || task.likes || '未知'}`,
    `频道：${task.channel_title || '未知'}`,
  ].join('\n');

  const reqBody = {
    systemInstruction: { parts: [{ text: systemText }] },
    contents: [{
      role: 'user',
      parts: [
        { inline_data: { mime_type: 'video/mp4', data: b64 }, video_metadata: { fps: 10 } },
        { text: metaLines + '\n\n请按照系统指令对这条视频进行专业级影视拆解。' },
      ],
    }],
    generationConfig: {
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
      temperature: 0.2,
      thinkingConfig: { thinkingLevel: 'high', includeThoughts: true },
    },
  };

  const reqSize = JSON.stringify(reqBody).length;
  console.log(`  [${task.id}] 请求体 ${(reqSize / 1024 / 1024).toFixed(1)} MB，调用 Gemini...`);

  const t0 = Date.now();
  const result = await callGemini(reqBody);
  const elapsed = ((Date.now() - t0) / 1000).toFixed(1);

  const parts = result.candidates?.[0]?.content?.parts || [];
  let output = '', thoughts = '';
  for (const p of parts) {
    if (!p.text) continue;
    if (p.thought) thoughts += p.text;
    else output += p.text;
  }
  if (!output) throw new Error('Gemini 返回为空');

  // 清旧对话 + 写新对话
  db.prepare('DELETE FROM import_conversations WHERE task_id = ?').run(task.id);
  db.prepare('INSERT INTO import_conversations (task_id, role, content) VALUES (?, ?, ?)')
    .run(task.id, 'assistant', output);

  const nameMatch = output.match(/建议视频名[:：]\s*([^\n]+)/);
  const suggestedName = nameMatch ? nameMatch[1].trim().replace(/^["']|["']$/g, '') : '';
  db.prepare("UPDATE import_tasks SET analysis_status='ready', analysis_error='', suggested_name=? WHERE id=?")
    .run(suggestedName, task.id);

  console.log(`  [${task.id}] ✅ 完成（${elapsed}s，输出 ${output.length} 字）`);
  try { fs.unlinkSync(localPath); } catch (e) {}
}

async function main() {
  let taskIds;
  if (process.argv[2] === '--all-failed') {
    taskIds = db.prepare(`SELECT id FROM import_tasks WHERE source_video_id IS NOT NULL AND analysis_status='failed' ORDER BY id`).all().map(r => r.id);
  } else {
    taskIds = process.argv.slice(2).map(Number).filter(Boolean);
  }
  if (taskIds.length === 0) {
    console.log('用法: node retry-via-inline.js --all-failed');
    console.log('      node retry-via-inline.js 157 170 180');
    process.exit(1);
  }

  console.log(`处理 ${taskIds.length} 个任务：${taskIds.join(', ')}\n`);

  let ok = 0, fail = 0;
  for (const id of taskIds) {
    try {
      await processTask(id);
      ok++;
    } catch (e) {
      fail++;
      console.error(`  [${id}] ❌ ${e.message}`);
      db.prepare("UPDATE import_tasks SET analysis_error=? WHERE id=?").run('[inline] ' + e.message.slice(0, 300), id);
    }
    console.log('');
  }
  console.log(`\n总计：成功 ${ok}，失败 ${fail}`);
  db.close();
}

main();
