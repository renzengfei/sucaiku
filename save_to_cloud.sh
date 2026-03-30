#!/bin/bash
# 进入项目目录
cd "$(dirname "$0")"

echo "📦 正在导出 SQLite 数据库..."
sqlite3 database.db .dump > database_backup.sql

echo "🚀 添加文件到 Git..."
git add .

echo "💾 提交版本..."
current_time=$(date "+%Y-%m-%d %H:%M:%S")
git commit -m "Auto backup: $current_time"

echo "☁️ 正在同步到云端仓库..."
# 如果网络不好，推荐用 Gitee
git push origin main

echo "✅ 云端备份完成！"
