#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const https = require('https');
const { spawn } = require('child_process');
const Database = require('better-sqlite3');
require('dotenv').config({ path: path.join(__dirname, '..', '.env') });

const ROOT = path.join(__dirname, '..');
const db = new Database(path.join(ROOT, 'database.db'));

const GEMINI_API_KEY = process.env.GEMINI_API_KEY;
const GEMINI_MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-preview';
const PROMPT_PATH = path.join(ROOT, '提示词', '视频反推提示词.md');
const TRANSCRIPT_DIR = path.join(ROOT, 'transcripts');
const VIDEO_CACHE_DIR = path.join(ROOT, '.tmp-downloads', 'gemini-rewrite');
const RAW_DIR = path.join(ROOT, '.tmp-downloads', 'gemini-file-restarts');

if (!GEMINI_API_KEY) {
  console.error('缺少 GEMINI_API_KEY');
  process.exit(1);
}

fs.mkdirSync(VIDEO_CACHE_DIR, { recursive: true });
fs.mkdirSync(RAW_DIR, { recursive: true });

function nowSql() {
  return new Date().toISOString().replace('T', ' ').slice(0, 19);
}

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function request(method, url, headers = {}, body = null, timeoutMs = 20 * 60 * 1000) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const req = https.request({
      method,
      hostname: u.hostname,
      port: 443,
      path: u.pathname + u.search,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', chunk => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode,
          headers: res.headers,
          body: Buffer.concat(chunks),
        });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function isRetryableGeminiBusy(err) {
  const msg = String(err && err.message || '');
  return /503|high demand|UNAVAILABLE|currently experiencing high demand/i.test(msg);
}

function cleanPrompt(text) {
  return text.replace(/^\s*```(?:\w+)?\s*\n/, '').replace(/\n```\s*$/, '\n').trim();
}

function readPrompt() {
  return cleanPrompt(fs.readFileSync(PROMPT_PATH, 'utf8'));
}

function readTranscript(task) {
  const candidates = [];
  if (task.source_video_id) {
    candidates.push(path.join(TRANSCRIPT_DIR, `${task.source_video_id}.txt`));
  }
  if (task.youtube_video_id) {
    candidates.push(path.join(TRANSCRIPT_DIR, `yt-${task.youtube_video_id}.txt`));
  }
  for (const p of candidates) {
    if (fs.existsSync(p)) {
      const text = fs.readFileSync(p, 'utf8').trim();
      if (text) return text;
    }
  }
  return '';
}

function curlDownload(url, outputPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn('curl', [
      '-sL', '--fail',
      '--retry', '6', '--retry-delay', '10', '--retry-all-errors',
      '--max-time', '600', '--connect-timeout', '30',
      '-o', outputPath, url,
    ]);
    let stderr = '';
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', code => {
      if (code === 0) resolve();
      else reject(new Error(`curl 退出码 ${code}: ${stderr.slice(-300)}`));
    });
    proc.on('error', reject);
  });
}

async function ensureLocalVideo(task) {
  if (task.local_file_path && fs.existsSync(task.local_file_path) && fs.statSync(task.local_file_path).size > 1024) {
    return task.local_file_path;
  }
  const localPath = path.join(VIDEO_CACHE_DIR, `v${task.source_video_id}.mp4`);
  if (fs.existsSync(localPath) && fs.statSync(localPath).size > 1024) {
    return localPath;
  }
  if (!task.video_path) {
    throw new Error('缺少视频地址，无法下载视频文件');
  }
  console.log(`  📥 下载视频 #${task.source_video_id}: ${task.video_name}`);
  await curlDownload(task.video_path, localPath);
  return localPath;
}

