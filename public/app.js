// ==================== 状态管理 ====================
let videos = [];
let allVideos = []; // 完整列表（用于筛选）
let currentView = 'all';
let currentVideoId = null;
let currentPage = 1;
const itemsPerPage = 10; // 每页显示机制组数量

// ==================== DOM 元素 ====================
const $videoList = document.getElementById('video-list');
const $summaryView = document.getElementById('summary-view');
const $emptyState = document.getElementById('empty-state');
const $videoCount = document.getElementById('video-count');
const $searchInput = document.getElementById('search-input');
const $modalOverlay = document.getElementById('modal-overlay');
const $detailOverlay = document.getElementById('detail-overlay');
const $modalTitle = document.getElementById('modal-title');
const $detailTitle = document.getElementById('detail-title');
const $detailContent = document.getElementById('detail-content');

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  loadVideos();
  bindEvents();
});

function bindEvents() {
  // 新增按钮
  document.getElementById('btn-add-video').addEventListener('click', () => openModal());

  // 关闭弹窗
  document.getElementById('btn-close-modal').addEventListener('click', closeModal);
  document.getElementById('btn-cancel').addEventListener('click', closeModal);
  document.getElementById('btn-close-detail').addEventListener('click', closeDetail);

  // 保存
  document.getElementById('btn-save').addEventListener('click', saveVideo);

  // 编辑 & 删除
  document.getElementById('btn-edit').addEventListener('click', () => {
    closeDetail();
    const video = videos.find(v => v.id === currentVideoId);
    if (video) openModal(video);
  });
  document.getElementById('btn-delete').addEventListener('click', deleteVideo);

  // 搜索
  let searchTimeout;
  $searchInput.addEventListener('input', () => {
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      const q = $searchInput.value.trim();
      if (q) {
        searchVideos(q);
      } else {
        loadVideos();
      }
    }, 300);
  });

  // 视图切换
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
      tab.classList.add('active');
      currentView = tab.dataset.view;
      switchView();
    });
  });

  // 筛选
  document.getElementById('filter-video-tag').addEventListener('change', applyFilters);
  document.getElementById('filter-hook-tag').addEventListener('change', applyFilters);
  document.getElementById('filter-mechanism').addEventListener('change', applyFilters);

  // 动态添加行
  document.querySelectorAll('.btn-add-row').forEach(btn => {
    btn.addEventListener('click', () => addDynamicRow(btn.dataset.target));
  });

  // 点击蒙层关闭
  $modalOverlay.addEventListener('click', (e) => {
    if (e.target === $modalOverlay) closeModal();
  });
  $detailOverlay.addEventListener('click', (e) => {
    if (e.target === $detailOverlay) closeDetail();
  });

  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeDetail();
    }
  });
}

// ==================== 数据加载 ====================
async function loadVideos() {
  try {
    const res = await fetch('/api/videos');
    allVideos = await res.json();
    populateFilters();
    applyFilters();
  } catch (err) {
    showToast('加载失败: ' + err.message, 'error');
  }
}

async function searchVideos(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    allVideos = await res.json();
    currentPage = 1;
    applyFilters();
  } catch (err) {
    showToast('搜索失败: ' + err.message, 'error');
  }
}

// ==================== 筛选 & 排序 ====================
function populateFilters() {
  const videoTags = new Set();
  const hookTags = new Set();
  const mechanisms = new Set();

  allVideos.forEach(v => {
    (v.video_tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => videoTags.add(t));
    (v.hook_tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => hookTags.add(t));
    if (v.mechanism_name) mechanisms.add(v.mechanism_name);
  });

  fillSelect('filter-video-tag', '视频标签', videoTags);
  fillSelect('filter-hook-tag', '开头标签', hookTags);
  fillSelect('filter-mechanism', '机制', mechanisms);
}

function fillSelect(id, placeholder, items) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    [...items].sort().map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('');
  el.value = current; // 保留当前选中
}

