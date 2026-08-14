// src/worker.js — Filo 的 Cloudflare Workers 入口。
//
// 路由规则：
//   - 路径以 /api/ 开头 → 由下方各处理函数处理
//   - 其余请求 → 交给 Workers Static Assets 返回前端静态资源（public/）
//
// 后端存储：Cloudflare R2（见 store.js 的虚拟文件系统抽象）。
// 缩略图：Cloudflare Image Resizing（边缘按需缩放），未开启时自动降级为原图。

import {
  IMAGE_EXTS, MAX_EDIT_BYTES,
  safeRel, extOf, mimeFromExt,
  listDir, listDirPage, buildDir, collectDirs, isPublic, setPublic, dirExists,
  ensureDir, putObject, getObject, headObject, deleteItems, moveItems, renameItem,
  search, storageStats, uniqueName, looksText, dirIsPublicSelf,
} from './store.js';
import { imageCfOptions } from './img.js';
import * as auth from './auth.js';
import { downloadZip } from 'client-zip';

// 单个 Worker isolate 内的短 TTL 目录缓存。缓存只保存目录 JSON，不保存鉴权信息。
// isolate 可能随时重启，因此它是性能加速而不是数据持久化层。
const DIR_CACHE_TTL = 20_000;
const PUBLIC_CACHE_TTL = 60_000;
const dirCache = new Map();
const publicCache = new Map();
const imageTokens = new Set();

function issueImageToken() {
  const token = crypto.randomUUID();
  imageTokens.add(token);
  return token;
}

function consumeImageToken(token) {
  if (!token || !imageTokens.has(token)) return false;
  imageTokens.delete(token);
  return true;
}

function cachedDir(key) {
  const entry = dirCache.get(key);
  if (!entry) return null;
  if (entry.expiresAt <= Date.now()) {
    dirCache.delete(key);
    return null;
  }
  return entry.data;
}

function saveDirCache(key, data) {
  dirCache.set(key, { data, expiresAt: Date.now() + DIR_CACHE_TTL });
  // 防止长时间运行的 isolate 中缓存无限增长。
  if (dirCache.size > 100) {
    const oldest = dirCache.keys().next().value;
    if (oldest) dirCache.delete(oldest);
  }
}

// 任意写操作后清空目录缓存，避免上传/删除后短时间显示旧列表。
function invalidateDirCache() {
  dirCache.clear();
  publicCache.clear();
}

async function cachedPublic(bucket, rel) {
  const entry = publicCache.get(rel);
  if (entry && entry.expiresAt > Date.now()) return entry.value;
  const value = await isPublic(bucket, rel);
  publicCache.set(rel, { value, expiresAt: Date.now() + PUBLIC_CACHE_TTL });
  return value;
}

