// ==================== 顶级 Tab 状态 ====================
let currentSection = 'youtube'; // youtube | import | library

// ==================== 监控状态 ====================
let monitorConfigs = [];
let monitorVideos = [];
let monitorPage = 1;
let monitorTotal = 0;
let monitorTotalPages = 0;
let monitorFilterKeyword = '';
let monitorFilterType = '1'; // 默认短视频
let monitorFilterLink = '';
let monitorLinkDebounceTimer = null;
let isRefreshing = false;
let geminiKeyConfig = { keys: [], activeId: '' };

// ==================== 素材库状态 ====================
let videos = [];
let allVideos = []; // 完整列表（用于筛选）
let currentView = 'all';
let currentVideoId = null;
let currentPage = window.sessionStorage ? parseInt(sessionStorage.getItem('currentPage')) || 1 : 1;
let libraryDisplayMode = window.localStorage ? (localStorage.getItem('libraryDisplayMode') || 'latest') : 'latest';
let seriesSortMode = window.localStorage ? (localStorage.getItem('seriesSortMode') || 'recent') : 'recent';
let isInitialLoad = true;
let allHookTags = new Set(); // 全局开头标签集合（供编辑器使用）
let savedScrollY = 0; // 进入编辑页面前的滚动位置
let inlineAiTaskId = null;
let inlineAiPollTimer = null;
const itemsPerPage = 10; // 每页显示系列组数量
const videoItemsPerPage = 24; // 最新录入模式每页视频数量

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
  // 顶级 Tab 切换
  bindMainTabs();
  // 恢复上次选中的 Tab
  const savedSection = localStorage.getItem('currentSection');
  if (savedSection && ['youtube', 'import', 'library'].includes(savedSection)) {
    switchMainTab(savedSection);
  }
  // YouTube 监控初始化
  initMonitor();
  // 素材库初始化
  loadVideos().then(() => {
    const hash = location.hash;
    if (hash.startsWith('#video/')) {
      const id = parseInt(hash.split('/')[1]);
      if (id) {
        switchMainTab('library');
        showDetail(id);
      }
    }
  });
  bindEvents();
});

// ==================== 顶级 Tab 切换 ====================
function bindMainTabs() {
  document.querySelectorAll('.main-tab').forEach(tab => {
    tab.addEventListener('click', () => switchMainTab(tab.dataset.section));
  });
}

function switchMainTab(section) {
  currentSection = section;
  localStorage.setItem('currentSection', section);
  document.querySelectorAll('.main-tab').forEach(t => t.classList.toggle('active', t.dataset.section === section));
  document.querySelectorAll('.section-panel').forEach(p => p.style.display = 'none');
  document.getElementById(`section-${section}`).style.display = '';

  // 进入后台任务时加载数据，并每 3 秒轮询更新状态
  if (importRefreshTimer) { clearInterval(importRefreshTimer); importRefreshTimer = null; }
  if (section === 'import') {
    loadImportTasks();
    importRefreshTimer = setInterval(loadImportTasks, 3000);
  }
}

// ==================== YouTube 监控 ====================
function initMonitor() {
  // 配置面板展开/折叠
  document.getElementById('btn-toggle-config').addEventListener('click', () => {
    const body = document.getElementById('monitor-config-body');
    const btn = document.getElementById('btn-toggle-config');
    if (body.style.display === 'none') {
      body.style.display = '';
      btn.textContent = '▾';
    } else {
      body.style.display = 'none';
      btn.textContent = '▸';
    }
  });

  // 添加监控条件
  document.getElementById('btn-add-config').addEventListener('click', addMonitorConfig);
  document.getElementById('config-keyword').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') e.preventDefault();
  });

  // 立即刷新
  document.getElementById('btn-refresh-now').addEventListener('click', doManualRefresh);

  // 筛选
  document.getElementById('filter-monitor-type').addEventListener('change', () => {
    monitorFilterType = document.getElementById('filter-monitor-type').value;
    monitorPage = 1;
    loadMonitorVideos();
  });
  document.getElementById('filter-monitor-keyword').addEventListener('change', () => {
    monitorFilterKeyword = document.getElementById('filter-monitor-keyword').value;
    monitorPage = 1;
    loadMonitorVideos();
  });

  const $linkInput = document.getElementById('filter-monitor-link');
  const $linkClear = document.getElementById('btn-clear-monitor-link');
  const applyLinkFilter = () => {
    const raw = $linkInput.value.trim();
    const id = extractYouTubeIdFromInput(raw);
    monitorFilterLink = id;
    $linkClear.style.display = raw ? '' : 'none';
    monitorPage = 1;
    loadMonitorVideos();
  };
  $linkInput.addEventListener('input', () => {
    clearTimeout(monitorLinkDebounceTimer);
    monitorLinkDebounceTimer = setTimeout(applyLinkFilter, 300);
  });
  $linkInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') {
      e.preventDefault();
      clearTimeout(monitorLinkDebounceTimer);
      applyLinkFilter();
    }
  });
  $linkClear.addEventListener('click', () => {
    $linkInput.value = '';
    clearTimeout(monitorLinkDebounceTimer);
    applyLinkFilter();
    $linkInput.focus();
  });

  // 播放浮层关闭
  document.getElementById('btn-close-player').addEventListener('click', closeMonitorPlayer);
  document.getElementById('monitor-player-overlay').addEventListener('click', (e) => {
    if (e.target === document.getElementById('monitor-player-overlay')) closeMonitorPlayer();
  });

  // 加载数据
  loadGeminiKeyConfig();
  loadMonitorConfigs();
  loadMonitorStatus();
  loadMonitorVideos();
}

async function loadGeminiKeyConfig() {
  try {
    const res = await fetch('/api/system/gemini-keys');
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载 Gemini Key 失败');
    geminiKeyConfig = data;
    renderGeminiKeyConfig();
  } catch (err) {
    console.error('加载 Gemini Key 失败:', err);
  }
}

function renderGeminiKeyConfig() {
  const activeItem = (geminiKeyConfig.keys || []).find(item => item.is_active);
  const $btn = document.getElementById('btn-gemini-key-modal');
  if ($btn) {
    $btn.title = activeItem
      ? `当前：${activeItem.name} · ${activeItem.masked_key}`
      : '当前未配置可用 Key';
  }
  const $active = document.getElementById('gemini-key-active-label');
  if ($active) {
    $active.textContent = activeItem
      ? `当前：${activeItem.name} · ${activeItem.masked_key}`
      : '当前未配置可用 Key';
  }
  const $list = document.getElementById('gemini-key-list');
  if (!$list) return;
  if (!geminiKeyConfig.keys || geminiKeyConfig.keys.length === 0) {
    $list.innerHTML = '<div class="config-empty">还没有 Gemini Key，请先添加</div>';
    return;
  }
  $list.innerHTML = geminiKeyConfig.keys.map(item => `
    <div class="gemini-key-item${item.is_active ? ' active' : ''}">
      <div class="gemini-key-info">
        <div class="gemini-key-name-row">
          <span class="gemini-key-name">${escapeHtml(item.name)}</span>
          ${item.is_active ? '<span class="config-status-badge status-ready">当前</span>' : ''}
        </div>
        <div class="gemini-key-meta">${escapeHtml(item.masked_key)}</div>
      </div>
      <div class="gemini-key-actions">
        ${item.is_active ? '' : `<button class="btn-small btn-set-ready" onclick="activateGeminiKey('${item.id}')">切换</button>`}
        <button class="btn-icon btn-icon-danger" onclick="deleteGeminiKey('${item.id}')" title="删除">×</button>
      </div>
    </div>
  `).join('');
}

function openGeminiKeyModal() {
  if (!$modalOverlay) return;
  $modalOverlay.innerHTML = `
    <div class="modal gemini-key-modal" onclick="event.stopPropagation()">
      <div class="modal-header">
        <h2>Gemini Key</h2>
        <button class="btn-close" type="button" onclick="closeModal()">&times;</button>
      </div>
      <div class="modal-body">
        <div class="gemini-key-panel">
          <div class="gemini-key-panel-header">
            <div>
              <h3>当前通道</h3>
              <p id="gemini-key-active-label">当前未配置可用 Key</p>
            </div>
          </div>
          <div class="config-form-row gemini-key-form-row">
            <div class="form-group">
              <label>名称</label>
              <input type="text" id="gemini-key-name" placeholder="如：官方 Key 1">
            </div>
            <div class="form-group flex-grow">
              <label>Key</label>
              <input type="password" id="gemini-key-value" placeholder="粘贴 Gemini Key">
            </div>
            <div class="form-group" style="align-self:flex-end">
              <button class="btn-primary" id="btn-add-gemini-key">添加并切换</button>
            </div>
          </div>
          <div class="gemini-key-list" id="gemini-key-list"></div>
        </div>
      </div>
    </div>
  `;
  $modalOverlay.style.display = 'flex';
  const $addBtn = document.getElementById('btn-add-gemini-key');
  const $value = document.getElementById('gemini-key-value');
  if ($addBtn) $addBtn.addEventListener('click', addGeminiKey);
  if ($value) {
    $value.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        addGeminiKey();
      }
    });
  }
  renderGeminiKeyConfig();
}