function applyFilters() {
  const fVideoTag = document.getElementById('filter-video-tag').value;
  const fHookTag = document.getElementById('filter-hook-tag').value;
  const fMechanism = document.getElementById('filter-mechanism').value;

  // 筛选
  let filtered = allVideos.filter(v => {
    if (fVideoTag && !(v.video_tags || '').split(',').map(t => t.trim()).includes(fVideoTag)) return false;
    if (fHookTag && !(v.hook_tags || '').split(',').map(t => t.trim()).includes(fHookTag)) return false;
    if (fMechanism && v.mechanism_name !== fMechanism) return false;
    return true;
  });

  videos = filtered;
  currentPage = 1;
  renderCurrentView();
  renderStats();
}

// ==================== 标签分布统计 ====================
function renderStats() {
  const $stats = document.getElementById('stats-bar');
  if (currentView !== 'all' || allVideos.length === 0) {
    $stats.style.display = 'none';
    return;
  }

  const tagCounts = {};
  allVideos.forEach(v => {
    (v.video_tags || '').split(',').map(t => t.trim()).filter(Boolean)
      .forEach(t => { tagCounts[t] = (tagCounts[t] || 0) + 1; });
  });

  const sorted = Object.entries(tagCounts).sort((a, b) => b[1] - a[1]);
  if (sorted.length === 0) { $stats.style.display = 'none'; return; }

  $stats.style.display = '';
  $stats.innerHTML = sorted.map(([tag, count]) =>
    `<span class="stat-pill" data-tag="${escapeHtml(tag)}"><span class="stat-dot"></span>${escapeHtml(tag)} <span class="stat-count">${count}</span></span>`
  ).join('');

  // 点击统计标签触发筛选
  $stats.querySelectorAll('.stat-pill').forEach(pill => {
    pill.addEventListener('click', () => {
      const tag = pill.dataset.tag;
      const sel = document.getElementById('filter-video-tag');
      sel.value = sel.value === tag ? '' : tag;
      applyFilters();
    });
  });
}

// ==================== 视图切换 ====================
function switchView() {
  if (currentView === 'all') {
    $videoList.style.display = '';
    $summaryView.style.display = 'none';
    renderVideoList();
  } else {
    $videoList.style.display = 'none';
    $summaryView.style.display = '';
    loadSummaryView(currentView);
  }
}

function renderCurrentView() {
  $videoCount.textContent = `${videos.length} 个视频`;
  if (currentView === 'all') {
    renderVideoList();
  } else {
    loadSummaryView(currentView);
  }
}

