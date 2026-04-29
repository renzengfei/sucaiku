const fs = require('fs');
const Database = require('better-sqlite3');
const db = new Database('database.db');
db.prepare("UPDATE videos SET script_path = 'scripts/999辣椒成瘾.txt' WHERE id = 2").run();
db.prepare("UPDATE videos SET script_path = 'scripts/998柠檬成瘾.txt' WHERE id = 3").run();
db.prepare("UPDATE videos SET script_path = 'scripts/997冰块成瘾.txt' WHERE id = 4").run();
db.prepare("UPDATE videos SET script_path = 'scripts/996跳舞成瘾.md' WHERE id = 5").run(); // 假设是md
db.prepare("UPDATE videos SET script_path = 'scripts/995谁偷吃了.md' WHERE id = 6").run(); 
console.log('路径修复完成');
