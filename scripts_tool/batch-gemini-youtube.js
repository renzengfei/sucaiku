#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const API_BASE = process.env.MATERIAL_API_BASE || 'http://localhost:3456';
const CONCURRENCY = Number(process.env.BATCH_GEMINI_CONCURRENCY || process.argv.find(a => a.startsWith('--concurrency='))?.split('=')[1] || 10);
const LIMIT = Number(process.argv.find(a => a.startsWith('--limit='))?.split('=')[1] || 0);
const POLL_MS = Number(process.env.BATCH_GEMINI_POLL_MS || 5000);
const TASK_TIMEOUT_MS = Number(process.env.BATCH_GEMINI_TASK_TIMEOUT_MS || 45 * 60 * 1000);
const FORCE = process.argv.includes('--force');
const ROOT = path.join(__dirname, '..');
const LOG_DIR = path.join(ROOT, 'logs');
const RUN_ID = new Date().toISOString().replace(/[:.]/g, '-');
const STATE_PATH = path.join(LOG_DIR, 'batch-gemini-youtube-state.json');
const LOG_PATH = path.join(LOG_DIR, `batch-gemini-youtube-${RUN_ID}.jsonl`);

if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function log(event, data = {}) {
  const row = { ts: new Date().toISOString(), event, ...data };
  fs.appendFileSync(LOG_PATH, JSON.stringify(row, null, 0) + '\n');
  const details = data.videoId ? ` video=${data.videoId}` : data.taskId ? ` task=${data.taskId}` : '';
  console.log(`[${row.ts}] ${event}${details}${data.message ? ` - ${data.message}` : ''}`);
}

async function api(pathname, options = {}) {
  const res = await fetch(`${API_BASE}${pathname}`, {
    ...options,
    headers: {
      'Content-Type': 'application/json',
      ...(options.headers || {}),
    },
  });
  const text = await res.text();
  let body = null;
  if (text) {
    try { body = JSON.parse(text); } catch (e) { body = { raw: text }; }
  }
  if (!res.ok) {
    throw new Error(body?.error || body?.message || text || `HTTP ${res.status}`);
  }
  return body;
}

function loadState() {
  if (!fs.existsSync(STATE_PATH)) return { completed: {}, failed: {}, skipped: {} };
  try { return JSON.parse(fs.readFileSync(STATE_PATH, 'utf8')); }
  catch (e) { return { completed: {}, failed: {}, skipped: {} }; }
}

function saveState(state) {
  fs.writeFileSync(STATE_PATH, JSON.stringify(state, null, 2));
}

function cleanName(name) {
  return String(name || '').trim() || '未命名视频';
}

async function ensureTask(video) {
  const result = await api(`/api/videos/${video.id}/rewrite-script`, {
    method: 'POST',
    body: JSON.stringify({ trigger: false }),
  });
  if (!result?.taskId) throw new Error('未返回 taskId');
  return result.taskId;
}

async function restartAnalysis(taskId) {
  await api(`/api/import/tasks/${taskId}/restart-analysis`, {
    method: 'POST',
    body: JSON.stringify({ useTranscript: true }),
  });
}

async function sendRepairMessage(taskId, problems) {
  const repairPrompt = [
    '上一版输出不符合脚本文档规范，请基于同一个视频与字幕，重新输出一份完整脚本文档。',
    '只输出最终文档正文，不要解释，不要输出修改说明。',
    '',
    '必须满足：',
    '1. 开头必须包含 `## 【视频元数据】`。',
    '2. 必须包含 `## 【故事骨架】`、`## 【全局设定】`、`## 【逐分镜详细分析】`。',
    '3. 每个分镜必须包含：画面、构图、人物、表演、声音、镜头、叙事。',
    '4. 最后一行必须是 `建议视频名：xxx`。',
    '5. 不得出现乱码字符 `�`。',
    '6. 声音/台词必须优先使用我提供的 Whisper 字幕原文。',
    '',
    `本次需要修复的问题：${problems.join('；')}`,
  ].join('\n');

  await api(`/api/import/tasks/${taskId}/chat`, {
    method: 'POST',
    body: JSON.stringify({ message: repairPrompt }),
  });
}

async function waitForAnalysis(taskId) {
  const startedAt = Date.now();
  while (true) {
    const task = await api(`/api/import/tasks/${taskId}`);
    if (task.analysis_status === 'ready') return task;
    if (task.analysis_status === 'failed') {
      throw new Error(task.analysis_error || 'Gemini 分析失败');
    }
    if (Date.now() - startedAt > TASK_TIMEOUT_MS) {
      throw new Error(`等待超时，最后状态: ${task.analysis_status || 'unknown'}`);
    }
    await sleep(POLL_MS);
  }
}

