// ==================== 状态管理 ====================
let videos = [];
let allVideos = []; // 完整列表（用于筛选）
let currentView = 'all';
let currentVideoId = null;
let currentPage = window.sessionStorage ? parseInt(sessionStorage.getItem('currentPage')) || 1 : 1;
let isInitialLoad = true;
let allHookTags = new Set(); // 全局开头标签集合（供编辑器使用）
let savedScrollY = 0; // 进入编辑页面前的滚动位置
const itemsPerPage = 10; // 每页显示系列组数量

// ==================== DOM 元素 ====================
const $videoList = document.getElementById('video-list');
const $summaryView = document.getElementById('summary-view');
const $emptyState = document.getElementById('empty-state');
const $videoCount = document.getElementById('video-count');
const $searchInput = document.getElementById('search-input');
const $modalOverlay = document.getElementById('modal-overlay');
const $inlineDetailView = document.getElementById('inline-detail-view');
const $listViewContainer = document.getElementById('list-view-container');
const $inlineVideoPlayer = document.getElementById('inline-video-player');
const $inlineDetailTitle = document.getElementById('inline-detail-title');
const $inlineDetailContent = document.getElementById('inline-detail-content');
const $viewTabs = document.getElementById('view-tabs');
const $filterBar = document.getElementById('filter-bar');
const $modalTitle = document.getElementById('modal-title');

// ==================== 初始化 ====================
document.addEventListener('DOMContentLoaded', () => {
  loadVideos().then(() => {
    // 刷新时恢复编辑页面
    const hash = location.hash;
    if (hash.startsWith('#video/')) {
      const id = parseInt(hash.split('/')[1]);
      if (id) showDetail(id);
    }
  });
  bindEvents();
});

function bindEvents() {
  // 新增按钮
  document.getElementById('btn-add-video').addEventListener('click', () => showDetail(null));

  // 关闭内嵌视图返回主列表
  document.getElementById('btn-back-to-list').addEventListener('click', closeDetail);

  // 保存 & 删除
  document.getElementById('btn-save-inline').addEventListener('click', saveVideo);
  document.getElementById('btn-delete-inline').addEventListener('click', deleteVideo);

  // 标记
  document.getElementById('btn-toggle-mark').addEventListener('click', () => {
    const input = document.getElementById('form-is-marked');
    const btn = document.getElementById('btn-toggle-mark');
    if (input.value === '1') {
      input.value = '0';
      btn.innerHTML = '☆ 标记';
      btn.className = 'btn-secondary';
    } else {
      input.value = '1';
      btn.innerHTML = '★ 已标记';
      btn.className = 'btn-primary';
    }
  });

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

  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeModal();
      closeDetail();
    }
  });
}

// ==================== 数据加载 ====================
async function loadVideos(keepPage = false) {
  try {
    const res = await fetch('/api/videos');
    allVideos = await res.json();
    populateFilters();
    applyFilters(keepPage);
  } catch (err) {
    showToast('加载失败: ' + err.message, 'error');
  }
}

async function searchVideos(q) {
  try {
    const res = await fetch(`/api/search?q=${encodeURIComponent(q)}`);
    allVideos = await res.json();
    currentPage = 1;
    sessionStorage.setItem('currentPage', 1);
    applyFilters();
  } catch (err) {
    showToast('搜索失败: ' + err.message, 'error');
  }
}

// ==================== 筛选 & 排序 ====================
function populateFilters() {
  const videoTags = new Set();
  const hookTags = new Set();
  allHookTags = new Set(); // 重置全局集合
  const mechanisms = new Set();

  allVideos.forEach(v => {
    (v.video_tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => videoTags.add(t));
    (v.hook_tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => { hookTags.add(t); allHookTags.add(t); });
    if (v.mechanism_name) mechanisms.add(v.mechanism_name);
  });

  fillSelect('filter-video-tag', '视频标签', videoTags);
  fillSelect('filter-hook-tag', '开头标签', hookTags);
  fillSelect('filter-mechanism', '系列', mechanisms);
}

function fillSelect(id, placeholder, items) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    [...items].sort().map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('');
  el.value = current; // 保留当前选中
}

