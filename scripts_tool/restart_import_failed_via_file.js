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
const WHISPER_PYTHON = process.env.WHISPER_PYTHON || path.join(ROOT, 'scripts_tool/whisper_venv/bin/python');
const WHISPER_SCRIPT = path.join(ROOT, 'scripts_tool/transcribe.py');
const WHISPER_MODEL = process.env.WHISPER_MODEL || 'large-v3-turbo';
const THINKING_LEVEL = process.env.GEMINI_THINKING_LEVEL || 'high';
const INCLUDE_THOUGHTS = process.env.GEMINI_INCLUDE_THOUGHTS !== 'false';
const PROMPT_PATH = path.join(ROOT, '提示词', '视频反推提示词.md');
const TRANSCRIPT_DIR = path.join(ROOT, 'transcripts');
const RAW_DIR = path.join(ROOT, '.tmp-downloads', 'gemini-file-restarts');

const DEFAULT_TASK_IDS = [131, 133, 27, 126];
const REQUEST_SPACING_MS = 75 * 1000;

if (!GEMINI_API_KEY) {
  console.error('缺少 GEMINI_API_KEY');
  process.exit(1);
}

fs.mkdirSync(TRANSCRIPT_DIR, { recursive: true });
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
        resolve({ status: res.statusCode, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => req.destroy(new Error('request timeout')));
    if (body) req.write(body);
    req.end();
  });
}

function cleanPrompt(text) {
  return text.replace(/^\s*```(?:\w+)?\s*\n/, '').replace(/\n```\s*$/, '\n').trim();
}

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

function formatTranscriptForPrompt(transcript) {
  if (!transcript || !transcript.segments || transcript.segments.length === 0) return '';
  const lines = [
    '【上游提供的字幕（Whisper 自动转写，带时间戳）】',
    '🔴 这些字幕只是辅助参考，不是绝对真相；请结合视频音轨、画面、口型、语境一起判断。',
    '🔴 先按时间戳定位台词，再按实际说话的分镜落位；禁止把一句台词挪到相邻分镜。',
    '🔴 如果一条字幕跨越多个剪切点，只把它放到真正说出这句台词的那个分镜；实在无法确认时，明确标注“未确认说话人”或“画外音”，不要硬猜。',
    '🔴 只要某个分镜里有人说话，该分镜在【故事骨架】和【逐分镜详细分析】里都要保留对应台词（双引号包起）。',
    '',
  ];
  for (const s of transcript.segments) {
    lines.push(`${fmtWhisperTs(s.start)}-${fmtWhisperTs(s.end)}: "${s.text}"`);
  }
  return lines.join('\n');
}

function runWhisper(localVideoPath) {
  return new Promise((resolve, reject) => {
    const proc = spawn(WHISPER_PYTHON, [WHISPER_SCRIPT, localVideoPath, WHISPER_MODEL], {
      env: { ...process.env, HF_ENDPOINT: process.env.HF_ENDPOINT || 'https://hf-mirror.com' },
    });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', d => { stdout += d.toString(); });
    proc.stderr.on('data', d => { stderr += d.toString(); });
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`whisper 退出码 ${code}: ${stderr.slice(-300)}`));
      try {
        const data = JSON.parse(stdout);
        if (data.error) return reject(new Error(data.error));
        resolve(data);
      } catch (e) {
        reject(new Error('whisper 非 JSON: ' + stdout.slice(0, 200)));
      }
    });
    proc.on('error', reject);
  });
}

async function ensureTranscript(task) {
  const keys = [];
  if (task.youtube_video_id) keys.push(`yt-${task.youtube_video_id}`);
  if (task.source_video_id) keys.push(String(task.source_video_id));

  for (const key of keys) {
    const jsonPath = path.join(TRANSCRIPT_DIR, `${key}.json`);
    if (fs.existsSync(jsonPath)) {
      const cached = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
      const textPath = path.join(TRANSCRIPT_DIR, `${key}.txt`);
      if (!fs.existsSync(textPath)) fs.writeFileSync(textPath, formatTranscriptCacheText(cached), 'utf8');
      return formatTranscriptForPrompt(cached);
    }
  }

  if (!task.local_file_path || !fs.existsSync(task.local_file_path)) return '';

  console.log(`  🎤 Whisper 转字幕 #${task.source_video_id} (${WHISPER_MODEL})`);
  db.prepare(`UPDATE import_tasks SET transcript_status = 'transcribing', transcript_error = '', updated_at = ? WHERE id = ?`)
    .run(nowSql(), task.task_id);
  const transcript = await runWhisper(task.local_file_path);
  const key = task.youtube_video_id ? `yt-${task.youtube_video_id}` : String(task.source_video_id || task.task_id);
  fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${key}.json`), JSON.stringify(transcript, null, 2), 'utf8');
  fs.writeFileSync(path.join(TRANSCRIPT_DIR, `${key}.txt`), formatTranscriptCacheText(transcript), 'utf8');
  db.prepare(`UPDATE import_tasks SET transcript_status = ?, transcript_error = '', updated_at = ? WHERE id = ?`)
    .run(transcript.segments?.length ? 'ready' : 'skipped', nowSql(), task.task_id);
  return formatTranscriptForPrompt(transcript);
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
    if (json.state && json.state !== 'PROCESSING') throw new Error(`文件状态异常: ${json.state}`);
    await delay(5000);
  }
  throw new Error('等待视频文件转 ACTIVE 超时');
}

function isRetryableGenerateError(err) {
  const msg = String(err && err.message || '');
  return /503|high demand|UNAVAILABLE|quota|rate-limits|ResourceExhausted|exceeded/i.test(msg);
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
        throw new Error(`Gemini 调用失败: ${gen.status} ${gen.body.toString().slice(0, 500)}`);
      }
      return gen;
    } catch (err) {
      lastErr = err;
      if (!isRetryableGenerateError(err) || attempt === maxAttempts) throw err;
      const waitMs = attempt * 90 * 1000;
      console.log(`  ⏳ #${task.source_video_id} 官方接口限流/繁忙，${waitMs / 1000}s 后重试 (${attempt}/${maxAttempts})`);
      await delay(waitMs);
    }
  }
  throw lastErr || new Error('Gemini 重试失败');
}

