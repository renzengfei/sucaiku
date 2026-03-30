#!/bin/zsh
# 检测链接收集.md中每个YouTube Shorts的播放量
# 将低于500万的链接移到文档最下面

INPUT_FILE="/Users/renzengfei/短视频/素材库/scripts/链接收集.md"
OUTPUT_FILE="/Users/renzengfei/短视频/素材库/scripts/链接收集_sorted.md"
LOG_FILE="/Users/renzengfei/短视频/素材库/scripts/views_log.csv"
TEMP_DIR="/Users/renzengfei/短视频/素材库/scripts/.views_tmp"

THRESHOLD=5000000  # 500万

# 清理并创建临时目录
rm -rf "$TEMP_DIR"
mkdir -p "$TEMP_DIR"

# 提取所有链接到数组
LINKS=()
while IFS= read -r line; do
    LINKS+=("$line")
done < <(grep -E '^https://www\.youtube\.com/shorts/' "$INPUT_FILE")

TOTAL=${#LINKS[@]}

echo "共发现 $TOTAL 个链接，开始检测播放量..."
echo "链接,播放量" > "$LOG_FILE"

# 并发获取播放量的函数
fetch_views() {
    local idx=$1
    local url=$2
    local result_file="$TEMP_DIR/result_$(printf '%04d' $idx)"
    
    VIEW_COUNT=$(yt-dlp --skip-download --print "%(view_count)s" --cookies-from-browser chrome --no-warnings --socket-timeout 15 "$url" 2>/dev/null)
    
    if [ -z "$VIEW_COUNT" ] || [ "$VIEW_COUNT" = "NA" ] || [ "$VIEW_COUNT" = "None" ]; then
        echo "FAIL|$url|0" > "$result_file"
    else
        echo "OK|$url|$VIEW_COUNT" > "$result_file"
    fi
}

MAX_JOBS=5
echo "使用 $MAX_JOBS 并发获取中..."

RUNNING=0
for i in $(seq 1 $TOTAL); do
    idx=$((i - 1))
    url="${LINKS[$i]}"  # zsh数组从1开始
    echo "[$i/$TOTAL] 提交: $url"
    
    fetch_views "$idx" "$url" &
    RUNNING=$((RUNNING + 1))
    
    # 控制并发数
    if [ "$RUNNING" -ge "$MAX_JOBS" ]; then
        wait -n 2>/dev/null || { sleep 2; }
        RUNNING=$((RUNNING - 1))
    fi
done

# 等待所有任务完成
wait
echo ""
echo "所有链接检测完毕，正在整理结果..."

# 汇总结果
HIGH_LINKS=()
LOW_LINKS=()
FAIL_LINKS=()

for i in $(seq 0 $((TOTAL - 1))); do
    result_file="$TEMP_DIR/result_$(printf '%04d' $i)"
    if [ -f "$result_file" ]; then
        line=$(cat "$result_file")
        status=$(echo "$line" | cut -d'|' -f1)
        url=$(echo "$line" | cut -d'|' -f2)
        views=$(echo "$line" | cut -d'|' -f3)
        
        echo "$url,$views" >> "$LOG_FILE"
        
        if [ "$status" = "FAIL" ]; then
            FAIL_LINKS+=("$url")
            echo "  ⚠️  $url - 获取失败"
        elif [ "$views" -ge "$THRESHOLD" ] 2>/dev/null; then
            HIGH_LINKS+=("$url")
            views_formatted=$(printf "%'d" "$views" 2>/dev/null || echo "$views")
            echo "  ✅ $url - $views_formatted 次播放"
        else
            LOW_LINKS+=("$url")
            views_formatted=$(printf "%'d" "$views" 2>/dev/null || echo "$views")
            echo "  ⬇️  $url - $views_formatted 次播放 (<500万)"
        fi
    fi
done

echo ""
echo "========== 统计结果 =========="
echo "≥500万播放: ${#HIGH_LINKS[@]} 个"
echo "<500万播放: ${#LOW_LINKS[@]} 个"
echo "获取失败:   ${#FAIL_LINKS[@]} 个"

# 生成排序后的文件
{
    for link in "${HIGH_LINKS[@]}"; do
        echo "$link"
    done
    for link in "${FAIL_LINKS[@]}"; do
        echo "$link"
    done
    echo ""
    echo ""
    echo "---"
    echo ""
    echo "# 以下链接播放量低于500万"
    echo ""
    for link in "${LOW_LINKS[@]}"; do
        echo "$link"
    done
} > "$OUTPUT_FILE"

# 清理临时文件
rm -rf "$TEMP_DIR"

echo ""
echo "✅ 排序结果已保存到: $OUTPUT_FILE"
echo "📊 详细播放量日志: $LOG_FILE"
echo ""
echo "如果确认无误，可以用以下命令替换原文件:"
echo "  cp \"$OUTPUT_FILE\" \"$INPUT_FILE\""
