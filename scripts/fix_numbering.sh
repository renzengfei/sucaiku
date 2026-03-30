#!/bin/bash
# 修正重复编号：将重复编号的文件重新编号从1057开始
cd "/Users/renzengfei/短视频/素材库/scripts"

# 找出所有重复编号的文件(每个编号的第二个文件)
declare -A seen
newnum=1057
files=()

for f in $(ls -1 0967-*.md 096[89]-*.md 09[7-9]?-*.md 10[0-5]?-*.md 2>/dev/null | sort); do
  num=$(echo "$f" | grep -oP '^\d+')
  if [[ -n "${seen[$num]}" ]]; then
    # 重复编号，需要重命名
    newprefix=$(printf "%04d" $newnum)
    rest="${f#*-}"
    newname="${newprefix}-${rest}"
    echo "mv: $f -> $newname"
    mv "$f" "$newname"
    newnum=$((newnum+1))
  else
    seen[$num]=1
  fi
done

echo "重命名完成，新编号范围: 1057 - $((newnum-1))"
