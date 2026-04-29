const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = path.join(__dirname, '..', 'database.db');
const db = new Database(dbPath);

// 获取所有视频
const videos = db.prepare('SELECT id, name, mechanism, script_path, duration FROM videos ORDER BY id').all();

const results = [];

for (const v of videos) {
  const entry = {
    id: v.id,
    name: v.name,
    duration: v.duration,
    old_mechanism: v.mechanism,
    script_path: v.script_path,
    story_beats: [],
    clips: []
  };

  // 读取脚本文件
  if (v.script_path) {
    const fullPath = path.join(__dirname, '..', v.script_path);
    if (fs.existsSync(fullPath)) {
      const content = fs.readFileSync(fullPath, 'utf-8');
      
      // 提取故事节拍（【完整故事】或【故事骨架】）
      const storyMatch = content.match(/【完整故事】|【故事骨架】/);
      if (storyMatch) {
        const storyStart = storyMatch.index;
        const nextSection = content.indexOf('【', storyStart + storyMatch[0].length);
        const storySection = nextSection > -1 ? content.substring(storyStart, nextSection) : content.substring(storyStart);
        
        // 提取编号条目 - 支持 "1. **标题**：" 和 "1. 描述文字" 格式
        const beatRegex = /\d+\.\s+(?:\*\*(.+?)\*\*[：:]|(.+?)(?:\n|$))/g;
        let match;
        while ((match = beatRegex.exec(storySection)) !== null) {
          const title = (match[1] || match[2] || '').trim().replace(/[。，]/g, '');
          if (title) entry.story_beats.push(title);
        }
      }

      // 提取 Clip 时间轴
      const clipRegex = /Clip\s*\d+[：:]\s*(\d{1,2}:\d{2})\s*[-–]\s*(\d{1,2}:\d{2})/gi;
      let clipMatch;
      while ((clipMatch = clipRegex.exec(content)) !== null) {
        const start = clipMatch[1];
        const end = clipMatch[2];
        // 转秒
        const toSec = (t) => {
          const parts = t.split(':');
          return parseInt(parts[0]) * 60 + parseInt(parts[1]);
        };
        entry.clips.push({
          start: toSec(start),
          end: toSec(end),
          startStr: start,
          endStr: end
        });
      }
    } else {
      entry.error = '文件不存在: ' + fullPath;
    }
  }

  results.push(entry);
}

// 输出 JSON
const outputPath = path.join(__dirname, 'mechanism_data.json');
fs.writeFileSync(outputPath, JSON.stringify(results, null, 2), 'utf-8');
console.log(`✅ 已提取 ${results.length} 个视频的数据到 ${outputPath}`);

// 统计
const withBeats = results.filter(r => r.story_beats.length > 0).length;
const withClips = results.filter(r => r.clips.length > 0).length;
const withErrors = results.filter(r => r.error).length;
console.log(`   有故事节拍: ${withBeats}`);
console.log(`   有Clip时间轴: ${withClips}`);
console.log(`   文件错误: ${withErrors}`);

db.close();