// ---------------------------------------------------------------------------
// 工具
// ---------------------------------------------------------------------------
function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...headers },
  });
}
function num(v, def) {
  const n = parseInt(v, 10);
  return Number.isFinite(n) ? n : def;
}
function settings(env) {
  return {
    AUTH_ENABLED: auth.authEnabled(env),
    ALLOW_MANAGEMENT: env.ALLOW_MANAGEMENT ? env.ALLOW_MANAGEMENT !== 'false' : true,
    IMAGE_RESIZE: env.IMAGE_RESIZE ? env.IMAGE_RESIZE !== 'false' : false,
    THUMB_SIZE: num(env.THUMB_SIZE, 320),
    THUMB_RETINA: num(env.THUMB_RETINA, 480),
    MENU_MAX_DEPTH: num(env.MENU_MAX_DEPTH, 5),
    ROOT_NAME: env.ROOT_NAME || 'Filo',
    QUOTA_BYTES: env.QUOTA_BYTES || '',
    MAX_UPLOAD: num(env.MAX_UPLOAD_MB, 100) * 1024 * 1024,
  };
}
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\/\\]/g, '_')
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim()
    .slice(0, 180) || 'untitled';
}
function buildFileForPage(rel, obj) {
  const basename = rel.split('/').pop();
  const ext = extOf(basename);
  let icon = 'file';
  let mime = mimeFromExt(rel);
  if (IMAGE_EXTS.has(ext) && ext !== 'svg') icon = 'image';
  else if (['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'm3u8'].includes(ext)) icon = 'video';
  else if (['mp3', 'm4a', 'aac', 'ogg', 'oga', 'wav', 'flac'].includes(ext)) icon = 'audio';
  else if (['pdf', 'txt', 'md', 'json', 'csv', 'log', 'xml', 'html', 'htm'].includes(ext)) icon = 'doc';
  const editable = obj.size <= MAX_EDIT_BYTES && [
    'txt', 'md', 'json', 'csv', 'log', 'xml', 'html', 'htm', 'css', 'js', 'mjs', 'ts', 'tsx', 'jsx',
    'vue', 'svelte', 'yaml', 'yml', 'toml', 'ini', 'conf', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'java',
    'kt', 'swift', 'sql',
  ].includes(ext);
  return {
    basename, ext, fileperms: '0644', filetype: 'file', filesize: obj.size,
    is_readable: true, is_writeable: true, is_link: false, is_dir: false,
    mtime: obj.uploaded ? Math.floor(obj.uploaded.getTime() / 1000) : 0,
    path: rel, url_path: '/api/image?path=' + encodeURIComponent(rel), mime, icon, editable,
  };
}

function lightweightDirEntry(rel, cfg) {
  const basename = rel ? rel.split('/').pop() : (cfg.ROOT_NAME || 'Filo');
  return {
    basename, fileperms: '0755', filetype: 'dir', is_readable: true,
    is_writeable: true, is_link: false, is_dir: true, mime: 'directory',
    mtime: 0, path: rel, files_count: 0, dirsize: 0, images_count: 0,
    url_path: '/api/dir?path=' + encodeURIComponent(rel),
    public_self: false, public: false,
  };
}

function filenameFromUrl(url, contentDisposition) {
  if (contentDisposition) {
    const m = /filename\*?=(?:UTF-8'')?["']?([^"';,\r\n]+)/i.exec(contentDisposition);
    if (m) {
      try { return decodeURIComponent(m[1].trim()); } catch { return m[1].trim(); }
    }
  }
  try {
    const last = new URL(url).pathname.split('/').filter(Boolean).pop();
    if (last) return last;
  } catch { /* ignore */ }
  return 'remote-file';
}

// 鉴权门控
async function needAuth(request, env, cfg) {
  if (!cfg.AUTH_ENABLED) return true;
  return auth.isAuthed(request, env);
}
async function needMgmt(request, env, cfg) {
  if (!cfg.ALLOW_MANAGEMENT) return false;
  if (cfg.AUTH_ENABLED && !(await auth.isAuthed(request, env))) return false;
  return true;
}
// 读门控：公开目录（含 .public 链）免登录
async function gateRead(request, env, cfg, rel) {
  if (!cfg.AUTH_ENABLED) return true;
  if (await auth.isAuthed(request, env)) return true;
  return isPublic(env.FILO_STORAGE, rel);
}

// ---------------------------------------------------------------------------
// 各 API 处理
// ---------------------------------------------------------------------------
async function apiConfig(request, env, cfg) {
  const authed = await auth.isAuthed(request, env);
  return json({
    script: 'worker',
    root_basename: cfg.ROOT_NAME,
    root: '',
    menu_exists: true,
    layout: 'small',
    thumb_size: cfg.THUMB_SIZE,
    thumb_retina: cfg.THUMB_RETINA,
    menu_max_depth: cfg.MENU_MAX_DEPTH,
    auth_enabled: cfg.AUTH_ENABLED,
    logged_in: authed,
    allow_management: cfg.ALLOW_MANAGEMENT && (!cfg.AUTH_ENABLED || authed),
    version: '1.2.0-r2',
  });
}

async function apiLogin(request, env, cfg) {
  if (!cfg.AUTH_ENABLED) return json({ error: '未启用密码鉴权' }, 400);
  const body = await request.json().catch(() => ({}));
  const pw = String(body.password || '');
  if (!auth.verifyPassword(env, pw)) return json({ error: '密码错误' }, 401);
  const token = await auth.tokenFor(env);
  const headers = new Headers();
  auth.setAuthCookie(headers, token);
  return new Response(JSON.stringify({ ok: true, logged_in: true }), { status: 200, headers });
}

// 原图直出（缩略图降级、直接下载共用）
async function serveImage(request, env, rel, download, cfg, isPublicResource = false) {
  const obj = await getObject(env.FILO_STORAGE, rel);
  if (!obj) return json({ error: 'Not found' }, 404);
  const headers = new Headers();
  const ct = obj.contentType && obj.contentType !== 'application/octet-stream'
    ? obj.contentType : mimeFromExt(rel);
  headers.set('Content-Type', ct);
  headers.set('Cache-Control', isPublicResource
    ? 'public, max-age=604800, s-maxage=2592000, immutable'
    : 'private, no-store');
  if (download) {
    const name = rel.split('/').pop();
    headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(name)}"`);
  }
  return new Response(obj.body, { headers });
}

// ---------------------------------------------------------------------------
// 主入口
// ---------------------------------------------------------------------------
export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    // 非 API 请求 → 静态资源
    if (!url.pathname.startsWith('/api/')) {
      return env.ASSETS.fetch(request);
    }

    const cfg = settings(env);
    const method = request.method;
    const p = url.pathname;

    // 所有写请求都使目录缓存失效；登录/登出清理缓存成本很低。
    if (method !== 'GET' && method !== 'HEAD') invalidateDirCache();

    try {
      // ---- config / auth ----
      if (p === '/api/config' && method === 'GET') return apiConfig(request, env, cfg);
      if (p === '/api/login' && method === 'POST') return apiLogin(request, env, cfg);
      if (p === '/api/logout' && method === 'POST') {
        const headers = new Headers();
        auth.setAuthCookie(headers, '');
        return new Response(JSON.stringify({ ok: true, logged_in: false }), { status: 200, headers });
      }

      // ---- menu tree ----
      if (p === '/api/dirs' && method === 'GET') {
        if (!(await needAuth(request, env, cfg))) return json({ error: '需要登录' }, 401);
        const rel = safeRel(url.searchParams.get('path'));
        const cacheKey = 'dirs:' + (cfg.AUTH_ENABLED ? 'auth:' : 'public:') + rel;
        const cached = cachedDir(cacheKey);
        if (cached) return json(cached);
        const { dirs } = await listDir(env.FILO_STORAGE, rel);
        const out = await Promise.all(dirs.map(async (name) => {
          const childRel = rel ? rel + '/' + name : name;
          return buildDir(env.FILO_STORAGE, childRel, false, cfg);
        }));
        saveDirCache(cacheKey, out.filter(Boolean));
        return json(out.filter(Boolean));
      }

      if (p === '/api/dir-page' && method === 'GET') {
        if (!(await needAuth(request, env, cfg))) return json({ error: '需要登录' }, 401);
        const rel = safeRel(url.searchParams.get('path'));
        const limit = Math.min(Math.max(num(url.searchParams.get('limit'), 100), 20), 500);
        const cursor = url.searchParams.get('cursor') || undefined;
        const cacheKey = `page:${cfg.AUTH_ENABLED ? 'auth:' : 'public:'}${rel}:${limit}:${cursor || ''}`;
        const cached = cachedDir(cacheKey);
        if (cached) return json(cached);
        const page = await listDirPage(env.FILO_STORAGE, rel, limit, cursor);
        const children = await Promise.all(page.dirs.map(async (name) => {
          const childRel = rel ? rel + '/' + name : name;
          return buildDir(env.FILO_STORAGE, childRel, false, cfg);
        }));
        const fileObjs = await Promise.all(page.files.map((f) => buildFileForPage(
          rel ? rel + '/' + f.name : f.name, f.obj,
        )));
        const response = {
          path: rel,
          dirs: children.filter(Boolean),
          files: fileObjs.filter(Boolean),
          next_cursor: page.cursor,
          has_more: !!page.cursor,
          public: await cachedPublic(env.FILO_STORAGE, rel),
          public_self: await dirIsPublicSelf(env.FILO_STORAGE, rel),
        };
        saveDirCache(cacheKey, response);
        return json(response);
      }

      // ---- single dir ----
      if (p === '/api/dir' && method === 'GET') {
        if (!(await needAuth(request, env, cfg))) return json({ error: '需要登录' }, 401);
        const rel = safeRel(url.searchParams.get('path'));
        const cacheKey = 'dir:' + (cfg.AUTH_ENABLED ? 'auth:' : 'public:') + rel;
        const cached = cachedDir(cacheKey);
        if (cached) return json(cached);
        const dir = await buildDir(env.FILO_STORAGE, rel, true, cfg);
        if (!dir) return json({ error: 'Not found' }, 404);
        saveDirCache(cacheKey, dir);
        return json(dir);
      }

      // ---- thumbnail ----
      if (p === '/api/thumb' && method === 'GET') {
        const rel = safeRel(url.searchParams.get('path'));
        const size = num(url.searchParams.get('size'), cfg.THUMB_SIZE);
        if (!(await gateRead(request, env, cfg, rel))) return json({ error: '需要登录' }, 401);
        const publicResource = cfg.AUTH_ENABLED
          ? await cachedPublic(env.FILO_STORAGE, rel)
          : true;
        const obj = await headObject(env.FILO_STORAGE, rel);
        if (!obj) return json({ error: 'Not found' }, 404);
        const ext = extOf(rel);
        if (!IMAGE_EXTS.has(ext) || ext === 'svg') return json({ error: 'Not an image' }, 415);

        if (cfg.IMAGE_RESIZE) {
          try {
            const origUrl = `${url.origin}/api/image?path=${encodeURIComponent(rel)}`;
            const internalToken = issueImageToken();
            const internalReq = new Request(origUrl, {
              headers: { 'x-filo-internal': internalToken },
            });
            const r = await fetch(internalReq, imageCfOptions(size));
            const ct = r.headers.get('content-type') || '';
            if (r.ok && ct.startsWith('image/')) {
              return new Response(r.body, {
                status: r.status,
                headers: {
                  'Content-Type': ct,
                  'Cache-Control': publicResource
                    ? 'public, max-age=604800, s-maxage=2592000, immutable'
                    : 'private, no-store',
                },
              });
            }
          } catch { /* 缩放失败 → 降级原图 */ }
        }
        return serveImage(request, env, rel, false, cfg, publicResource);
      }

      // ---- original image / file ----
      if (p === '/api/image' && method === 'GET') {
        const rel = safeRel(url.searchParams.get('path'));
        if (!rel) return json({ error: 'Invalid path' }, 400);
        const internal = consumeImageToken(request.headers.get('x-filo-internal'));
        if (!internal && !(await gateRead(request, env, cfg, rel))) return json({ error: '需要登录' }, 401);
        const publicResource = internal || !cfg.AUTH_ENABLED
          ? true
          : await cachedPublic(env.FILO_STORAGE, rel);
        return serveImage(request, env, rel, url.searchParams.has('download'), cfg, publicResource);
      }

      // ---- storage ----
      if (p === '/api/storage' && method === 'GET') {
        if (!(await needAuth(request, env, cfg))) return json({ error: '需要登录' }, 401);
        return json(await storageStats(env.FILO_STORAGE, cfg.QUOTA_BYTES));
      }

      // ---- public toggle ----
      if (p === '/api/public' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const body = await request.json().catch(() => ({}));
        const rel = safeRel(body.path);
        if (!rel) return json({ error: '不能对根目录设置公开' }, 400);
        if (!(await dirExists(env.FILO_STORAGE, rel))) return json({ error: '目标不是目录' }, 400);
        const make = !!body.public;
        const res = await setPublic(env.FILO_STORAGE, rel, make);
        return json({ ok: true, public: res, public_self: res, path: rel });
      }

      // ---- search ----
      if (p === '/api/search' && method === 'GET') {
        if (!(await needAuth(request, env, cfg))) return json({ error: '需要登录' }, 401);
        const q = String(url.searchParams.get('q') || '').toLowerCase().trim();
        if (!q) return json([]);
        return json(await search(env.FILO_STORAGE, q));
      }

      // ---- upload ----
      if (p === '/api/upload' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const parent = safeRel(url.searchParams.get('path'));
        if (parent && !(await dirExists(env.FILO_STORAGE, parent))) return json({ error: 'Invalid target directory' }, 400);
        let form;
        try { form = await request.formData(); } catch { return json({ error: 'Invalid form data' }, 400); }
        const files = form.getAll('files');
        if (!files.length) return json({ error: 'No files received' }, 400);
        const saved = [];
        for (const f of files) {
          const base = sanitizeName(f.name || 'file');
          const finalName = await uniqueName(env.FILO_STORAGE, parent, base);
          const rel = parent ? parent + '/' + finalName : finalName;
          const buf = await f.arrayBuffer();
          if (buf.byteLength > cfg.MAX_UPLOAD) return json({ error: `文件 ${base} 超过大小限制` }, 413);
          await putObject(env.FILO_STORAGE, rel, buf, { contentType: f.type || mimeFromExt(rel) });
          saved.push(rel);
        }
        return json({ ok: true, saved });
      }

      // ---- remote fetch ----
      if (p === '/api/remote-fetch' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const parent = safeRel((await request.json().catch(() => ({}))).path);
        if (parent && !(await dirExists(env.FILO_STORAGE, parent))) return json({ error: 'Invalid target directory' }, 400);
        const body = await request.json().catch(() => ({}));
        const urls = Array.isArray(body.urls) ? body.urls.map(String) : [];
        const clean = urls.map((u) => u.trim()).filter(Boolean);
        if (!clean.length) return json({ error: 'No URLs provided' }, 400);
        const saved = [];
        const failed = [];
        for (const u of clean) {
          try {
            const urlObj = new URL(u);
            if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') throw new Error('仅支持 http/https 链接');
            const ctrl = new AbortController();
            const timer = setTimeout(() => ctrl.abort(), 60000);
            const resp = await fetch(urlObj, { signal: ctrl.signal, redirect: 'follow' });
            clearTimeout(timer);
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
            const buf = await resp.arrayBuffer();
            if (buf.byteLength > cfg.MAX_UPLOAD) throw new Error('文件超过大小限制');
            const base = filenameFromUrl(u, resp.headers.get('content-disposition') || '');
            const finalName = await uniqueName(env.FILO_STORAGE, parent, sanitizeName(base) || 'remote-file');
            const rel = parent ? parent + '/' + finalName : finalName;
            await putObject(env.FILO_STORAGE, rel, buf, { contentType: resp.headers.get('content-type') || mimeFromExt(rel) });
            saved.push(rel);
          } catch (e) {
            failed.push({ url: u, error: e.name === 'AbortError' ? '下载超时' : (e.message || '下载失败') });
          }
        }
        return json({ ok: true, saved, failed });
      }

      // ---- mkfile ----
      if (p === '/api/mkfile' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const body = await request.json().catch(() => ({}));
        const parent = safeRel(body.path);
        if (parent && !(await dirExists(env.FILO_STORAGE, parent))) return json({ error: 'Invalid target directory' }, 400);
        const name = sanitizeName(body.name);
        if (!name) return json({ error: '文件名不能为空' }, 400);
        const content = String(body.content || '');
        if (new TextEncoder().encode(content).length > MAX_EDIT_BYTES) return json({ error: '文件内容超过编辑大小上限' }, 413);
        const rel = parent ? parent + '/' + name : name;
        await ensureDir(env.FILO_STORAGE, parent);
        await putObject(env.FILO_STORAGE, rel, content, { contentType: mimeFromExt(rel) });
        return json({ ok: true, path: rel });
      }

      // ---- read file for editor ----
      if (p === '/api/file' && method === 'GET') {
        const rel = safeRel(url.searchParams.get('path'));
        if (!rel) return json({ error: 'Invalid path' }, 400);
        if (!(await gateRead(request, env, cfg, rel))) return json({ error: '需要登录' }, 401);
        const obj = await headObject(env.FILO_STORAGE, rel);
        if (!obj) return json({ error: 'Not found' }, 404);
        if (obj.size > MAX_EDIT_BYTES) return json({ error: '文件过大，无法在编辑器内打开（上限 5 MB）' }, 415);
        if (!(await looksText(env.FILO_STORAGE, rel))) return json({ error: '该文件不是文本文件，不支持编辑' }, 415);
        const body = await getObject(env.FILO_STORAGE, rel);
        if (!body) return json({ error: 'Not found' }, 404);
        const content = await body.text();
        return json({ ok: true, content, size: obj.size, name: rel.split('/').pop() });
      }

      // ---- write file ----
      if (p === '/api/write' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const body = await request.json().catch(() => ({}));
        const rel = safeRel(body.path);
        const obj = await headObject(env.FILO_STORAGE, rel);
        if (!obj) return json({ error: 'Not found' }, 404);
        if (obj.size > MAX_EDIT_BYTES) return json({ error: '文件过大，无法在编辑器内打开（上限 5 MB）' }, 415);
        if (!(await looksText(env.FILO_STORAGE, rel))) return json({ error: '该文件不是文本文件，不支持编辑' }, 415);
        const content = String(body.content || '');
        if (new TextEncoder().encode(content).length > MAX_EDIT_BYTES) return json({ error: '文件内容超过编辑大小上限' }, 413);
        await putObject(env.FILO_STORAGE, rel, content, { contentType: mimeFromExt(rel) });
        return json({ ok: true });
      }

      // ---- mkdir ----
      if (p === '/api/mkdir' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const body = await request.json().catch(() => ({}));
        const parent = safeRel(body.path);
        if (parent && !(await dirExists(env.FILO_STORAGE, parent))) return json({ error: 'Invalid parent' }, 400);
        const name = sanitizeName(body.name);
        if (!name) return json({ error: '文件名不能为空' }, 400);
        const rel = parent ? parent + '/' + name : name;
        if (await dirExists(env.FILO_STORAGE, rel)) return json({ error: 'Already exists' }, 409);
        await ensureDir(env.FILO_STORAGE, rel);
        return json({ ok: true, path: rel });
      }

      // ---- rename ----
      if (p === '/api/rename' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const body = await request.json().catch(() => ({}));
        const rel = safeRel(body.path);
        if (!rel) return json({ error: 'Invalid path' }, 400);
        if (!(await dirExists(env.FILO_STORAGE, rel)) && !(await headObject(env.FILO_STORAGE, rel))) return json({ error: 'Not found' }, 404);
        const name = sanitizeName(body.name);
        if (!name) return json({ error: '文件名不能为空' }, 400);
        const newRel = await renameItem(env.FILO_STORAGE, rel, name);
        return json({ ok: true, path: newRel });
      }

      // ---- delete ----
      if (p === '/api/delete' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const body = await request.json().catch(() => ({}));
        const paths = Array.isArray(body.paths) ? body.paths.map(safeRel) : [];
        if (!paths.length) return json({ error: 'No paths' }, 400);
        const removed = await deleteItems(env.FILO_STORAGE, paths);
        return json({ ok: true, removed });
      }

      // ---- move / copy ----
      if (p === '/api/move' && method === 'POST') {
        if (!(await needMgmt(request, env, cfg))) return json({ error: '需要登录后才能操作' }, 401);
        const body = await request.json().catch(() => ({}));
        const items = Array.isArray(body.items) ? body.items.map(safeRel) : [];
        const copy = !!body.copy;
        if (!items.length) return json({ error: 'No items' }, 400);
        const dest = safeRel(body.dest);
        if (dest && !(await dirExists(env.FILO_STORAGE, dest))) return json({ error: 'Invalid destination' }, 400);
        const moved = await moveItems(env.FILO_STORAGE, items, dest, copy);
        return json({ ok: true, moved });
      }

      // ---- zip (GET: 单路径 / POST: 多路径) ----
      if (p === '/api/zip') {
        if (!(await needAuth(request, env, cfg))) return json({ error: '需要登录' }, 401);
        let items = [];
        let baseName = 'files';
        if (method === 'GET') {
          const rel = safeRel(url.searchParams.get('path'));
          if (!rel) return json({ error: 'Invalid path' }, 400);
          items = await collectZipItems(env.FILO_STORAGE, rel);
          baseName = rel.split('/').pop() || 'files';
        } else if (method === 'POST') {
          const body = await request.json().catch(() => ({}));
          const paths = Array.isArray(body.paths) ? body.paths.map(safeRel) : [];
          if (!paths.length) return json({ error: 'No paths' }, 400);
          for (const pp of paths) items = items.concat(await collectZipItems(env.FILO_STORAGE, pp));
          baseName = 'selection';
        } else {
          return json({ error: 'Method not allowed' }, 405);
        }
        return zipResponse(env, items, baseName);
      }

      return json({ error: 'Not found' }, 404);
    } catch (e) {
      return json({ error: e && e.message ? e.message : 'server error' }, 500);
    }
  },
};

