// Filo frontend — vanilla JS, renders the file management UI.
// Talks to the JSON API exposed by server.js (/api/config, /api/dirs, /api/dir,
// /api/thumb, /api/image).

const state = {
  config: null,
  dirs: [],          // current-level directory list from /api/dirs
  current: null,     // current dir object (with files)
  pageCursor: null,
  pageLoading: false,
  path: '',          // current relative path
  search: '',
  sort: 'name',
  layout: 'rows',
  images: [],        // image files of current dir (for lightbox)
  lbIndex: -1,
  lbList: [],        // active lightbox list (current dir images OR search images)
  allowManagement: false,
  selectMode: false,
  selection: new Set(),   // selected relative paths
  ctxTarget: null,        // file under context menu
  searchMode: false,      // true when showing recursive search results
  searchResults: [],
  authEnabled: false,     // server requires a password
  loggedIn: false,
  expanded: new Set(),    // sidebar tree paths currently expanded
  fileCache: new Map(),   // path -> file objects (lazy-loaded for the tree)
  publicCache: new Map(), // dir path -> inherited public flag (for tree right-click)
};
// items currently being dragged (internal move); empty when not dragging
let dragItems = [];

// lightbox view/zoom state
let lbZoom = 1, lbPanX = 0, lbPanY = 0, lbDragging = false, lbDragX = 0, lbDragY = 0;
let slideTimer = null;

const $ = (sel) => document.querySelector(sel);
// Show / hide an overlay element by id (modals, context menu, etc.)
const show = (id) => $('#' + id).classList.remove('hidden');
const hide = (id) => $('#' + id).classList.add('hidden');
const api = (p, q = {}) => {
  const u = new URL(p, location.origin);
  Object.entries(q).forEach(([k, v]) => u.searchParams.set(k, v));
  return fetch(u).then((r) => r.json());
};
const apiPost = (p, body) => fetch(p, {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify(body),
}).then((r) => r.json());

const ICONS = {
  home: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M3 11l9-8 9 8"/><path d="M5 10v10h14V10"/><path d="M10 20v-6h4v6"/></svg>`,
  folder: `<svg viewBox="0 0 24 24" fill="currentColor"><path d="M10 4H4c-1.1 0-2 .9-2 2v12c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2h-8l-2-2z"/></svg>`,
  image: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5" fill="currentColor" stroke="none"/><path d="M21 15l-5-5L5 21"/></svg>`,
  video: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2" y="6" width="20" height="12" rx="2"/><polygon points="10,9 16,12 10,15" fill="currentColor" stroke="none"/></svg>`,
  audio: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M9 18V6l8-3v13"/><circle cx="6" cy="18" r="3"/><circle cx="18" cy="14" r="3"/></svg>`,
  pdf: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="12" y1="18" x2="12" y2="12"/><line x1="9" y1="15" x2="15" y2="15"/></svg>`,
  doc: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="16" y1="13" x2="8" y2="13"/><line x1="16" y1="17" x2="8" y2="17"/></svg>`,
  file: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M13 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V9z"/><polyline points="13 2 13 9 20 9"/></svg>`,
  lock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>`,
  unlock: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 9.9 1"/></svg>`,
};

