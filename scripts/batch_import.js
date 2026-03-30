/**
 * 批量导入脚本：从 markdown 拆解报告中提取元数据 + 分析字段，录入素材库
 * 用法: node batch_import.js [startIndex] [endIndex]
 * 示例: node batch_import.js 0 9  (导入第0-9个文件)
 */
const fs = require('fs');
const path = require('path');

const SCRIPTS_DIR = __dirname;
const API_URL = 'http://localhost:3456/api/videos';
const TODAY = '2026-03-29';

// ========== 元数据解析器 ==========

function parseMetadata(content) {
  const get = (pattern) => {
    const m = content.match(pattern);
    return m ? m[1].trim() : '';
  };

  // Handle formats like: - **视频标题**：xxx  OR  视频标题：xxx
  // Also handle links wrapped in [[...]{.underline}](url) pandoc artifacts
  let videoLink = get(/视频链接\*?\*?[：:]\s*(?:\[?\[?)?(https?:\/\/[^\s\]>]+)/);
  // Clean up any trailing markdown artifacts
  videoLink = videoLink.replace(/\]\{\.underline\}.*$/, '').replace(/\]$/, '');

  return {
    video_title: get(/视频标题\*?\*?[：:]\s*(.+?)(?:\n|$)/),
    video_link: videoLink,
    publish_date: get(/发布日期\*?\*?[：:]\s*(\d{4}-\d{2}-\d{2})/),
    duration: get(/视频时长\*?\*?[：:]\s*(\d+)/),
    views: get(/播放量\*?\*?[：:]\s*([\d,]+)/)?.replace(/,/g, '') || '',
    likes: get(/点赞量\*?\*?[：:]\s*([\d,]+)/)?.replace(/,/g, '') || '',
  };
}