async function uploadFile(localVideoPath, displayName) {
  const bytes = fs.statSync(localVideoPath).size;
  const start = await request('POST', 'https://generativelanguage.googleapis.com/upload/v1beta/files', {
    'x-goog-api-key': GEMINI_API_KEY,
    'X-Goog-Upload-Protocol': 'resumable',
    'X-Goog-Upload-Command': 'start',
    'X-Goog-Upload-Header-Content-Length': String(bytes),
    'X-Goog-Upload-Header-Content-Type': 'video/mp4',
    'Content-Type': 'application/json',
  }, Buffer.from(JSON.stringify({ file: { display_name: displayName } })));
  if (start.status < 200 || start.status >= 300) {
    throw new Error(`启动上传失败: ${start.status} ${start.body.toString().slice(0, 300)}`);
  }
  const uploadUrl = start.headers['x-goog-upload-url'];
  if (!uploadUrl) throw new Error('缺少上传地址');
  const video = fs.readFileSync(localVideoPath);
  const up = await request('POST', uploadUrl, {
    'Content-Length': String(bytes),
    'X-Goog-Upload-Offset': '0',
    'X-Goog-Upload-Command': 'upload, finalize',
  }, video);
  if (up.status < 200 || up.status >= 300) {
    throw new Error(`上传视频失败: ${up.status} ${up.body.toString().slice(0, 300)}`);
  }
  return JSON.parse(up.body.toString()).file;
}

async function waitUntilActive(fileName) {
  for (let i = 1; i <= 60; i++) {
    const res = await request('GET', `https://generativelanguage.googleapis.com/v1beta/${fileName}?key=${encodeURIComponent(GEMINI_API_KEY)}`);
    if (res.status < 200 || res.status >= 300) {
      throw new Error(`查询文件状态失败: ${res.status} ${res.body.toString().slice(0, 300)}`);
    }
    const json = JSON.parse(res.body.toString());
    if (json.state === 'ACTIVE') return json;
    if (json.state && json.state !== 'PROCESSING') {
      throw new Error(`文件状态异常: ${json.state}`);
    }
    await delay(5000);
  }
  throw new Error('等待视频文件转 ACTIVE 超时');
}

async function generateWithRetries(requestBody, task, maxAttempts = 3) {
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const gen = await request('POST', `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`, {
        'x-goog-api-key': GEMINI_API_KEY,
        'Content-Type': 'application/json',
      }, Buffer.from(JSON.stringify(requestBody)));
      if (gen.status < 200 || gen.status >= 300) {
        throw new Error(`Gemini 调用失败: ${gen.status} ${gen.body.toString().slice(0, 400)}`);
      }
      return gen;
    } catch (err) {
      lastErr = err;
      if (!isRetryableGeminiBusy(err) || attempt === maxAttempts) {
        throw err;
      }
      const waitMs = attempt * 45 * 1000;
      console.log(`  ⏳ #${task.source_video_id} Gemini 忙，${waitMs / 1000}s 后重试 (${attempt}/${maxAttempts})`);
      await delay(waitMs);
    }
  }
  throw lastErr || new Error('Gemini 重试失败');
}

function buildFirstTurnText(task, transcriptText) {
  const blocks = [];
  if (transcriptText) blocks.push(transcriptText);
  blocks.push(
    '请按照系统指令对这条视频进行专业级影视拆解。特别注意：' +
    '1）有对白的分镜，在【故事骨架】对应行末尾必须带出原话；' +
    '2）台词先对时间戳，再对分镜，不能因为语义顺手就挪到前后镜头；' +
    '3）说话人不确定时不要硬猜。'
  );
  return blocks.join('\n\n');
}

function validateOutput(output, finishReason) {
  const hasSuggested = /建议视频名[:：]\s*\S+/.test(output);
  const hasCodeBlock = output.includes('```');
  return finishReason === 'STOP'
    && hasCodeBlock
    && output.includes('【故事骨架】')
    && output.includes('【全局设定】')
    && output.includes('【逐分镜详细分析】')
    && hasSuggested;
}

function extractSuggestedName(output, fallback) {
  const m = output.match(/建议视频名[:：]\s*([^\n]+)/);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : fallback;
}