function fmtSize(bytes) {
  if (!bytes) return '';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0, n = bytes;
  while (n >= 1024 && i < u.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(n < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}
function fmtDate(ts) {
  if (!ts) return '';
  return new Date(ts * 1000).toLocaleDateString('zh-CN', { year: 'numeric', month: 'short', day: 'numeric' });
}
function fmtDateTime(ts) {
  if (!ts) return '—';
  return new Date(ts * 1000).toLocaleString('zh-CN', {
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
}

// ---------------------------------------------------------------------------
// Boot
// ---------------------------------------------------------------------------
async function init() {
  state.config = await api('/api/config');
  state.layout = state.config.layout || 'rows';
  state.allowManagement = !!state.config.allow_management;
  state.authEnabled = !!state.config.auth_enabled;
  state.loggedIn = !!state.config.logged_in;
  applyAuthState();

  // Auth/login handlers must be live even before a successful login, so wire
  // them once up front (everything is guarded by state.wired).
  if (!state.wired) { wireEvents(); state.wired = true; }

  // When no password is set the system is open; with a password, entering
  // requires login (unless you hit a public file's direct link, which needs no UI).
  if (state.authEnabled && !state.loggedIn) {
    openLoginModal();
    return;
  }
  await bootFilo();
}

async function loadMenuLevel(path = '') {
  const rows = await api('/api/dirs', { path });
  const normalized = (rows || []).map((d) => ({ ...d, path: d.path || '' }));
  const known = new Map(state.dirs.map((d) => [d.path, d]));
  normalized.forEach((d) => known.set(d.path, d));
  state.dirs = [...known.values()];
  return normalized;
}

async function bootFilo() {
  // 只请求根目录的直接子目录；展开目录时再请求对应层级。
  await loadMenuLevel('');
  state.expanded.add('');
  renderMenu();
  ensureFiles('');
  buildLayoutMenu();
  buildSortMenu();

  // restore path from hash
  const hash = decodeURIComponent(location.hash.replace(/^#/, ''));
  const start = hash && hash.indexOf('=') === -1 ? hash : '';
  if (start) {
    let parent = '';
    for (const part of start.split('/')) {
      parent = parent ? parent + '/' + part : part;
      await loadMenuLevel(parent === start ? (parent.includes('/') ? parent.slice(0, parent.lastIndexOf('/')) : '') : parent);
    }
  }
  renderMenu();
  await loadDir(start);
  document.body.classList.remove('body-loading');
}

// Reflect current auth state in the UI (toolbar visibility, lock button).
function applyAuthState() {
  $('#auth-btn').classList.toggle('hidden', !state.authEnabled);
  $('#auth-btn').innerHTML = state.loggedIn ? ICONS.unlock : ICONS.lock;
  $('#auth-btn').title = state.loggedIn ? '登出' : '登录';
  if (!state.selectMode) $('#tools').classList.toggle('hidden', !state.allowManagement);
  // drag-to-move cursor hint only when management is available
  document.body.classList.toggle('allow-mgmt', !!state.allowManagement);
}

// ---- login / logout ----
function openLoginModal() {
  $('#login-error').textContent = '';
  $('#login-input').value = '';
  show('modal-login');
  $('#login-input').focus();
}
function closeLoginModal() { hide('modal-login'); }
async function doLogin() {
  const ok = $('#login-ok');
  ok.disabled = true;
  try {
    const j = await apiPost('/api/login', { password: $('#login-input').value });
    if (j.error) { $('#login-error').textContent = j.error; return; }
    state.config = await api('/api/config');
    state.authEnabled = !!state.config.auth_enabled;
    state.loggedIn = !!state.config.logged_in;
    state.allowManagement = !!state.config.allow_management;
    applyAuthState();
    closeLoginModal();
    toast('已登录');
    await bootFilo();
  } catch {
    $('#login-error').textContent = '网络错误，请重试';
  } finally {
    ok.disabled = false;
  }
}
async function doLogout() {
  try { await apiPost('/api/logout'); } catch { /* ignore */ }
  state.loggedIn = false;
  state.selectMode = false;
  state.selection.clear();
  state.config = await api('/api/config');
  state.allowManagement = !!state.config.allow_management;
  document.body.classList.remove('select-mode');
  applyAuthState();        // restores #tools visibility based on allow_management
  renderFiles(state.current); // refresh cards (e.g. selection checkboxes)
  toast('已登出');
}

// Reload both menu (sidebar) and current dir after a mutation.
async function refreshAll() {
  // 记录当前已展开的目录，随后清空它们的文件缓存，使移动/删除后树能立即反映变化。
  const expanded = [...state.expanded];
  for (const p of expanded) state.fileCache.delete(p);
  try {
    await loadMenuLevel('');
    renderMenu();
  } catch { /* ignore */ }
  // 重新加载当前目录（含主视图渲染）
  await loadDir(state.path);
  // 其余已展开目录逐一重新拉取文件叶子，避免它们卡在“加载中…”占位。
  for (const p of expanded) {
    if (p !== state.path) ensureFiles(p);
  }
}

// ---------------------------------------------------------------------------
// Directory loading + rendering
// ---------------------------------------------------------------------------
async function loadDir(rel) {
  rel = (rel || '').trim();
  if (rel !== state.path) { state.selection.clear(); }
  document.body.classList.add('body-loading');
  try {
    const dir = await api('/api/dir-page', { path: rel, limit: 100 });
    if (dir && dir.error) {
      if (dir.error.includes('登录')) openLoginModal();
      throw new Error(dir.error);
    }
    const fileMap = Object.fromEntries((dir.files || []).map((f) => [f.basename, f]));
    state.current = { ...dir, files: fileMap, files_count: (dir.dirs || []).length + (dir.files || []).length }; 
    state.publicCache.set(rel, !!dir.public);
    state.pageCursor = dir.next_cursor || null;
    state.path = rel;
    location.hash = rel;
    // 默认折叠、保持清爽：导航时不再自动展开父链，目录是否展开完全由用户控制。
    // 仅当当前目录（含 Home 根）已被用户展开时，重新拉取它的文件叶子，确保移动/删除后树即时更新。
    if (state.expanded.has(rel)) ensureFiles(rel);
    markActiveMenu(rel);
    renderMenu();
    renderFiles(dir);
    updateInfo(dir);
  } catch (e) {
    toast('加载失败: ' + e.message, 'error');
  } finally {
    document.body.classList.remove('body-loading');
  }
}

function filesArray(dir) {
  const dirs = dir.dirs || Object.values(dir.files || {}).filter((f) => f.is_dir);
  const files = Object.values(dir.files || {}).filter((f) => !f.is_dir);
  return dirs.concat(files);
}

async function loadMoreFiles() {
  if (!state.pageCursor || state.pageLoading || !state.current) return;
  state.pageLoading = true;
  try {
    const page = await api('/api/dir-page', { path: state.path, limit: 100, cursor: state.pageCursor });
    const old = Object.values(state.current.files || {});
    const next = [...old, ...(page.files || [])];
    state.current.files = Object.fromEntries(next.map((f) => [f.basename, f]));
    state.current.dirs = [...(state.current.dirs || []), ...(page.dirs || [])];
    state.pageCursor = page.next_cursor || null;
    renderFiles(state.current);
    updateInfo(state.current);
  } finally {
    state.pageLoading = false;
  }
}

function applySearchSort(list) {
  let out = list;
  if (state.search) {
    const q = state.search.toLowerCase();
    out = out.filter((f) => f.basename.toLowerCase().includes(q));
  }
  const s = state.sort;
  out = out.slice().sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1; // folders first
    switch (s) {
      case 'date': return b.mtime - a.mtime;
      case 'size': return (b.filesize || 0) - (a.filesize || 0);
      case 'type': return (a.ext || '').localeCompare(b.ext || '');
      default: return a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' });
    }
  });
  return out;
}

// ---------------------------------------------------------------------------
// Drag & drop shared helpers — cards, tree rows and the document-level
// fallback all reuse these so the move/upload logic lives in one place.
// ---------------------------------------------------------------------------
function hasExternalFiles(e) {
  return !!(e.dataTransfer && e.dataTransfer.types && Array.from(e.dataTransfer.types).includes('Files'));
}
// Find the directory row an element belongs to: walk up to the nearest
// directory-type .tree-node (covering its expanded children area too).
function dirRowForTarget(el) {
  let n = el.closest('.tree-node');
  while (n) {
    const dirRow = n.querySelector(':scope > .tree-row.dir');
    if (dirRow) return dirRow;
    n = n.parentElement ? n.parentElement.closest('.tree-node') : null;
  }
  return null;
}
// Clear a single element's drop highlight + label.
function clearTarget(el) {
  el.classList.remove('drop-target', 'move-target');
  if (el.dataset) el.dataset.uploadLabel = '';
}
// Clear every drop highlight, label and the whole-view drag hint.
function clearTargets() {
  document.querySelectorAll('.drop-target').forEach((el) => clearTarget(el));
  const fc = $('#files-container');
  if (fc) fc.classList.remove('drag-over', 'drag-move');
}
// Make an element a drag source (internal move). useSelection lets cards drag
// the whole selection when one of their items is already selected.
function wireDragSource(el, path, useSelection = false) {
  el.draggable = true;
  el.addEventListener('dragstart', (e) => {
    if (useSelection && state.selectMode && state.selection.has(path)) dragItems = [...state.selection];
    else dragItems = [path];
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', path); // Firefox needs a payload
    el.classList.add('dragging');
  });
  el.addEventListener('dragend', () => {
    el.classList.remove('dragging');
    dragItems = [];
    clearTargets();
  });
}
// Make an element a drop target (internal move OR external upload into it).
function wireDropTarget(el, { path, name }) {
  el.addEventListener('dragover', (e) => {
    const hasFiles = hasExternalFiles(e);
    if (dragItems.length) {
      if (dragItems.includes(path)) return;
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'move';
      $('#files-container').classList.remove('drag-over', 'drag-move'); // hide whole-view hint when over a real folder
      clearTarget(el); el.classList.add('drop-target', 'move-target'); el.dataset.uploadLabel = name; // 移动到 X
    } else if (hasFiles) {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
      $('#files-container').classList.remove('drag-over', 'drag-move');
      clearTarget(el); el.dataset.uploadLabel = name; el.classList.add('drop-target'); // 上传到 X
    }
  });
  el.addEventListener('dragleave', (e) => {
    // only clear when the pointer truly leaves the element (not when crossing
    // child nodes like the thumbnail/text), so the dashed box never "sticks".
    if (!e.relatedTarget || !el.contains(e.relatedTarget)) clearTarget(el);
  });
  el.addEventListener('drop', (e) => {
    const hasFiles = hasExternalFiles(e);
    if (dragItems.length) {
      if (dragItems.includes(path)) return;
      e.preventDefault(); e.stopPropagation();
      clearTarget(el);
      dropMove(dragItems, path);
      dragItems = [];
    } else if (hasFiles && e.dataTransfer?.files?.length) {
      e.preventDefault(); e.stopPropagation();
      clearTarget(el);
      uploadFiles(e.dataTransfer.files, path);
      endUploadDrag();
    }
  });
}

function makeCard(f, { thumbSize, withCheck = true, showParent = false } = {}) {
  const card = document.createElement('div');
  card.className = 'card' + (f.is_dir ? ' folder' : '');
  card.dataset.path = f.path;

  const thumb = document.createElement('div');
  thumb.className = 'card-thumb';
  if (f.is_dir) {
    thumb.innerHTML = ICONS.folder;
  } else if (f.icon === 'image') {
    const img = document.createElement('img');
    img.loading = 'lazy';
    img.src = `/api/thumb?path=${encodeURIComponent(f.path)}&size=${thumbSize}`;
    img.alt = f.basename;
    img.onerror = () => {
      img.replaceWith(Object.assign(document.createElement('div'),
        { innerHTML: ICONS.image, style: 'display:flex;align-items:center;justify-content:center;height:100%;color:var(--fg-dim)' }));
    };
    thumb.appendChild(img);
  } else {
    thumb.innerHTML = ICONS[f.icon] || ICONS.file;
    thumb.style.cssText += 'display:flex;align-items:center;justify-content:center;color:var(--fg-dim);background:var(--bg-3)';
  }
  card.appendChild(thumb);

  const meta = document.createElement('div');
  meta.className = 'card-meta';
  const name = document.createElement('div');
  name.className = 'card-name';
  name.textContent = f.basename;
  name.title = f.basename;
  meta.appendChild(name);

  const sub = document.createElement('div');
  sub.className = 'card-sub';
  if (showParent && f.parent) {
    sub.textContent = f.parent || '根目录';
    sub.title = f.parent || '根目录';
  } else if (!f.is_dir) {
    const dims = f.image ? `${f.image.width}×${f.image.height}` : '';
    sub.textContent = [fmtSize(f.filesize), dims, fmtDate(f.mtime)].filter(Boolean).join('  ·  ');
  } else {
    sub.textContent = `${f.files_count || 0} 项`;
  }
  meta.appendChild(sub);
  card.appendChild(meta);

  if (withCheck) {
    const check = document.createElement('div');
    check.className = 'card-check';
    check.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    card.appendChild(check);
  }

  card.addEventListener('click', () => {
    if (state.selectMode) { toggleSelect(f.path, card); return; }
    if (f.is_dir) {
      if (state.searchMode) { clearSearch(); loadDir(f.path); }
      else loadDir(f.path);
    } else if (f.icon === 'image') {
      if (state.searchMode) openLightboxFromList(state.searchImages, state.searchImages.indexOf(f));
      else openLightbox(state.images.indexOf(f));
    } else if (f.editable && state.allowManagement) {
      openEditModal(f);
    } else {
      window.open(`/api/image?path=${encodeURIComponent(f.path)}&download=1`, '_blank');
    }
  });
  card.addEventListener('contextmenu', (e) => {
    e.preventDefault();
    // 文件沿用当前目录的继承公开位判断“复制直连”；文件夹用自身返回的公开位
    openContextMenu(e.clientX, e.clientY, Object.assign({}, f, {
      public: f.is_dir ? !!f.public : (state.current?.public || false),
    }));
  });

  // ---- drag to move (management only, not in search mode) ----
  if (state.allowManagement && !state.searchMode) {
    wireDragSource(card, f.path, true);
    if (f.is_dir) wireDropTarget(card, { path: f.path, name: f.basename });
  }

  return card;
}

function renderFiles(dir) {
  const container = $('#files');
  container.className = `list files-${state.layout}`;
  const list = applySearchSort(filesArray(dir));

  // collect image-only list for lightbox
  state.images = list.filter((f) => f.icon === 'image' && !f.is_dir);
  state.lbList = state.images; // dir-mode lightbox list

  if (!list.length) {
    container.innerHTML = `<div class="empty-state">这里空空如也${state.search ? '（无匹配结果）' : ''}</div>`;
    return;
  }

  const frag = document.createDocumentFragment();
  const thumbSize = { small: 200, rows: 320, large: 480, list: 96 }[state.layout] || 320;
  list.forEach((f) => frag.appendChild(makeCard(f, { thumbSize })));
  container.innerHTML = '';
  container.appendChild(frag);
  if (state.pageCursor) {
    const more = document.createElement('button');
    more.className = 'btn load-more';
    more.textContent = state.pageLoading ? '加载中…' : '加载更多';
    more.disabled = state.pageLoading;
    more.addEventListener('click', loadMoreFiles);
    container.appendChild(more);
  }
  if (state.selectMode) syncSelectionUI();
}

// Recursive search across the whole file tree.
async function doSearch(q) {
  try {
    const results = await api('/api/search', { q });
    state.searchResults = results;
    state.searchImages = results.filter((f) => f.icon === 'image');
    state.searchMode = true;
    renderSearch(q);
  } catch (e) {
    toast('搜索失败: ' + e.message, 'error');
  }
}

function clearSearch() {
  state.searchMode = false;
  state.searchResults = [];
  state.searchImages = [];
}

function renderSearch(q) {
  const container = $('#files');
  container.className = 'list files-rows';
  const results = state.searchResults;
  $('#topbar-info').textContent = `搜索 “${q}” · 命中 ${results.length} 项`;
  $('#topbar-info').classList.remove('info-hidden');

  if (!results.length) {
    container.innerHTML = `<div class="empty-state">没有匹配 “${q}” 的文件</div>`;
    return;
  }
  const frag = document.createDocumentFragment();
  results.forEach((f) => frag.appendChild(makeCard(f, { thumbSize: 320, withCheck: false, showParent: true })));
  container.innerHTML = '';
  container.appendChild(frag);
}

function updateInfo(dir) {
  const imgs = filesArray(dir).filter((f) => f.icon === 'image').length;
  const files = filesArray(dir).filter((f) => !f.is_dir).length;
  const txt = `${filesArray(dir).length} 项 · ${imgs} 个图片 · ${(dir.dirsize || 0) ? fmtSize(dir.dirsize) : ''}`;
  const info = $('#topbar-info');
  info.textContent = txt.trim();
  info.classList.remove('info-hidden');
}

// ---------------------------------------------------------------------------
// Sidebar file tree: directory skeleton (from /api/dirs) + lazy-loaded files
// ---------------------------------------------------------------------------
function buildDirSkeleton(dirs) {
  const root = { path: '', children: {} };
  const map = { '': root };
  dirs.forEach((d) => {
    const parent = d.path.includes('/') ? d.path.slice(0, d.path.lastIndexOf('/')) : '';
    const node = { path: d.path, name: d.basename, children: {}, isDir: true, publicSelf: !!d.public_self };
    (map[parent]?.children || root.children)[d.basename] = node;
    map[d.path] = node;
  });
  return root;
}

function sortKeys(obj) {
  return Object.keys(obj).sort((a, b) =>
    a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }));
}

function renderMenu() {
  const tree = buildDirSkeleton(state.dirs);
  tree.name = 'Home';        // 根目录在树里显示为 “Home”
  tree.publicSelf = false;   // 根目录不可设为公开
  const box = $('#sidebar-menu');
  box.innerHTML = '';
  box.appendChild(renderTreeNode(tree));
  markActiveMenu(state.path);
}

function renderTreeNode(node) {
  const wrap = document.createElement('div');
  const expanded = state.expanded.has(node.path);
  wrap.className = 'tree-node' + (expanded ? '' : ' collapsed');

  const row = document.createElement('div');
  row.className = 'tree-row dir';
  row.dataset.path = node.path;
  row.dataset.name = node.name;

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  toggle.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M9 6l6 6-6 6"/></svg>';
  row.appendChild(toggle);

  const icon = document.createElement('span');
  icon.className = 'tree-icon';
  icon.innerHTML = node.path === '' ? ICONS.home : ICONS.folder;
  row.appendChild(icon);

  const label = document.createElement('span');
  label.textContent = node.name;
  row.appendChild(label);

  if (node.publicSelf) {
    const badge = document.createElement('span');
    badge.className = 'tree-badge'; badge.innerHTML = ICONS.unlock; badge.title = '公开目录';
    row.appendChild(badge);
  }

  // toggle click: only expand/collapse (stop propagation so it doesn't navigate)
  toggle.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (state.expanded.has(node.path)) {
      state.expanded.delete(node.path);
      renderMenu();
      return;
    }
    state.expanded.add(node.path);
    renderMenu();
    await loadMenuLevel(node.path);
    ensureFiles(node.path);
    renderMenu();
  });
  // row click: navigate to the folder only (no auto-expand — keep the tree tidy)
  row.addEventListener('click', () => {
    if (state.path !== node.path) loadDir(node.path);
    else renderMenu();
  });
  // right-click on a directory (incl. Home): open context menu
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    openContextMenu(e.clientX, e.clientY, {
      is_dir: true,
      path: node.path,
      basename: node.name,
      publicSelf: !!node.publicSelf,
      public: state.publicCache.has(node.path) ? state.publicCache.get(node.path) : !!node.publicSelf,
    });
  });

  // drag source + target (management only, works everywhere in the tree)
  if (state.allowManagement) {
    wireDragSource(row, node.path);
    wireDropTarget(row, { path: node.path, name: node.name });
  }

  wrap.appendChild(row);

  if (expanded) {
    const childBox = document.createElement('div');
    childBox.className = 'tree-children';
    sortKeys(node.children).forEach((k) => childBox.appendChild(renderTreeNode(node.children[k])));
    // 所有目录（含根目录 Home）都展示其文件叶子，文件懒加载。
    const files = state.fileCache.get(node.path);
    if (files && files.length) {
      files.forEach((f) => childBox.appendChild(renderFileNode(f)));
    } else if (!files) {
      const loading = document.createElement('div');
      loading.className = 'tree-row file loading';
      loading.innerHTML = '<span class="tree-toggle"></span><span class="tree-icon"></span><span>加载中…</span>';
      childBox.appendChild(loading);
    }
    wrap.appendChild(childBox);
  }
  return wrap;
}