async function addGeminiKey() {
  const $name = document.getElementById('gemini-key-name');
  const $value = document.getElementById('gemini-key-value');
  const $btn = document.getElementById('btn-add-gemini-key');
  if (!$value || !$btn) return;
  const name = $name.value.trim();
  const key = $value.value.trim();
  if (!key) {
    showToast('请先粘贴 Gemini Key', 'error');
    return;
  }
  $btn.disabled = true;
  $btn.textContent = '添加中...';
  try {
    const res = await fetch('/api/system/gemini-keys', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name, key, activate: true }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '添加失败');
    geminiKeyConfig = data;
    renderGeminiKeyConfig();
    $name.value = '';
    $value.value = '';
    showToast('已添加并切换 Gemini Key');
  } catch (err) {
    showToast('添加失败: ' + err.message, 'error');
  } finally {
    $btn.disabled = false;
    $btn.textContent = '添加并切换';
  }
}

window.activateGeminiKey = async function(id) {
  try {
    const res = await fetch(`/api/system/gemini-keys/${id}/activate`, { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '切换失败');
    geminiKeyConfig = data;
    renderGeminiKeyConfig();
    showToast('已切换 Gemini Key');
  } catch (err) {
    showToast('切换失败: ' + err.message, 'error');
  }
};

window.deleteGeminiKey = async function(id) {
  if (!confirm('确定删除这个 Gemini Key 吗？')) return;
  try {
    const res = await fetch(`/api/system/gemini-keys/${id}`, { method: 'DELETE' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '删除失败');
    geminiKeyConfig = data;
    renderGeminiKeyConfig();
    showToast('已删除 Gemini Key');
  } catch (err) {
    showToast('删除失败: ' + err.message, 'error');
  }
};

async function loadMonitorConfigs() {
  try {
    const res = await fetch('/api/monitor/configs');
    monitorConfigs = await res.json();

    // 加载每个配置的频道
    for (const c of monitorConfigs) {
      const chRes = await fetch(`/api/monitor/configs/${c.id}/channels`);
      c._channels = await chRes.json();
    }

    renderMonitorConfigs();
    populateMonitorKeywordFilter();
  } catch (err) {
    console.error('加载监控条件失败:', err);
  }
}

function renderMonitorConfigs() {
  const $list = document.getElementById('config-list');
  if (monitorConfigs.length === 0) {
    $list.innerHTML = '<div class="config-empty">暂无监控条件，请在上方添加关键词</div>';
    return;
  }
  $list.innerHTML = monitorConfigs.map(c => {
    const durationLabels = { any: '全部', short: '<4分钟', medium: '4-20分钟', long: '>20分钟' };
    const viewsLabel = c.min_views > 0 ? `${formatViewsNum(c.min_views)}+` : '不限';
    const status = c.status || 'testing';
    const statusLabel = status === 'ready' ? '就绪' : '测试中';
    const statusClass = status === 'ready' ? 'status-ready' : 'status-testing';
    const channels = c._channels || [];

    // 月份选项
    let monthOptions = '';
    if (status === 'testing') {
      const pulledSet = new Set((c.pulled_months || '').split(',').filter(Boolean));
      const now = new Date();
      for (let i = 0; i < 24; i++) {
        const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
        const y = d.getFullYear();
        const m = d.getMonth() + 1;
        const key = `${y}-${String(m).padStart(2, '0')}`;
        const pulled = pulledSet.has(key);
        monthOptions += `<option value="${y}-${m}" ${pulled ? 'disabled' : ''}>${y}年${m}月${pulled ? ' ✓' : ''}</option>`;
      }
    }

    // 频道列表
    const channelsHtml = channels.map(ch => `
      <div class="channel-item">
        ${ch.thumbnail_url ? `<img class="channel-avatar" src="${escapeHtml(ch.thumbnail_url)}" alt="">` : ''}
        <span class="channel-name">${escapeHtml(ch.channel_title)}</span>
        <button class="btn-icon btn-icon-danger" onclick="event.stopPropagation(); deleteChannel(${ch.id})" title="删除">×</button>
      </div>
    `).join('');

    return `
      <div class="config-block" data-id="${c.id}">
        <div class="config-item ${c.enabled ? '' : 'disabled'}">
          <div class="config-item-info">
            <span class="config-keyword">${escapeHtml(c.keyword)}</span>
            <span class="config-status-badge ${statusClass}">${statusLabel}</span>
            <span class="config-meta">${durationLabels[c.duration] || '全部'} · 播放量${viewsLabel}</span>
          </div>
          <div class="config-item-actions">
            ${status === 'testing' ? `
              <select class="month-select" id="month-select-${c.id}">${monthOptions}</select>
              <button class="btn-small btn-full-pull" onclick="monthPullConfig(${c.id})">拉取该月</button>
              <button class="btn-small btn-set-ready" onclick="setConfigReady(${c.id})">设为就绪</button>
            ` : ''}
            <button class="btn-icon" onclick="toggleMonitorConfig(${c.id}, ${c.enabled ? 0 : 1})" title="${c.enabled ? '暂停' : '启用'}">
              ${c.enabled ? '⏸' : '▶'}
            </button>
            <button class="btn-icon btn-icon-danger" onclick="deleteMonitorConfig(${c.id})" title="删除">×</button>
          </div>
        </div>
        <div class="config-channels">
          ${channelsHtml}
          <div class="channel-add-row">
            <input type="text" class="channel-add-input" id="channel-input-${c.id}" placeholder="添加频道: URL / @handle / ID">
            <button class="btn-small btn-channel-add" onclick="addChannelToConfig(${c.id})">添加</button>
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function populateMonitorKeywordFilter() {
  const $select = document.getElementById('filter-monitor-keyword');
  const current = $select.value;
  const keywords = [...new Set(monitorConfigs.map(c => c.keyword))];
  $select.innerHTML = '<option value="">全部关键词</option>' +
    keywords.map(k => `<option value="${escapeHtml(k)}">${escapeHtml(k)}</option>`).join('');
  $select.value = current;
}

async function addMonitorConfig() {
  const keyword = document.getElementById('config-keyword').value.trim();
  if (!keyword) return;
  const duration = document.getElementById('config-duration').value;
  const minViews = parseInt(document.getElementById('config-min-views').value) || 0;

  const btn = document.getElementById('btn-add-config');
  btn.disabled = true;
  btn.textContent = '拉取中...';

  try {
    const res = await fetch('/api/monitor/configs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ keyword, duration, min_views: minViews })
    });
    if (!res.ok) { const e = await res.json(); throw new Error(e.error); }
    document.getElementById('config-keyword').value = '';
    showToast('已添加');
    loadMonitorConfigs();
  } catch (err) {
    showToast('添加失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '添加';
  }
}

window.monthPullConfig = async function(id) {
  const select = document.getElementById(`month-select-${id}`);
  if (!select) return;
  const [year, month] = select.value.split('-').map(Number);

  const btn = event.target;
  btn.disabled = true;
  btn.textContent = '拉取中...';

  try {
    const res = await fetch(`/api/monitor/configs/${id}/month-pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ year, month })
    });
    const result = await res.json();
    if (result.success) {
      showToast(`${year}年${month}月: ${result.total} 个视频，新增 ${result.newCount} 个`);
      loadMonitorConfigs();
      loadMonitorVideos();
    } else {
      showToast(result.error || '拉取失败', 'error');
    }
  } catch (err) {
    showToast('拉取失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '拉取该月';
  }
};

window.setConfigReady = async function(id) {
  try {
    const res = await fetch(`/api/monitor/configs/${id}/set-ready`, { method: 'POST' });
    if (res.ok) {
      showToast('已设为就绪');
      loadMonitorConfigs();
    }
  } catch (err) {
    showToast('操作失败', 'error');
  }
};

// ==================== 频道管理（绑定到关键词配置） ====================

window.addChannelToConfig = async function(configId) {
  const input = document.getElementById(`channel-input-${configId}`);
  if (!input || !input.value.trim()) return;

  const btn = input.nextElementSibling;
  btn.disabled = true;
  btn.textContent = '解析中...';

  try {
    const res = await fetch(`/api/monitor/configs/${configId}/channels`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input: input.value.trim() })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    input.value = '';
    showToast(`已添加频道: ${data.channel_title}`);
    loadMonitorConfigs();
  } catch (err) {
    showToast('添加失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = '添加';
  }
};

window.deleteChannel = async function(id) {
  try {
    await fetch(`/api/monitor/channels/${id}`, { method: 'DELETE' });
    showToast('已删除');
    loadMonitorConfigs();
  } catch (err) {
    showToast('删除失败', 'error');
  }
};

