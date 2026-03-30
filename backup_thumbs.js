#!/usr/bin/env node
/**
 * 缩略图批量下载脚本（本地版）
 * 用法：node backup_thumbs.js        - 下载所有缩略图
 *       node backup_thumbs.js <id>   - 下载指定视频的缩略图
 * 
 * 使用 curl 下载（走系统代理），保存到 public/thumbs/ 目录
 * 数据库 thumb_url 更新为本地路径 /thumbs/xxx.jpg
 */

const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

const API_BASE = 'http://localhost:3456/api';
const THUMB_DIR = path.join(__dirname, 'public', 'thumbs');

function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function apiUpdate(videoId, data) {
  const json = JSON.stringify(data).replace(/'/g, "'\\''");
  execSync(`curl -s -X PUT "${API_BASE}/videos/${videoId}" -H "Content-Type: application/json" -d '${json}'`, {
    stdio: 'pipe', timeout: 10000
  });
}

function apiGet(url) {
  const out = execSync(`curl -s "${url}"`, { encoding: 'utf-8', timeout: 10000 });
  return JSON.parse(out);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

function backupThumb(video) {
  const ytId = extractYouTubeId(video.video_link);
  if (!ytId) return 'skip';

  // 已经是本地路径则跳过
  if (video.thumb_url && video.thumb_url.startsWith('/thumbs/')) return 'skip';

  const paddedId = String(video.id).padStart(3, '0');
  const thumbFilename = `${paddedId}_${ytId}.jpg`;
  const thumbPath = path.join(THUMB_DIR, thumbFilename);

  // 已存在文件则只更新数据库
  if (fs.existsSync(thumbPath) && fs.statSync(thumbPath).size > 1024) {
    const localUrl = `/thumbs/${thumbFilename}`;
    apiUpdate(video.id, { thumb_url: localUrl });
    console.log(`⏭  ID=${video.id} | 已存在，更新路径`);
    return 'ok';
  }

  // 用 curl 下载（走系统代理）
  const ytUrl = `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg`;
  try {
    execSync(`curl -sL -o "${thumbPath}" --connect-timeout 10 --max-time 30 "${ytUrl}"`, {
      stdio: 'pipe', timeout: 35000
    });
  } catch (err) {
    // 尝试 hqdefault
    try {
      const ytUrl2 = `https://img.youtube.com/vi/${ytId}/hqdefault.jpg`;
      execSync(`curl -sL -o "${thumbPath}" --connect-timeout 10 --max-time 30 "${ytUrl2}"`, {
        stdio: 'pipe', timeout: 35000
      });
    } catch (err2) {
      console.error(`  ❌ ID=${video.id} | ${video.name}: 下载失败`);
      return 'fail';
    }
  }

  // 检查文件是否有效（至少 1KB）
  if (!fs.existsSync(thumbPath) || fs.statSync(thumbPath).size < 1024) {
    if (fs.existsSync(thumbPath)) fs.unlinkSync(thumbPath);
    console.error(`  ❌ ID=${video.id} | ${video.name}: 文件无效`);
    return 'fail';
  }

  // 更新数据库
  const localUrl = `/thumbs/${thumbFilename}`;
  apiUpdate(video.id, { thumb_url: localUrl });

  const sizeKB = (fs.statSync(thumbPath).size / 1024).toFixed(0);
  console.log(`✅ ID=${video.id} | ${video.name} (${sizeKB}KB)`);
  return 'ok';
}

async function main() {
  // 确保目录存在
  if (!fs.existsSync(THUMB_DIR)) fs.mkdirSync(THUMB_DIR, { recursive: true });

  const arg = process.argv[2];

  if (arg && !isNaN(arg)) {
    const video = apiGet(`${API_BASE}/videos/${arg}`);
    if (!video || !video.id) { console.error('视频不存在'); return; }
    backupThumb(video);
    return;
  }

  // 批量
  const videos = apiGet(`${API_BASE}/videos`);
  const pending = videos.filter(v => {
    if (!v.video_link) return false;
    if (v.thumb_url && v.thumb_url.startsWith('/thumbs/')) return false;
    return true;
  });

  if (pending.length === 0) {
    console.log('✅ 所有缩略图都已下载');
    return;
  }

  console.log(`🖼  共 ${pending.length} 个缩略图待下载\n`);

  let ok = 0, fail = 0, skip = 0;
  for (const v of pending) {
    const result = backupThumb(v);
    if (result === 'ok') ok++;
    else if (result === 'fail') fail++;
    else skip++;
    // 小延迟避免过快
    await sleep(200);
  }

  console.log(`\n📊 完成: ✅${ok} 成功, ❌${fail} 失败, ⏭${skip} 跳过`);
}

main().catch(console.error);