function renderFileNode(f) {
  const wrap = document.createElement('div');
  wrap.className = 'tree-node';
  const row = document.createElement('div');
  row.className = 'tree-row file';
  row.dataset.path = f.path;
  row.title = f.basename;

  const toggle = document.createElement('span');
  toggle.className = 'tree-toggle';
  row.appendChild(toggle);

  const icon = document.createElement('span');
  icon.className = 'tree-icon'; icon.innerHTML = ICONS[f.icon] || ICONS.file;
  row.appendChild(icon);

  const label = document.createElement('span');
  label.textContent = f.basename;
  row.appendChild(label);

  row.addEventListener('click', () => onSidebarFileClick(f));
  // right-click on a file leaf: open context menu (public flag from parent dir)
  row.addEventListener('contextmenu', (e) => {
    e.preventDefault(); e.stopPropagation();
    const parentPath = f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '';
    openContextMenu(e.clientX, e.clientY, Object.assign({}, f, {
      is_dir: false,
      public: state.publicCache.has(parentPath) ? state.publicCache.get(parentPath) : false,
    }));
  });
  // drag source (management only, works everywhere in the tree)
  if (state.allowManagement) {
    row.draggable = true;
    row.addEventListener('dragstart', (e) => {
      dragItems = [f.path];
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', f.path);
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => {
      row.classList.remove('dragging');
      dragItems = [];
      document.querySelectorAll('.drop-target').forEach((el) => el.classList.remove('drop-target'));
    });
  }
  wrap.appendChild(row);
  return wrap;
}

// Lazily fetch a directory's files so the tree can show file leaves.
async function ensureFiles(path) {
  if (state.fileCache.has(path)) return;
  try {
    const dir = await api('/api/dir-page', { path, limit: 100 });
    if (dir && !dir.error) {
      // dir.files includes subdirectories too; the tree already shows those
      // via the directory skeleton, so only keep actual files as leaves.
      state.fileCache.set(path, dir.files || []);
      state.publicCache.set(path, !!dir.public);
      state.publicCache.set(`${path}:self`, !!dir.public_self);
      state.publicCache.set(path, !!dir.public); // inherited public flag (for tree right-click)
      renderMenu();
    }
  } catch { /* ignore (e.g. session expired) */ }
}

function ancestorsOf(rel) {
  const out = [];
  let acc = '';
  (rel || '').split('/').forEach((part) => {
    if (!part) return;
    acc = acc ? acc + '/' + part : part;
    out.push(acc);
  });
  return out;
}

function onSidebarFileClick(f) {
  if (f.is_dir) { loadDir(f.path); return; }
  if (f.icon === 'image') openLightboxFromList([f], 0);
  else if (f.editable && state.allowManagement) openEditModal(f);
  else window.open(`/api/image?path=${encodeURIComponent(f.path)}&download=1`, '_blank');
}

function markActiveMenu(rel) {
  document.querySelectorAll('.tree-row.dir').forEach((r) => {
    r.classList.toggle('active', r.dataset.path === rel);
  });
}

// ---------------------------------------------------------------------------
// Layout + sort menus
// ---------------------------------------------------------------------------
function buildLayoutMenu() {
  const menu = $('#layout-menu');
  const opts = [
    ['rows', '默认网格'], ['small', '小图'], ['large', '大图'], ['list', '列表'],
  ];
  menu.innerHTML = '';
  opts.forEach(([val, label]) => {
    const item = document.createElement('div');
    item.className = 'item' + (state.layout === val ? ' active' : '');
    item.innerHTML = `<span>${label}</span><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 6-8"/></svg></span>`;
    item.addEventListener('click', () => {
      state.layout = val;
      menu.querySelectorAll('.item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      $('#layout-menu').parentElement.classList.remove('open');
      if (state.current) renderFiles(state.current);
    });
    menu.appendChild(item);
  });
}

function buildSortMenu() {
  const menu = $('#sort-menu');
  const opts = [
    ['name', '名称'], ['date', '日期'], ['size', '大小'], ['type', '类型'],
  ];
  menu.innerHTML = '';
  opts.forEach(([val, label]) => {
    const item = document.createElement('div');
    item.className = 'item' + (state.sort === val ? ' active' : '');
    item.innerHTML = `<span>${label}</span><span class="check"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.6" stroke-linecap="round" stroke-linejoin="round"><path d="M5 12l4 4 6-8"/></svg></span>`;
    item.addEventListener('click', () => {
      state.sort = val;
      menu.querySelectorAll('.item').forEach((i) => i.classList.remove('active'));
      item.classList.add('active');
      $('#sort-menu').parentElement.classList.remove('open');
      if (state.current) renderFiles(state.current);
    });
    menu.appendChild(item);
  });
}

// ---------------------------------------------------------------------------
// Lightbox (slideshow / zoom / filmstrip / preload)
// ---------------------------------------------------------------------------
function openLightbox(idx) {
  if (idx < 0 || idx >= state.lbList.length) return;
  state.lbIndex = idx;
  const lb = $('#lightbox');
  lb.classList.remove('hidden');
  resetZoom();
  renderStrip();
  showLightboxImage();
  document.addEventListener('keydown', onKey);
}
// open lightbox from an arbitrary list (e.g. recursive search results)
function openLightboxFromList(list, idx) {
  state.lbList = list;
  openLightbox(idx);
}
function closeLightbox() {
  stopSlideshow();
  $('#lightbox').classList.add('hidden');
  document.removeEventListener('keydown', onKey);
}
function showLightboxImage() {
  const f = state.lbList[state.lbIndex];
  if (!f) return;
  const img = $('#lb-img');
  resetZoom();
  img.classList.add('lb-loading');
  img.onload = () => img.classList.remove('lb-loading');
  img.src = `/api/image?path=${encodeURIComponent(f.path)}`;
  $('#lb-caption').textContent = `${f.basename}${f.image ? `  ·  ${f.image.width}×${f.image.height}` : ''}`;
  $('#lb-counter').textContent = `${state.lbIndex + 1} / ${state.lbList.length}`;
  highlightStrip();
  preloadNeighbors();
}
function lbNav(dir) {
  const n = state.lbList.length;
  if (n === 0) return;
  state.lbIndex = (state.lbIndex + dir + n) % n;
  showLightboxImage();
}
// preload prev + next for smooth navigation
function preloadNeighbors() {
  const n = state.lbList.length;
  [-1, 1].forEach((d) => {
    const f = state.lbList[(state.lbIndex + d + n) % n];
    if (f && f.icon === 'image') {
      const im = new Image();
      im.src = `/api/image?path=${encodeURIComponent(f.path)}`;
    }
  });
}
// ---- filmstrip ----
function renderStrip() {
  const strip = $('#lb-strip');
  strip.innerHTML = '';
  const list = state.lbList;
  if (list.length <= 1) { strip.classList.add('hidden'); return; }
  strip.classList.remove('hidden');
  list.forEach((f, i) => {
    const t = document.createElement('div');
    t.className = 'strip-thumb';
    t.dataset.idx = i;
    if (f.icon === 'image') {
      const im = document.createElement('img');
      const size = 120;
      im.src = `/api/thumb?path=${encodeURIComponent(f.path)}&size=${size}`;
      im.alt = f.basename;
      t.appendChild(im);
    } else {
      t.innerHTML = ICONS[f.icon] || ICONS.file;
    }
    strip.appendChild(t);
  });
}
function highlightStrip() {
  const strip = $('#lb-strip');
  strip.querySelectorAll('.strip-thumb').forEach((t, i) => {
    t.classList.toggle('active', i === state.lbIndex);
  });
  const active = strip.querySelector('.strip-thumb.active');
  if (active) active.scrollIntoView({ block: 'nearest', inline: 'center' });
}
// ---- zoom / pan ----
function resetZoom() { lbZoom = 1; lbPanX = 0; lbPanY = 0; applyZoomTransform(); }
function setZoom(z) {
  lbZoom = Math.max(1, Math.min(6, z));
  if (lbZoom === 1) { lbPanX = 0; lbPanY = 0; }
  applyZoomTransform();
}
function toggleZoom() { setZoom(lbZoom > 1 ? 1 : 2.5); }
function applyZoomTransform() {
  const img = $('#lb-img');
  img.style.transform = `translate(${lbPanX}px, ${lbPanY}px) scale(${lbZoom})`;
  img.style.cursor = lbZoom > 1 ? 'grab' : 'zoom-in';
}
// ---- slideshow ----
function toggleSlideshow() {
  if (slideTimer) stopSlideshow();
  else startSlideshow();
}
function startSlideshow() {
  if (state.lbList.length < 2) return;
  $('#lb-play').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><rect x="6" y="5" width="4" height="14" rx="1"/><rect x="14" y="5" width="4" height="14" rx="1"/></svg>';
  slideTimer = setInterval(() => lbNav(1), 2800);
}
function stopSlideshow() {
  if (slideTimer) { clearInterval(slideTimer); slideTimer = null; }
  $('#lb-play').innerHTML = '<svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M8 5v14l11-7z"/></svg>';
}
function onKey(e) {
  const tag = (e.target.tagName || '').toLowerCase();
  // Esc 在输入框/文本域内也允许关闭弹窗（尤其是编辑器）
  if (e.key === 'Escape' && (tag === 'input' || tag === 'select' || tag === 'textarea')) {
    if (!$('#modal-edit').classList.contains('hidden')) { closeEditModal(); return; }
    if (!$('#modal-mkfile').classList.contains('hidden')) { closeMkfileModal(); return; }
    if (tag !== 'textarea' && !$('#modal').classList.contains('hidden')) { closeModal(); return; }
  }
  if (tag === 'input' || tag === 'select' || tag === 'textarea') return;
  if (e.key === 'Escape') {
    closeContextMenu(); closeEmptyMenu();
    closeDropdown('dd-new'); closeDropdown('dd-upload');
    if (!$('#help').classList.contains('hidden')) { $('#help').classList.add('hidden'); return; }
    if (!$('#modal').classList.contains('hidden')) { closeModal(); return; }
    if (!$('#modal-move').classList.contains('hidden')) { closeMoveModal(); return; }
    if (!$('#modal-mkfile').classList.contains('hidden')) { closeMkfileModal(); return; }
    if (!$('#modal-edit').classList.contains('hidden')) { closeEditModal(); return; }
    closeLightbox();
  } else if ($('#lightbox').classList.contains('hidden')) {
    if (e.key === '?') $('#help').classList.remove('hidden');
  } else {
    if (e.key === 'ArrowLeft') lbNav(-1);
    else if (e.key === 'ArrowRight') lbNav(1);
    else if (e.key === 'f' || e.key === 'F') toggleFull();
    else if (e.key === 's' || e.key === 'S') toggleSlideshow();
    else if (e.key === 'z' || e.key === 'Z') toggleZoom();
  }
}
function toggleFull() {
  const el = document.documentElement;
  if (!document.fullscreenElement) el.requestFullscreen?.();
  else document.exitFullscreen?.();
}

// ---------------------------------------------------------------------------
// Events + helpers
// ---------------------------------------------------------------------------
function wireEvents() {
  let searchTimer;
  $('#search').addEventListener('input', (e) => {
    const q = e.target.value.trim();
    state.search = q;
    clearTimeout(searchTimer);
    if (!q) {
      state.searchMode = false;
      loadDir(state.path);
      return;
    }
    searchTimer = setTimeout(() => doSearch(q), 220);
  });
  $('#layout-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#layout-menu').parentElement.classList.toggle('open'); $('#sort-menu').parentElement.classList.remove('open'); });
  $('#sort-btn').addEventListener('click', (e) => { e.stopPropagation(); $('#sort-menu').parentElement.classList.toggle('open'); $('#layout-menu').parentElement.classList.remove('open'); });
  document.addEventListener('click', () => { document.querySelectorAll('.dropdown.open').forEach((d) => d.classList.remove('open')); });

  $('#sidebar-toggle').addEventListener('click', () => {
    let open;
    if (window.innerWidth <= 760) open = document.body.classList.toggle('sidebar-open');
    else open = !document.body.classList.toggle('sidebar-closed');
    $('#sidebar-toggle').title = open ? '收起目录' : '展开目录';
  });
  $('#sidebar-bg').addEventListener('click', () => {
    document.body.classList.remove('sidebar-open');
    $('#sidebar-toggle').title = '收起目录';
  });
  $('#brand').addEventListener('click', (e) => { e.preventDefault(); loadDir(''); });

  $('#lb-close').addEventListener('click', closeLightbox);
  $('#lb-prev').addEventListener('click', () => lbNav(-1));
  $('#lb-next').addEventListener('click', () => lbNav(1));
  $('#lb-play').addEventListener('click', toggleSlideshow);
  $('#lb-zoom').addEventListener('click', () => toggleZoom());
  $('#lb-full').addEventListener('click', toggleFull);
  $('#lb-dl').addEventListener('click', () => {
    const f = state.lbList[state.lbIndex];
    if (f) window.open(`/api/image?path=${encodeURIComponent(f.path)}&download=1`, '_blank');
  });
  // click empty stage closes; click image toggles zoom (only if not dragging)
  $('#lb-stage').addEventListener('click', (e) => {
    if (e.target.id === 'lb-stage') closeLightbox();
  });
  $('#lb-img').addEventListener('click', (e) => {
    if (lbDragging) return;
    toggleZoom();
  });
  // wheel to zoom inside lightbox
  $('#lb-img').addEventListener('wheel', (e) => {
    e.preventDefault();
    setZoom(lbZoom * (e.deltaY < 0 ? 1.12 : 0.89));
  }, { passive: false });
  // drag to pan when zoomed
  $('#lb-img').addEventListener('mousedown', (e) => {
    if (lbZoom <= 1) return;
    lbDragging = true; lbDragX = e.clientX - lbPanX; lbDragY = e.clientY - lbPanY;
    e.preventDefault();
  });
  window.addEventListener('mousemove', (e) => {
    if (!lbDragging) return;
    lbPanX = e.clientX - lbDragX; lbPanY = e.clientY - lbDragY;
    applyZoomTransform();
  });
  window.addEventListener('mouseup', () => { lbDragging = false; });
  // filmstrip click → jump
  $('#lb-strip').addEventListener('click', (e) => {
    const t = e.target.closest('.strip-thumb');
    if (t) openLightbox(parseInt(t.dataset.idx, 10));
  });

  $('#help-btn').addEventListener('click', () => $('#help').classList.remove('hidden'));
  $('#help-close').addEventListener('click', () => $('#help').classList.add('hidden'));
  $('#help').addEventListener('click', (e) => { if (e.target.id === 'help') $('#help').classList.add('hidden'); });

  // ---- Auth (login / logout) ----
  $('#auth-btn').addEventListener('click', () => {
    if (state.loggedIn) doLogout();
    else openLoginModal();
  });
  $('#login-ok').addEventListener('click', doLogin);
  $('#login-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin(); });
  $('#modal-login').addEventListener('click', (e) => { if (e.target.id === 'modal-login') closeLoginModal(); });
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!$('#modal-details').classList.contains('hidden')) { closeDetailsModal(); return; }
      if (!$('#modal-storage').classList.contains('hidden')) { closeStorageModal(); return; }
      if (!$('#modal-login').classList.contains('hidden')) closeLoginModal();
    }
  });

  window.addEventListener('hashchange', () => {
    const h = decodeURIComponent(location.hash.replace(/^#/, ''));
    if (h !== state.path && h.indexOf('=') === -1) loadDir(h);
  });

  // ---- File management wiring ----
  // Attach unconditionally: when management is disabled the toolbar buttons are
  // hidden via applyAuthState, so they're unreachable. This also keeps the
  // public toggle working after a login changes allowManagement at runtime.
  wireManagement();
}

// ---------------------------------------------------------------------------
// File management: selection, context menu, modal, upload, batch ops
// ---------------------------------------------------------------------------
function wireManagement() {
  $('#btn-upload').addEventListener('click', (e) => toggleDropdown(e, 'dd-upload', 'dd-new'));
  $('#file-input').addEventListener('change', (e) => uploadFiles(e.target.files));
  $('#btn-new').addEventListener('click', (e) => toggleDropdown(e, 'dd-new', 'dd-upload'));
  $('#remote-cancel').addEventListener('click', closeRemoteModal);
  $('#remote-ok').addEventListener('click', submitRemote);
  $('#remote-urls').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) submitRemote(); });
  // “新建”下拉：新建文件 / 新建文件夹
  document.querySelectorAll('#new-menu .ctx-item').forEach((it) => {
    it.addEventListener('click', () => {
      closeDropdown('dd-new');
      if (it.dataset.act === 'mkfile') openMkfileModal(state.path);
      else if (it.dataset.act === 'mkdir') promptModal('新建文件夹', '', (name) => doMkdir(name));
    });
  });
  // “上传”下拉：本地上传 / 远程上传
  document.querySelectorAll('#upload-menu .ctx-item').forEach((it) => {
    it.addEventListener('click', () => {
      closeDropdown('dd-upload');
      if (it.dataset.act === 'local') $('#file-input').click();
      else if (it.dataset.act === 'remote') openRemoteModal();
    });
  });
  // 视图空白处右键菜单：新建 / 上传 / 刷新
  document.querySelectorAll('#ctx-empty .ctx-item').forEach((it) => {
    it.addEventListener('click', () => {
      closeEmptyMenu();
      if (it.dataset.act === 'mkfile') openMkfileModal(state.path);
      else if (it.dataset.act === 'mkdir') promptModal('新建文件夹', '', (name) => doMkdir(name));
      else if (it.dataset.act === 'local') $('#file-input').click();
      else if (it.dataset.act === 'remote') openRemoteModal();
      else if (it.dataset.act === 'refresh') refreshAll();
    });
  });
  $('#mkfile-cancel').addEventListener('click', closeMkfileModal);
  $('#mkfile-ok').addEventListener('click', submitMkfile);
  $('#edit-cancel').addEventListener('click', closeEditModal);
  $('#edit-ok').addEventListener('click', saveEdit);
  const editTa = $('#edit-content');
  editTa.addEventListener('input', () => { updateEditMeta(); renderGutter(); });
  editTa.addEventListener('scroll', () => { const g = $('#edit-gutter'); if (g) g.scrollTop = editTa.scrollTop; });
  editTa.addEventListener('keydown', (e) => {
    if (e.key === 'Tab') {
      e.preventDefault();
      const s = editTa.selectionStart, en = editTa.selectionEnd, TAB = '  ';
      if (e.shiftKey) {
        const v = editTa.value, ls = v.lastIndexOf('\n', s - 1) + 1;
        if (v.substr(ls, 2) === TAB) {
          editTa.value = v.slice(0, ls) + v.slice(ls + 2);
          editTa.selectionStart = Math.max(ls, s - 2);
          editTa.selectionEnd = Math.max(ls, en - 2);
        }
      } else {
        editTa.value = editTa.value.slice(0, s) + TAB + editTa.value.slice(en);
        editTa.selectionStart = s + TAB.length;
        editTa.selectionEnd = en + TAB.length;
      }
      updateEditMeta(); renderGutter();
    } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault(); saveEdit();
    }
  });
  $('#btn-refresh').addEventListener('click', () => refreshAll());
  $('#btn-select').addEventListener('click', toggleSelectMode);

  $('#btn-batch-download').addEventListener('click', batchDownload);
  $('#btn-batch-move').addEventListener('click', () => openMoveModal([...state.selection], false));
  $('#btn-batch-delete').addEventListener('click', batchDelete);
  $('#btn-batch-cancel').addEventListener('click', exitSelectMode);

  // move / copy modal
  $('#move-cancel').addEventListener('click', closeMoveModal);
  $('#move-ok').addEventListener('click', submitMoveModal);

  // context menu actions
  document.querySelectorAll('#contextmenu .ctx-item').forEach((it) => {
    it.addEventListener('click', () => ctxAction(it.dataset.act));
  });
  document.addEventListener('click', () => { closeContextMenu(); closeEmptyMenu(); });
  document.addEventListener('contextmenu', (e) => {
    // 文件卡片 / 侧边栏目录行各自接管右键，这里不再处理
    if (e.target.closest('.card') || e.target.closest('#sidebar')) return;
    // 主视图空白区域 → 打开“新建 / 上传 / 刷新”菜单
    if (e.target.closest('#files-container')) {
      e.preventDefault();
      openEmptyMenu(e.clientX, e.clientY);
      return;
    }
    closeContextMenu();
    closeEmptyMenu();
  });

  // 统一在 document 层兜底处理“空白处”的拖放：
  //  · 外部文件拖入 → 上传到目标目录
  //  · 内部文件拖动 → 移动到目标目录
  // 目录行(.tree-row.dir)/视图文件夹卡片(.card.folder) 自身处理器已 stopPropagation 接管“拖到行/卡片上”，
  // 此处只处理“拖到目录行之间空白 / 文件叶子 / 侧边栏留白 / 主视图留白”。
  const fc = $('#files-container');
  // highlight a single sidebar directory as the (move/upload) target, clearing others first
  const setTargetHi = (row, move) => {
    clearTargets();
    row.classList.add('drop-target');
    if (move) row.classList.add('move-target');
    row.dataset.uploadLabel = row.dataset.name || row.dataset.path;
  };
  ['dragenter', 'dragover'].forEach((ev) => document.addEventListener(ev, (e) => {
    // 既不是内部移动也不是外部文件拖入：忽略（如纯文本拖拽）
    if (!dragItems.length && !hasExternalFiles(e)) return;
    const inSidebar = e.target.closest('#sidebar');
    const inView = e.target.closest('#files-container');
    if (!inSidebar && !inView) { clearTargets(); return; } // 落在无关区域（顶栏等）不接管
    e.preventDefault();
    if (dragItems.length) {
      // 内部移动：在“非目录行/卡片”的空白区域高亮目标目录
      if (inSidebar) {
        const row = dirRowForTarget(e.target);
        if (row) setTargetHi(row, true);
      } else { clearTargets(); fc.classList.add('drag-over', 'drag-move'); } // 主视图空白 → 移动到当前目录
    } else {
      // 外部文件上传
      fc.classList.add('drag-over');
      if (inSidebar) {
        const row = dirRowForTarget(e.target);
        if (row) setTargetHi(row, false);
      } else clearTargets();
    }
  }));
  document.addEventListener('dragleave', (e) => {
    if (e.relatedTarget === null) { fc.classList.remove('drag-over', 'drag-move'); clearTargets(); } // 真正离开整个页面才隐藏提示
  });
  document.addEventListener('drop', (e) => {
    const inSidebar = !!e.target.closest('#sidebar');
    const inView = !!e.target.closest('#files-container');
    if (!inSidebar && !inView) return; // 落在无关区域（顶栏等）忽略
    if (dragItems.length) {
      // 内部移动：空白处 → 目标目录（子目录展开区域下方→该子目录；主视图空白→当前目录）
      e.preventDefault();
      const target = inSidebar ? (dirRowForTarget(e.target)?.dataset.path ?? '') : state.path;
      dropMove(dragItems, target);
      dragItems = [];
      endUploadDrag();
    } else {
      if (!hasExternalFiles(e) || !e.dataTransfer?.files?.length) return;
      e.preventDefault();
      // 侧边栏内：上传到鼠标位置隶属的目录（拖到某子目录展开区域下方 → 该子目录；
      // 拖到主目录 Home 下方/侧边栏留白 → 根目录）。主视图空白 → 当前目录。
      const target = inSidebar ? (dirRowForTarget(e.target)?.dataset.path ?? '') : state.path;
      uploadFiles(e.dataTransfer.files, target);
      endUploadDrag();
    }
  });
  // 任意拖拽结束（含移出页面/取消）统一清理高亮与提示，避免“粘住”
  document.addEventListener('dragend', () => { dragItems = []; endUploadDrag(); });

  // modal buttons
  $('#modal-cancel').addEventListener('click', closeModal);
  $('#modal-ok').addEventListener('click', submitModal);
  $('#modal-input').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitModal(); });

  // storage modal
  $('#storage-close').addEventListener('click', closeStorageModal);
  $('#details-close').addEventListener('click', closeDetailsModal);
  $('#modal-details').addEventListener('click', (e) => { if (e.target.id === 'modal-details') closeDetailsModal(); });
}