function latestAssistantContent(task) {
  const turns = (task.conversations || []).filter(c => c.role === 'assistant');
  return turns.length ? turns[turns.length - 1].content || '' : '';
}

function validateDocument(content) {
  const checks = [
    ['缺少视频元数据章节', content.includes('## 【视频元数据】')],
    ['缺少故事骨架章节', content.includes('## 【故事骨架】')],
    ['缺少全局设定章节', content.includes('## 【全局设定】')],
    ['缺少逐分镜详细分析章节', content.includes('## 【逐分镜详细分析】')],
    ['缺少建议视频名', /建议视频名[:：]\s*\S+/.test(content)],
    ['包含乱码字符', !content.includes('�')],
  ];
  return checks.filter(([, ok]) => !ok).map(([name]) => name);
}

async function ensureValidDocument(taskId, task) {
  let current = task;
  for (let attempt = 1; attempt <= 2; attempt++) {
    const content = latestAssistantContent(current);
    const problems = validateDocument(content);
    if (problems.length === 0) return current;
    if (attempt === 2) {
      throw new Error(`文档校验失败: ${problems.join('；')}`);
    }
    log('repair-started', { taskId, message: problems.join('；') });
    await sendRepairMessage(taskId, problems);
    current = await waitForAnalysis(taskId);
  }
  return current;
}

async function processVideo(video, state) {
  const videoId = String(video.id);
  const taskId = await ensureTask(video);
  log('task-ready', { videoId: video.id, taskId, message: cleanName(video.name) });

  await restartAnalysis(taskId);
  log('analysis-started', { videoId: video.id, taskId });

  const task = await waitForAnalysis(taskId);
  const validTask = await ensureValidDocument(taskId, task);
  const assistantTurns = (validTask.conversations || []).filter(c => c.role === 'assistant').length;
  if (assistantTurns === 0) throw new Error('分析 ready 但没有 assistant 回复');

  const latest = await api(`/api/videos/${video.id}/ai-script`);
  state.completed[videoId] = {
    taskId,
    name: video.name,
    scriptSource: 'import_conversations.latest_assistant',
    scriptBytes: latest.latestScript ? latest.latestScript.length : 0,
    completedAt: new Date().toISOString(),
  };
  delete state.failed[videoId];
  saveState(state);
  log('completed', { videoId: video.id, taskId, message: 'latest assistant reply stored in database' });
}

async function worker(workerId, queue, state) {
  while (queue.length > 0) {
    const video = queue.shift();
    const videoId = String(video.id);
    if (!FORCE && state.completed[videoId]) {
      log('skip-completed', { videoId: video.id, message: state.completed[videoId].scriptSource || 'database' });
      continue;
    }
    if (!video.video_link) {
      state.skipped[videoId] = { name: video.name, reason: '缺少 YouTube 链接' };
      saveState(state);
      log('skip-no-link', { videoId: video.id, message: video.name });
      continue;
    }

    try {
      log('worker-start', { videoId: video.id, message: `worker=${workerId} ${cleanName(video.name)}` });
      await processVideo(video, state);
    } catch (err) {
      state.failed[videoId] = {
        name: video.name,
        error: err.message,
        failedAt: new Date().toISOString(),
      };
      saveState(state);
      log('failed', { videoId: video.id, message: err.message });
    }
  }
}

async function main() {
  const videos = await api('/api/videos');
  const selected = videos
    .filter(v => v.video_link)
    .sort((a, b) => Number(a.id) - Number(b.id));
  const state = loadState();
  const queue = process.argv.includes('--retry-failed')
    ? selected.filter(v => state.failed[String(v.id)])
    : selected.slice(0, LIMIT > 0 ? LIMIT : selected.length);

  log('batch-start', {
    message: `videos=${queue.length}, concurrency=${CONCURRENCY}, state=${STATE_PATH}, log=${LOG_PATH}`,
  });

  const workers = [];
  for (let i = 0; i < Math.max(1, CONCURRENCY); i++) {
    workers.push(worker(i + 1, queue, state));
  }
  await Promise.all(workers);

  const finalState = loadState();
  const summary = {
    completed: Object.keys(finalState.completed || {}).length,
    failed: Object.keys(finalState.failed || {}).length,
    skipped: Object.keys(finalState.skipped || {}).length,
  };
  log('batch-finished', { message: JSON.stringify(summary) });
  console.log(JSON.stringify(summary, null, 2));
}

main().catch(err => {
  log('fatal', { message: err.stack || err.message });
  process.exit(1);
});
