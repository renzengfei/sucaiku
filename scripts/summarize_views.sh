#!/bin/zsh
# 从临时结果文件汇总数据，生成排序后的链接文件

TEMP_DIR="/Users/renzengfei/短视频/素材库/scripts/.views_tmp"
OUTPUT_FILE="/Users/renzengfei/短视频/素材库/scripts/链接收集_sorted.md"
LOG_FILE="/Users/renzengfei/短视频/素材库/scripts/views_log.csv"

THRESHOLD=5000000

echo "链接,播放量" > "$LOG_FILE"

HIGH_LINKS=()
LOW_LINKS=()
FAIL_LINKS=()

TOTAL=204

for i in $(seq 0 $((TOTAL - 1))); do
    result_file="$TEMP_DIR/result_$(printf '%04d' $i)"
    if [ -f "$result_file" ]; then
        content=$(cat "$result_file")
        st=$(echo "$content" | cut -d'|' -f1)
        url=$(echo "$content" | cut -d'|' -f2)
        views=$(echo "$content" | cut -d'|' -f3)
        
        echo "$url,$views" >> "$LOG_FILE"
        
        if [ "$st" = "FAIL" ]; then
            FAIL_LINKS+=("$url")
            echo "  ⚠️  $url - 获取失败"
        elif [ "$views" -ge "$THRESHOLD" ] 2>/dev/null; then
            HIGH_LINKS+=("$url")
            echo "  ✅ $url - $views 次播放"
        else
            LOW_LINKS+=("$url")
            echo "  ⬇️  $url - $views 次播放 (<500万)"
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

echo ""
echo "✅ 排序结果已保存到: $OUTPUT_FILE"
echo "📊 详细播放量日志: $LOG_FILE"