// ---- selection ----
function toggleSelectMode() {
  state.selectMode = !state.selectMode;
  if (!state.selectMode) state.selection.clear();
  document.body.classList.toggle('select-mode', state.selectMode);
  $('#tools').classList.toggle('hidden', state.selectMode);
  $('#batchbar').classList.toggle('hidden', !state.selectMode);
  renderFiles(state.current);
}
function exitSelectMode() {
  state.selectMode = false;
  state.selection.clear();
  document.body.classList.remove('select-mode');
  $('#tools').classList.remove('hidden');
  $('#batchbar').classList.add('hidden');
  renderFiles(state.current);
}
function toggleSelect(path, card) {
  if (state.selection.has(path)) state.selection.delete(path);
  else state.selection.add(path);
  card.classList.toggle('selected', state.selection.has(path));
  updateSelCount();
}
function syncSelectionUI() {
  document.querySelectorAll('.card').forEach((card) => {
    const name = card.querySelector('.card-name')?.textContent;
    const f = Object.values(state.current?.files || {}).find((x) => x.basename === name);
    if (f) card.classList.toggle('selected', state.selection.has(f.path));
  });
  updateSelCount();
}
function updateSelCount() {
  $('#sel-count').textContent = `已选 ${state.selection.size} 项`;
}

