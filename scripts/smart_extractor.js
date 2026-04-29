const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new Database(dbPath);

console.log('🔄 开始执行超级本地骨架提取器...');

// 修正潜在的文件后缀路径错误
function findActualFilePath(basePath) {
  const fullPath = path.join(__dirname, '..', basePath);
  if (fs.existsSync(fullPath)) return basePath;
  if (fs.existsSync(fullPath + '.md')) return basePath + '.md';
  if (fs.existsSync(fullPath + '.txt')) return basePath + '.txt';
  // 按照名字硬找一个
  const dir = path.dirname(fullPath);
  const baseName = path.basename(basePath);
  if (fs.existsSync(dir)) {
    const files = fs.readdirSync(dir);
    for (let f of files) {
      if (f.includes(baseName)) return path.join('scripts', f);
    }
  }
  return null;
}

const videos = db.prepare('SELECT id, name, script_path, mechanism, duration, notes FROM videos ORDER BY id').all();

let updatedCount = 0;
let skipCount = 0;

videos.forEach(v => {
  // 如果是我刚刚人工做好的前几个，跳过
  if (v.id <= 6 || v.id === 122 || v.id === 106) return;

  if (!v.script_path) { skipCount++; return; }
  let actualPath = findActualFilePath(v.script_path);

  if (!actualPath || !fs.existsSync(path.join(__dirname, '..', actualPath))) {
    skipCount++;
    return;
  }
  
  // 更新修好后缀名的路径
  if (actualPath !== v.script_path) {
    db.prepare('UPDATE videos SET script_path = ? WHERE id = ?').run(actualPath, v.id);
  }

  const content = fs.readFileSync(path.join(__dirname, '..', actualPath), 'utf-8');
  let newSkeletonParts = [];
  
  // ==========================================
  // 【策略 1】寻找 Clip 里的"叙事"并精确计算时间
  // ==========================================
  const clipRegex = /Clip\s*\d+[：:]\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})[\s\S]*?(?:叙事|故事).*?[：:]\s*(.*?)(?=\n|$)/gi;
  let match;
  while ((match = clipRegex.exec(content)) !== null) {
    let startStr = match[1];
    let endStr = match[2];
    let narrative = match[3].trim().replace(/[。，]/g, '');
    
    // 提纯文本 (例如 "叙事：展现了女主极其反常的吃冰行为" -> "女主极其反常的吃冰行为")
    narrative = narrative.replace(/^(展示了?|展现了?|交代了?|表现了?|揭示了?|建立)/, '');
    if (narrative.length > 25) narrative = narrative.substring(0, 22) + '...';
    if (narrative.length === 0) continue;

    const toSec = (t) => {
      let p = t.split(':');
      return parseInt(p[0]) * 60 + parseInt(p[1]);
    };
    let dur = toSec(endStr) - toSec(startStr);
    if (dur <= 0) dur = 1;
    newSkeletonParts.push(`${narrative}(${dur}s)`);
  }

  // ==========================================
  // 【策略 2】如果没有叙事，找故事骨架并平摊时间
  // ==========================================
  if (newSkeletonParts.length < 3) {
    newSkeletonParts = [];
    const storyMatch = content.match(/【完整故事】|【故事骨架】/);
    if (storyMatch) {
      const storyStart = storyMatch.index;
      const nextSec = content.indexOf('【', storyStart + storyMatch[0].length);
      const storySection = nextSec > -1 ? content.substring(storyStart, nextSec) : content.substring(storyStart);
      
      const beatRegex = /\d+\.\s+(?:\*\*(.+?)\*\*[：:]|(.+?)(?:\n|$))/g;
      let beats = [];
      let m;
      while ((m = beatRegex.exec(storySection)) !== null) {
        let b = (m[1] || m[2] || '').trim().replace(/[。，]/g, '');
        if (b.length > 22) b = b.substring(0, 20) + '...';
        if (b) beats.push(b);
      }
      
      if (beats.length > 0) {
        let totalDur = parseInt(v.duration) || 30; // 默认30s
        let durPerBeat = Math.max(1, Math.floor(totalDur / beats.length));
        
        beats.forEach((b, i) => {
          // 最后一段吃掉余数
          let d = (i === beats.length - 1) ? totalDur - (beats.length - 1) * durPerBeat : durPerBeat;
          newSkeletonParts.push(`${b}(${d}s)`);
        });
      }
    }
  }

  // ==========================================
  // 回写数据库
  // ==========================================
  if (newSkeletonParts.length >= 2) {
    const newMechanism = newSkeletonParts.join('→');
    let notesUpdate = v.notes ? v.notes + '\n[旧骨架] ' + (v.mechanism || '') : '[旧骨架] ' + (v.mechanism || '');
    db.prepare('UPDATE videos SET mechanism = ?, notes = ? WHERE id = ?').run(newMechanism, notesUpdate, v.id);
    updatedCount++;
    if (updatedCount <= 5) {
      console.log(`[样例展示 ID:${v.id}] ${newMechanism}`);
    }
  } else {
    skipCount++;
  }
});

console.log(`\n🎉 批量更替完成！`);
console.log(`成功矫正骨架数量：${updatedCount} 个视频`);
console.log(`未能提炼的视频数量：${skipCount} 个视频 (可能是找不到文件或格式极不规范)`);

db.close();