function applyFilters(keepPage = false) {
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
  if (!isInitialLoad && !keepPage) {
    currentPage = 1;
    sessionStorage.setItem('currentPage', 1);
  }
  isInitialLoad = false;
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

// ==================== 共享渲染组件 ====================
window.padId = id => String(id).padStart(3, '0');
window.formatVideoLabel = v => `${window.padId(v.id)}-${v.name}`;

window.tagsHtml = (str, cls) => (str || '').split(',').filter(t => t.trim())
  .map(t => `<span class="tag ${cls}">${escapeHtml(t.trim())}</span>`).join('');

window.formatViewsNum = n => {
  if (!n) return '-';
  const num = parseInt(n);
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString();
};

window.renderGlobalCard = v => {
  const thumbSrc = v.thumb_url || '';
  const thumbLink = v.preview_path ? ('/' + v.preview_path) : (v.video_link || v.video_path || '');
  return `
  <div class="video-card" data-id="${v.id}">
    <div class="card-thumb" id="thumb-container-${v.id}">
      ${thumbSrc
        ? `<div class="card-thumb-link" onclick="event.stopPropagation(); playVideoInline(${v.id}, '${escapeHtml(thumbLink)}')">
             <img src="${escapeHtml(thumbSrc)}" alt="" loading="lazy">
             <span class="card-play">▶</span>
           </div>`
        : '<div class="card-thumb-empty">无封面</div>'}
      ${v.duration ? `<span class="card-duration">${v.duration}s</span>` : ''}
    </div>
    <div class="card-info">
      <div class="card-header">
        <div class="card-title" title="${escapeHtml(window.formatVideoLabel(v))}">${v.is_marked == '1' ? '<span style="color:#f59e0b; margin-right:4px;">★</span>' : ''}${escapeHtml(window.formatVideoLabel(v))}</div>
        <button class="btn-copy-title" onclick="event.stopPropagation(); copyToClipboard('${escapeHtml(window.formatVideoLabel(v)).replace(/'/g, "\\'")}')" title="复制标题">
          <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
        </button>
      </div>

      <div class="card-tags">${window.tagsHtml(v.video_tags, 'tag-video') || ''}</div>
      <div class="card-hook-section">
        <div class="card-hook-tags-wrapper" id="hook-tags-${v.id}">
          <div class="card-hook-tags">${window.tagsHtml(v.hook_tags, 'tag-hook') || '<span class="hook-tag-empty">—</span>'}</div>
          <button class="btn-edit-hook-tags" onclick="event.stopPropagation(); openHookTagEditor(${v.id}, this)" title="编辑开头标签">
            <svg viewBox="0 0 24 24" width="11" height="11" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
          </button>
        </div>
        <div class="card-hook-body" id="hook-body-${v.id}">
          <div class="card-hook" id="hook-text-${v.id}">${escapeHtml(v.hook || '')}</div>
          <div class="hook-body-actions">
            <button class="btn-copy-hook" data-vid="${v.id}" onclick="event.stopPropagation(); copyHookById(this.dataset.vid)" title="复制开头描述">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
            <button class="btn-edit-hook" onclick="event.stopPropagation(); startEditHook(${v.id})" title="编辑开头描述">
              <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
            </button>
          </div>
        </div>
      </div>
      <div class="card-meta">
        <div class="card-stats">
          <span class="card-views">👁 ${window.formatViewsNum(v.views)}</span>
          ${v.publish_date ? `<span class="card-date">${v.publish_date}</span>` : ''}
        </div>
        <button class="btn-notes ${v.notes ? 'has-notes' : ''}" onclick="event.stopPropagation(); openNotes(${v.id})" title="${v.notes ? escapeHtml(v.notes).substring(0,50) : '添加备注'}">${v.notes ? '📝' : '➕'}</button>
      </div>
    </div>
  </div>
  `;
};

window.generateGroupedCardsHtml = function(videoList) {
  const groups = new Map();
  const sortedById = [...videoList].sort((a, b) => b.id - a.id);
  
  for (const v of sortedById) {
    const key = v.mechanism_name || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }
  const groupEntries = Array.from(groups.entries());
  for (const [, vids] of groupEntries) {
    vids.sort((a, b) => (a.publish_date || '').localeCompare(b.publish_date || ''));
  }

  let html = '';
  for (const [mechanism, vids] of groupEntries) {
    html += `
      <div class="mechanism-group">
        <div class="mechanism-header">
          <div class="mechanism-header-left">
            <span class="mechanism-name">🎬 系列：${escapeHtml(mechanism)}</span>
            <span class="mechanism-count">${vids.length} 个视频</span>
          </div>
          ${vids[0].mechanism ? `<div class="mechanism-chain">🦴 骨架：${escapeHtml(vids[0].mechanism)}</div>` : ''}
        </div>
        <div class="card-grid">
          ${vids.map(v => window.renderGlobalCard(v)).join('')}
        </div>
      </div>
    `;
  }
  return html;
};

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

  // 按系列名称分组
  const groups = new Map();
  // 先按 ID 倒序排列（最新录入在前），确定组间顺序
  const sortedById = [...videos].sort((a, b) => b.id - a.id);
  
  // 先全量按系列名称分组
  for (const v of sortedById) {
    const key = v.mechanism_name || '未分类';
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(v);
  }

  // 将 Map 转换为数组以便进行分页
  const groupEntries = Array.from(groups.entries());

  // 计算系列的分页
  const totalPages = Math.ceil(groupEntries.length / itemsPerPage);
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  else if (currentPage < 1) currentPage = 1;
  
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedGroups = groupEntries.slice(startIndex, startIndex + itemsPerPage);
  
  // 提取需要渲染的视频组
  const videosToRender = [];
  for (const [, vids] of paginatedGroups) {
    videosToRender.push(...vids);
  }

  $videoList.innerHTML = window.generateGroupedCardsHtml(videosToRender);

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
  
  html += `
    <div class="page-jump">
      跳至 <input type="number" id="jumpInput" class="jump-input" min="1" max="${totalPages}" placeholder="${currentPage}" onkeydown="if(event.key==='Enter') window.jumpToPage(${totalPages})"> 页
      <button class="page-btn jump-btn" onclick="window.jumpToPage(${totalPages})">Go</button>
    </div>
  `;
  $pagination.innerHTML = html;
}