// ---- context menu ----
// ---- toolbar dropdowns (新建 / 上传) ----
function toggleDropdown(e, openId, otherId) {
  e.stopPropagation();
  closeContextMenu();
  closeEmptyMenu();
  if (otherId) closeDropdown(otherId);
  const dd = $('#' + openId);
  dd.classList.toggle('open');
}
function closeDropdown(id) { const dd = $('#' + id); if (dd) dd.classList.remove('open'); }

// ---- empty-area right-click menu (新建 / 上传 / 刷新) ----
function closeAllDropdowns() {
  ['dd-new', 'dd-upload', 'change-layout', 'change-sort'].forEach(closeDropdown);
}

function openEmptyMenu(x, y) {
  closeAllDropdowns();
  closeContextMenu();
  const menu = $('#ctx-empty');
  // 仅管理员可见的“新建 / 上传”项
  menu.querySelectorAll('.mgmt-only').forEach((el) => el.classList.toggle('hidden', !state.allowManagement));
  menu.style.left = Math.min(x, innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, innerHeight - 220) + 'px';
  menu.classList.remove('hidden');
}
function closeEmptyMenu() { hide('ctx-empty'); }

function openContextMenu(x, y, f) {
  closeAllDropdowns();
  closeEmptyMenu();
  state.ctxTarget = f;
  const menu = $('#contextmenu');
  const isDir = !!f.is_dir;
  const isHome = isDir && f.path === '';
  // 按目标类型（目录 / 文件）显示对应菜单项
  menu.querySelectorAll('.ctx-item').forEach((el) => {
    const t = el.dataset.type || 'all';
    const showByType = t === 'all' || (t === 'dir' && isDir) || (t === 'file' && !isDir);
    el.classList.toggle('hidden', !showByType);
  });
  // "复制直连" only for files inside a public directory (inherited flag)
  const inPublic = !isDir && !!f.public;
  menu.querySelectorAll('.ctx-public').forEach((el) => el.classList.toggle('hidden', el.classList.contains('hidden') || !inPublic));
  // "设为公开 / 取消公开" only for non-root directories, and when management is allowed.
  // Icon reflects the action: open lock (🔓︎) = will publish, closed lock (🔒︎) = will lock back.
  const flagItem = menu.querySelector('.ctx-public-flag');
  if (flagItem) {
    const showFlag = isDir && f.path !== '' && state.allowManagement;
    flagItem.classList.toggle('hidden', !showFlag);
    const isPub = !!(f.publicSelf || f.public);
    flagItem.querySelector('[data-role="icon"]').innerHTML = isPub ? ICONS.lock : ICONS.unlock;
    flagItem.querySelector('[data-role="label"]').textContent = isPub ? '取消公开' : '设为公开';
  }
  // hide management-only actions when not authenticated
  menu.querySelectorAll('.mgmt-only').forEach((el) => el.classList.toggle('hidden', el.classList.contains('hidden') || !state.allowManagement));
  // "编辑" only for editable text/code files (back-end decides editable)
  const editItem = menu.querySelector('.ctx-edit');
  if (editItem) {
    const showEdit = state.allowManagement && !isDir && !!f.editable;
    editItem.classList.toggle('hidden', !showEdit);
  }
  menu.style.left = Math.min(x, innerWidth - 180) + 'px';
  menu.style.top = Math.min(y, innerHeight - 160) + 'px';
  menu.classList.remove('hidden');
  state.ctxHome = isHome;
  if (isHome) {
    // 根目录(Home)：移动/复制/重命名/删除对根没有意义，但允许在根内
    // 新建文件/文件夹，并提供“查看存储”。
    menu.querySelectorAll('.ctx-item').forEach((el) => {
      const a = el.dataset.act;
      el.classList.toggle('hidden', a !== 'storage' && a !== 'mkfile' && a !== 'mkdir');
    });
  }
}
function closeContextMenu() { hide('contextmenu'); }
function ctxAction(act) {
  const f = state.ctxTarget;
  closeContextMenu();
  if (!f) return;
  if (act === 'open') {
    if (f.is_dir) loadDir(f.path);
    else if (f.icon === 'image') {
      openLightboxFromList([f], 0);
    } else window.open(`/api/image?path=${encodeURIComponent(f.path)}&download=1`, '_blank');
  } else if (act === 'download') {
    window.open(`/api/image?path=${encodeURIComponent(f.path)}&download=1`, '_blank');
  } else if (act === 'copylink') {
    const link = location.origin + '/api/image?path=' + encodeURIComponent(f.path);
    copyToClipboard(link);
  } else if (act === 'setpublic') {
    togglePublicDir(f.path, !!(f.publicSelf || f.public));
  } else if (act === 'storage') {
    openStorageModal();
  } else if (act === 'details') {
    openDetailsModal(f);
  } else if (act === 'move') {
    openMoveModal([f.path], false);
  } else if (act === 'copy') {
    openMoveModal([f.path], true);
  } else if (act === 'rename') {
    promptModal('重命名', f.basename, (name) => doRename(f.path, name));
  } else if (act === 'mkfile' || act === 'mkdir') {
    // 右键文件夹 → 建在其内部（文件右键不显示新建，此处 f 必为目录）
    const dir = f.is_dir ? f.path : (f.path.includes('/') ? f.path.slice(0, f.path.lastIndexOf('/')) : '');
    if (act === 'mkfile') openMkfileModal(dir);
    else promptModal('新建文件夹', '', (name) => doMkdirIn(dir, name));
  } else if (act === 'edit') {
    openEditModal(f);
  } else if (act === 'delete') {
    confirmDialog(`确定删除 “${f.basename}”？此操作不可恢复。`, () => doDelete([f.path]));
  }
}

