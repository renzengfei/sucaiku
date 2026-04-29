#!/bin/bash
# 进入项目目录
cd "$(dirname "$0")"

current_time=$(date "+%Y%m%d_%H%M%S")
backup_name="VideoAgentDB_Backup_${current_time}.zip"

echo "📦 正在导出 SQLite 数据库最新数据..."
sqlite3 database.db .dump > database_backup.sql

echo "🗜️ 正在打包压缩文件 (跳过视频媒体文件)..."
# 打包代码、脚本和SQL备份，剔除视频等大文件
zip -r "$backup_name" . -x "*.mp4" -x "*.mov" -x "*.mp3" -x ".git/*" -x "node_modules/*" -x "database.db" -x "*.zip"

echo "✅ 打包完成！"
echo "👉 请打开本地文件夹，把新生成的【$backup_name】拖进浏览器上传到网盘或发给自己的微信！"
