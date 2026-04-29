#!/usr/bin/env python3
"""批量自动合并 Whisper + YouTube 字幕 → yt-<ytid>-merged.json

算法：
1. YouTube 骨架为主，Whisper 补专名、校对
2. 专名字典修正（常驻 8 人 + title hashtag）
3. YouTube 全大写还原成句首大写
4. 相邻 YouTube 段的「语法连续」合并（前段不以句号结尾 + 后段小写开头）
5. 每条 YouTube 段用最大时间重叠匹配一条 Whisper 段
6. 两家相似（编辑距离 ≤ 20%）→ 用 Whisper（专名更准）
7. Whisper 明显缩水（< 50% 长度）→ 用 YouTube（Whisper 吞字）
8. 只有 Whisper：直接拷到 merged
"""
import os, re, json, sqlite3, sys
from pathlib import Path
from datetime import datetime, timezone

DB = '/Users/renzengfei/短视频/素材库/database.db'
CACHE = Path('/Users/renzengfei/短视频/素材库/transcripts')

CANONICAL = ['Jinu', 'Rumi', 'Mira', 'Zoye', 'Abby', 'Baby', 'Romance', 'Mystery']

# 已知常见错识（从 AI 子代理归纳）
KNOWN_FIXES = {
    # Jinu
    'Gino': 'Jinu', 'Ginu': 'Jinu', 'Genu': 'Jinu', 'Jeanu': 'Jinu', 'Geno': 'Jinu',
    'Ginoo': 'Jinu', 'Jinnu': 'Jinu', 'Jino': 'Jinu', 'Ginyu': 'Jinu',
    # Mira
    'Mera': 'Mira', 'Mery': 'Mira', 'Mary': 'Mira',
    # Zoye
    'Zoey': 'Zoye', 'Zoe': 'Zoye', 'Joey': 'Zoye', 'Zoi': 'Zoye', 'Zo': 'Zoye',
    # Abby
    'Abbie': 'Abby', 'Abbey': 'Abby',
    # Rumi
    'Rummy': 'Rumi', 'Roomi': 'Rumi', 'Rumy': 'Rumi', 'Roomie': 'Rumi', 'Ruby': 'Rumi',
}

COMMON_ENGLISH = {
    'The','Yo','Let','Wait','Look','Oh','Okay','Yeah','Yes','No','And','But','Or','So',
    'Hey','Hi','Hello','Bro','Man','Girl','God','Boy','Sir','Dude',
    'Give','Take','Come','Go','Get','Run','Stop','Help','Watch','Simply',
    'This','That','Here','There','These','Those','Now','Then','Again','Off','On','Up','Down',
    'What','Who','When','Where','Why','How','It','Its','My','Your','Our','His','Her','Their',
    'I','You','We','He','She','They','One','Two','Three','Some','Any','All','No','More',
    'Don','Can','Will','Would','Should','Could','Must','Do','Did','Does','Have','Has','Had',
    'Been','Being','Be','Am','Is','Are','Was','Were',
    'Heaven','Popcorn','Gold','Cardio','Perfection','Even','Ever','Home','Viral','Smell','Smells','Insane',
    'Keep','First','Thing','Best','Tasted','Think','About','Running','Trash','Back',
    'Before','After','During','While','Since','Until',
    'Spider','Man','Mine','Us',
}


def levenshtein(a, b):
    if a == b: return 0
    if not a: return len(b)
    if not b: return len(a)
    prev = list(range(len(b) + 1))
    for i, ca in enumerate(a, 1):
        curr = [i]
        for j, cb in enumerate(b, 1):
            curr.append(min(prev[j] + 1, curr[-1] + 1, prev[j-1] + (0 if ca == cb else 1)))
        prev = curr
    return prev[-1]


def extract_hashtag_names(title):
    if not title: return []
    return re.findall(r'#([A-Za-z][A-Za-z0-9_]*)', title)


def build_name_dict(title):
    names = list(CANONICAL)
    lower_set = {n.lower() for n in names}
    for h in extract_hashtag_names(title):
        # 跳过标签词
        if h.lower() in {'kpop','shorts','short','katebrush','demon','hunters','kpopdemon','k-pop'}:
            continue
        # 只有长度合理才视为专名
        if 2 <= len(h) <= 12 and h.lower() not in lower_set:
            names.append(h[0].upper() + h[1:].lower())
            lower_set.add(h.lower())
    return names