// Toggle the .public marker on an arbitrary directory (used by the sidebar
// right-click menu). Refreshes the tree + main view afterwards.
async function togglePublicDir(dirPath, currentlyPublic) {
  if (dirPath === '') { toast('不能对根目录设置公开', 'error'); return; }
  // 当前公开状态：优先用调用方传入的真实值；否则回退到目录树缓存
  const cur = (currentlyPublic !== undefined)
    ? currentlyPublic
    : !!(state.publicCache.get(dirPath) || false);
  const make = !cur;
  try {
    const j = await apiPost('/api/public', { path: dirPath, public: make });
    if (j.error) throw new Error(j.error);
    // force-refresh the toggled dir's cached public flag + file leaves
    state.fileCache.delete(dirPath);
    state.publicCache.delete(dirPath);
    toast(make ? '已设为公开' : '已取消公开');
    await refreshAll();
  } catch (e) {
    toast('操作失败: ' + e.message, 'error');
  }
}

// ---- modal ----
let modalCb = null;
function promptModal(title, value, cb) {
  $('#modal-title').textContent = title;
  $('#modal-input').value = value;
  modalCb = cb;
  show('modal');
  $('#modal-input').focus();
  $('#modal-input').select();
}
function submitModal() {
  const v = $('#modal-input').value.trim();
  const cb = modalCb; closeModal();
  if (v && cb) cb(v);
}
function closeModal() { hide('modal'); modalCb = null; }