// ==================== 录入功能 ====================
let importTasks = [];
let importRefreshTimer = null;

window.importVideo = async function(monitorVideoId, btn) {
  if (btn) { btn.disabled = true; btn.textContent = '录入中...'; }
  try {
    const res = await fetch('/api/import/tasks', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ monitor_video_id: monitorVideoId })
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error);
    showToast(`已创建素材卡片 #${data.material_video_id || data.source_video_id || ''}，后台任务已启动`);
    if (btn) { btn.textContent = '已录入'; btn.disabled = true; btn.classList.add('btn-import-done'); }
    loadMonitorVideos();
    loadVideos(true);
  } catch (err) {
    const msg = err.message || '';
    showToast(msg.includes('重复') ? msg : ('录入失败: ' + msg), 'error', { duration: msg.includes('重复') ? 6000 : 3000 });
    if (msg.includes('重复')) loadMonitorVideos();
    if (btn) { btn.disabled = false; btn.textContent = '录入'; }
  }
};


async function loadImportTasks() {
  try {
    const res = await fetch('/api/import/tasks');
    importTasks = await res.json();
    renderImportTasks();
    loadQueueStatus();   // 任务列表刷新后立即拉一次队列状态
  } catch (err) {
    console.error('加载录入任务失败:', err);
  }
}

async function loadQueueStatus() {
  try {
    const res = await fetch('/api/import/queue-status');
    const s = await res.json();
    const $bar = document.getElementById('queue-status-bar');
    if (!$bar) return;

    const fmtSec = (ms) => Math.round(ms / 1000);
    const fmtMin = (ms) => (ms / 60000).toFixed(1);

    let statusText = '', cls = 'queue-idle';
    if (s.phase === 'idle') {
      if (s.queuedCountInDb > 0) {
        statusText = `⚠️ 队列空闲，但数据库里还有 ${s.queuedCountInDb} 个 queued 任务未处理（可能需重启恢复）`;
        cls = 'queue-warn';
      } else {
        statusText = '✓ 队列空闲，无待处理任务';
      }
    } else if (s.phase === 'paused') {
      statusText = `🚫 触发限流，暂停中 · 剩余 ${fmtMin(s.nextResumeInMs)} 分钟 · 队列还有 ${s.queueLength} 个任务`;
      cls = 'queue-paused';
    } else if (s.phase === 'cooling_down') {
      statusText = `⏱ 冷却中（防限流）· ${fmtSec(s.nextResumeInMs)}s 后开始下一个 · 队列还有 ${s.queueLength} 个`;
      cls = 'queue-cooling';
    } else if (s.phase === 'downloading') {
      const title = s.currentTask ? s.currentTask.title : `#${s.currentTask?.id || '?'}`;
      statusText = `⬇️ 下载中 · <span class="queue-task-title" title="${escapeHtml(title)}">${escapeHtml(title.slice(0, 50))}${title.length > 50 ? '…' : ''}</span> · 已运行 ${fmtSec(s.phaseElapsedMs)}s · 队列还有 ${s.queueLength} 个`;
      cls = 'queue-active';
    }

    // 若有失败任务，右侧加一个批量重试按钮
    const retryBtn = s.failedCount > 0
      ? `<button class="btn-small queue-retry-btn" onclick="retryAllFailed()">🔁 重试 ${s.failedCount} 个失败</button>`
      : '';

    $bar.className = `queue-status-bar ${cls}`;
    $bar.innerHTML = `<span class="queue-status-text">${statusText}</span>${retryBtn}`;
  } catch (err) {
    console.error('加载队列状态失败:', err);
  }
}