window.changePage = function(p) {
  currentPage = p;
  sessionStorage.setItem('currentPage', currentPage);
  renderCurrentView();
  window.scrollTo({ top: 0, behavior: 'smooth' });
};

window.jumpToPage = function(maxPages) {
  const input = document.getElementById('jumpInput');
  if (!input) return;
  let p = parseInt(input.value);
  if (!isNaN(p)) {
    if (p < 1) p = 1;
    if (p > maxPages) p = maxPages;
    if (p !== currentPage) {
      changePage(p);
    }
  }
};


// ==================== 汇总视图 ====================
async function loadSummaryView(type) {
  try {
    const res = await fetch(`/api/${type}`);
    const data = await res.json();

    $videoList.style.display = 'none';
    $emptyState.style.display = 'none';
    $summaryView.style.display = '';

    // 开头标签汇总 - 专用渲染
    if (type === 'hooks') {
      renderHooksSummary(data);
      return;
    }

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

function renderHooksSummary(data) {
  const { tags, totalVideos } = data;
  const maxCount = tags.length > 0 ? tags[0].count : 1;

  let html = `
    <div class="hooks-summary">
      <div class="hooks-header">
        <h2>🎣 爆款开头公式分析</h2>
        <p class="hooks-subtitle">基于 <strong>${totalVideos}</strong> 个爆款视频的开头标签逆向拆解，按出现频次从高到低排列</p>
      </div>
      <div class="hooks-list">
  `;

  tags.forEach((item, index) => {
    const pct = Math.round((item.count / totalVideos) * 100);
    const barWidth = Math.round((item.count / maxCount) * 100);
    
    // 根据排名给不同的等级色
    let tierClass = 'tier-normal';
    let tierLabel = '';
    if (pct >= 30) { tierClass = 'tier-s'; tierLabel = 'S'; }
    else if (pct >= 20) { tierClass = 'tier-a'; tierLabel = 'A'; }
    else if (pct >= 10) { tierClass = 'tier-b'; tierLabel = 'B'; }

    html += `
      <div class="hook-row ${tierClass}" data-index="${index}">
        <div class="hook-rank">#${index + 1}</div>
        <div class="hook-info">
          <div class="hook-top">
            <span class="hook-tag-name">${escapeHtml(item.tag)}</span>
            ${tierLabel ? `<span class="hook-tier ${tierClass}">${tierLabel}</span>` : ''}
            <span class="hook-count">${item.count} 个视频</span>
            <span class="hook-pct">${pct}%</span>
          </div>
          <div class="hook-bar-bg">
            <div class="hook-bar-fill ${tierClass}" style="width: ${barWidth}%"></div>
          </div>
          <div class="hook-videos" style="display:none">
            ${item.videos.map(v => `<a class="video-link hook-video-chip" data-id="${v.id}">${escapeHtml(window.padId(v.id))}-${escapeHtml(v.name)}</a>`).join('')}
          </div>
        </div>
        <button class="hook-expand" onclick="toggleHookVideos(this, ${index})">展开 ▾</button>
      </div>
    `;
  });

  html += `</div></div>`;
  $summaryView.innerHTML = html;

  // 绑定视频链接点击
  $summaryView.querySelectorAll('.video-link').forEach(link => {
    link.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      showDetail(parseInt(link.dataset.id));
    });
  });
}