// ---- storage usage (Home right-click) ----
async function openStorageModal() {
  show('modal-storage');
  $('#storage-used').textContent = '加载中…';
  $('#storage-free').textContent = '';
  $('#storage-total').textContent = '';
  $('#storage-fill').style.width = '0%';
  $('#storage-pct').textContent = '';
  try {
    const j = await api('/api/storage');
    if (j.error) throw new Error(j.error);
    $('#storage-used').textContent = fmtSize(j.used);
    $('#storage-free').textContent = fmtSize(j.free);
    $('#storage-total').textContent = fmtSize(j.total);
    const pct = j.total > 0 ? Math.min(100, (j.used / j.total) * 100) : 0;
    $('#storage-fill').style.width = pct + '%';
    $('#storage-pct').textContent = `已用 ${pct.toFixed(1)}%`;
  } catch (e) {
    $('#storage-used').textContent = '获取失败';
    $('#storage-pct').textContent = e.message;
  }
}
function closeStorageModal() { hide('modal-storage'); }

// ---- item details modal ----
function openDetailsModal(f) {
  const icon = $('#details-icon');
  if (f.is_dir) {
    icon.innerHTML = ICONS.folder;
  } else if (f.icon === 'image') {
    icon.innerHTML = `<img src="${f.url_path}" alt="">`;
  } else {
    icon.innerHTML = ICONS[f.icon] || ICONS.file;
  }
  $('#details-name').textContent = f.basename;
  $('#details-sub').textContent = f.is_dir
    ? '文件夹'
    : ('文件' + (f.ext ? ' · .' + f.ext : ''));

  const rows = [];
  rows.push(['路径', f.path || '/']);
  if (f.is_dir) {
    rows.push(['项目数', f.files_count != null ? `${f.files_count} 个` : '—']);
  } else {
    rows.push(['大小', fmtSize(f.filesize) || '0 B']);
    if (f.image) rows.push(['尺寸', `${f.image.width} × ${f.image.height}`]);
    if (f.mime) rows.push(['类型', f.mime]);
  }
  rows.push(['修改时间', fmtDateTime(f.mtime)]);
  rows.push(['权限', (f.fileperms || '—'), true]);
  rows.push(['可读', f.is_readable ? '是' : '否']);
  rows.push(['可写', f.is_writeable ? '是' : '否']);
  if (f.is_link) rows.push(['符号链接', '是']);

  const list = $('#details-list');
  list.innerHTML = '';
  for (const [k, v, mono] of rows) {
    const row = document.createElement('div');
    row.className = 'details-row';
    const kEl = document.createElement('div');
    kEl.className = 'k';
    kEl.textContent = k;
    const vEl = document.createElement('div');
    vEl.className = mono ? 'v mono' : 'v';
    vEl.textContent = v;
    row.append(kEl, vEl);
    list.appendChild(row);
  }
  show('modal-details');
}
function closeDetailsModal() { hide('modal-details'); }

// ---- move / copy modal ----
let moveCtx = { items: [], copy: false };
function openMoveModal(items, copy) {
  if (!items.length) return;
  moveCtx = { items, copy };
  const sel = $('#move-dest');
  sel.innerHTML = '';
  const rootOpt = document.createElement('option');
  rootOpt.value = ''; rootOpt.textContent = '根目录 /';
  sel.appendChild(rootOpt);
  state.dirs.forEach((d) => {
    const o = document.createElement('option');
    o.value = d.path; o.textContent = (d.path || '根目录') + '/';
    sel.appendChild(o);
  });
  $('#modal-move-title').textContent = copy ? '复制到…' : '移动到…';
  $('#move-ok').textContent = copy ? '复制' : '移动';
  show('modal-move');
}
function closeMoveModal() { hide('modal-move'); moveCtx = { items: [], copy: false }; }
async function submitMoveModal() {
  const dest = $('#move-dest').value;
  const { items, copy } = moveCtx;
  closeMoveModal();
  const ok = await mgmtOp(() => apiPost('/api/move', { items, dest, copy }),
    (j) => (copy ? `已复制 ${j.moved} 项` : `已移动 ${j.moved} 项`), copy ? '复制' : '移动');
  if (ok) exitSelectMode();
}

// ---- public / private toggle for the current directory ----
// ---- confirm ----
function confirmDialog(msg, cb) {
  if (window.confirm(msg)) cb();
}

// ---- API calls ----
// Move one or more items (paths) into a destination directory via drag & drop.
async function dropMove(items, destPath) {
  if (!items || !items.length) return;
  // prevent dropping a directory into itself or its own descendant
  for (const it of items) {
    if (it === destPath || destPath.startsWith(it + '/')) {
      toast('无法移动到自身或子目录内', 'error');
      return;
    }
  }
  await mgmtOp(() => apiPost('/api/move', { items, dest: destPath, copy: false }),
    (j) => `已移动 ${j.moved} 项到 ${destPath || '根目录'}`, '移动');
}
function showUploadProgress(pct) {
  const bar = $('#upload-bar');
  bar.classList.toggle('hidden', pct >= 100);
  $('#upload-fill').style.width = pct + '%';
  $('#upload-text').textContent = pct >= 100 ? '处理中…' : `上传中 ${pct}%`;
}
// 清除上传/移动拖放期间的全部高亮与提示（整 view 遮罩 + 各目录虚线高亮）
function endUploadDrag() {
  clearTargets();
}