function renderImportTasks() {
  const $section = document.getElementById('section-import');
  if (importTasks.length === 0) {
    $section.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📭</div>
        <p>暂无录入任务</p>
        <p class="empty-hint">在 YouTube 监控中点击「录入」按钮开始录入视频</p>
      </div>`;
    return;
  }

  $section.innerHTML = `
    <div class="import-tasks-header">
      <h2>后台录入队列</h2>
      <span class="task-count">${importTasks.length} 个任务</span>
    </div>
    <div id="queue-status-bar" class="queue-status-bar queue-idle">正在查询队列状态…</div>
    <div class="import-tasks-list">
      ${importTasks.map(t => {
        const ds = taskStatusPill('下载', t.download_status || t.backup_status);
        const us = taskStatusPill('上传', t.upload_status);
        const ts = taskStatusPill('字幕', t.transcript_status);
        const ps = taskStatusPill('预览', t.preview_status);
        const as = taskStatusPill('Gemini', t.analysis_status);
        return `
          <div class="import-task-item">
            <img class="task-thumb" src="${escapeHtml(t.thumbnail_url)}" alt="" loading="lazy">
            <div class="task-info">
              <div class="task-title">${escapeHtml(t.title)}</div>
              <div class="task-meta">
                <span class="task-channel">${escapeHtml(t.channel_title)}</span>
                <span>👁 ${formatViewsNum(t.views)}</span>
                <span>${t.publish_date || ''}</span>
                ${t.suggested_name ? `<span class="task-suggested">💡 ${escapeHtml(t.suggested_name)}</span>` : ''}
              </div>
              <div class="task-statuses">
                ${ds}${us}${ts}${ps}${as}
              </div>
              ${renderTaskErrors(t)}
            </div>
            <div class="task-actions" onclick="event.stopPropagation()">
              ${t.source_video_id ? `<button class="btn-small" onclick="switchMainTab('library'); showDetail(${t.source_video_id})">打开卡片</button>` : ''}
              ${hasTaskFailure(t) ? `<button class="btn-small" onclick="retryBackup(${t.id})">重试</button>` : ''}
              <button class="btn-icon btn-icon-danger" onclick="deleteImportTask(${t.id})" title="删除">×</button>
            </div>
          </div>
        `;
      }).join('')}
    </div>
  `;

  // 确保详情弹层存在于 body 下，避免被列表轮询刷新时破坏
  if (!document.getElementById('task-detail-overlay')) {
    const overlay = document.createElement('div');
    overlay.id = 'task-detail-overlay';
    overlay.className = 'task-detail-overlay';
    overlay.style.display = 'none';
    document.body.appendChild(overlay);
  }
}

function taskStatusPill(label, status) {
  const map = {
    queued: { label: '排队中', class: 'status-queued', active: true },
    downloading: { label: '下载中', class: 'status-downloading', active: true },
    downloaded: { label: '已下载', class: 'status-uploaded' },
    uploading: { label: '上传中', class: 'status-uploading', active: true },
    uploaded: { label: '已上传', class: 'status-uploaded' },
    transcribing: { label: '转写中', class: 'status-downloading', active: true },
    generating: { label: '生成中', class: 'status-downloading', active: true },
    analyzing: { label: '分析中', class: 'status-downloading', active: true },
    ready: { label: '就绪', class: 'status-uploaded' },
    skipped: { label: '跳过', class: 'status-queued' },
    failed: { label: '失败', class: 'status-failed' },
  };
  const s = map[status] || { label: status || '-', class: 'status-queued' };
  if (label === '字幕' && status === 'skipped') {
    s.label = '无语音';
  }
  return `<span class="task-status ${s.class}">${s.active ? '<span class="spinner-small"></span> ' : ''}${label}: ${s.label}</span>`;
}

function hasTaskFailure(t) {
  return [t.download_status, t.upload_status, t.transcript_status, t.preview_status, t.analysis_status, t.backup_status].includes('failed');
}

function renderTaskErrors(t) {
  const errors = [
    t.download_error && `下载: ${t.download_error}`,
    t.upload_error && `上传: ${t.upload_error}`,
    t.transcript_error && `字幕: ${t.transcript_error}`,
    t.preview_error && `预览: ${t.preview_error}`,
    t.analysis_error && `Gemini: ${t.analysis_error}`,
    t.backup_error && !t.download_error && !t.upload_error && `备份: ${t.backup_error}`,
  ].filter(Boolean);
  if (errors.length === 0) return '';
  return `<div class="task-error task-error-inline">${escapeHtml(errors[0])}</div>`;
}

let taskDetailPollTimer = null;
let currentDetailTaskId = null;

window.openImportTaskDetail = async function(taskId) {
  let overlay = document.getElementById('task-detail-overlay');
  if (!overlay) {
    overlay = document.createElement('div');
    overlay.id = 'task-detail-overlay';
    overlay.className = 'task-detail-overlay';
    document.body.appendChild(overlay);
  }
  overlay.style.display = 'flex';

  // 首次打开时显示加载；后续轮询刷新不重置 innerHTML 避免输入框/滚动位置丢失
  const isNewOpen = currentDetailTaskId !== taskId;
  if (isNewOpen) {
    overlay.innerHTML = '<div class="task-detail-loading">加载中...</div>';
    currentDetailTaskId = taskId;
  }

  try {
    const res = await fetch(`/api/import/tasks/${taskId}`);
    const task = await res.json();
    renderTaskDetail(task, !isNewOpen);

    // 清除旧的轮询
    if (taskDetailPollTimer) clearTimeout(taskDetailPollTimer);
    // 如果还在进行中，继续轮询
    const stillActive = ['queued', 'analyzing'].includes(task.analysis_status) ||
                        ['queued', 'downloading', 'uploading'].includes(task.backup_status);
    if (stillActive && overlay.style.display !== 'none') {
      taskDetailPollTimer = setTimeout(() => {
        if (currentDetailTaskId === taskId && overlay.style.display !== 'none') {
          openImportTaskDetail(taskId);
        }
      }, 3000);
    }
  } catch (err) {
    if (isNewOpen) overlay.innerHTML = '<div class="task-detail-loading">加载失败</div>';
  }
};

function renderTaskDetail(task, preserveInputs = false) {
  const overlay = document.getElementById('task-detail-overlay');

  const backupLabels = {
    queued: '排队中', downloading: '下载中', uploading: '上传中',
    uploaded: '已上传 ✅', downloaded: '已下载 ✅', failed: '失败 ❌',
  };
  const analysisLabels = {
    queued: '排队中', analyzing: '分析中...', ready: '就绪 ✅', failed: '失败 ❌',
  };
  const isShort = task.is_short === 1 ||
    (task.video_url && task.video_url.includes('/shorts/')) ||
    (task.source_video_id && Number(task.duration_seconds) > 0 && Number(task.duration_seconds) <= 60);

  const statusPanelHtml = `
    <div class="status-row"><strong>备份:</strong> ${backupLabels[task.backup_status] || '-'}
      ${task.backup_status === 'failed' ? `<button class="btn-small" onclick="retryBackup(${task.id})">重试</button>` : ''}
    </div>
    ${task.backup_error ? `<div class="task-error">${escapeHtml(task.backup_error)}</div>` : ''}
    ${task.oss_video_url ? `<div class="task-url">☁️ <a href="${escapeHtml(task.oss_video_url)}" target="_blank">${escapeHtml(task.oss_video_url)}</a></div>` : ''}
    ${task.analysis_status === 'failed' ? `
      <div class="status-row"><strong>分析:</strong> ${analysisLabels[task.analysis_status]}
        <button class="btn-small" onclick="retryAnalysis(${task.id})">重试</button>
      </div>
      ${task.analysis_error ? `<div class="task-error">${escapeHtml(task.analysis_error)}</div>` : ''}
    ` : ''}
  `;

  const rightPanelHtml = `
    <div class="conversation-header">
      <span>💬 对话</span>
      ${task.analysis_status === 'ready' || task.analysis_status === 'analyzing' ? `<button class="btn-small btn-restart" onclick="restartAnalysis(${task.id})">重启分析</button>` : ''}
    </div>
    <div class="conversation-list" id="conversation-list">
      ${getVisibleConversations(task.conversations || []).map((c) => {
        const isLast = c.role === 'assistant';
        return `
          <div class="conv-msg conv-${c.role}${isLast ? ' conv-latest-assistant' : ''}">
            <div class="conv-meta">
              <div class="conv-role">${c.role === 'user' ? '我' : 'Gemini'}</div>
              ${formatConversationTime(c.created_at) ? `<div class="conv-time">${formatConversationTime(c.created_at)}</div>` : ''}
            </div>
            ${isLast ? `
              <div class="conv-save-toolbar">
                <span class="saved-badge">当前脚本：最后一条 Gemini 回复</span>
                <button class="btn-small" onclick="copyTaskLatestScript(${task.id})">复制脚本</button>
              </div>
            ` : ''}
            <div class="conv-content">${escapeHtml(c.content)}</div>
          </div>
        `;
      }).join('') || '<div class="conv-empty">对话将在分析开始后显示</div>'}
      ${task.analysis_status === 'analyzing' ? '<div class="conv-thinking"><span class="spinner-small"></span> Gemini 思考中...</div>' : ''}
    </div>
    <div class="conversation-input">
      <textarea id="chat-input" placeholder="指出哪里不对，让 Gemini 重新输出..."></textarea>
      <button class="btn-primary" onclick="sendChatMessage(${task.id})" ${task.analysis_status !== 'ready' ? 'disabled' : ''}>发送</button>
    </div>
  `;

  // 如果已经渲染过（preserveInputs=true 意味着轮询更新），只替换会变的部分，iframe 保持不动避免闪烁
  const existingStatus = overlay.querySelector('.task-detail-status-panel');
  const existingRight = overlay.querySelector('.task-detail-right');
  const existingPlayer = overlay.querySelector('.task-detail-player iframe');
  const sameVideo = existingPlayer && existingPlayer.src.includes(task.youtube_video_id);

  if (preserveInputs && existingStatus && existingRight && sameVideo) {
    // 保留用户输入状态
    const ta = document.getElementById('chat-input');
    const savedChatInput = ta ? ta.value : '';
    const list = document.getElementById('conversation-list');
    const savedScrollTop = list ? list.scrollTop : 0;

    existingStatus.innerHTML = statusPanelHtml;
    existingRight.innerHTML = rightPanelHtml;
    existingPlayer.parentElement.classList.toggle('player-vertical', isShort);

    // 恢复输入与滚动
    const ta2 = document.getElementById('chat-input');
    if (ta2 && savedChatInput) ta2.value = savedChatInput;
    const list2 = document.getElementById('conversation-list');
    if (list2) list2.scrollTop = savedScrollTop;
    return;
  }

  // 首次渲染（或视频换了）— 全量重建
  const ytEmbedUrl = `https://www.youtube.com/embed/${task.youtube_video_id}?rel=0`;

  overlay.innerHTML = `
    <div class="task-detail-container">
      <button class="task-detail-close" onclick="closeImportTaskDetail()">&times;</button>
      <div class="task-detail-layout">
        <div class="task-detail-left">
          <div class="task-detail-player ${isShort ? 'player-vertical' : ''}">
            <iframe src="${ytEmbedUrl}" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
          </div>
          <div class="task-detail-status-panel">${statusPanelHtml}</div>
        </div>
        <div class="task-detail-right">${rightPanelHtml}</div>
      </div>
    </div>
  `;
  // 首次打开滚到最新一条 AI 回复的顶部（没有 AI 回复则回到顶部）
  const list = document.getElementById('conversation-list');
  if (list) {
    scrollListToLatestAssistantTop(list, '.conv-latest-assistant');
  }
}

window.closeImportTaskDetail = function() {
  document.getElementById('task-detail-overlay').style.display = 'none';
  currentDetailTaskId = null;
  if (taskDetailPollTimer) { clearTimeout(taskDetailPollTimer); taskDetailPollTimer = null; }
};

window.retryBackup = async function(id) {
  await fetch(`/api/import/tasks/${id}/retry-backup`, { method: 'POST' });
  showToast('已重试备份');
  openImportTaskDetail(id);
};

window.retryAnalysis = async function(id) {
  await fetch(`/api/import/tasks/${id}/retry-analysis`, { method: 'POST' });
  showToast('已重试分析');
  openImportTaskDetail(id);
};

window.retryAllFailed = async function() {
  if (!confirm('确定重新入队所有失败的备份任务吗？它们会按新策略重新下载+上传。')) return;
  try {
    const res = await fetch('/api/import/retry-all-failed', { method: 'POST' });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '失败');
    showToast(`已重新入队 ${data.count} 个任务`);
    loadImportTasks();
    loadQueueStatus();
  } catch (err) {
    showToast('批量重试失败: ' + err.message, 'error');
  }
};

window.restartAnalysis = async function(id) {
  if (!confirm('确定要清空对话历史重新开始分析吗？')) return;
  await fetch(`/api/import/tasks/${id}/restart-analysis`, { method: 'POST' });
  showToast('已重启分析');
  openImportTaskDetail(id);
};