// ==================== 视频表格列表 ====================
function renderVideoList() {
  $summaryView.style.display = 'none';
  $videoList.style.display = '';

  if (videos.length === 0) {
    $videoList.style.display = 'none';
    $emptyState.style.display = '';
    return;
  }
  $emptyState.style.display = 'none';

  const tagsHtml = (str, cls) => (str || '').split(',').filter(t => t.trim())
    .map(t => `<span class="tag ${cls}">${escapeHtml(t.trim())}</span>`).join('');

  const formatNum = n => {
    if (!n) return '-';
    const num = parseInt(n);
    if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
    if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
    return num.toLocaleString();
  };

  // 按机制名称分组
  const groups = new Map();
  // 先按 ID 倒序排列（最新录入在前），确定组间顺序
  const sortedById = [...videos].sort((a, b) => b.id - a.id);
  
  // 先全量按机制名称分组
  for (const v of sortedById) {
    const key = v.mechanism_name || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }

  // 将 Map 转换为数组以便进行分页
  const groupEntries = Array.from(groups.entries());

  // 计算机制的分页
  const totalPages = Math.ceil(groupEntries.length / itemsPerPage);
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  else if (currentPage < 1) currentPage = 1;
  
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedGroups = groupEntries.slice(startIndex, startIndex + itemsPerPage);

  // 组内按发布日期升序（越早越靠上）
  for (const [, vids] of paginatedGroups) {
    vids.sort((a, b) => (a.publish_date || '').localeCompare(b.publish_date || ''));
  }

  const renderCard = v => {
    const thumbSrc = v.thumb_url || '';
    const thumbLink = v.video_link || v.video_path || '';
    return `
    <div class="video-card" data-id="${v.id}">
      <div class="card-thumb">
        ${thumbSrc
          ? `<a href="${escapeHtml(thumbLink)}" target="_blank" onclick="event.stopPropagation()" title="点击查看视频">
               <img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy">
               <span class="card-play">▶</span>
             </a>`
          : '<div class="card-thumb-empty">无封面</div>'}
        ${v.duration ? `<span class="card-duration">${v.duration}s</span>` : ''}
      </div>
      <div class="card-info">
        <div class="card-header">
          <span class="card-id">#${v.id}</span>
          <div class="card-title" title="${escapeHtml(v.name)}">${escapeHtml(v.name)}</div>
          <button class="btn-copy-title" onclick="event.stopPropagation(); copyToClipboard('${escapeHtml(v.name).replace(/'/g, "\\'")}')" title="复制标题">
            <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
          </button>
        </div>

        <div class="card-tags">${tagsHtml(v.video_tags, 'tag-video') || ''}</div>
        <div class="card-hook-section">
          ${tagsHtml(v.hook_tags, 'tag-hook') ? `<div class="card-hook-tags">${tagsHtml(v.hook_tags, 'tag-hook')}</div>` : ''}
          ${v.hook ? `
            <div class="card-hook-body">
              <div class="card-hook">${escapeHtml(v.hook)}</div>
              <button class="btn-copy-hook" onclick="event.stopPropagation(); copyToClipboard('${escapeHtml(v.hook).replace(/'/g, "\\'")}')" title="复制开头剧情">
                <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
              </button>
            </div>
          ` : ''}
        </div>
        <div class="card-meta">
          <div class="card-stats">
            <span class="card-views">👁 ${formatNum(v.views)}</span>
            ${v.publish_date ? `<span class="card-date">${v.publish_date}</span>` : ''}
          </div>
          <button class="btn-notes ${v.notes ? 'has-notes' : ''}" onclick="event.stopPropagation(); openNotes(${v.id})" title="${v.notes ? escapeHtml(v.notes).substring(0,50) : '添加备注'}">${v.notes ? '📝' : '➕'}</button>
        </div>
      </div>
    </div>
  `};

  let html = '';
  for (const [mechanism, vids] of paginatedGroups) {
    html += `
      <div class="mechanism-group">
        <div class="mechanism-header">
          <div class="mechanism-header-left">
            <span class="mechanism-name">⚙️ ${escapeHtml(mechanism)}</span>
            <span class="mechanism-count">${vids.length} 个视频</span>
          </div>
          ${vids[0].mechanism ? `<div class="mechanism-chain">${escapeHtml(vids[0].mechanism)}</div>` : ''}
        </div>
        <div class="card-grid">
          ${vids.map(renderCard).join('')}
        </div>
      </div>
    `;
  }

  $videoList.innerHTML = html;

  // 渲染分页器
  renderPagination(totalPages);

  // 绑定卡片点击 → 详情
  document.querySelectorAll('.video-card').forEach(card => {
    card.addEventListener('click', () => {
      const id = parseInt(card.dataset.id);
      showDetail(id);
    });
  });
}

function renderPagination(totalPages) {
  const $pagination = document.getElementById('pagination');
  if (totalPages <= 1) {
    $pagination.style.display = 'none';
    return;
  }
  
  $pagination.style.display = 'flex';
  let html = '';
  
  html += `<button class="page-btn" ${currentPage <= 1 ? 'disabled' : ''} onclick="changePage(${currentPage - 1})">上一页</button>`;
  
  for (let i = 1; i <= totalPages; i++) {
    if (i === 1 || i === totalPages || (i >= currentPage - 2 && i <= currentPage + 2)) {
      html += `<button class="page-btn ${i === currentPage ? 'active' : ''}" onclick="changePage(${i})">${i}</button>`;
    } else if (i === currentPage - 3 || i === currentPage + 3) {
      html += `<span class="page-dot">...</span>`;
    }
  }

  html += `<button class="page-btn" ${currentPage >= totalPages ? 'disabled' : ''} onclick="changePage(${currentPage + 1})">下一页</button>`;
  $pagination.innerHTML = html;
}

window.changePage = function(p) {
  currentPage = p;
  renderCurrentView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};