async function uploadFiles(fileList, targetPath = state.path) {
  if (!fileList || !fileList.length) return;
  const fd = new FormData();
  for (const f of fileList) fd.append('files', f);
  showUploadProgress(0);
  try {
    await new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open('POST', `/api/upload?path=${encodeURIComponent(targetPath)}`);
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable) showUploadProgress(Math.round((e.loaded / e.total) * 100));
      };
      xhr.onload = () => {
        if (xhr.status >= 200 && xhr.status < 300) {
          try { resolve(JSON.parse(xhr.responseText)); }
          catch { resolve({}); }
        } else {
          let msg = '上传失败';
          try { msg = (JSON.parse(xhr.responseText).error) || msg; } catch {}
          reject(new Error(msg));
        }
      };
      xhr.onerror = () => reject(new Error('网络错误'));
      xhr.send(fd);
    });
    showUploadProgress(100);
    $('#file-input').value = '';
    await refreshAll();
    setTimeout(() => $('#upload-bar').classList.add('hidden'), 600);
  } catch (e) {
    $('#upload-bar').classList.add('hidden');
    toast('上传失败: ' + e.message, 'error');
  }
}
// ---------------------------------------------------------------------------
// Remote upload: fetch files from remote http(s) URLs into the current dir.
// ---------------------------------------------------------------------------
function openRemoteModal() {
  const ta = $('#remote-urls');
  ta.value = '';
  $('#remote-result').classList.add('hidden');
  $('#remote-target').textContent = '目标目录：' + (state.path || 'Home');
  show('modal-remote');
  ta.focus();
}
function closeRemoteModal() { hide('modal-remote'); }

// Fetch each URL one at a time so progress (and partial failures) are honest.
async function submitRemote() {
  const urls = $('#remote-urls').value.split('\n').map((s) => s.trim()).filter(Boolean);
  if (!urls.length) { toast('请输入至少一个 URL', 'error'); return; }
  showUploadProgress(4);
  const rb = $('#remote-result');
  rb.classList.remove('hidden');
  let saved = 0;
  const failed = [];
  for (let i = 0; i < urls.length; i++) {
    rb.textContent = `拉取中 ${i + 1}/${urls.length}…`;
    try {
      const j = await apiPost('/api/remote-fetch', { path: state.path, urls: [urls[i]] });
      if (j && j.error) failed.push({ url: urls[i], error: j.error });
      else {
        saved += (j.saved || []).length;
        for (const f of (j.failed || [])) failed.push(f);
      }
    } catch (e) { failed.push({ url: urls[i], error: e.message }); }
    showUploadProgress(Math.round(((i + 1) / urls.length) * 100));
  }
  const okMsg = `已拉取 ${saved} 个文件`;
  const failMsg = failed.length ? `，${failed.length} 个失败` : '';
  await refreshAll();
  const okEl = document.createElement('div');
  okEl.className = 'remote-ok';
  okEl.textContent = '✓ ' + okMsg + failMsg;
  rb.replaceChildren(okEl);
  if (failed.length) {
    const fe = document.createElement('div');
    fe.className = 'remote-fail';
    for (const f of failed) {
      const line = document.createElement('div');
      line.textContent = `✗ ${f.url}: ${f.error}`;
      fe.appendChild(line);
    }
    rb.appendChild(fe);
  }
  showUploadProgress(100);
  setTimeout(() => $('#upload-bar').classList.add('hidden'), 600);
  toast(okMsg + failMsg);
}

// Run a management API call: await op(), surface errors as toast, then refresh.
// okMsg may be a string or a function of the JSON response. Returns true on success.
async function mgmtOp(op, okMsg, failMsg) {
  try {
    const j = await op();
    if (j && j.error) throw new Error(j.error);
    if (okMsg) toast(typeof okMsg === 'function' ? okMsg(j) : okMsg);
    await refreshAll();
    return true;
  } catch (e) {
    toast((failMsg || '操作') + '失败: ' + e.message, 'error');
    return false;
  }
}

async function doMkdir(name) {
  await doMkdirIn(state.path, name);
}
async function doMkdirIn(dir, name) {
  await mgmtOp(() => apiPost('/api/mkdir', { path: dir, name }), '已创建文件夹', '创建');
}
async function doRename(oldPath, name) {
  await mgmtOp(() => apiPost('/api/rename', { path: oldPath, name }), '已重命名', '重命名');
}
async function doDelete(paths) {
  await mgmtOp(() => apiPost('/api/delete', { paths }), (j) => `已删除 ${j.removed} 项`, '删除');
}

// ---- new file ----
let mkfileTargetPath = '';
function openMkfileModal(targetPath) {
  mkfileTargetPath = targetPath || state.path;
  $('#mkfile-name').value = '';
  $('#mkfile-content').value = '';
  show('modal-mkfile');
  $('#mkfile-name').focus();
}
function closeMkfileModal() { hide('modal-mkfile'); mkfileTargetPath = ''; }
async function submitMkfile() {
  const name = $('#mkfile-name').value.trim();
  const content = $('#mkfile-content').value;
  const target = mkfileTargetPath; // 先取出目标目录，再关闭弹窗（关闭会清空它）
  closeMkfileModal();
  if (!name) return;
  await doMkfile(target, name, content);
}
async function doMkfile(parentPath, name, content) {
  await mgmtOp(() => apiPost('/api/mkfile', { path: parentPath, name, content }), '已创建文件', '创建');
}

// ---- edit text file ----
let editPath = '';
async function openEditModal(f) {
  editPath = f.path;
  const j = await api('/api/file?path=' + encodeURIComponent(f.path));
  if (j.error) { toast('无法编辑: ' + j.error, 'error'); return; }
  $('#edit-title').textContent = '编辑：' + f.basename;
  $('#edit-path').textContent = f.path || 'Home';
  const ta = $('#edit-content');
  ta.value = j.content;
  updateEditMeta();
  show('modal-edit');
  ta.focus();
  const len = ta.value.length; ta.setSelectionRange(len, len);
  renderGutter();
}
function updateEditMeta() {
  const t = $('#edit-content').value;
  const bytes = new TextEncoder().encode(t).length;
  const lines = t.length ? t.split('\n').length : 0;
  const chars = [...t].length;
  $('#edit-meta').textContent = `${bytes} 字节 · ${lines} 行 · ${chars} 字符`;
}
function renderGutter() {
  const ta = $('#edit-content'), g = $('#edit-gutter');
  if (!ta || !g) return;
  const n = ta.value.length ? ta.value.split('\n').length : 1;
  let s = '';
  for (let i = 1; i <= n; i++) s += i + '\n';
  g.textContent = s;
  g.scrollTop = ta.scrollTop;
}
async function saveEdit() {
  const content = $('#edit-content').value;
  const p = editPath;
  const btn = $('#edit-ok');
  if (!p || btn.disabled) return;
  btn.disabled = true; const label = btn.textContent; btn.textContent = '保存中…';
  const ok = await mgmtOp(() => apiPost('/api/write', { path: p, content }), '已保存', '保存');
  btn.disabled = false; btn.textContent = label;
  if (ok) closeEditModal();
}
function closeEditModal() { hide('modal-edit'); editPath = ''; }
async function batchDelete() {
  if (!state.selection.size) return;
  confirmDialog(`确定删除选中的 ${state.selection.size} 项？此操作不可恢复。`, () => {
    doDelete([...state.selection]);
  });
}
async function batchDownload() {
  if (!state.selection.size) return;
  const fd = new FormData();
  fd.append('paths', JSON.stringify([...state.selection]));
  const r = await fetch('/api/zip', { method: 'POST', body: fd });
  if (r.ok) {
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'selection.zip';
    a.click();
    URL.revokeObjectURL(a.href);
  } else {
    toast('打包失败', 'error');
  }
}

let toastTimer;
function toast(msg, type = 'ok') {
  let el = $('#toast');
  if (!el) { el = document.createElement('div'); el.id = 'toast'; document.body.appendChild(el); }
  el.textContent = msg;
  el.classList.toggle('toast-error', type === 'error');
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Copy text to the clipboard, with a textarea fallback for non-secure contexts.
async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
    } else {
      const ta = document.createElement('textarea');
      ta.value = text;
      ta.style.position = 'fixed';
      ta.style.opacity = '0';
      document.body.appendChild(ta);
      ta.select();
      document.execCommand('copy');
      ta.remove();
    }
    toast('直连链接已复制');
  } catch {
    toast('复制失败，请手动复制', 'error');
  }
}

init();
