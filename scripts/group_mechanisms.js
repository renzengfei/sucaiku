const Database = require('better-sqlite3');
const db = new Database(__dirname + '/../database.db');
const rows = db.prepare('SELECT id, name, mechanism_name, mechanism FROM videos ORDER BY mechanism_name').all();

const groups = {};
for (const r of rows) {
  const key = r.mechanism_name || '(空)';
  if (!groups[key]) groups[key] = [];
  groups[key].push({ id: r.id, name: r.name, mechanism: r.mechanism });
}

const repeated = Object.entries(groups).filter(([k,v]) => v.length >= 2).sort((a,b) => b[1].length - a[1].length);
console.log('=== 重复机制（≥2个视频）===\n');
for (const [mech, videos] of repeated) {
  console.log('【' + mech + '】(' + videos.length + '个)');
  for (const v of videos) {
    console.log('  ID=' + v.id + ' | ' + v.name);
  }
  console.log('  机制: ' + videos[0].mechanism);
  console.log('');
}
console.log('--- 统计 ---');
console.log('总机制数:', Object.keys(groups).length);
console.log('重复机制数:', repeated.length);
console.log('涉及视频数:', repeated.reduce((s,[,v]) => s + v.length, 0));
const unique = Object.entries(groups).filter(([k,v]) => v.length === 1);
console.log('独立机制数:', unique.length);
