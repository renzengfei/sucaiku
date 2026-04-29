const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new Database(dbPath);

console.log('🔄 开始自动化提取骨架...');

const videos = db.prepare('SELECT id, name, script_path, mechanism, notes FROM videos ORDER BY id').all();

let successCount = 0;

videos.forEach(v => {
  if (!v.script_path) return;
  const fullPath = path.join(__dirname, '..', v.script_path);
  if (!fs.existsSync(fullPath)) return;

  const content = fs.readFileSync(fullPath, 'utf-8');
  
  // 匹配所有 Clip 的时间段 和 它带的 叙事（或者类似的核心动作）
  // 兼容不同的格式：Clip xy: 0:00-0:05 \n...\n - 叙事：xxx
  const clipRegex = /Clip\s*\d+[：:]\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})[\s\S]*?(?:叙事|故事).*?[：:]\s*(.*?)(?=\n|$)/gi;
  
  let match;
  let newSkeletonParts = [];
  
  while ((match = clipRegex.exec(content)) !== null) {
    let startStr = match[1];
    let endStr = match[2];
    let narrative = match[3].trim().replace(/[。，]/g, '').substr(0, 15); // 限制字符防止太长
    
    // 过滤一些模板化的前缀，提炼核心动作
    narrative = narrative.replace(/展现了?|交代了?|表现了?|揭示了?|展示了?/g, '');
    if (narrative.length === 0) continue;

    const toSec = (t) => {
      const p = t.split(':');
      return parseInt(p[0]) * 60 + parseInt(p[1]);
    };
    let duration = toSec(endStr) - toSec(startStr);
    if (duration <= 0) duration = 1;

    newSkeletonParts.push(`${narrative}(${duration}s)`);
  }
  
  if (newSkeletonParts.length > 0) {
    const newMechanism = newSkeletonParts.join('→');
    
    // 如果超过一定长度，证明提取成功，可以更新数据库
    if (newMechanism.length > 10) {
      let notesUpdate = v.notes ? v.notes + '\n[旧骨架] ' + (v.mechanism || '') : '[旧骨架] ' + (v.mechanism || '');
      db.prepare('UPDATE videos SET mechanism = ?, notes = ? WHERE id = ?').run(newMechanism, notesUpdate, v.id);
      successCount++;
      if (successCount <= 3) {
        console.log(`✅ [${v.id}] ${v.name} -> ${newMechanism}`);
      }
    }
  }
});

console.log(`🎉 批量更新完成，成功覆盖 ${successCount} 个视频骨架！`);
db.close();