// ==================== 汇总视图 ====================
async function loadSummaryView(type) {
  try {
    const res = await fetch(`/api/${type}`);
    const data = await res.json();

    $videoList.style.display = 'none';
    $emptyState.style.display = 'none';
    $summaryView.style.display = '';

    const labels = {
      scenes: { title: '场景', cols: [{ key: 'name', label: '场景名称' }, { key: 'function', label: '场景功能' }] },
      props: { title: '道具', cols: [{ key: 'name', label: '道具名称' }, { key: 'type', label: '类型' }, { key: 'function', label: '作用' }] },
      characters: { title: '角色', cols: [{ key: 'name', label: '角色名称' }, { key: 'persona', label: '人设' }] }
    };

    const label = labels[type];

    $summaryView.innerHTML = `
      <table>
        <thead>
          <tr>
            ${label.cols.map(c => `<th>${c.label}</th>`).join('')}
            <th>来源视频</th>
          </tr>
        </thead>
        <tbody>
          ${data.map(item => `
            <tr>
              ${label.cols.map(c => `<td>${c.key === 'name' ? `<strong>${escapeHtml(item.name)}</strong>` : escapeHtml(item[c.key] || '-')}</td>`).join('')}
              <td><a class="video-link" data-id="${item.video_id}">${escapeHtml(item.video_name)}</a></td>
            </tr>
          `).join('')}
          ${data.length === 0 ? `<tr><td colspan="${label.cols.length + 1}" style="text-align:center;color:var(--text-muted);padding:40px">暂无数据</td></tr>` : ''}
        </tbody>
      </table>
    `;

    // 绑定来源视频链接
    $summaryView.querySelectorAll('.video-link').forEach(link => {
      link.addEventListener('click', (e) => {
        e.preventDefault();
        showDetail(parseInt(link.dataset.id));
      });
    });
  } catch (err) {
    showToast('加载汇总失败: ' + err.message, 'error');
  }
}

// ==================== 详情弹窗 ====================
function showDetail(id) {
  const video = videos.find(v => v.id === id);
  if (!video) {
    fetch(`/api/videos/${id}`)
      .then(r => r.json())
      .then(v => renderDetail(v))
      .catch(err => showToast('加载详情失败', 'error'));
    return;
  }
  renderDetail(video);
}