window.toggleHookVideos = function(btn, index) {
  const row = btn.closest('.hook-row');
  const videosDiv = row.querySelector('.hook-videos');
  
  if (videosDiv.style.display === 'none') {
    if (!videosDiv.classList.contains('cards-rendered')) {
      const vids = Array.from(videosDiv.querySelectorAll('.hook-video-chip')).map(chip => parseInt(chip.dataset.id));
      const fullVideos = vids.map(id => videos.find(v => v.id === id)).filter(Boolean);
      
      videosDiv.innerHTML = window.generateGroupedCardsHtml(fullVideos);
      videosDiv.classList.add('cards-rendered');
      videosDiv.style.display = 'block';
      videosDiv.style.width = '100%';
      videosDiv.style.marginTop = '20px';
      
      videosDiv.querySelectorAll('.video-card').forEach(card => {
        card.addEventListener('click', (e) => {
          e.stopPropagation();
          showDetail(parseInt(card.dataset.id));
        });
      });
    } else {
      videosDiv.style.display = 'block';
    }
    btn.textContent = '收起 ▴';
    row.style.background = '#fcfcfc';
  } else {
    videosDiv.style.display = 'none';
    btn.textContent = '展开 ▾';
    row.style.background = 'white';
  }
};


// ==================== 内嵌详情/编辑视图 ====================
function showDetail(id) {
  if (id === null) {
    // 新增模式
    location.hash = '';
    openInlineEditor(null);
    return;
  }
  location.hash = `video/${id}`;
  
  const video = videos.find(v => v.id === id);
  if (!video) {
    fetch(`/api/videos/${id}`)
      .then(r => r.json())
      .then(v => openInlineEditor(v))
      .catch(err => showToast('加载详情失败', 'error'));
    return;
  }
  openInlineEditor(video);
}

