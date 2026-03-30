// 为所有视频添加 YouTube 缩略图 URL
async function main() {
  const res = await fetch('http://localhost:3456/api/videos');
  const videos = await res.json();

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

  let updated = 0;
  let skipped = 0;
  for (const v of videos) {
    if (v.thumb_url) { skipped++; continue; }
    const vid = extractVideoId(v.video_link);
    if (!vid) { skipped++; continue; }

    const thumbUrl = `https://img.youtube.com/vi/${vid}/maxresdefault.jpg`;
    const r = await fetch(`http://localhost:3456/api/videos/${v.id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ thumb_url: thumbUrl })
    });
    if (r.ok) {
      console.log(`✅ ID=${v.id} | ${v.name} | ${vid}`);
      updated++;
    } else {
      console.log(`❌ ID=${v.id} | ${v.name}`);
    }
  }
  console.log(`\n更新完成: ✅${updated} 跳过:${skipped}`);
}
main();
