const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');
const { spawnSync } = require('child_process');

console.log('🔄 开始自动切片 3秒抢先版...');

const dbPath = path.join(__dirname, '../database.db');
const db = new Database(dbPath);

const previewsDir = path.join(__dirname, '../public/previews');
if (!fs.existsSync(previewsDir)) {
  fs.mkdirSync(previewsDir, { recursive: true });
}

const videosToProcess = db.prepare(`
  SELECT id, name, video_path 
  FROM videos 
  WHERE video_path IS NOT NULL AND video_path != '' 
  AND (preview_path IS NULL OR preview_path = '')
`).all();

console.log(`共扫出 ${videosToProcess.length} 个尚无预览切片的视频.`);

const updatePreviewPath = db.prepare('UPDATE videos SET preview_path = ? WHERE id = ?');

let successCount = 0;
let failCount = 0;

for (let i = 0; i < videosToProcess.length; i++) {
  const v = videosToProcess[i];
  console.log(`[${i+1}/${videosToProcess.length}] 处理: #${v.id} ${v.name}`);

  const outputFileName = `${v.id}_preview.mp4`;
  const absoluteOutputPath = path.join(previewsDir, outputFileName);
  const relativeDbPath = `previews/${outputFileName}`;

  try {
    const args = [
      '-y',
      '-i', v.video_path,
      '-t', '3',
      '-c:v', 'libx264',
      '-c:a', 'aac',
      '-avoid_negative_ts', 'make_zero',
      '-loglevel', 'error',
      absoluteOutputPath
    ];
    
    // 同步执行 ffmpeg
    const result = spawnSync('ffmpeg', args, { stdio: 'inherit' });
    
    if (result.status === 0 && fs.existsSync(absoluteOutputPath)) {
      updatePreviewPath.run(relativeDbPath, v.id);
      successCount++;
      console.log(`  ✅ 成功 -> ${relativeDbPath}`);
    } else {
      failCount++;
      console.log(`  ❌ 切片失败 (退出码: ${result.status})`);
      if (fs.existsSync(absoluteOutputPath)) fs.unlinkSync(absoluteOutputPath);
    }
  } catch (err) {
    failCount++;
    console.log(`  ❌ FFmpeg 发生异常: ${err.message}`);
  }
}

console.log('========================');
console.log(`🎉 任务完成! 成功: ${successCount}, 失败: ${failCount}`);