function openInlineEditor(video = null) {
  window._currentEditVideo = video;
  currentVideoId = video ? video.id : null;
  const $copyBtn = document.getElementById('btn-copy-video-id');
  if (video) {
    const paddedId = String(video.id).padStart(3, '0');
    const idTitle = `${paddedId}-${video.name}`;
    $inlineDetailTitle.textContent = idTitle;
    $copyBtn.style.display = '';
    $copyBtn.onclick = () => {
      navigator.clipboard.writeText(idTitle).then(() => {
        $copyBtn.title = '已复制';
        setTimeout(() => { $copyBtn.title = '复制编号和标题'; }, 1500);
      });
    };
  } else {
    $inlineDetailTitle.textContent = '新增视频';
    $copyBtn.style.display = 'none';
  }
  
  // 1. ===== 渲染左侧视频播放器 =====
  // 判断是否同时拥有两个数据源
  const hasYouTube = video && video.video_link && (video.video_link.includes('youtube.com') || video.video_link.includes('youtu.be'));
  const hasAliyun = video && video.video_path && video.video_path.includes('.mp4');
  const hasBothSources = hasYouTube && hasAliyun;

  // 默认使用 YouTube；如果没有则用阿里云
  if (!window._videoSourcePref) window._videoSourcePref = 'youtube';
  let activeSource = window._videoSourcePref;
  if (activeSource === 'youtube' && !hasYouTube) activeSource = 'aliyun';
  if (activeSource === 'aliyun' && !hasAliyun) activeSource = 'youtube';

  let embedHtml = '';
  if (video) {
    let url = activeSource === 'youtube' ? (video.video_link || video.video_path) : (video.video_path || video.video_link);
    if (url) {
      if (url.includes('youtube.com') || url.includes('youtu.be')) {
        let ytId = '';
        if (url.includes('youtube.com/shorts/')) {
          ytId = url.split('youtube.com/shorts/')[1].split('?')[0];
        } else if (url.includes('v=')) {
          ytId = new URLSearchParams(url.split('?')[1]).get('v');
        } else if (url.includes('youtu.be/')) {
          ytId = url.split('youtu.be/')[1].split('?')[0];
        }
        if (ytId) {
          embedHtml = `<iframe width="100%" height="100%" src="https://www.youtube.com/embed/${ytId}?autoplay=1&mute=0&rel=0" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="border-radius:12px; background:#000;"></iframe>`;
        }
      } else if (url.includes('.mp4')) {
        embedHtml = `<video width="100%" height="100%" src="${escapeHtml(url)}" autoplay controls loop style="border-radius:12px; object-fit:contain; background:#000;"></video>`;
      }
    }

    if (!embedHtml && video.thumb_url) {
       embedHtml = `<img src="${escapeHtml(video.thumb_url)}" style="width:100%; height:100%; object-fit:contain; border-radius:12px; background:#000;" />`;
    }
  }

  if (!embedHtml) {
     embedHtml = `<div style="width:100%; height:100%; display:flex; align-items:center; justify-content:center; background:#f0f1f3; border-radius:12px; color:#888;">暂无视频画面</div>`;
  }

  // 切换按钮（仅当两个源都有时显示）
  if (hasBothSources) {
    const otherLabel = activeSource === 'youtube' ? '阿里云' : 'YouTube';
    embedHtml += `<button class="video-source-toggle" onclick="window._videoSourcePref = window._videoSourcePref === 'youtube' ? 'aliyun' : 'youtube'; openInlineEditor(window._currentEditVideo);">${otherLabel}</button>`;
  }

  $inlineVideoPlayer.innerHTML = embedHtml;

  // 2. ===== 填充右侧编辑表单 =====
  document.getElementById('form-id').value = video ? video.id : '';
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

  // 初始化标记按钮状态
  const markedInput = document.getElementById('form-is-marked');
  const markBtn = document.getElementById('btn-toggle-mark');
  if (markedInput.value === '1' || markedInput.value == 1) {
    markedInput.value = '1';
    markBtn.innerHTML = '★ 已标记';
    markBtn.className = 'btn-primary';
  } else {
    markedInput.value = '0';
    markBtn.innerHTML = '☆ 标记';
    markBtn.className = 'btn-secondary';
  }

  // 动态行 (场景/道具/角色/视频标签组合)
  ['scenes', 'props', 'characters', 'video_tags_rel'].forEach(type => {
    const container = document.getElementById(`${type}-container`);
    if (!container) return; // 新表单区域如果没加载到也不报错
    container.innerHTML = '';
    const items = video ? (video[type] || []) : [];
    if (items.length === 0) {
      if (type === 'video_tags_rel') {
        addDynamicRow(type);
        addDynamicRow(type); // 默认给两行
      } else {
        addDynamicRow(type);
      }
    } else {
      items.forEach(item => addDynamicRow(type, item));
    }
  });

  // 控制底部署名删除按钮的显示/隐藏（新增模式不显示删除）
  const btnDelete = document.getElementById('btn-delete-inline');
  if (btnDelete) {
    btnDelete.style.display = video ? 'inline-flex' : 'none';
  }

  // 3. ===== 切换视图层次 =====
  // 隐藏主列表视图及所有导航/筛选
  $listViewContainer.style.display = 'none';
  if ($viewTabs) $viewTabs.style.display = 'none';
  if ($filterBar) $filterBar.style.display = 'none';
  const $statsBar = document.getElementById('stats-bar');
  if ($statsBar) $statsBar.style.display = 'none';
  const $pagination = document.getElementById('pagination');
  if ($pagination) $pagination.style.display = 'none';

  // 记住当前滚动位置
  savedScrollY = window.scrollY;

  // 显示内嵌详情
  $inlineDetailView.style.display = 'block';

  // 自动滚回顶部
  window.scrollTo({ top: 0, behavior: 'auto' });
}