function renderDetail(video) {
  currentVideoId = video.id;
  $detailTitle.textContent = video.name;

  // 视频链接按钮栏
  const linkBtns = [];
  if (video.video_link) linkBtns.push(`<a href="${escapeHtml(video.video_link)}" target="_blank" class="detail-video-btn btn-youtube" title="打开 YouTube"><span class="btn-icon">▶</span> YouTube 原片</a>`);
  if (video.video_path) linkBtns.push(`<a href="${escapeHtml(video.video_path)}" target="_blank" class="detail-video-btn btn-oss" title="打开 OSS 备份"><span class="btn-icon">☁</span> 阿里云备份</a>`);

  let html = `
    ${linkBtns.length > 0 ? `<div class="detail-video-links">${linkBtns.join('')}</div>` : ''}
    ${video.thumb_url ? `<div class="detail-thumb-preview"><img src="${escapeHtml(video.thumb_url)}" alt="缩略图" class="detail-thumb-img"></div>` : ''}
    <div class="detail-meta">
      <span>📅 录入 ${video.date || '未填写'}</span>
      ${video.duration ? `<span>⏱ ${video.duration}s</span>` : ''}
      ${video.publish_date ? `<span>📆 发布 ${video.publish_date}</span>` : ''}
      ${video.views ? `<span>👁 ${Number(video.views).toLocaleString()}</span>` : ''}
      ${video.likes ? `<span>👍 ${Number(video.likes).toLocaleString()}</span>` : ''}
    </div>
  `;

  // 视频分析
  const analysisFields = [
    { key: 'summary', label: '📖 故事大纲', multi: true },
    { key: 'hook_tags', label: '🏷️ 开头标签' },
    { key: 'hook', label: '🎯 开头' },
    { key: 'video_tags', label: '🏷️ 视频标签' },
    { key: 'technique', label: '🎭 标签手法' },
    { key: 'mechanism_name', label: '🔗 机制名称' },
    { key: 'mechanism', label: '⚙️ 机制链条' },
    { key: 'protagonist', label: '🦸 主角' },
    { key: 'protagonist_goal', label: '🎯 主角目标' },
    { key: 'antagonist', label: '🦹 反派' },
    { key: 'antagonist_goal', label: '💣 反派目标' },
  ];

  html += `<div class="detail-section"><h3>🔍 视频分析</h3>`;
  for (const f of analysisFields) {
    html += `
      <div class="detail-field">
        <span class="detail-field-label">${f.label}</span>
        <div class="detail-field-value${f.multi ? ' multi-line' : ''}">${video[f.key] ? escapeHtml(video[f.key]) : '<span style="color:var(--text-muted)">-</span>'}</div>
      </div>
    `;
  }
  html += `</div>`;

  // 改编溯源
  if (video.adapt_tags || video.adapt_brief || video.source_video_id) {
    html += `<div class="detail-section"><h3>🔄 改编溯源</h3>`;
    if (video.adapt_tags) {
      html += `<div class="detail-field"><span class="detail-field-label">改编标签</span><div class="detail-field-value">${escapeHtml(video.adapt_tags)}</div></div>`;
    }
    if (video.adapt_brief) {
      html += `<div class="detail-field"><span class="detail-field-label">改编简介</span><div class="detail-field-value">${escapeHtml(video.adapt_brief)}</div></div>`;
    }
    if (video.source_video_id) {
      const sourceVideo = allVideos.find(v => v.id === video.source_video_id);
      const sourceName = sourceVideo ? sourceVideo.name : `ID: ${video.source_video_id}`;
      html += `<div class="detail-field"><span class="detail-field-label">母版视频</span><div class="detail-field-value"><a href="#" class="detail-link source-video-link" data-id="${video.source_video_id}">📎 ${escapeHtml(sourceName)}</a></div></div>`;
    }
    html += `</div>`;
  }

  // 场景
  if (video.scenes && video.scenes.length > 0) {
    html += `
      <div class="detail-section">
        <h3>🏠 场景</h3>
        ${video.scenes.map(s => `
          <div class="detail-item">
            <div class="detail-item-name">${escapeHtml(s.name)}</div>
            ${s.function ? `<div class="detail-item-desc">${escapeHtml(s.function)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // 道具
  if (video.props && video.props.length > 0) {
    html += `
      <div class="detail-section">
        <h3>🔧 道具</h3>
        ${video.props.map(p => `
          <div class="detail-item">
            <div class="detail-item-name">${escapeHtml(p.name)}${p.type ? ` <span class="detail-item-type">${escapeHtml(p.type)}</span>` : ''}</div>
            ${p.function ? `<div class="detail-item-desc">${escapeHtml(p.function)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // 角色
  if (video.characters && video.characters.length > 0) {
    html += `
      <div class="detail-section">
        <h3>👤 角色</h3>
        ${video.characters.map(c => `
          <div class="detail-item">
            <div class="detail-item-name">${escapeHtml(c.name)}</div>
            ${c.persona ? `<div class="detail-item-desc">${escapeHtml(c.persona)}</div>` : ''}
          </div>
        `).join('')}
      </div>
    `;
  }

  // 链接 & 元数据
  const metaItems = [];
  if (video.video_title) metaItems.push(`<div class="detail-field"><span class="detail-field-label">视频标题</span><div class="detail-field-value">${escapeHtml(video.video_title)}</div></div>`);
  if (video.video_link) metaItems.push(`<div class="detail-field"><span class="detail-field-label">🔗 视频链接</span><div class="detail-field-value"><a href="${escapeHtml(video.video_link)}" target="_blank" class="detail-link">${escapeHtml(video.video_link)}</a></div></div>`);
  if (video.script_path) metaItems.push(`<div class="detail-field"><span class="detail-field-label">📄 脚本路径</span><div class="detail-field-value">${escapeHtml(video.script_path)}</div></div>`);

  if (metaItems.length > 0) {
    html += `<div class="detail-section"><h3>📎 元数据</h3>${metaItems.join('')}</div>`;
  }

  $detailContent.innerHTML = html;
  $detailOverlay.style.display = '';

  // 母版视频链接点击
  $detailContent.querySelectorAll('.source-video-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      const sourceId = parseInt(link.dataset.id);
      showDetail(sourceId);
    });
  });
}

function closeDetail() {
  $detailOverlay.style.display = 'none';
  currentVideoId = null;
}

// ==================== 新增/编辑弹窗 ====================
// 表单字段映射：form元素id → 数据库列名
const FORM_FIELDS = {
  'form-name': 'name',
  'form-video-title': 'video_title',
  'form-duration': 'duration',
  'form-publish-date': 'publish_date',
  'form-summary': 'summary',
  'form-hook': 'hook',
  'form-hook-tags': 'hook_tags',
  'form-video-tags': 'video_tags',
  'form-technique': 'technique',
  'form-mechanism-name': 'mechanism_name',
  'form-mechanism': 'mechanism',
  'form-adapt-tags': 'adapt_tags',
  'form-adapt-brief': 'adapt_brief',
  'form-date': 'date',
  'form-video-link': 'video_link',
  'form-views': 'views',
  'form-likes': 'likes',
  'form-script-path': 'script_path',
  'form-protagonist': 'protagonist',
  'form-protagonist-goal': 'protagonist_goal',
  'form-antagonist': 'antagonist',
  'form-antagonist-goal': 'antagonist_goal'
};

function openModal(video = null) {
  $modalTitle.textContent = video ? '编辑视频' : '新增视频';
  document.getElementById('form-id').value = video ? video.id : '';

  // 填充所有字段
  for (const [formId, dbKey] of Object.entries(FORM_FIELDS)) {
    const el = document.getElementById(formId);
    if (el) {
      if (video) {
        el.value = video[dbKey] || '';
      } else {
        el.value = dbKey === 'date' ? new Date().toISOString().slice(0, 10) : '';
      }
    }
  }

  // 清空并填充动态行
  ['scenes', 'props', 'characters'].forEach(type => {
    const container = document.getElementById(`${type}-container`);
    container.innerHTML = '';

    const items = video ? (video[type] || []) : [];
    if (items.length === 0) {
      addDynamicRow(type);
    } else {
      items.forEach(item => addDynamicRow(type, item));
    }
  });

  $modalOverlay.style.display = '';
}

function closeModal() {
  $modalOverlay.style.display = 'none';
}

function addDynamicRow(type, data = null) {
  const container = document.getElementById(`${type}-container`);
  const row = document.createElement('div');
  row.className = 'dynamic-row';

  const configs = {
    scenes: [
      { key: 'name', label: '场景名称', placeholder: '如：杂乱厨房' },
      { key: 'function', label: '场景功能', placeholder: '如：制造封闭感' }
    ],
    props: [
      { key: 'name', label: '道具名称', placeholder: '如：平底锅' },
      { key: 'type', label: '类型', placeholder: '如：厨具' },
      { key: 'function', label: '作用', placeholder: '如：制造痛苦' }
    ],
    characters: [
      { key: 'name', label: '角色名称', placeholder: '如：男主' },
      { key: 'persona', label: '人设', placeholder: '如：控制者/催化者' }
    ]
  };

  const fields = configs[type];

  row.innerHTML = fields.map(f => `
    <div class="form-group">
      <label>${f.label}</label>
      <input type="text" data-key="${f.key}" placeholder="${f.placeholder}" value="${data ? escapeHtml(data[f.key] || '') : ''}">
    </div>
  `).join('') + `<button type="button" class="btn-remove-row" title="删除">×</button>`;

  row.querySelector('.btn-remove-row').addEventListener('click', () => {
    row.remove();
  });

  container.appendChild(row);
}

// ==================== 保存 ====================
async function saveVideo() {
  const id = document.getElementById('form-id').value;
  const name = document.getElementById('form-name').value.trim();
  const date = document.getElementById('form-date').value;

  if (!name) {
    showToast('请填写视频名称', 'error');
    return;
  }
  if (!date) {
    showToast('请填写录入日期', 'error');
    return;
  }

  // 收集所有字段
  const body = {};
  for (const [formId, dbKey] of Object.entries(FORM_FIELDS)) {
    const el = document.getElementById(formId);
    body[dbKey] = el ? el.value.trim() : '';
  }

  // 收集动态行
  body.scenes = collectDynamicRows('scenes', ['name', 'function']);
  body.props = collectDynamicRows('props', ['name', 'type', 'function']);
  body.characters = collectDynamicRows('characters', ['name', 'persona']);

  try {
    const url = id ? `/api/videos/${id}` : '/api/videos';
    const method = id ? 'PUT' : 'POST';
    const res = await fetch(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });

    if (!res.ok) {
      const err = await res.json();
      throw new Error(err.error || '保存失败');
    }

    closeModal();
    showToast(id ? '已更新' : '已添加', 'success');
    loadVideos();
  } catch (err) {
    showToast('保存失败: ' + err.message, 'error');
  }
}

function collectDynamicRows(type, keys) {
  const container = document.getElementById(`${type}-container`);
  const rows = container.querySelectorAll('.dynamic-row');
  const result = [];
  rows.forEach(row => {
    const item = {};
    keys.forEach(key => {
      const input = row.querySelector(`[data-key="${key}"]`);
      item[key] = input ? input.value.trim() : '';
    });
    if (item[keys[0]]) result.push(item);
  });
  return result;
}

// ==================== 删除 ====================
async function deleteVideo() {
  if (!currentVideoId) return;
  if (!confirm('确定要删除这个视频吗？')) return;

  try {
    const res = await fetch(`/api/videos/${currentVideoId}`, { method: 'DELETE' });
    if (!res.ok) throw new Error('删除失败');

    closeDetail();
    showToast('已删除', 'success');
    loadVideos();
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
}

// ==================== 工具函数 ====================
function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'success') {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), 3000);
}