window.sendChatMessage = async function(id) {
  const ta = document.getElementById('chat-input');
  const msg = ta.value.trim();
  if (!msg) return;
  ta.value = '';
  try {
    await fetch(`/api/import/tasks/${id}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message: msg })
    });
    setTimeout(() => openImportTaskDetail(id), 500);
  } catch (err) {
    showToast('发送失败', 'error');
  }
};

window.copyTaskLatestScript = async function(id) {
  try {
    const res = await fetch(`/api/ai/tasks/${id}`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '读取脚本失败');
    if (!data.latestScript) {
      showToast('暂无可复制的脚本', 'error');
      return;
    }
    await navigator.clipboard.writeText(data.latestScript);
    showToast('已复制脚本');
  } catch (err) {
    showToast('复制失败: ' + err.message, 'error');
  }
};

window.deleteImportTask = async function(id) {
  if (!confirm('确定要删除这个任务吗？本地文件也会被删除。')) return;
  try {
    await fetch(`/api/import/tasks/${id}`, { method: 'DELETE' });
    showToast('已删除');
    loadImportTasks();
  } catch (err) {
    showToast('删除失败', 'error');
  }
};

window.toggleMonitorConfig = async function(id, enabled) {
  try {
    await fetch(`/api/monitor/configs/${id}`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ enabled })
    });
    loadMonitorConfigs();
    showToast(enabled ? '已启用' : '已暂停');
  } catch (err) {
    showToast('操作失败', 'error');
  }
};

window.deleteMonitorConfig = async function(id) {
  if (!confirm('确定要删除这个监控条件吗？已发现的视频不会被删除。')) return;
  try {
    await fetch(`/api/monitor/configs/${id}`, { method: 'DELETE' });
    loadMonitorConfigs();
    showToast('已删除');
  } catch (err) {
    showToast('删除失败', 'error');
  }
};

const REFRESH_BTN_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>`;

let refreshPollTimer = null;

async function doManualRefresh() {
  if (isRefreshing) return;
  const btn = document.getElementById('btn-refresh-now');

  try {
    const res = await fetch('/api/monitor/refresh', { method: 'POST' });
    const result = await res.json();
    if (!result.success && !result.running) {
      showToast(result.error || '刷新失败', 'error');
      return;
    }
    // 进入轮询模式
    isRefreshing = true;
    btn.disabled = true;
    btn.innerHTML = '<span class="spinner"></span> 刷新中...';
    startRefreshPolling();
  } catch (err) {
    showToast('刷新失败: ' + err.message, 'error');
  }
}

function startRefreshPolling() {
  if (refreshPollTimer) clearInterval(refreshPollTimer);
  const btn = document.getElementById('btn-refresh-now');

  const tick = async () => {
    try {
      const res = await fetch('/api/monitor/status');
      const status = await res.json();
      updateMonitorStatusDisplay(status);

      if (status.refreshing) {
        // 更新按钮文案带进度
        if (status.progress) {
          btn.innerHTML = `<span class="spinner"></span> ${status.phase} ${status.progress.current}/${status.progress.total}`;
        } else {
          btn.innerHTML = `<span class="spinner"></span> ${status.phase || '刷新中...'}`;
        }
      } else {
        // 完成
        clearInterval(refreshPollTimer);
        refreshPollTimer = null;
        isRefreshing = false;
        btn.disabled = false;
        btn.innerHTML = `${REFRESH_BTN_ICON} 立即刷新`;
        showToast(`刷新完成，新增 ${status.lastNewCount || 0} 个视频`);
        loadMonitorVideos();
      }
    } catch (err) {
      console.error('轮询刷新状态失败:', err);
    }
  };
  tick(); // 立即跑一次
  refreshPollTimer = setInterval(tick, 2500);
}

function updateMonitorStatusDisplay(status) {
  const $time = document.getElementById('monitor-last-refresh');
  const $status = document.getElementById('monitor-refresh-status');
  if (!$time || !$status) return;

  if (status.lastRefreshTime) {
    const d = new Date(status.lastRefreshTime);
    $time.textContent = `上次刷新: ${d.toLocaleString('zh-CN')}`;
  } else {
    $time.textContent = '上次刷新: 从未';
  }

  if (!status.apiKeyConfigured) {
    $status.textContent = '⚠️ API Key 未配置';
    $status.className = 'monitor-refresh-status status-error';
  } else if (status.lastRefreshStatus === 'error:QUOTA_EXCEEDED') {
    $status.textContent = '⚠️ 配额已用完';
    $status.className = 'monitor-refresh-status status-error';
  } else if (status.lastRefreshStatus && status.lastRefreshStatus.startsWith('error:')) {
    $status.textContent = '⚠️ ' + status.lastRefreshStatus.slice(6);
    $status.className = 'monitor-refresh-status status-error';
  } else {
    $status.textContent = '';
  }
}

async function loadMonitorStatus() {
  try {
    const res = await fetch('/api/monitor/status');
    const status = await res.json();
    updateMonitorStatusDisplay(status);

    // 如果后台正在刷新（页面刷新/另一个 tab 触发过），无缝接管轮询
    if (status.refreshing && !isRefreshing) {
      isRefreshing = true;
      const btn = document.getElementById('btn-refresh-now');
      if (btn) {
        btn.disabled = true;
        btn.innerHTML = '<span class="spinner"></span> 刷新中...';
      }
      startRefreshPolling();
    }
  } catch (err) {
    console.error('加载监控状态失败:', err);
  }
}

async function loadMonitorVideos() {
  try {
    const params = new URLSearchParams({ page: monitorPage, limit: 50 });
    if (monitorFilterType !== '') params.set('is_short', monitorFilterType);
    if (monitorFilterKeyword) params.set('keyword', monitorFilterKeyword);
    if (monitorFilterLink) params.set('youtube_id', monitorFilterLink);

    const res = await fetch(`/api/monitor/videos?${params}`);
    const data = await res.json();
    monitorVideos = data.videos;
    monitorTotal = data.total;
    monitorTotalPages = data.totalPages;

    document.getElementById('monitor-video-count').textContent = `${monitorTotal} 个视频`;
    renderMonitorVideos();
    renderMonitorPagination();
  } catch (err) {
    console.error('加载监控视频失败:', err);
  }
}

function renderMonitorVideos() {
  const $grid = document.getElementById('monitor-videos-grid');
  const $empty = document.getElementById('monitor-empty');

  if (monitorVideos.length === 0) {
    $grid.innerHTML = '';
    $empty.style.display = '';
    return;
  }
  $empty.style.display = 'none';

  $grid.innerHTML = monitorVideos.map(v => {
    const discoveredDate = new Date(v.discovered_at);
    const now = new Date();
    const diffHours = Math.floor((now - discoveredDate) / (1000 * 60 * 60));
    let discoveredLabel;
    if (diffHours < 1) discoveredLabel = '刚刚发现';
    else if (diffHours < 24) discoveredLabel = `${diffHours}小时前`;
    else discoveredLabel = `${Math.floor(diffHours / 24)}天前`;

    const isNew = diffHours < 24;
    const isShort = v.is_short || (v.video_url && v.video_url.includes('/shorts/'));

    return `
      <div class="monitor-card ${isShort ? 'monitor-card-short' : ''}">
        <div class="monitor-card-thumb ${isShort ? 'thumb-short' : ''}" id="monitor-thumb-${v.id}" onclick="playMonitorInline(${v.id}, '${v.youtube_video_id}')">
          ${v.thumbnail_url ? `<img src="${escapeHtml(v.thumbnail_url)}" alt="" loading="lazy">` : '<div class="card-thumb-empty">无封面</div>'}
          <span class="card-play">▶</span>
          ${v.duration_seconds ? `<span class="card-duration">${formatDurationDisplay(v.duration_seconds)}</span>` : ''}
        </div>
        <div class="monitor-card-info">
          <div class="monitor-card-title" title="${escapeHtml(v.title)}">${escapeHtml(v.title)}</div>
          <div class="monitor-card-channel">${escapeHtml(v.channel_title)}</div>
          <div class="monitor-card-meta">
            <span>👁 ${formatViewsNum(v.views)}</span>
            <span>${v.publish_date || ''}</span>
          </div>
          <div class="monitor-card-bottom">
            <span class="discovered-badge ${isNew ? 'discovered-new' : ''}">${discoveredLabel}</span>
            <span class="monitor-keyword-tag">${escapeHtml(v.keyword)}</span>
          </div>
          ${v.imported
            ? `<button class="btn-import btn-import-done" disabled>已录入</button>`
            : `<button class="btn-import" onclick="importVideo(${v.id}, this)">录入</button>`}
        </div>
      </div>
    `;
  }).join('');
}

function renderMonitorPagination() {
  const $pagination = document.getElementById('monitor-pagination');
  if (monitorTotalPages <= 1) { $pagination.style.display = 'none'; return; }

  $pagination.style.display = 'flex';
  let html = `<button class="page-btn" ${monitorPage <= 1 ? 'disabled' : ''} onclick="changeMonitorPage(${monitorPage - 1})">上一页</button>`;
  for (let i = 1; i <= monitorTotalPages; i++) {
    if (i === 1 || i === monitorTotalPages || (i >= monitorPage - 2 && i <= monitorPage + 2)) {
      html += `<button class="page-btn ${i === monitorPage ? 'active' : ''}" onclick="changeMonitorPage(${i})">${i}</button>`;
    } else if (i === monitorPage - 3 || i === monitorPage + 3) {
      html += `<span class="page-dot">...</span>`;
    }
  }
  html += `<button class="page-btn" ${monitorPage >= monitorTotalPages ? 'disabled' : ''} onclick="changeMonitorPage(${monitorPage + 1})">下一页</button>`;
  $pagination.innerHTML = html;
}

window.changeMonitorPage = function(p) {
  monitorPage = p;
  loadMonitorVideos();
  document.getElementById('section-youtube').scrollTo({ top: 0, behavior: 'smooth' });
};

// 原位置播放（性能关键：同一时间只有 1 个 iframe）
let currentlyPlayingMonitorId = null;

window.playMonitorInline = function(cardId, youtubeVideoId) {
  // 停止当前正在播放的视频
  if (currentlyPlayingMonitorId && currentlyPlayingMonitorId !== cardId) {
    stopMonitorInline(currentlyPlayingMonitorId);
  }

  const container = document.getElementById(`monitor-thumb-${cardId}`);
  if (!container || container.classList.contains('is-playing')) return;

  // 保留原始 HTML 和视频 ID
  if (!container.dataset.originalHtml) {
    container.dataset.originalHtml = container.innerHTML;
    container.dataset.youtubeId = youtubeVideoId;
  }

  container.innerHTML = `
    <div class="inline-player-wrapper">
      <iframe src="https://www.youtube.com/embed/${youtubeVideoId}?autoplay=1&rel=0" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen></iframe>
      <button class="inline-player-close" onclick="event.stopPropagation(); stopMonitorInline(${cardId})">✕</button>
    </div>
  `;
  container.classList.add('is-playing');
  // 阻止点击传播（已播放时再点不再触发播放）
  container.onclick = (e) => e.stopPropagation();
  currentlyPlayingMonitorId = cardId;
};

window.stopMonitorInline = function(cardId) {
  const container = document.getElementById(`monitor-thumb-${cardId}`);
  if (!container) return;
  if (container.dataset.originalHtml) {
    container.innerHTML = container.dataset.originalHtml;
  }
  container.classList.remove('is-playing');
  // 恢复点击事件
  container.onclick = () => playMonitorInline(cardId, container.dataset.youtubeId || '');
  if (currentlyPlayingMonitorId === cardId) currentlyPlayingMonitorId = null;
};

// 保留旧的浮层播放函数用于后备（不再使用）
function openMonitorPlayer(youtubeVideoId, isShort) {
  const overlay = document.getElementById('monitor-player-overlay');
  const container = document.querySelector('.player-container');
  const content = document.getElementById('monitor-player-content');

  if (isShort) {
    container.classList.add('player-short');
  } else {
    container.classList.remove('player-short');
  }

  content.innerHTML = `<iframe width="100%" height="100%" src="https://www.youtube.com/embed/${youtubeVideoId}?autoplay=1&rel=0" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share" allowfullscreen style="border-radius:12px;"></iframe>`;
  overlay.style.display = 'flex';
}

function closeMonitorPlayer() {
  const overlay = document.getElementById('monitor-player-overlay');
  const content = document.getElementById('monitor-player-content');
  overlay.style.display = 'none';
  content.innerHTML = '';
}

function formatViewsNum(n) {
  if (!n) return '-';
  const num = parseInt(n);
  if (num >= 10000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 1000000) return (num / 1000000).toFixed(1) + 'M';
  if (num >= 10000) return (num / 10000).toFixed(1) + '万';
  if (num >= 1000) return (num / 1000).toFixed(1) + 'K';
  return num.toLocaleString();
}

function formatDurationDisplay(seconds) {
  if (!seconds) return '';
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  if (h > 0) return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  return `${m}:${String(s).padStart(2, '0')}`;
}

function closeModal() {
  if ($modalOverlay) {
    $modalOverlay.style.display = 'none';
    $modalOverlay.innerHTML = '';
  }
}

// ==================== 素材库事件绑定 ====================
function bindEvents() {
  // 新增按钮
  document.getElementById('btn-add-video').addEventListener('click', () => showDetail(null));

  // 关闭内嵌视图返回主列表
  document.getElementById('btn-back-to-list').addEventListener('click', closeDetail);

  // 保存 & 删除
  document.getElementById('btn-save-inline').addEventListener('click', saveVideo);
  document.getElementById('btn-delete-inline').addEventListener('click', deleteVideo);
  document.getElementById('btn-ai-restart').addEventListener('click', startOrRestartInlineAi);
  document.getElementById('btn-ai-send').addEventListener('click', sendInlineAiMessage);
  document.getElementById('btn-copy-ai-script').addEventListener('click', copyInlineAiScript);
  document.getElementById('btn-gemini-key-modal').addEventListener('click', openGeminiKeyModal);

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
  bindLibraryDisplayControls();

  // 动态添加行
  document.querySelectorAll('.btn-add-row').forEach(btn => {
    btn.addEventListener('click', () => addDynamicRow(btn.dataset.target));
  });

  // 点击蒙层关闭
  if ($modalOverlay) {
    $modalOverlay.addEventListener('click', (e) => {
      if (e.target === $modalOverlay) closeModal();
    });
  }

  // ESC 关闭弹窗
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      closeMonitorPlayer();
      closeModal();
      closeDetail();
    }
  });
}