function parseSummary(content) {
  // 提取【完整故事】到【全局设定】之间的内容
  const m = content.match(/【完整故事】\s*\n([\s\S]*?)(?=\n\s*【全局设定】|\n\s*##\s*【全局设定】)/);
  if (!m) return '';
  // 清理 markdown 格式，保留纯文本
  return m[1]
    .replace(/^\d+\.\s+\*\*.*?\*\*[：:]\s*/gm, '')  // 移除编号和加粗时间码
    .replace(/\*\*/g, '')  // 移除剩余加粗
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function parseScenes(content) {
  const scenes = [];
  // 匹配场景段落
  const sceneSection = content.match(/场景[（(]环境[)）][：:]\s*\n([\s\S]*?)(?=\n\s*###|\n\s*运镜|$)/);
  if (!sceneSection) {
    // 尝试其他格式：### 场景（环境）：
    const alt = content.match(/###\s*场景[（(]环境[)）][：:]?\s*\n([\s\S]*?)(?=\n\s*###|\n\s*##(?!\s*#))/);
    if (alt) {
      const items = alt[1].match(/-\s+\*\*(.+?)\*\*[：:]\s*(.+?)(?=\n-|\n\n|$)/gs);
      if (items) {
        for (const item of items) {
          const m = item.match(/-\s+\*\*(.+?)\*\*[：:]\s*([\s\S]+)/);
          if (m) scenes.push({ name: m[1].trim(), function: m[2].trim().split('\n')[0] });
        }
      }
    }
    return scenes;
  }

  const items = sceneSection[1].match(/-\s+\*\*(.+?)\*\*[：:]\s*(.+?)(?=\n-|\n\n|$)/gs);
  if (items) {
    for (const item of items) {
      const m = item.match(/-\s+\*\*(.+?)\*\*[：:]\s*([\s\S]+)/);
      if (m) scenes.push({ name: m[1].trim(), function: m[2].trim().split('\n')[0] });
    }
  }
  return scenes;
}

function parseProps(content) {
  const props = [];
  const propSection = content.match(/核心道具[：:]\s*\n([\s\S]*?)(?=\n\s*##\s|$)/);
  if (!propSection) return props;

  const items = propSection[1].match(/-\s+\*\*(.+?)\*\*[：:]\s*(.+?)(?=\n-|\n\n|$)/gs);
  if (items) {
    for (const item of items) {
      const m = item.match(/-\s+\*\*(.+?)\*\*[：:]\s*([\s\S]+)/);
      if (m) {
        const name = m[1].trim().replace(/[（(].+?[)）]/, '').trim();
        props.push({ name, type: '', function: m[2].trim().split('\n')[0] });
      }
    }
  }
  return props;
}

function parseCharacters(content) {
  const chars = [];
  // 常驻角色对照
  const KNOWN = {
    'jinu': '黑发偏分男生', 'rumi': '紫色麻花辫', 'mira': '红色双马尾',
    'zoye': '黑发双丸子', 'abby': '棕发肌肉男', 'baby': '绿发男生',
    'romance': '粉发男生', 'mystery': '银发男生'
  };

  const charSection = content.match(/角色与服化道[：:]\s*\n([\s\S]*?)(?=\n\s*###\s*核心道具|\n\s*核心道具)/);
  if (!charSection) return chars;

  const items = charSection[1].match(/-\s+\*\*(.+?)\*\*[：:]\s*(.+?)(?=\n-|\n\n|$)/gs);
  if (items) {
    for (const item of items) {
      const m = item.match(/-\s+\*\*(.+?)\*\*[：:]\s*([\s\S]+)/);
      if (m) {
        let rawName = m[1].trim();
        // 识别常驻角色
        let charName = rawName;
        for (const [key, desc] of Object.entries(KNOWN)) {
          if (rawName.toLowerCase().includes(key)) {
            charName = key;
            break;
          }
        }
        chars.push({ name: charName, persona: '', abilities: '', states: '' });
      }
    }
  }
  return chars;
}

// ========== 文件列表 ==========

function getFiles() {
  const files = fs.readdirSync(SCRIPTS_DIR)
    .filter(f => /^(0967|096[89]|09[7-9]\d|10[0-4]\d|105[0-6])-.+\.md$/.test(f))
    .sort();
  return files;
}

// ========== 分析数据 (手动填充) ==========
// 这个对象包含每个文件的分析字段，由逐个分析后填入
const ANALYSIS_DATA = {};

// ========== 导入函数 ==========

async function importFile(filename, extraAnalysis = {}) {
  const filepath = path.join(SCRIPTS_DIR, filename);
  const content = fs.readFileSync(filepath, 'utf-8');

  const metadata = parseMetadata(content);
  const summary = parseSummary(content);
  const scenes = parseScenes(content);
  const props = parseProps(content);
  const characters = parseCharacters(content);

  // 从文件名生成 script_path
  const scriptPath = `scripts/${filename}`;

  // 从 YouTube 链接自动生成缩略图 URL
  function extractVideoId(url) {
    if (!url) return null;
    let m = url.match(/youtube\.com\/shorts\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    m = url.match(/[?&]v=([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    m = url.match(/youtu\.be\/([a-zA-Z0-9_-]+)/);
    if (m) return m[1];
    return null;
  }
  const vid = extractVideoId(metadata.video_link);
  const thumbUrl = vid ? `https://img.youtube.com/vi/${vid}/maxresdefault.jpg` : '';

  const payload = {
    ...metadata,
    summary,
    name: extraAnalysis.name || metadata.video_title?.substring(0, 20) || filename.replace(/\.md$/, ''),
    video_type: extraAnalysis.video_type || '',
    hook_tags: extraAnalysis.hook_tags || '',
    hook: extraAnalysis.hook || '',
    video_tags: extraAnalysis.video_tags || '',
    technique: extraAnalysis.technique || '',
    mechanism_name: extraAnalysis.mechanism_name || '',
    mechanism: extraAnalysis.mechanism || '',
    protagonist: extraAnalysis.protagonist || '',
    protagonist_goal: extraAnalysis.protagonist_goal || '',
    antagonist: extraAnalysis.antagonist || '',
    antagonist_goal: extraAnalysis.antagonist_goal || '',
    adapt_tags: extraAnalysis.adapt_tags || '',
    adapt_brief: extraAnalysis.adapt_brief || '',
    source_video_id: extraAnalysis.source_video_id || '',
    date: TODAY,
    script_path: scriptPath,
    thumb_url: thumbUrl,
    scenes: extraAnalysis.scenes || scenes,
    props: extraAnalysis.props || props,
    characters: extraAnalysis.characters || characters,
  };

  try {
    const resp = await fetch(API_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const data = await resp.json();
    if (resp.ok) {
      console.log(`✅ ID=${data.id} | ${payload.name} | ${filename}`);
      return data;
    } else {
      console.error(`❌ ${filename}: ${data.error}`);
      return null;
    }
  } catch (err) {
    console.error(`❌ ${filename}: ${err.message}`);
    return null;
  }
}

// ========== 主函数 ==========

async function main() {
  const args = process.argv.slice(2);

  if (args[0] === 'list') {
    const files = getFiles();
    files.forEach((f, i) => console.log(`${i}: ${f}`));
    console.log(`\n共 ${files.length} 个文件`);
    return;
  }

  if (args[0] === 'import-batch') {
    // 从 JSON 文件导入一批
    const batchFile = args[1];
    if (!batchFile) { console.error('用法: node batch_import.js import-batch <batch.json>'); return; }
    const batch = JSON.parse(fs.readFileSync(batchFile, 'utf-8'));
    let ok = 0, fail = 0;
    for (const item of batch) {
      const result = await importFile(item.filename, item.analysis);
      if (result) ok++; else fail++;
    }
    console.log(`\n导入完成: ✅${ok} ❌${fail}`);
    return;
  }

  // 默认：列出文件
  const files = getFiles();
  console.log(`共找到 ${files.length} 个待导入文件`);
  files.slice(0, 5).forEach(f => console.log(`  ${f}`));
  console.log('  ...');
  console.log('\n用法:');
  console.log('  node batch_import.js list          - 列出所有文件');
  console.log('  node batch_import.js import-batch <file.json> - 从JSON导入一批');
}

main();