// ==================== 备注功能 ====================
function openNotes(videoId) {
  const video = allVideos.find(v => v.id === videoId);
  if (!video) return;

  // 移除已有弹窗
  const existing = document.querySelector('.notes-modal-overlay');
  if (existing) existing.remove();

  const overlay = document.createElement('div');
  overlay.className = 'notes-modal-overlay';
  overlay.innerHTML = `
    <div class="notes-modal">
      <div class="notes-modal-header">
        <h3>📝 备注 - ${escapeHtml(video.name)}</h3>
        <button class="notes-close" onclick="closeNotes()">&times;</button>
      </div>
      <textarea id="notes-textarea" placeholder="输入备注内容...">${escapeHtml(video.notes || '')}</textarea>
      <div class="notes-modal-footer">
        <button class="notes-cancel" onclick="closeNotes()">取消</button>
        <button class="notes-save" onclick="saveNotes(${videoId})">保存</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);

  // 点击遮罩关闭
  overlay.addEventListener('click', (e) => {
    if (e.target === overlay) closeNotes();
  });

  // 聚焦到文本框
  const ta = document.getElementById('notes-textarea');
  ta.focus();
  ta.setSelectionRange(ta.value.length, ta.value.length);
}

function closeNotes() {
  const overlay = document.querySelector('.notes-modal-overlay');
  if (overlay) overlay.remove();
}

async function saveNotes(videoId) {
  const ta = document.getElementById('notes-textarea');
  const notes = ta.value.trim();
  try {
    const resp = await fetch(`/api/videos/${videoId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ notes })
    });
    if (!resp.ok) throw new Error('保存失败');
    // 更新本地数据
    const video = allVideos.find(v => v.id === videoId);
    if (video) video.notes = notes;
    closeNotes();
    renderVideos(allVideos);
    showToast('备注已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// 复制文本到剪贴板
function copyToClipboard(text) {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      showToast('已复制标题');
    }).catch(err => {
      console.error('复制失败', err);
      showToast('复制失败', 'error');
    });
  } else {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    try {
      document.execCommand('copy');
      showToast('已复制标题');
    } catch (err) {
      showToast('复制失败', 'error');
    }
    document.body.removeChild(ta);
  }
}