def fix_proper_nouns(text, names):
    """替换 text 中的音近错识专名"""
    if not text: return text
    name_lower_to_canon = {n.lower(): n for n in names}

    def fix_token(m):
        tok = m.group(0)
        # 1) 已知错识表（精确）
        if tok in KNOWN_FIXES:
            return KNOWN_FIXES[tok]
        # 2) 句中大写词里找音近的专名（跳过句首 & 常见英文词）
        if tok in COMMON_ENGLISH:
            return tok
        tl = tok.lower()
        if tl in name_lower_to_canon:
            return name_lower_to_canon[tl]  # 已对，只规范大小写
        # 音近匹配（谨慎，只对长度 ≥ 3 的 token）
        if len(tok) < 3: return tok
        best = None
        for lc, canon in name_lower_to_canon.items():
            if abs(len(tl) - len(lc)) > 2: continue
            d = levenshtein(tl, lc)
            threshold = 1 if len(lc) <= 4 else 2
            if d <= threshold and (best is None or d < best[1]):
                best = (canon, d)
        if best and best[1] > 0:
            return best[0]
        return tok

    return re.sub(r"[A-Z][a-zA-Z']*", fix_token, text)


def decaps(text):
    """整句全大写还原为句首大写"""
    letters = [c for c in text if c.isalpha()]
    if len(letters) < 6 or not all(c.isupper() for c in letters):
        return text
    lower = text.lower()
    result = []
    cap_next = True
    for c in lower:
        if cap_next and c.isalpha():
            result.append(c.upper())
            cap_next = False
        else:
            result.append(c)
        if c in '.!?':
            cap_next = True
    s = ''.join(result)
    s = re.sub(r'\bi\b', 'I', s)
    s = re.sub(r"\bi'", "I'", s)
    return s


def clean_youtube_text(text):
    if not text: return text
    text = re.sub(r'^\s*>>\s*', '', text)
    # 去掉 YouTube 非语音标注 [music] / [laughter] / [applause] 等
    text = re.sub(r'\s*\[[a-zA-Z ]+\]\s*', ' ', text)
    text = decaps(text)
    text = re.sub(r'\s+', ' ', text).strip()
    return text


def merge_adjacent_youtube(segs):
    """前段不以句号/感叹/问号结尾 + 后段首字母小写 → 合并成一段"""
    out = []
    for s in segs:
        if out:
            prev = out[-1]['text']
            cur = s['text']
            if prev and cur and not re.search(r'[.!?]["\'\)]?\s*$', prev) and cur[0].islower():
                out[-1] = {**out[-1], 'text': (prev + ' ' + cur).strip(), 'end': s['end']}
                continue
        out.append(dict(s))
    return out


def norm_for_sim(s):
    return re.sub(r'[^a-z0-9]', '', s.lower())


def texts_similar(a, b):
    na, nb = norm_for_sim(a), norm_for_sim(b)
    if not na or not nb: return False
    if na == nb: return True
    d = levenshtein(na, nb)
    return d / max(len(na), len(nb)) <= 0.25


def pick_text_and_source(ytext, wtext):
    if not ytext and not wtext:
        return None, None
    if not wtext:
        return ytext, 'youtube'
    if not ytext:
        return wtext, 'whisper'
    if texts_similar(ytext, wtext):
        return wtext, 'whisper'  # 同一句 → Whisper 专名更准
    # 内容明显不同
    if len(wtext.strip()) < len(ytext.strip()) * 0.5:
        return ytext, 'youtube'  # Whisper 吞字
    return wtext, 'whisper'


def merge_one(video_id, ytid, title, whisper_data, youtube_data):
    names = build_name_dict(title)
    w_segs_raw = (whisper_data or {}).get('segments', []) or []
    y_segs_raw = ((youtube_data or {}).get('segments', []) or []) if (youtube_data and youtube_data.get('available')) else []

    # 预清洗
    w_segs = [{'start': s.get('start', 0), 'end': s.get('end', 0),
               'text': fix_proper_nouns(s.get('text', '').strip(), names)} for s in w_segs_raw]
    y_segs = [{'start': s.get('start', 0), 'end': s.get('end', 0),
               'text': fix_proper_nouns(clean_youtube_text(s.get('text', '')), names)} for s in y_segs_raw]
    y_segs = merge_adjacent_youtube(y_segs)

    # 只有 Whisper
    if not y_segs:
        return [{'start': s['start'], 'end': s['end'], 'text': s['text'], 'source': 'whisper'}
                for s in w_segs if s['text']]

    # YouTube 做骨架，只有「时间接近 + 文本相似」才配对，避免一家盖另一家
    pairs = []
    for i, y in enumerate(y_segs):
        for j, w in enumerate(w_segs):
            ov = min(y['end'], w['end']) - max(y['start'], w['start'])
            gap = max(y['start'] - w['end'], w['start'] - y['end'])
            time_near = ov > 0 or gap <= 1.0
            if not time_near:
                continue
            if not texts_similar(y['text'], w['text']):
                continue  # 文本不同 = 不是同一句话，不配对（YouTube 保留原词，Whisper 留作孤儿行）
            pairs.append((i, j, ov if ov > 0 else 0.01))
    pairs.sort(key=lambda p: -p[2])
    y_to_w = {}
    w_used = set()
    for i, j, ov in pairs:
        if i in y_to_w or j in w_used: continue
        y_to_w[i] = j
        w_used.add(j)

    items = []
    for i, y in enumerate(y_segs):
        w = w_segs[y_to_w[i]] if i in y_to_w else None
        ytext = y['text']
        wtext = w['text'] if w else ''
        text, src = pick_text_and_source(ytext, wtext)
        if not text: continue
        items.append({'start': y['start'], 'end': y['end'], 'text': text, 'source': src})

    # Whisper 里没匹配上的（YouTube 完全漏掉那段）插回
    for j, w in enumerate(w_segs):
        if j in w_used or not w['text']: continue
        items.append({'start': w['start'], 'end': w['end'], 'text': w['text'], 'source': 'whisper'})
    items.sort(key=lambda x: x['start'])
    return _final_dedup(items)


