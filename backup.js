#!/usr/bin/env node
/**
 * 视频备份脚本
 * 用法：node backup.js <video_id> | node backup.js --all
 * 
 * 功能：
 * 1. 通过 API 读取视频信息
 * 2. 用 yt-dlp 下载视频到临时目录
 * 3. 上传到阿里云 OSS
 * 4. 通过 API 更新数据库（video_path, thumb_url）
 * 5. 删除本地临时文件
 */

require('dotenv').config();
const OSS = require('ali-oss');
const { execSync } = require('child_process');
const path = require('path');
const fs = require('fs');

// ==================== 配置 ====================
const API_BASE = 'http://localhost:3456/api';
const tmpDir = path.join(__dirname, '.tmp-downloads');

const ossClient = new OSS({
  region: process.env.OSS_REGION,
  accessKeyId: process.env.OSS_ACCESS_KEY_ID,
  accessKeySecret: process.env.OSS_ACCESS_KEY_SECRET,
  bucket: process.env.OSS_BUCKET,
  timeout: 600000,  // 10 分钟超时
  secure: true,     // 使用 HTTPS
});

// ==================== 工具函数 ====================
function extractYouTubeId(url) {
  if (!url) return null;
  const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/);
  return m ? m[1] : null;
}

function getYouTubeThumbUrl(videoLink) {
  const ytId = extractYouTubeId(videoLink);
  return ytId ? `https://img.youtube.com/vi/${ytId}/maxresdefault.jpg` : '';
}

async function downloadThumb(ytThumbUrl, destPath) {
  const resp = await fetch(ytThumbUrl);
  if (!resp.ok) return false;
  const buffer = Buffer.from(await resp.arrayBuffer());
  fs.writeFileSync(destPath, buffer);
  return true;
}

async function apiFetch(url, options = {}) {
  const resp = await fetch(url, options);
  return resp.json();
}

// ==================== 主流程 ====================
async function backupVideo(videoId) {
  // 1. 通过 API 读取视频
  const video = await apiFetch(`${API_BASE}/videos/${videoId}`);
  if (!video || !video.id) {
    console.error(`❌ 视频 ID ${videoId} 不存在`);
    return false;
  }

  if (video.video_path) {
    console.log(`⏭  视频「${video.name}」已有备份`);
    return true;
  }

  if (!video.video_link) {
    console.error(`❌ 视频「${video.name}」没有视频链接`);
    return false;
  }

  const paddedId = String(video.id).padStart(3, '0');
  const safeName = video.name.replace(/[\/\\:*?"<>|]/g, '_');

  console.log(`🎬 开始备份: ${video.name} (ID: ${video.id})`);

  // 2. 下载并上传缩略图到 OSS
  const ytThumbUrl = getYouTubeThumbUrl(video.video_link);
  let thumbUrl = ytThumbUrl; // 默认使用 YouTube CDN
  if (ytThumbUrl) {
    const thumbTmpFile = path.join(tmpDir, `${paddedId}_thumb.jpg`);
    const thumbOssKey = `thumbs/${paddedId}_${safeName}.jpg`;
    console.log(`🖼  下载缩略图...`);
    const thumbOk = await downloadThumb(ytThumbUrl, thumbTmpFile);
    if (thumbOk) {
      try {
        await ossClient.put(thumbOssKey, thumbTmpFile);
        thumbUrl = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${thumbOssKey}`;
        console.log(`🖼  缩略图上传成功`);
      } catch (err) {
        console.error(`⚠️  缩略图上传失败，使用 YouTube CDN: ${err.message}`);
      }
      if (fs.existsSync(thumbTmpFile)) fs.unlinkSync(thumbTmpFile);
    }
  }

  // 3. 下载视频
  if (!fs.existsSync(tmpDir)) fs.mkdirSync(tmpDir, { recursive: true });

  const ossKey = `videos/${paddedId}_${safeName}.mp4`;
  const tmpFile = path.join(tmpDir, `${paddedId}_${safeName}.mp4`);

  console.log(`⬇️  下载视频...`);
  try {
    execSync(
      `yt-dlp --cookies-from-browser chrome -f "best[ext=mp4]/best" --merge-output-format mp4 -o "${tmpFile}" "${video.video_link}"`,
      { stdio: 'inherit', timeout: 180000 }
    );
  } catch (err) {
    console.error(`❌ 下载失败: ${err.message}`);
    return false;
  }

  if (!fs.existsSync(tmpFile)) {
    console.error(`❌ 下载文件不存在`);
    return false;
  }

  // 4. 上传到 OSS（带重试）
  const fileSize = (fs.statSync(tmpFile).size / 1024 / 1024).toFixed(1);
  console.log(`☁️  上传到 OSS (${fileSize}MB)...`);
  let uploaded = false;
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      await ossClient.put(ossKey, tmpFile);
      uploaded = true;
      break;
    } catch (err) {
      console.error(`   ⚠️  上传第${attempt}次失败: ${err.message}`);
      if (attempt < 3) {
        console.log(`   🔄 ${3}秒后重试...`);
        await new Promise(r => setTimeout(r, 3000));
      }
    }
  }

  if (!uploaded) {
    console.error(`❌ 上传最终失败（3次重试均失败）`);
    return false;
  }

  const videoPath = `https://${process.env.OSS_BUCKET}.${process.env.OSS_REGION}.aliyuncs.com/${ossKey}`;

  // 5. 通过 API 更新数据库
  await apiFetch(`${API_BASE}/videos/${video.id}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ video_path: videoPath, thumb_url: thumbUrl })
  });

  console.log(`✅ 备份完成: ${videoPath}`);

  // 6. 清理临时文件
  fs.unlinkSync(tmpFile);
  return true;
}

// ==================== 批量模式 ====================
async function backupAll() {
  const videos = await apiFetch(`${API_BASE}/videos`);
  const pending = videos.filter(v => !v.video_path && v.video_link);

  if (pending.length === 0) {
    console.log('✅ 所有视频都已备份');
    return;
  }

  console.log(`📦 共 ${pending.length} 个视频待备份\n`);

  let ok = 0, fail = 0;
  for (const v of pending) {
    const success = await backupVideo(v.id);
    if (success) ok++; else fail++;
    console.log('');
  }

  console.log(`\n📊 完成: ${ok} 成功, ${fail} 失败`);
}

// ==================== 入口 ====================
const arg = process.argv[2];

if (arg === '--all') {
  backupAll().catch(console.error);
} else if (arg && !isNaN(arg)) {
  backupVideo(parseInt(arg)).catch(console.error);
} else {
  console.log(`
视频备份工具
用法:
  node backup.js <video_id>   备份指定视频
  node backup.js --all        备份所有未备份的视频
  `);
}