// 表单字段映射：form元素id → 数据库列名
const FORM_FIELDS = {
  'form-name': 'name',
  'form-video-title': 'video_title',
  'form-duration': 'duration',
  'form-publish-date': 'publish_date',
  'form-summary': 'summary',
  'form-hook': 'hook',
  'form-hook-tags': 'hook_tags',
  'form-mechanism-name': 'mechanism_name',
  'form-mechanism': 'mechanism',
  'form-story-structure': 'story_structure',
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
  'form-antagonist-goal': 'antagonist_goal',
  'form-is-marked': 'is_marked'
};

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
    ],
    video_tags_rel: [
      { key: 'name', label: '视频标签', placeholder: '如：搞笑/荒诞' },
      { key: 'technique', label: '核心手法', placeholder: '靠什么具体元素支撑该标签' }
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

function closeDetail() {
  // 清除 hash
  history.replaceState(null, '', location.pathname + location.search);
  // 隐藏详情
  $inlineDetailView.style.display = 'none';
  // 销毁视频播放器，避免后台声音
  $inlineVideoPlayer.innerHTML = ''; 

  // 恢复列表视图部件
  $listViewContainer.style.display = 'block';
  if ($viewTabs) $viewTabs.style.display = 'flex';
  if ($filterBar) $filterBar.style.display = 'flex';
  renderStats();

  const $pagination = document.getElementById('pagination');
  if ($pagination && currentView === 'all') {
    const groupEntries = new Map();
    for (const v of videos) {
      const key = v.mechanism_name || '未分类';
      if (!groupEntries.has(key)) groupEntries.set(key, []);
      groupEntries.get(key).push(v);
    }
    const totalPages = Math.ceil(groupEntries.size / itemsPerPage);
    if (totalPages > 1) {
       $pagination.style.display = 'flex';
    }
  }

  currentVideoId = null;
  // 所有 DOM 操作完成后恢复滚动位置
  setTimeout(() => window.scrollTo(0, savedScrollY), 0);
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
  body.video_tags_rel = collectDynamicRows('video_tags_rel', ['name', 'technique']);

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

    closeDetail();
    showToast(id ? '已更新' : '已添加', 'success');
    loadVideos(true);
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
    loadVideos(true);
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

// ==================== 开头标签编辑器 ====================
function openHookTagEditor(videoId, btn) {
  closeHookTagEditor();
  const video = allVideos.find(v => v.id === videoId);
  if (!video) return;

  const currentTags = (video.hook_tags || '').split(',').map(t => t.trim()).filter(Boolean);
  const allTags = [...allHookTags].sort();

  const currentHtml = currentTags.length
    ? currentTags.map(t => `<span class="hook-tag-chip selected">${escapeHtml(t)}<button class="hook-tag-remove" onclick="event.stopPropagation(); removeHookTag(${videoId}, '${t.replace(/'/g, "\\'")}')">×</button></span>`).join('')
    : '<span class="hook-tag-none">暂无标签</span>';

  const allTagsHtml = allTags.map(t =>
    `<span class="hook-tag-chip ${currentTags.includes(t) ? 'active' : ''}" onclick="event.stopPropagation(); toggleHookTag(${videoId}, '${t.replace(/'/g, "\\'")}')">${escapeHtml(t)}</span>`
  ).join('');

  document.body.insertAdjacentHTML('beforeend', `
    <div class="hook-tag-editor" id="hook-tag-editor" data-video-id="${videoId}">
      <div class="hook-tag-editor-header">🏷️ 开头标签</div>
      <div class="hook-tag-editor-current">${currentHtml}</div>
      <div class="hook-tag-editor-divider">全部标签（点击添加）</div>
      <div class="hook-tag-editor-all">${allTagsHtml}</div>
    </div>`);

  const rect = btn.getBoundingClientRect();
  const editor = document.getElementById('hook-tag-editor');
  const editorW = 290;
  let left = rect.left + window.scrollX;
  if (left + editorW > window.innerWidth - 8) left = window.innerWidth - editorW - 8;
  editor.style.top = (rect.bottom + window.scrollY + 6) + 'px';
  editor.style.left = left + 'px';
  setTimeout(() => document.addEventListener('click', _closeEditorOutside), 0);
}

function _closeEditorOutside(e) {
  const editor = document.getElementById('hook-tag-editor');
  if (editor && !editor.contains(e.target)) closeHookTagEditor();
}

function closeHookTagEditor() {
  const editor = document.getElementById('hook-tag-editor');
  if (editor) editor.remove();
  document.removeEventListener('click', _closeEditorOutside);
}

async function toggleHookTag(videoId, tag) {
  const video = allVideos.find(v => v.id === videoId);
  if (!video) return;
  let tags = (video.hook_tags || '').split(',').map(t => t.trim()).filter(Boolean);
  tags = tags.includes(tag) ? tags.filter(t => t !== tag) : [...tags, tag];
  await saveHookTags(videoId, tags);
}

async function removeHookTag(videoId, tag) {
  const video = allVideos.find(v => v.id === videoId);
  if (!video) return;
  const tags = (video.hook_tags || '').split(',').map(t => t.trim()).filter(t => t && t !== tag);
  await saveHookTags(videoId, tags);
}

async function saveHookTags(videoId, tags) {
  const hookTagsStr = tags.join(', ');
  try {
    const resp = await fetch(`/api/videos/${videoId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook_tags: hookTagsStr })
    });
    if (!resp.ok) throw new Error('保存失败');
    const video = allVideos.find(v => v.id === videoId);
    if (video) { video.hook_tags = hookTagsStr; tags.forEach(t => allHookTags.add(t)); }
    const wrapper = document.getElementById(`hook-tags-${videoId}`);
    if (wrapper) {
      const tagsDiv = wrapper.querySelector('.card-hook-tags');
      if (tagsDiv) {
        tagsDiv.innerHTML = tags.map(t => `<span class="tag tag-hook">${escapeHtml(t)}</span>`).join('') || '<span class="hook-tag-empty">—</span>';
      }
    }
    const btn = wrapper ? wrapper.querySelector('.btn-edit-hook-tags') : null;
    if (document.getElementById('hook-tag-editor') && btn) openHookTagEditor(videoId, btn);
    showToast('标签已更新');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ==================== 开头描述内联编辑 ====================
function copyHookById(videoId) {
  const video = allVideos.find(v => v.id === parseInt(videoId));
  if (video && video.hook) copyToClipboard(video.hook);
}

function startEditHook(videoId) {
  const body = document.getElementById(`hook-body-${videoId}`);
  if (!body || body.classList.contains('editing')) return;
  const video = allVideos.find(v => v.id === videoId);
  if (!video) return;

  body.classList.add('editing');
  const textEl = document.getElementById(`hook-text-${videoId}`);
  const currentText = video.hook || '';

  textEl.innerHTML = `<textarea class="hook-edit-textarea" id="hook-ta-${videoId}" onclick="event.stopPropagation()" onkeydown="event.stopPropagation(); if(event.key==='Escape') cancelEditHook(${videoId})">${escapeHtml(currentText)}</textarea>`;

  const actionsEl = body.querySelector('.hook-body-actions');
  if (actionsEl) {
    actionsEl.innerHTML = `
      <button class="hook-btn-save" onclick="event.stopPropagation(); saveHook(${videoId})">✓ 保存</button>
      <button class="hook-btn-cancel" onclick="event.stopPropagation(); cancelEditHook(${videoId})">取消</button>`;
  }

  const ta = document.getElementById(`hook-ta-${videoId}`);
  if (ta) { ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
}

function cancelEditHook(videoId) {
  const body = document.getElementById(`hook-body-${videoId}`);
  if (!body) return;
  body.classList.remove('editing');
  const video = allVideos.find(v => v.id === videoId);
  const textEl = document.getElementById(`hook-text-${videoId}`);
  if (textEl) textEl.innerHTML = escapeHtml(video ? (video.hook || '') : '');
  const actionsEl = body.querySelector('.hook-body-actions');
  if (actionsEl) {
    actionsEl.innerHTML = `
      <button class="btn-copy-hook" data-vid="${videoId}" onclick="event.stopPropagation(); copyHookById(this.dataset.vid)" title="复制开头描述">
        <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
      </button>
      <button class="btn-edit-hook" onclick="event.stopPropagation(); startEditHook(${videoId})" title="编辑开头描述">
        <svg viewBox="0 0 24 24" width="13" height="13" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"></path><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"></path></svg>
      </button>`;
  }
}

async function saveHook(videoId) {
  const ta = document.getElementById(`hook-ta-${videoId}`);
  if (!ta) return;
  const newHook = ta.value.trim();
  try {
    const resp = await fetch(`/api/videos/${videoId}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ hook: newHook })
    });
    if (!resp.ok) throw new Error('保存失败');
    const video = allVideos.find(v => v.id === videoId);
    if (video) video.hook = newHook;
    cancelEditHook(videoId);
    showToast('开头描述已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// ==================== 原地(Inline)播放视频 ====================
window.currentlyPlayingId = null; 

function playVideoInline(videoId, url) {
  if (!url) return;
  
  // 恢复之前播放的卡片（同一时间只播一个）
  if (window.currentlyPlayingId && window.currentlyPlayingId !== videoId) {
    stopVideoInline(window.currentlyPlayingId);
  }
  
  const container = document.getElementById(`thumb-container-${videoId}`);
  if (!container) return;
  
  // 如果已经在播放，点击可以看作是不做处理，或者是停止
  if (container.classList.contains('is-playing')) return;

  // 记住它的原始 HTML，以便之后恢复（存放缩略图）
  if (!container.dataset.originalHtml) {
    container.dataset.originalHtml = container.innerHTML;
  }
  
  let embedHtml = '';
  // 判断是 YouTube 还是本地视频
  if (url.includes('youtube.com') || url.includes('youtu.be')) {
    let ytId = '';
    if (url.includes('youtube.com/shorts/')) {
      ytId = url.split('youtube.com/shorts/')[1].split('?')[0];
    } else if (url.includes('v=')) {
      ytId = new URLSearchParams(url.split('?')[1]).get('v');
    } else if (url.includes('youtu.be/')) {
      ytId = url.split('youtu.be/')[1].split('?')[0];
    }
    // 强制自动播放和静音（大部分浏览器要求静音才能自动播放）
    if (ytId) {
      embedHtml = `<iframe style="width:100%; height:100%; border:none;" src="https://www.youtube.com/embed/${ytId}?autoplay=1&rel=0&loop=1&playlist=${ytId}&mute=0" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    } else {
      embedHtml = `<iframe style="width:100%; height:100%; border:none;" src="${url}" allow="autoplay; encrypted-media" allowfullscreen></iframe>`;
    }
  } else {
    // 本地视频
    embedHtml = `<video style="width:100%; height:100%; object-fit: cover; border-radius:12px 12px 0 0;" src="${url}" controls autoplay playsinline loop></video>`;
  }

  // 增加一个关闭按钮或者点击拦截层，也可以让它一直保持播放
  // 这里在内部加一个右上角关闭按钮
  container.innerHTML = `
    <div style="position:relative; width:100%; height:100%;" onclick="event.stopPropagation()">
      ${embedHtml}
      <button onclick="event.stopPropagation(); stopVideoInline(${videoId})" style="position:absolute; top:4px; right:4px; background:rgba(0,0,0,0.5); color:#fff; border:none; border-radius:50%; width:24px; height:24px; cursor:pointer; font-size:12px; z-index:10; display:flex; align-items:center; justify-content:center;">✕</button>
    </div>
  `;
  container.classList.add('is-playing');
  window.currentlyPlayingId = videoId;
}

function stopVideoInline(videoId) {
  const container = document.getElementById(`thumb-container-${videoId}`);
  if (!container || !container.classList.contains('is-playing')) return;
  
  if (container.dataset.originalHtml) {
    container.innerHTML = container.dataset.originalHtml;
  }
  container.classList.remove('is-playing');
  if (window.currentlyPlayingId === videoId) {
    window.currentlyPlayingId = null;
  }
}