function loadFailedTasks() {
  return db.prepare(`
    SELECT
      t.id AS task_id,
      t.source_video_id,
      t.youtube_video_id,
      t.title,
      t.video_url,
      t.views,
      t.likes,
      t.publish_date,
      t.duration_seconds,
      t.channel_title,
      t.local_file_path,
      t.suggested_name,
      v.name AS video_name,
      v.video_path
    FROM import_tasks t
    LEFT JOIN videos v ON v.id = t.source_video_id
    WHERE COALESCE(NULLIF(t.task_type, ''), 'library_analysis') = 'library_analysis'
      AND t.analysis_status = 'failed'
    ORDER BY t.source_video_id DESC
  `).all();
}

async function processTask(task, promptText) {
  console.log(`\n▶️ 任务 #${task.task_id} / 视频 #${task.source_video_id} ${task.video_name}`);
  db.prepare(`UPDATE import_tasks SET analysis_status = 'analyzing', analysis_error = '', updated_at = ? WHERE id = ?`)
    .run(nowSql(), task.task_id);

  const localVideoPath = await ensureLocalVideo(task);
  const transcriptText = readTranscript(task);
  const uploaded = await uploadFile(localVideoPath, `video-${task.source_video_id}-${task.youtube_video_id || 'local'}`);
  const activeFile = await waitUntilActive(uploaded.name);

  const requestBody = {
    systemInstruction: { parts: [{ text: promptText }] },
    contents: [{
      role: 'user',
      parts: [
        { file_data: { file_uri: activeFile.uri, mime_type: 'video/mp4' }, video_metadata: { fps: 10 } },
        { text: buildFirstTurnText(task, transcriptText) },
      ],
    }],
    generationConfig: {
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
      temperature: 0.2,
      thinkingConfig: {
        thinkingLevel: 'medium',
        includeThoughts: true,
      },
    },
  };

  const gen = await generateWithRetries(requestBody, task);
  const rawPath = path.join(RAW_DIR, `${task.source_video_id || task.task_id}.json`);
  fs.writeFileSync(rawPath, gen.body);

  const json = JSON.parse(gen.body.toString());
  const candidate = json.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  let output = '';
  for (const p of parts) {
    if (p.text && !p.thought) output += p.text;
  }
  if (!output.trim()) {
    throw new Error('Gemini 返回为空');
  }

  const usage = json.usageMetadata || {};
  console.log(`  finish=${candidate.finishReason || 'unknown'} output=${usage.candidatesTokenCount ?? '?'} thoughts=${usage.thoughtsTokenCount ?? '?'}`);

  if (!validateOutput(output, candidate.finishReason)) {
    throw new Error(`Gemini 输出未完整: ${candidate.finishReason || 'unknown'}`);
  }

  const suggestedName = extractSuggestedName(output, task.suggested_name || task.video_name || task.title);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM import_conversations WHERE task_id = ?').run(task.task_id);
    db.prepare('INSERT INTO import_conversations (task_id, role, content) VALUES (?, ?, ?)').run(task.task_id, 'assistant', output);
    db.prepare(`
      UPDATE import_tasks
      SET analysis_status = 'ready',
          analysis_error = '',
          suggested_name = ?,
          local_file_path = COALESCE(NULLIF(local_file_path, ''), ?),
          updated_at = ?
      WHERE id = ?
    `).run(suggestedName, localVideoPath, nowSql(), task.task_id);
  });
  tx();
}

async function main() {
  const tasks = loadFailedTasks();
  console.log(`当前失败分析：${tasks.length} 条`);
  const promptText = readPrompt();
  let success = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      await processTask(task, promptText);
      success++;
    } catch (err) {
      failed++;
      console.error(`  ❌ 失败 #${task.source_video_id}: ${err.message}`);
      db.prepare(`UPDATE import_tasks SET analysis_status = 'failed', analysis_error = ?, updated_at = ? WHERE id = ?`)
        .run(err.message, nowSql(), task.task_id);
    }
    await delay(15000);
  }

  console.log(`\n完成：成功 ${success}，失败 ${failed}`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