def _final_dedup(items):
    """去重：若 A 的规范化文本包含 B 的规范化文本（B 严格更短），且两者时间邻近（起止差 ≤ 3 秒），丢 B"""
    n = len(items)
    drop = set()
    norms = [norm_for_sim(x['text']) for x in items]
    for i in range(n):
        if i in drop: continue
        for j in range(n):
            if i == j or j in drop: continue
            ni, nj = norms[i], norms[j]
            if not ni or not nj or ni == nj: continue
            if len(ni) <= len(nj): continue
            if nj not in ni: continue
            a, b = items[i], items[j]
            # 时间邻近：任一端点差 ≤ 3 秒
            if abs(a['start'] - b['start']) <= 3.0 or abs(a['end'] - b['end']) <= 3.0 \
               or (a['start'] <= b['start'] and a['end'] >= b['end']):
                drop.add(j)
    return [x for k, x in enumerate(items) if k not in drop]


def load_cache(path):
    if not path.exists(): return None
    try:
        return json.load(open(path, 'r', encoding='utf-8'))
    except Exception:
        return None


def main():
    conn = sqlite3.connect(DB)
    rows = conn.execute("""
    SELECT v.id, t.youtube_video_id, v.video_title, t.title
    FROM videos v
    JOIN import_tasks t ON t.id = (SELECT MAX(id) FROM import_tasks WHERE source_video_id = v.id)
    WHERE t.youtube_video_id IS NOT NULL AND t.youtube_video_id != ''
    ORDER BY v.id
    """).fetchall()

    stats = {'total': 0, 'skipped_existing': 0, 'merged_with_youtube': 0,
             'only_whisper': 0, 'no_whisper': 0, 'no_cache': 0}

    skip_existing = '--force' not in sys.argv

    for vid, ytid, vtitle, ttitle in rows:
        stats['total'] += 1
        title = (vtitle or ttitle or '').strip()
        merged_path = CACHE / f'yt-{ytid}-merged.json'

        if merged_path.exists():
            # 即使 --force 也保护人工版：revisionNote 不是 'auto-merge by script' 的跳过
            try:
                existing = json.load(open(merged_path, 'r', encoding='utf-8'))
                if existing.get('revisionNote', '') != 'auto-merge by script':
                    stats['skipped_existing'] += 1
                    continue
            except Exception:
                pass  # 坏 JSON，当成可覆盖
            if skip_existing:
                stats['skipped_existing'] += 1
                continue

        whisper_path = None
        for candidate in (CACHE / f'{vid}.json', CACHE / f'yt-{ytid}.json'):
            if candidate.exists():
                whisper_path = candidate; break
        youtube_path = CACHE / f'yt-{ytid}-youtube.json'

        wdata = load_cache(whisper_path) if whisper_path else None
        ydata = load_cache(youtube_path)

        if not wdata and not ydata:
            stats['no_cache'] += 1
            continue
        if not wdata:
            stats['no_whisper'] += 1
            continue

        segments = merge_one(vid, ytid, title, wdata, ydata)
        if not segments:
            stats['no_cache'] += 1
            continue

        y_available = bool(ydata and ydata.get('available'))
        if y_available and any(s.get('segments') for s in [ydata]):
            stats['merged_with_youtube'] += 1
        else:
            stats['only_whisper'] += 1

        payload = {
            'source': 'merged',
            'available': len(segments) > 0,
            'language': (wdata or {}).get('language', 'en'),
            'duration': segments[-1]['end'] if segments else 0,
            'revisedAt': datetime.now(timezone.utc).isoformat(),
            'revisionNote': 'auto-merge by script',
            'segments': segments,
        }
        with open(merged_path, 'w', encoding='utf-8') as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)

    print(json.dumps(stats, indent=2))


if __name__ == '__main__':
    main()
