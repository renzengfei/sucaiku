const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const db = new Database(path.join(__dirname, '..', 'database.db'));
const doneIds = [2,3,4,5,6,7,8,9,10,12,13,14,15,16,17,18,19,20,21,22,23,24,25,26,27,28,29,30,31,32,33,106,122];

const videos = db.prepare('SELECT id, name, script_path, duration FROM videos ORDER BY id').all();

// 修正文件路径
function findFile(sp) {
  const base = path.join(__dirname, '..', sp);
  if (fs.existsSync(base)) return base;
  if (fs.existsSync(base + '.md')) return base + '.md';
  if (fs.existsSync(base + '.txt')) return base + '.txt';
  return null;
}

let output = [];

for (const v of videos) {
  if (doneIds.includes(v.id)) continue;
  if (!v.script_path) { output.push(`\n=== ID${v.id} ${v.name} (${v.duration}s) === 无script_path`); continue; }
  
  const fp = findFile(v.script_path);
  if (!fp) { output.push(`\n=== ID${v.id} ${v.name} (${v.duration}s) === 文件不存在: ${v.script_path}`); continue; }
  
  const content = fs.readFileSync(fp, 'utf-8');
  
  // 提取完整故事（取前500字）
  let story = '';
  const storyMatch = content.match(/【完整故事】([\s\S]*?)(?=【全局设定】|【场景|---)/);
  if (storyMatch) story = storyMatch[1].replace(/\n{2,}/g, ' ').replace(/\s+/g, ' ').trim().substring(0, 500);
  
  // 提取每个Clip的时间+表演(动作描述)
  let clips = [];
  // 支持多种格式: "Clip 1: 0-2s", "Clip 01: 0:00-0:02", "#### Clip 1: 00:00-00:02"
  const clipBlocks = content.split(/(?=(?:####?\s*)?Clip\s*\d)/gi).filter(b => /Clip\s*\d/i.test(b));
  
  for (const block of clipBlocks) {
    // 提取时间
    const timeMatch = block.match(/Clip\s*(\d+)[：:]\s*(\d{1,2}[:-]\d{1,2}(?:s)?)\s*[-–]\s*(\d{1,2}[:-]\d{1,2}(?:s)?)/i);
    if (!timeMatch) continue;
    
    let startStr = timeMatch[2].replace('s','');
    let endStr = timeMatch[3].replace('s','');
    
    // 统一转秒
    const toSec = (t) => {
      t = t.replace('-',':');
      if (!t.includes(':')) t = '0:' + t;
      const p = t.split(':');
      return parseInt(p[0]) * 60 + parseInt(p[1]);
    };
    const start = toSec(startStr);
    const end = toSec(endStr);
    const dur = end - start;
    
    // 提取表演字段
    let perf = '';
    const perfMatch = block.match(/表演[：:]\s*(.*?)(?=\n|声音|$)/s);
    if (perfMatch) perf = perfMatch[1].trim().substring(0, 80);
    
    clips.push(`${start}-${end}s(${dur}s): ${perf}`);
  }
  
  output.push(`\n=== ID${v.id} ${v.name} (${v.duration}s) ===`);
  if (story) output.push(`故事: ${story}`);
  if (clips.length > 0) output.push(`Clips(${clips.length}):\n${clips.join('\n')}`);
  else output.push('无Clip数据');
}

const outPath = path.join(__dirname, 'compact_data.txt');
fs.writeFileSync(outPath, output.join('\n'), 'utf-8');
console.log(`✅ 已提取 ${videos.length - doneIds.length} 个待处理视频的紧凑数据到 ${outPath}`);
db.close();
