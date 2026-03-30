const Database = require('better-sqlite3');
const db = new Database(__dirname + '/../database.db');

const merges = [
  // 3. 隐忍爆发
  { ids: [119], newName: '隐忍爆发' },
  // 4. 噩梦追逐反转
  { ids: [93, 118], newName: '噩梦追逐反转' },
  // 5. 嘲笑者被反整
  { ids: [105], newName: '嘲笑者被反整', from: '嘲笑者被反整+第四面墙求助' },
  { ids: [77], newName: '嘲笑者被反整' },
  // 6. 诅咒能力递进
  { ids: [106, 122], newName: '诅咒能力递进' },
  // 7. 体内异次元掏取
  { ids: [76, 90], newName: '体内异次元掏取' },
  // 8. 恶作剧反转
  { ids: [78, 87], newName: '恶作剧反转' },
  // 9. 隐藏作弊
  { ids: [80, 86, 99], newName: '隐藏作弊' },
  // 10. 递进挑战
  { ids: [98, 103, 107], newName: '递进挑战' },
  // 11. 食物执念超越物理 (已统一名称，无需改)
  // 12. 极端行为的治愈真相
  { ids: [88, 92], newName: '极端行为的治愈真相' },
  // 13. 第四面墙求助
  { ids: [83, 101], newName: '第四面墙求助' },
];

const stmt = db.prepare('UPDATE videos SET mechanism_name = ? WHERE id = ?');

let count = 0;
for (const m of merges) {
  for (const id of m.ids) {
    const old = db.prepare('SELECT mechanism_name FROM videos WHERE id = ?').get(id);
    if (old && old.mechanism_name !== m.newName) {
      stmt.run(m.newName, id);
      console.log(`✅ ID=${id} | 「${old.mechanism_name}」→「${m.newName}」`);
      count++;
    } else {
      console.log(`⏭  ID=${id} | 已是「${m.newName}」`);
    }
  }
}

console.log(`\n合并完成: ${count} 条已更新`);

// 验证：输出合并后的分组
const rows = db.prepare(`
  SELECT mechanism_name, COUNT(*) as cnt 
  FROM videos 
  GROUP BY mechanism_name 
  HAVING cnt >= 2 
  ORDER BY cnt DESC
`).all();

console.log('\n=== 合并后分组（≥2个视频）===');
for (const r of rows) {
  console.log(`  ${r.mechanism_name} (${r.cnt}个)`);
}