function bindLibraryDisplayControls() {
  const modeWrap = document.getElementById('library-display-mode');
  const seriesSort = document.getElementById('series-sort');
  if (!modeWrap || !seriesSort) return;

  modeWrap.querySelectorAll('.segmented-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.mode;
      if (!mode || mode === libraryDisplayMode) return;
      libraryDisplayMode = mode;
      localStorage.setItem('libraryDisplayMode', mode);
      currentPage = 1;
      sessionStorage.setItem('currentPage', 1);
      updateLibraryDisplayControls();
      renderCurrentView();
    });
  });

  seriesSort.value = seriesSortMode;
  seriesSort.addEventListener('change', () => {
    seriesSortMode = seriesSort.value;
    localStorage.setItem('seriesSortMode', seriesSortMode);
    currentPage = 1;
    sessionStorage.setItem('currentPage', 1);
    renderCurrentView();
  });

  updateLibraryDisplayControls();
}

function updateLibraryDisplayControls() {
  document.querySelectorAll('#library-display-mode .segmented-btn').forEach(btn => {
    btn.classList.toggle('active', btn.dataset.mode === libraryDisplayMode);
  });
  const seriesSort = document.getElementById('series-sort');
  if (seriesSort) {
    seriesSort.value = seriesSortMode;
    seriesSort.style.display = libraryDisplayMode === 'series' ? '' : 'none';
  }
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
  const mechanisms = new Map();

  allVideos.forEach(v => {
    (v.video_tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => videoTags.add(t));
    (v.hook_tags || '').split(',').map(t => t.trim()).filter(Boolean).forEach(t => { hookTags.add(t); allHookTags.add(t); });
    const seriesName = window.getVideoSeriesName(v);
    if (seriesName) mechanisms.set(seriesName, window.getVideoSeriesId(v));
  });

  fillSelect('filter-video-tag', '视频标签', videoTags);
  fillSelect('filter-hook-tag', '开头标签', hookTags);
  fillSeriesSelect('filter-mechanism', '系列', mechanisms);
}

function fillSelect(id, placeholder, items) {
  const el = document.getElementById(id);
  const current = el.value;
  el.innerHTML = `<option value="">${placeholder}</option>` +
    [...items].sort().map(i => `<option value="${escapeHtml(i)}">${escapeHtml(i)}</option>`).join('');
  el.value = current; // 保留当前选中
}

function fillSeriesSelect(id, placeholder, items) {
  const el = document.getElementById(id);
  const current = el.value;
  const entries = [...items.entries()].sort((a, b) => {
    const idA = a[1] || Number.MAX_SAFE_INTEGER;
    const idB = b[1] || Number.MAX_SAFE_INTEGER;
    return idA === idB ? a[0].localeCompare(b[0]) : idA - idB;
  });
  el.innerHTML = `<option value="">${placeholder}</option>` +
    entries.map(([name, seriesId]) =>
      `<option value="${escapeHtml(name)}">${escapeHtml(window.formatSeriesLabel(seriesId, name))}</option>`
    ).join('');
  el.value = current;
}

function applyFilters(keepPage = false) {
  const fVideoTag = document.getElementById('filter-video-tag').value;
  const fHookTag = document.getElementById('filter-hook-tag').value;
  const fMechanism = document.getElementById('filter-mechanism').value;

  // 筛选
  let filtered = allVideos.filter(v => {
    if (fVideoTag && !(v.video_tags || '').split(',').map(t => t.trim()).includes(fVideoTag)) return false;
    if (fHookTag && !(v.hook_tags || '').split(',').map(t => t.trim()).includes(fHookTag)) return false;
    if (fMechanism && window.getVideoSeriesName(v) !== fMechanism) return false;
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
    const $pagination = document.getElementById('pagination');
    if ($pagination) $pagination.style.display = 'none';
    loadSummaryView(currentView);
  }
}

function renderCurrentView() {
  $videoCount.textContent = `${videos.length} 个视频`;
  if (currentView === 'all') {
    renderVideoList();
  } else {
    const $pagination = document.getElementById('pagination');
    if ($pagination) $pagination.style.display = 'none';
    loadSummaryView(currentView);
  }
}

// ==================== 共享渲染组件 ====================
window.padId = id => String(id).padStart(3, '0');
window.formatVideoLabel = v => `${window.padId(v.id)}-${v.name || v.video_title || '待命名'}`;
window.getVideoSeriesId = v => {
  const id = Number(v.series_id);
  return Number.isFinite(id) && id > 0 ? id : null;
};
window.getVideoSeriesName = v => v.series_name || v.mechanism_name || '未分类';
window.formatSeriesLabel = (seriesId, name) => {
  const seriesName = name || '未分类';
  return seriesId ? `系列${window.padId(seriesId)}-${seriesName}` : `系列未编号-${seriesName}`;
};
window.formatCreatedAt = value => {
  if (!value) return '';
  const text = String(value).trim().replace('T', ' ');
  const match = text.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})/);
  if (match) return `${match[1]} ${match[2]}`;
  return text.slice(0, 16);
};
window.compareCreatedDesc = (a, b) => {
  const av = a.created_at || a.date || '';
  const bv = b.created_at || b.date || '';
  const byTime = String(bv).localeCompare(String(av));
  return byTime || ((b.id || 0) - (a.id || 0));
};