function buildFirstTurnText(transcriptText) {
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

function extractSuggestedName(output, fallback) {
  const m = output.match(/建议视频名[:：]\s*([^\n]+)/);
  return m ? m[1].trim().replace(/^["']|["']$/g, '') : fallback;
}

function validateOutput(output, finishReason) {
  return finishReason === 'STOP'
    && output.includes('```')
    && output.includes('【故事骨架】')
    && output.includes('【全局设定】')
    && output.includes('【逐分镜详细分析】')
    && /建议视频名[:：]\s*\S+/.test(output);
}

function parseTaskIds() {
  const arg = process.argv.find(v => v.startsWith('--task-ids='));
  if (!arg) return DEFAULT_TASK_IDS;
  return arg.slice('--task-ids='.length).split(',').map(v => Number(v.trim())).filter(Boolean);
}

function loadTasks(taskIds) {
  const placeholders = taskIds.map(() => '?').join(',');
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
    WHERE t.id IN (${placeholders})
    ORDER BY t.id
  `).all(...taskIds);
}

async function processTask(task, promptText) {
  console.log(`\n▶️ 任务 #${task.task_id} / 视频 #${task.source_video_id} ${task.video_name || task.title}`);
  if (!task.local_file_path || !fs.existsSync(task.local_file_path) || fs.statSync(task.local_file_path).size < 1024) {
    throw new Error('缺少本地视频文件，不能走文件上传');
  }

  db.prepare(`UPDATE import_tasks SET analysis_status = 'analyzing', analysis_error = '', updated_at = ? WHERE id = ?`)
    .run(nowSql(), task.task_id);

  const transcriptText = await ensureTranscript(task);
  console.log(`  ⬆️ 上传视频文件 ${path.basename(task.local_file_path)} (${(fs.statSync(task.local_file_path).size / 1024 / 1024).toFixed(1)}MB)`);
  const uploaded = await uploadFile(task.local_file_path, `import-${task.source_video_id}-${task.youtube_video_id || task.task_id}`);
  const activeFile = await waitUntilActive(uploaded.name);

  const requestBody = {
    systemInstruction: { parts: [{ text: promptText }] },
    contents: [{
      role: 'user',
      parts: [
        { file_data: { file_uri: activeFile.uri, mime_type: 'video/mp4' }, video_metadata: { fps: 10 } },
        { text: buildFirstTurnText(transcriptText) },
      ],
    }],
    generationConfig: {
      mediaResolution: 'MEDIA_RESOLUTION_HIGH',
      temperature: 0.2,
      thinkingConfig: {
        thinkingLevel: THINKING_LEVEL,
        includeThoughts: INCLUDE_THOUGHTS,
      },
    },
  };

  const gen = await generateWithRetries(requestBody, task);
  const rawPath = path.join(RAW_DIR, `import-${task.task_id}-video-${task.source_video_id}.json`);
  fs.writeFileSync(rawPath, gen.body);

  const json = JSON.parse(gen.body.toString());
  const candidate = json.candidates?.[0] || {};
  const parts = candidate.content?.parts || [];
  let output = '';
  let thoughts = '';
  for (const p of parts) {
    if (!p.text) continue;
    if (p.thought) thoughts += p.text;
    else output += p.text;
  }
  if (!output.trim()) throw new Error('Gemini 返回为空');

  const usage = json.usageMetadata || {};
  console.log(`  finish=${candidate.finishReason || 'unknown'} output=${usage.candidatesTokenCount ?? '?'} thoughts=${usage.thoughtsTokenCount ?? '?'}`);
  if (thoughts) console.log(`  💭 思考摘要 ${thoughts.length} 字`);
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
          updated_at = ?
      WHERE id = ?
    `).run(suggestedName, nowSql(), task.task_id);
  });
  tx();
}

async function main() {
  const taskIds = parseTaskIds();
  const promptText = cleanPrompt(fs.readFileSync(PROMPT_PATH, 'utf8'));
  const tasks = loadTasks(taskIds);
  console.log(`准备文件上传重跑：${tasks.length} 条 (${tasks.map(t => `#${t.source_video_id}`).join(', ')})`);

  let success = 0;
  let failed = 0;
  for (const task of tasks) {
    try {
      await processTask(task, promptText);
      success++;
      console.log(`  ✅ 完成 #${task.source_video_id}`);
    } catch (err) {
      failed++;
      console.error(`  ❌ 失败 #${task.source_video_id}: ${err.message}`);
      db.prepare(`UPDATE import_tasks SET analysis_status = 'failed', analysis_error = ?, updated_at = ? WHERE id = ?`)
        .run(err.message, nowSql(), task.task_id);
    }
    if (task !== tasks[tasks.length - 1]) {
      console.log(`  🕒 等 ${REQUEST_SPACING_MS / 1000}s，避开官方限流`);
      await delay(REQUEST_SPACING_MS);
    }
  }

  console.log(`\n完成：成功 ${success}，失败 ${failed}`);
}

main().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