// ---------------------------------------------------------------------------
// ZIP 打包（client-zip，Workers 流式友好）
// ---------------------------------------------------------------------------
async function collectZipItems(bucket, rel) {
  const isDir = (await headObject(bucket, rel + '/')) || (await (async () => {
    const r = await bucket.list({ prefix: rel + '/', limit: 1 });
    return r.objects.length > 0;
  })());
  const items = [];
  if (isDir) {
    const prefix = rel + '/';
    const baseName = rel.split('/').pop() || 'folder';
    let cursor;
    do {
      const r = await bucket.list({ prefix, cursor });
      for (const o of r.objects) {
        if (o.key === prefix || o.key.endsWith('/')) continue;
        items.push({ key: o.key, name: baseName + '/' + o.key.slice(prefix.length) });
      }
      cursor = r.cursor;
    } while (cursor);
  } else {
    items.push({ key: rel, name: rel.split('/').pop() });
  }
  return items;
}

async function zipResponse(env, items, baseName) {
  const entries = [];
  for (const it of items) {
    const obj = await getObject(env.FILO_STORAGE, it.key);
    if (obj) entries.push({ name: it.name, lastModified: obj.uploaded, size: obj.size, input: obj.body });
  }
  // client-zip 的 downloadZip() 直接返回 Response（已带 application/zip）
  const archive = downloadZip(entries);
  const headers = new Headers(archive.headers);
  headers.set('Content-Disposition', `attachment; filename="${encodeURIComponent(baseName)}.zip"`);
  return new Response(archive.body, { headers });
}
