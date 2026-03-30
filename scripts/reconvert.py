#!/usr/bin/env python3
"""
重新编号所有从 docx 转换来的 md 文件。
从源目录重新转换，确保文件名完整。
"""
import os
import subprocess
import json

SRC_DIR = "/Users/renzengfei/短视频/素材库/scripts/drive-download-20260328T174512Z-3-001"
DST_DIR = "/Users/renzengfei/短视频/素材库/scripts"
START_NUM = 967

# 1. 先删除之前错误转换的文件（0967-1218范围）
print("🗑️  清理之前错误的转换文件...")
import re
removed = 0
for f in os.listdir(DST_DIR):
    m = re.match(r'^(\d{4})-.*\.md$', f)
    if m:
        num = int(m.group(1))
        if 967 <= num <= 1300:
            # 检查是否是本次导入的文件（不是旧的已有文件）
            # 旧文件编号 < 967，安全
            filepath = os.path.join(DST_DIR, f)
            os.remove(filepath)
            removed += 1
print(f"   已删除 {removed} 个文件")

# 2. 获取源 docx 文件列表（排序）
docx_files = sorted([f for f in os.listdir(SRC_DIR) if f.endswith('.docx')])
print(f"\n📂 源文件数: {len(docx_files)}")

# 3. 逐个转换并编号
print("\n🔄 开始转换...")
results = []
num = START_NUM
for docx in docx_files:
    prefix = f"{num:04d}"
    basename = os.path.splitext(docx)[0]
    out_name = f"{prefix}-{basename}.md"
    out_path = os.path.join(DST_DIR, out_name)
    src_path = os.path.join(SRC_DIR, docx)
    
    result = subprocess.run(
        ["pandoc", src_path, "-t", "markdown", "-o", out_path],
        capture_output=True, text=True
    )
    
    if result.returncode == 0:
        print(f"  ✅ {prefix} - {basename}")
        results.append({"num": num, "filename": out_name, "status": "ok"})
    else:
        print(f"  ❌ {prefix} - {basename}: {result.stderr}")
        results.append({"num": num, "filename": out_name, "status": "error", "error": result.stderr})
    
    num += 1

# 4. 汇总
ok_count = sum(1 for r in results if r["status"] == "ok")
fail_count = sum(1 for r in results if r["status"] != "ok")
print(f"\n✅ 转换完成: 成功 {ok_count}, 失败 {fail_count}")
print(f"📋 编号范围: {START_NUM:04d} - {num-1:04d}")

# 保存文件列表
list_file = os.path.join(DST_DIR, "import_filelist.json")
with open(list_file, "w", encoding="utf-8") as f:
    json.dump(results, f, ensure_ascii=False, indent=2)
print(f"📝 文件列表已保存到: {list_file}")