window.buildSeriesGroups = function(videoList, sortMode = seriesSortMode) {
  const groups = new Map();
  const sortedById = [...videoList].sort((a, b) => b.id - a.id);

  for (const v of sortedById) {
    const seriesId = window.getVideoSeriesId(v);
    const seriesName = window.getVideoSeriesName(v);
    const key = seriesId ? `id:${seriesId}` : `name:${seriesName}`;
    if (!groups.has(key)) {
      groups.set(key, {
        id: seriesId,
        name: seriesName,
        mechanism: v.series_mechanism || v.mechanism || '',
        latestCreatedAt: v.created_at || v.date || '',
        latestVideoId: v.id || 0,
        vids: []
      });
    }
    const group = groups.get(key);
    if (!group.mechanism && (v.series_mechanism || v.mechanism)) {
      group.mechanism = v.series_mechanism || v.mechanism;
    }
    const createdAt = v.created_at || v.date || '';
    if (String(createdAt).localeCompare(String(group.latestCreatedAt)) > 0) {
      group.latestCreatedAt = createdAt;
      group.latestVideoId = v.id || group.latestVideoId;
    }
    group.vids.push(v);
  }

  const groupEntries = Array.from(groups.values());
  for (const group of groupEntries) {
    group.vids.sort(window.compareCreatedDesc);
  }
  groupEntries.sort((a, b) => {
    if (sortMode === 'series_desc') {
      return (b.id || 0) - (a.id || 0) || String(b.latestCreatedAt).localeCompare(String(a.latestCreatedAt));
    }
    if (sortMode === 'count_desc') {
      return b.vids.length - a.vids.length || String(b.latestCreatedAt).localeCompare(String(a.latestCreatedAt));
    }
    return String(b.latestCreatedAt).localeCompare(String(a.latestCreatedAt)) || ((b.latestVideoId || 0) - (a.latestVideoId || 0));
  });
  return groupEntries;
};

window.tagsHtml = (str, cls) => (str || '').split(',').filter(t => t.trim())
  .map(t => `<span class="tag ${cls}">${escapeHtml(t.trim())}</span>`).join('');

window.formatViewsNum = formatViewsNum;

function getVideoCardStatus(v) {
  const task = v.ai_task;
  if (!task) return null;
  const failed = [
    task.download_status, task.upload_status, task.transcript_status,
    task.preview_status, task.analysis_status, task.backup_status
  ].includes('failed');
  if (failed) return { text: '任务失败', cls: 'card-status-failed' };

  const download = task.download_status || task.backup_status;
  if (['queued', 'downloading'].includes(download)) return { text: download === 'downloading' ? '下载中' : '排队中', cls: 'card-status-active' };
  if (['queued', 'uploading'].includes(task.upload_status)) return { text: task.upload_status === 'uploading' ? '上传中' : '待上传', cls: 'card-status-active' };
  if (['queued', 'transcribing'].includes(task.transcript_status)) return { text: task.transcript_status === 'transcribing' ? '字幕中' : '待字幕', cls: 'card-status-active' };
  if (['queued', 'generating'].includes(task.preview_status)) return { text: task.preview_status === 'generating' ? '预览中' : '待预览', cls: 'card-status-active' };
  if (['queued', 'analyzing'].includes(task.analysis_status)) return { text: task.analysis_status === 'analyzing' ? 'Gemini中' : '待分析', cls: 'card-status-active' };

  const middleReady = !!(v.hook && v.mechanism_name && v.story_structure);
  if (task.analysis_status === 'ready' && !middleReady) return { text: '待补全', cls: 'card-status-waiting' };
  return null;
}

window.renderGlobalCard = v => {
  const thumbSrc = v.thumb_url || '';
  const thumbLink = v.preview_path ? ('/' + v.preview_path) : (v.video_link || v.video_path || '');
  const cardStatus = getVideoCardStatus(v);
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
      ${cardStatus ? `<span class="card-task-status ${cardStatus.cls}">${escapeHtml(cardStatus.text)}</span>` : ''}
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
        <div class="card-actions">
          <button class="btn-notes ${v.notes ? 'has-notes' : ''}" onclick="event.stopPropagation(); openNotes(${v.id})" title="${v.notes ? escapeHtml(v.notes).substring(0,50) : '添加备注'}">${v.notes ? '📝' : '➕'}</button>
        </div>
      </div>
    </div>
  </div>
  `;
};

window.generateGroupedCardsHtml = function(videoList) {
  const groupEntries = window.buildSeriesGroups(videoList);

  let html = '';
  for (const group of groupEntries) {
    const groupLabel = window.formatSeriesLabel(group.id, group.name);
    const copyArg = escapeHtml(groupLabel).replace(/'/g, "\\'");
    html += `
      <div class="mechanism-group">
        <div class="mechanism-header">
          <div class="mechanism-header-left">
            <span class="mechanism-number">${escapeHtml(group.id ? `系列${window.padId(group.id)}` : '系列未编号')}</span>
            <span class="mechanism-name">🎬 ${escapeHtml(group.name)}</span>
            <span class="mechanism-count">${group.vids.length} 个视频</span>
            <button class="btn-copy-mechanism" onclick="event.stopPropagation(); copyToClipboard('${copyArg}', '已复制系列')" title="复制系列号和名称">
              <svg viewBox="0 0 24 24" width="14" height="14" stroke="currentColor" stroke-width="2" fill="none" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path></svg>
            </button>
          </div>
        </div>
        <div class="card-grid">
          ${group.vids.map(v => window.renderGlobalCard(v)).join('')}
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
  updateLibraryDisplayControls();

  if (videos.length === 0) {
    $videoList.style.display = 'none';
    $emptyState.style.display = '';
    return;
  }
  $emptyState.style.display = 'none';

  if (libraryDisplayMode === 'latest') {
    const sortedVideos = [...videos].sort(window.compareCreatedDesc);
    const totalPages = Math.ceil(sortedVideos.length / videoItemsPerPage);
    if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
    else if (currentPage < 1) currentPage = 1;

    const startIndex = (currentPage - 1) * videoItemsPerPage;
    const paginatedVideos = sortedVideos.slice(startIndex, startIndex + videoItemsPerPage);
    $videoList.innerHTML = `<div class="latest-video-grid card-grid">${paginatedVideos.map(v => window.renderGlobalCard(v)).join('')}</div>`;
    renderPagination(totalPages);
    bindVideoCardClicks();
    return;
  }

  // 按固定系列编号分组
  const groupEntries = window.buildSeriesGroups(videos, seriesSortMode);

  // 计算系列的分页
  const totalPages = Math.ceil(groupEntries.length / itemsPerPage);
  if (currentPage > totalPages && totalPages > 0) currentPage = totalPages;
  else if (currentPage < 1) currentPage = 1;
  
  const startIndex = (currentPage - 1) * itemsPerPage;
  const paginatedGroups = groupEntries.slice(startIndex, startIndex + itemsPerPage);
  
  // 提取需要渲染的视频组
  const videosToRender = [];
  for (const group of paginatedGroups) {
    videosToRender.push(...group.vids);
  }

  $videoList.innerHTML = window.generateGroupedCardsHtml(videosToRender);

  // 渲染分页器
  renderPagination(totalPages);

  // 绑定卡片点击 → 详情
  bindVideoCardClicks();
}

function bindVideoCardClicks() {
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

function getCurrentListTotalPages() {
  if (libraryDisplayMode === 'latest') {
    return Math.ceil(videos.length / videoItemsPerPage);
  }
  return Math.ceil(window.buildSeriesGroups(videos, seriesSortMode).length / itemsPerPage);
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

  loadInlineAiPanel(video);

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
  'form-hook': 'hook',
  'form-hook-tags': 'hook_tags',
  'form-mechanism-name': 'mechanism_name',
  'form-story-structure': 'story_structure',
  'form-adapt-tags': 'adapt_tags',
  'form-adapt-brief': 'adapt_brief',
  'form-date': 'date',
  'form-video-link': 'video_link',
  'form-views': 'views',
  'form-likes': 'likes',
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
  clearInlineAiPoll();
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
    const totalPages = getCurrentListTotalPages();
    if (totalPages > 1) {
       $pagination.style.display = 'flex';
    }
  }

  currentVideoId = null;
  // 所有 DOM 操作完成后恢复滚动位置
  setTimeout(() => window.scrollTo(0, savedScrollY), 0);
}

function clearInlineAiPoll() {
  if (inlineAiPollTimer) {
    clearTimeout(inlineAiPollTimer);
    inlineAiPollTimer = null;
  }
}

function getVisibleConversations(conversations = []) {
  let latestAssistantIndex = -1;
  for (let i = conversations.length - 1; i >= 0; i -= 1) {
    if (conversations[i] && conversations[i].role === 'assistant') {
      latestAssistantIndex = i;
      break;
    }
  }
  return conversations.filter((c, idx) => c?.role === 'user' || idx === latestAssistantIndex);
}

function formatConversationTime(value) {
  if (!value) return '';
  const match = String(value).match(/^(\d{4})-(\d{2})-(\d{2})\s+(\d{2}:\d{2})/);
  if (!match) return String(value);
  const [, year, month, day, hm] = match;
  return `${year}-${month}-${day} ${hm}`;
}

function scrollListToLatestAssistantTop(list, selector) {
  if (!list) return;
  requestAnimationFrame(() => {
    const latestAssistant = list.querySelector(selector);
    if (!latestAssistant) {
      list.scrollTop = 0;
      return;
    }
    const listRect = list.getBoundingClientRect();
    const assistantRect = latestAssistant.getBoundingClientRect();
    list.scrollTop = list.scrollTop + (assistantRect.top - listRect.top);
  });
}

function resetInlineAiPanel(message = '保存视频后可启动 AI 分析') {
  clearInlineAiPoll();
  inlineAiTaskId = null;
  const status = document.getElementById('ai-panel-status');
  const list = document.getElementById('ai-conversation-list');
  const input = document.getElementById('ai-chat-input');
  const send = document.getElementById('btn-ai-send');
  const restart = document.getElementById('btn-ai-restart');
  if (status) status.textContent = message;
  if (list) list.innerHTML = '<div class="conv-empty">暂无 AI 对话</div>';
  if (input) input.value = '';
  if (send) send.disabled = true;
  if (restart) {
    restart.disabled = !currentVideoId;
    restart.textContent = currentVideoId ? '开始分析' : '开始分析';
  }
}

async function loadInlineAiPanel(video, preserveScroll = false) {
  if (!video?.id) {
    resetInlineAiPanel();
    return;
  }

  try {
    const res = await fetch(`/api/videos/${video.id}/ai-script`);
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '加载 AI 对话失败');
    renderInlineAiPanel(data, preserveScroll);
  } catch (err) {
    resetInlineAiPanel('AI 对话加载失败');
    showToast('AI 对话加载失败: ' + err.message, 'error');
  }
}

function renderInlineAiPanel(data, preserveScroll = false) {
  clearInlineAiPoll();
  const task = data.task;
  inlineAiTaskId = task ? task.id : null;

  const status = document.getElementById('ai-panel-status');
  const list = document.getElementById('ai-conversation-list');
  const input = document.getElementById('ai-chat-input');
  const send = document.getElementById('btn-ai-send');
  const restart = document.getElementById('btn-ai-restart');
  const oldScrollTop = list ? list.scrollTop : 0;

  const statusLabels = {
    queued: '排队中',
    analyzing: '分析中',
    ready: '就绪',
    failed: '失败',
  };
  if (status) {
    const label = task ? (statusLabels[task.analysis_status] || task.analysis_status || '未知') : '尚未分析';
    status.textContent = task?.analysis_error ? `${label}: ${task.analysis_error}` : label;
  }
  if (restart) {
    restart.disabled = !currentVideoId || task?.analysis_status === 'analyzing';
    restart.textContent = task ? '重启分析' : '开始分析';
  }
  if (send) send.disabled = !task || task.analysis_status === 'analyzing';
  if (input) input.disabled = !task || task.analysis_status === 'analyzing';

  if (list) {
    const conversations = getVisibleConversations(data.conversations || []);
    list.innerHTML = conversations.length ? conversations.map(c => `
      <div class="ai-message ai-message-${c.role}${c.role === 'assistant' ? ' ai-message-latest-assistant' : ''}">
        <div class="ai-message-meta">
          <div class="ai-message-role">${c.role === 'user' ? '我' : 'Gemini'}</div>
          ${formatConversationTime(c.created_at) ? `<div class="ai-message-time">${formatConversationTime(c.created_at)}</div>` : ''}
        </div>
        <div class="ai-message-content">${escapeHtml(c.content)}</div>
      </div>
    `).join('') : '<div class="conv-empty">暂无 AI 对话</div>';
    if (task?.analysis_status === 'analyzing') {
      list.insertAdjacentHTML('beforeend', '<div class="conv-thinking"><span class="spinner-small"></span> Gemini 分析中...</div>');
    }
    if (preserveScroll) list.scrollTop = oldScrollTop;
    else scrollListToLatestAssistantTop(list, '.ai-message-latest-assistant');
  }

  if (task && ['queued', 'analyzing'].includes(task.analysis_status)) {
    inlineAiPollTimer = setTimeout(() => loadInlineAiPanel({ id: data.videoId }, true), 4000);
  }
}

async function startOrRestartInlineAi() {
  const id = parseInt(document.getElementById('form-id').value);
  if (!id) { showToast('请先保存视频后再启动 AI 分析', 'error'); return; }

  const btn = document.getElementById('btn-ai-restart');
  const origText = btn.textContent;
  btn.disabled = true;
  btn.textContent = '处理中...';

  try {
    if (inlineAiTaskId) {
      const res = await fetch(`/api/import/tasks/${inlineAiTaskId}/restart-analysis`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useTranscript: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '重启分析失败');
    } else {
      const res = await fetch(`/api/videos/${id}/rewrite-script`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ useTranscript: true }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || '创建分析任务失败');
      inlineAiTaskId = data.taskId;
    }
    showToast('AI 分析已启动');
    loadInlineAiPanel({ id });
  } catch (err) {
    showToast('AI 分析失败: ' + err.message, 'error');
  } finally {
    btn.disabled = false;
    btn.textContent = origText;
  }
}

async function sendInlineAiMessage() {
  const id = parseInt(document.getElementById('form-id').value);
  const input = document.getElementById('ai-chat-input');
  const message = input.value.trim();
  if (!id) { showToast('请先保存视频后再发送', 'error'); return; }
  if (!inlineAiTaskId) { showToast('请先启动 AI 分析', 'error'); return; }
  if (!message) return;

  input.value = '';
  try {
    const res = await fetch(`/api/import/tasks/${inlineAiTaskId}/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ message }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || '发送失败');
    loadInlineAiPanel({ id });
  } catch (err) {
    showToast('发送失败: ' + err.message, 'error');
  }
}

function copyInlineAiScript() {
  const messages = document.querySelectorAll('.ai-message-assistant .ai-message-content');
  const text = messages.length ? messages[messages.length - 1].textContent : '';
  if (!text) return;
  navigator.clipboard.writeText(text).then(() => showToast('已复制脚本'));
}

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
function extractYouTubeIdFromInput(input) {
  if (!input) return '';
  const s = input.trim();
  if (!s) return '';
  if (s.includes('youtube.com/shorts/')) return s.split('youtube.com/shorts/')[1].split(/[?&/]/)[0];
  if (s.includes('youtu.be/')) return s.split('youtu.be/')[1].split(/[?&/]/)[0];
  if (s.includes('youtube.com/watch')) {
    const m = s.match(/[?&]v=([^?&/]+)/);
    if (m) return m[1];
  }
  if (s.includes('youtube.com/embed/')) return s.split('youtube.com/embed/')[1].split(/[?&/]/)[0];
  return s;
}

function escapeHtml(str) {
  if (!str) return '';
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function showToast(message, type = 'success', options = {}) {
  const existing = document.querySelector('.toast');
  if (existing) existing.remove();

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.setAttribute('role', 'status');
  toast.setAttribute('aria-live', 'polite');
  toast.textContent = message;
  document.body.appendChild(toast);

  setTimeout(() => toast.remove(), options.duration || 3000);
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
    renderCurrentView();
    showToast('备注已保存');
  } catch (e) {
    showToast('保存失败: ' + e.message, 'error');
  }
}

// 复制文本到剪贴板
function copyToClipboard(text, message = '已复制标题') {
  if (navigator.clipboard) {
    navigator.clipboard.writeText(text).then(() => {
      showToast(message);
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
      showToast(message);
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
