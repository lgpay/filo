/**
 * Filo — a lightweight file management system (Node.js + vanilla JS).
 *
 * Backend responsibilities (mirrors the original PHP index.php):
 *   - Walk a directory on disk and expose it through a small JSON API.
 *   - Generate image thumbnails on the fly (cached on disk).
 *   - Serve original images / files.
 *
 * The JSON shapes returned by /api/dir and /api/dirs intentionally mirror the
 * original PHP classes (Dir / File / Dirs) so the frontend can behave the same.
 */

import express from 'express';
import sharp from 'sharp';
import multer from 'multer';
import archiver from 'archiver';
import path from 'node:path';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { Readable } from 'node:stream';
import crypto from 'node:crypto';
import dns from 'node:dns';
import net from 'node:net';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------
const ROOT = path.resolve(process.env.GALLERY_ROOT || path.join(__dirname, 'sample-files'));
const PORT = parseInt(process.env.PORT || '8080', 10);
// 缩略图生成算法版本号：改动 fit/质量/裁切策略时 +1，旧缓存目录自动废弃，避免命中旧图
const THUMB_VERSION = 3;
const CACHE_DIR = path.join(__dirname, '.cache', 'thumbs', String(THUMB_VERSION));
const THUMB_DEFAULT = 320;
const THUMB_RETINA = 480;
const MENU_MAX_DEPTH = parseInt(process.env.MENU_MAX_DEPTH || '5', 10);
// File management (upload / mkdir / rename / delete / zip). Default ON for demo.
const ALLOW_MANAGEMENT = process.env.ALLOW_FILE_MANAGEMENT !== 'false';
// Password protection. When GALLERY_PASSWORD is set, visitors must log in to
// enter; management operations require the same authenticated session.
const GALLERY_PASSWORD = process.env.GALLERY_PASSWORD || '';
const AUTH_ENABLED = GALLERY_PASSWORD.length > 0;
const AUTH_SECRET = crypto.createHash('sha256').update('filo|' + GALLERY_PASSWORD).digest('hex');
const AUTH_COOKIE = 'pg_auth';
const AUTH_MAX_AGE = 60 * 60 * 24 * 30; // 30 days
// A directory is "public" when it (or any ancestor up to ROOT) contains this
// marker file. Public directories' files may be linked directly without login.
const PUBLIC_MARKER = '.public';
const MAX_UPLOAD = parseInt(process.env.MAX_UPLOAD_MB || '200', 10) * 1024 * 1024;
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD, files: 60 } });

const IMAGE_EXTS = new Set([
  'gif', 'jpg', 'jpeg', 'jpc', 'jp2', 'jpx', 'jb2', 'png', 'swf', 'psd',
  'bmp', 'tiff', 'tif', 'wbmp', 'xbm', 'ico', 'webp', 'avif', 'svg',
  'heic', 'heif', 'dng',
]);
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'm3u8']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'wav', 'flac']);
const DOC_EXTS = new Set(['pdf', 'txt', 'md', 'json', 'csv', 'log', 'xml', 'html', 'htm']);

// Cap on editable file size (read + write) to keep the editor responsive.
// Editable detection is content-based (looksText), not extension-based, so
// unusual extensions are still editable as long as the file is text-like.
const MAX_EDIT_BYTES = 5 * 1024 * 1024;

fs.mkdirSync(CACHE_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Path helpers
// ---------------------------------------------------------------------------
function relToAbs(rel) {
  const clean = String(rel || '').replace(/^\/+/, '').replace(/\.\.+/g, '');
  const abs = path.resolve(ROOT, clean);
  if (!abs.startsWith(ROOT)) return null; // path traversal guard
  return abs;
}

// Resolve a relative path to absolute, replying 400 (and returning null) on
// traversal / empty input. Callers do `const abs = resolveOr400(res, rel); if (!abs) return;`
function resolveOr400(res, rel) {
  const abs = relToAbs(rel);
  if (!abs) { res.status(400).json({ error: 'Invalid path' }); return null; }
  return abs;
}

function absToRel(abs) {
  const rel = path.relative(ROOT, abs).split(path.sep).join('/');
  return rel === '' ? '' : rel;
}

function isExcluded(name) {
  return name.startsWith('_files') || name.startsWith('.') && name !== '.';
}

function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}

// Map an extension to a coarse category used for front-end icons.
function catOf(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (DOC_EXTS.has(ext)) return 'doc';
  return 'file';
}

function filePerms(abs) {
  try {
    return '0' + (fs.statSync(abs).mode & 0o777).toString(8).padStart(3, '0');
  } catch {
    return '0000';
  }
}

// Sanitize an uploaded/created name: strip path separators + control chars.
function sanitizeName(name) {
  return String(name || '')
    .replace(/[\/\\]/g, '_')
    .replace(/[\x00-\x1f<>:"|?*]/g, '')
    .trim()
    .slice(0, 180) || 'untitled';
}

// Recursive delete, refusing to remove the root itself.
function rmrf(p) {
  if (!fs.existsSync(p)) return;
  if (p === ROOT) return;
  const s = fs.statSync(p);
  if (s.isDirectory()) {
    for (const e of fs.readdirSync(p)) rmrf(path.join(p, e));
    fs.rmdirSync(p);
  } else {
    fs.unlinkSync(p);
  }
}

// Produce a non-colliding name inside `dir` for `base`.
function uniqueName(dir, base) {
  let candidate = base;
  let i = 1;
  while (fs.existsSync(path.join(dir, candidate))) {
    const dot = base.lastIndexOf('.');
    candidate = dot > 0 ? base.slice(0, dot) + ` (${i})` + base.slice(dot) : `${base} (${i})`;
    i++;
  }
  return candidate;
}

// Recursive copy (used by /api/move with copy=true).
async function copyRecursive(src, dest) {
  const st = await fsp.stat(src);
  if (st.isDirectory()) {
    await fsp.mkdir(dest, { recursive: true });
    const entries = await fsp.readdir(src);
    for (const e of entries) await copyRecursive(path.join(src, e), path.join(dest, e));
  } else {
    await fsp.copyFile(src, dest);
  }
}

// ---------------------------------------------------------------------------
// Auth helpers (password-protected file system)
// ---------------------------------------------------------------------------
function parseCookies(req) {
  const out = {};
  const raw = req.headers.cookie || '';
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=');
    if (idx < 0) continue;
    const k = part.slice(0, idx).trim();
    const v = part.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v);
  }
  return out;
}
function authToken() {
  // Deterministic per-password token (stable across restarts).
  return crypto.createHmac('sha256', AUTH_SECRET).update('authed').digest('hex');
}
function isAuthed(req) {
  if (!AUTH_ENABLED) return true;
  const cookie = parseCookies(req)[AUTH_COOKIE];
  const expected = authToken();
  if (!cookie || cookie.length !== expected.length) return false;
  try {
    return crypto.timingSafeEqual(Buffer.from(cookie), Buffer.from(expected));
  } catch {
    return false;
  }
}
function setAuthCookie(res, value) {
  const maxAge = value ? AUTH_MAX_AGE : 0;
  res.setHeader('Set-Cookie',
    `${AUTH_COOKIE}=${value}; Path=/; Max-Age=${maxAge}; HttpOnly; SameSite=Lax`);
}
function requireAuth(req, res) {
  if (AUTH_ENABLED && !isAuthed(req)) {
    res.status(401).json({ error: '需要登录后才能操作' });
    return false;
  }
  return true;
}

// Is a directory itself marked public (has the .public marker file)?
function dirIsPublicSelf(absDir) {
  try { return fs.existsSync(path.join(absDir, PUBLIC_MARKER)); } catch { return false; }
}

// Walk from `absPath` up to ROOT; public if self or any ancestor is marked.
function isPublic(absPath) {
  let p = absPath;
  while (true) {
    if (fs.existsSync(path.join(p, PUBLIC_MARKER))) return true;
    if (p === ROOT) break;
    const parent = path.dirname(p);
    if (parent === p) break;
    p = parent;
  }
  return false;
}

// Gate for read endpoints. Allows anonymous access only when the requested
// resource lives inside a public directory; otherwise a valid login is needed.
function gateRead(req, res, abs) {
  if (AUTH_ENABLED && !isAuthed(req) && !isPublic(abs)) {
    res.status(401).json({ error: '需要登录后才能查看' });
    return false;
  }
  return true;
}

// ---------------------------------------------------------------------------
// File / Dir data builders (mirror PHP File / Dir classes)
// ---------------------------------------------------------------------------
// Decide whether a file is text-like (editable) by sniffing its first chunk.
// A file is editable when it has no NUL byte and a low ratio of control
// characters. This replaces a hard-coded extension allowlist so documents
// with unusual suffixes can still be edited; binary files (images, video,
// archives) are correctly rejected before any write corrupts them.
async function looksText(abs) {
  let fh;
  try {
    fh = await fsp.open(abs, 'r');
    const buf = Buffer.alloc(8192);
    const { bytesRead } = await fh.read(buf, 0, 8192, 0);
    if (bytesRead === 0) return true; // empty file is editable
    const head = buf.subarray(0, bytesRead);
    if (head.indexOf(0) !== -1) return false; // NUL byte ⇒ binary
    let nontext = 0;
    for (let i = 0; i < bytesRead; i++) {
      const c = buf[i];
      if ((c < 0x09) || (c > 0x0d && c < 0x20) || c === 0x7f) nontext++;
    }
    return nontext / bytesRead < 0.30;
  } catch {
    return false;
  } finally {
    if (fh) { try { await fh.close(); } catch { /* ignore */ } }
  }
}

async function buildFile(abs, rel, dirUrlPath) {
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return null;
  }
  const basename = path.basename(abs);
  const isDir = stat.isDirectory();
  const isLink = stat.isSymbolicLink();
  const ext = isDir ? '' : extOf(basename);

  const file = {
    basename,
    ext,
    fileperms: filePerms(abs),
    filetype: isDir ? 'dir' : 'file',
    filesize: isDir ? 0 : stat.size,
    is_readable: true,
    is_writeable: (stat.mode & 0o200) !== 0,
    is_link: isLink,
    is_dir: isDir,
    mtime: Math.floor(stat.mtimeMs / 1000),
    path: rel,
    url_path: '/api/image?path=' + encodeURIComponent(rel),
  };

  if (isDir) {
    file.mime = 'directory';
    // count visible entries inside subdir (cheap, no deep recursion)
    try {
      const subEntries = await fsp.readdir(abs, { withFileTypes: true });
      file.files_count = subEntries.filter((e) => e.name !== '.' && e.name !== '..' && !isExcluded(e.name)).length;
    } catch { file.files_count = 0; }
    // public flags so the front-end can reflect the folder's share state
    file.public_self = AUTH_ENABLED ? dirIsPublicSelf(abs) : false;
    file.public = AUTH_ENABLED ? isPublic(abs) : false;
    return file;
  }

  // image metadata
  if (IMAGE_EXTS.has(ext) && ext !== 'svg') {
    try {
      const meta = await sharp(abs, { limitInputPixels: false }).metadata();
      file.mime = meta.format ? `image/${meta.format}` : `image/${ext}`;
      file.icon = 'image';
      const image = { width: meta.width, height: meta.height, mime: file.mime };
      if (meta.orientation && meta.orientation >= 5 && meta.orientation <= 8) {
        [image.width, image.height] = [image.height, image.width];
      }
      file.image = image;
    } catch {
      file.mime = `image/${ext}`;
      file.icon = 'image';
    }
  } else if (VIDEO_EXTS.has(ext)) {
    file.mime = `video/${ext}`;
    file.icon = 'video';
  } else if (AUDIO_EXTS.has(ext)) {
    file.mime = `audio/${ext}`;
    file.icon = 'audio';
  } else if (DOC_EXTS.has(ext)) {
    file.mime = ext === 'pdf' ? 'application/pdf' : 'text/plain';
    file.icon = 'doc';
  } else {
    file.icon = 'file';
  }
  // Whether this file can be opened in the in-browser text editor.
  // Content-based (no NUL / low control-char ratio) and size-gated.
  file.editable = stat.size <= MAX_EDIT_BYTES && (stat.size === 0 || await looksText(abs));
  return file;
}

async function buildDir(abs, rel, withFiles = false, depth = 0) {
  let stat;
  try {
    stat = await fsp.stat(abs);
  } catch {
    return null;
  }
  const basename = path.basename(abs);
  const dir = {
    basename,
    fileperms: filePerms(abs),
    filetype: 'dir',
    is_readable: true,
    is_writeable: (stat.mode & 0o200) !== 0,
    is_link: stat.isSymbolicLink(),
    is_dir: true,
    mime: 'directory',
    mtime: Math.floor(stat.mtimeMs / 1000),
    path: rel,
    files_count: 0,
    dirsize: 0,
    images_count: 0,
    url_path: '/api/dir?path=' + encodeURIComponent(rel),
    // whether THIS directory carries the .public marker (not counting ancestors)
    public_self: AUTH_ENABLED ? dirIsPublicSelf(abs) : false,
  };

  let entries = [];
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    dir.files = {};
    return dir;
  }

  if (!withFiles) {
    // count visible entries even without full file metadata (for menus / folder cards)
    for (const e of entries) {
      if (e.name === '.' || e.name === '..') continue;
      if (isExcluded(e.name)) continue;
      dir.files_count++;
    }
    return dir;
  }

  const files = {};
  for (const name of entries.map(e => e.name)) {
    if (name === '.' || name === '..') continue;
    if (isExcluded(name)) continue;
    const childAbs = path.join(abs, name);
    const childRel = rel ? rel + '/' + name : name;
    const f = await buildFile(childAbs, childRel, dir.url_path);
    if (!f) continue;
    if (!f.is_dir) {
      dir.files_count++;
      dir.dirsize += f.filesize || 0;
      if (f.icon === 'image') dir.images_count++;
    }
    files[name] = f;
  }

  // sort: directories first, then natural case-insensitive
  const sorted = Object.values(files).sort((a, b) => {
    if (a.is_dir !== b.is_dir) return a.is_dir ? -1 : 1;
    return a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' });
  });
  dir.files = {};
  for (const f of sorted) dir.files[f.basename] = f;
  return dir;
}

// ---------------------------------------------------------------------------
// Recursive directory tree (mirror PHP Dirs / menu)
// ---------------------------------------------------------------------------
async function collectDirs(abs, rel, depth, out) {
  if (depth > MENU_MAX_DEPTH) return;
  let entries = [];
  try {
    entries = await fsp.readdir(abs, { withFileTypes: true });
  } catch {
    return;
  }
  const subdirs = [];
  for (const e of entries) {
    if (e.name === '.' || e.name === '..') continue;
    if (isExcluded(e.name)) continue;
    if (!e.isDirectory() && !e.isSymbolicLink()) continue;
    const childAbs = path.join(abs, e.name);
    const childRel = rel ? rel + '/' + e.name : e.name;
    const d = await buildDir(childAbs, childRel, false);
    if (!d) continue;
    out.push(d);
    subdirs.push([childAbs, childRel]);
  }
  for (const [cAbs, cRel] of subdirs) {
    await collectDirs(cAbs, cRel, depth + 1, out);
  }
}

// ---------------------------------------------------------------------------
// Thumbnail generation (mirror PHP ResizeImage / FileResponse)
// ---------------------------------------------------------------------------
function thumbCachePath(rel, size, mtime) {
  const hash = crypto.createHash('md5').update(rel + '|' + size + '|' + mtime).digest('hex');
  return path.join(CACHE_DIR, `${hash}.${size}.jpg`);
}

async function sendThumb(res, abs, rel, size) {
  const stat = await fsp.stat(abs);
  const mtime = Math.floor(stat.mtimeMs / 1000);
  const ext = extOf(rel);

  if (!IMAGE_EXTS.has(ext) || ext === 'svg') {
    return res.status(415).json({ error: 'Not an image' });
  }

  const cache = thumbCachePath(rel, size, mtime);
  if (fs.existsSync(cache)) {
    return res.sendFile(cache);
  }

  try {
    const buf = await sharp(abs, { limitInputPixels: false })
      .rotate() // respect EXIF orientation
      .resize(size, size, { fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality: 82, progressive: true })
      .toBuffer();
    fs.writeFileSync(cache, buf);
    res.type('image/jpeg').send(buf);
  } catch (err) {
    res.status(500).json({ error: 'Resize failed: ' + err.message });
  }
}

// ---------------------------------------------------------------------------
// Express app
// ---------------------------------------------------------------------------
const app = express();
// 反向代理（如平台网关）下让 req.ip 反映真实客户端 IP，登录限流据此按 IP 隔离
app.set('trust proxy', true);

// ---------------------------------------------------------------------------
// 前端资源版本化：按 app.js / style.css 内容哈希生成 ?v=，发布后浏览器自动加载
// 新资源（URL 变化 ⇒ 旧缓存失效），无需手动强制刷新。
// ---------------------------------------------------------------------------
function assetHash(file) {
  try { return crypto.createHash('md5').update(fs.readFileSync(file)).digest('hex').slice(0, 8); }
  catch { return '0'; }
}
const ASSET_VER =
  assetHash(path.join(__dirname, 'public', 'js', 'app.js')) +
  assetHash(path.join(__dirname, 'public', 'css', 'style.css'));
let INDEX_HTML;
try {
  INDEX_HTML = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8')
    .replace('/css/style.css', `/css/style.css?v=${ASSET_VER}`)
    .replace('/js/app.js', `/js/app.js?v=${ASSET_VER}`);
} catch { INDEX_HTML = null; }
function serveIndex(req, res) {
  if (INDEX_HTML) return res.type('html').send(INDEX_HTML);
  res.sendFile(path.join(__dirname, 'public', 'index.html')); // 兜底
}
// 优先于 express.static 处理入口，确保版本号注入生效
app.get('/', serveIndex);
app.get('/index.html', serveIndex);
app.use(express.static(path.join(__dirname, 'public')));
app.use(express.json({ limit: '1mb' }));

// Wrap an async route so any thrown error becomes a 500 JSON response.
const asyncHandler = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);
// Central error handler for async routes (catches errors not handled inline).
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  res.status(500).json({ error: err.message });
});

// config
app.get('/api/config', (req, res) => {
  const authed = isAuthed(req);
  res.json({
    script: 'server.js',
    root_basename: path.basename(ROOT),
    root: '',
    menu_exists: true,
    layout: 'small',
    thumb_size: THUMB_DEFAULT,
    thumb_retina: THUMB_RETINA,
    menu_max_depth: MENU_MAX_DEPTH,
    auth_enabled: AUTH_ENABLED,
    logged_in: authed,
    // management UI is offered only when enabled AND (no auth, or logged in)
    allow_management: ALLOW_MANAGEMENT && (!AUTH_ENABLED || authed),
    version: '1.2.0-js',
  });
});

// 登录失败限流：按真实客户端 IP 的内存滑动窗口（60s 内失败 10 次即拒绝 429）
const loginFails = new Map();
const LOGIN_WINDOW = 60 * 1000;
const LOGIN_MAX_FAILS = 10;
function loginFailWindow(ip) {
  const now = Date.now();
  const arr = (loginFails.get(ip) || []).filter((t) => now - t < LOGIN_WINDOW);
  if (arr.length) loginFails.set(ip, arr); else loginFails.delete(ip);
  return arr;
}
function recordLoginFail(ip) {
  const arr = loginFailWindow(ip);
  arr.push(Date.now());
  loginFails.set(ip, arr);
}

// login (verify password, issue signed cookie)
app.post('/api/login', (req, res) => {
  if (!AUTH_ENABLED) return res.status(400).json({ error: '未启用密码鉴权' });
  const ip = req.ip || 'unknown';
  if (loginFailWindow(ip).length >= LOGIN_MAX_FAILS) {
    return res.status(429).json({ error: '尝试过于频繁，请稍后再试' });
  }
  const pw = String(req.body && req.body.password || '');
  const a = Buffer.from(pw);
  const b = Buffer.from(GALLERY_PASSWORD);
  const ok = a.length === b.length && a.length > 0 && crypto.timingSafeEqual(a, b);
  if (!ok) { recordLoginFail(ip); return res.status(401).json({ error: '密码错误' }); }
  loginFails.delete(ip);
  setAuthCookie(res, authToken());
  res.json({ ok: true, logged_in: true });
});

// logout (clear cookie)
app.post('/api/logout', (req, res) => {
  setAuthCookie(res, '');
  res.json({ ok: true, logged_in: false });
});

// Toggle a directory's public flag (admin only). Writes/removes the .public
// marker inside the directory. Marking makes the directory and everything
// beneath it directly linkable without login. Root cannot be marked public.
app.post('/api/public', (req, res) => {
  if (!requireAuth(req, res)) return;
  const abs = resolveOr400(res, String(req.body.path || ''));
  if (!abs) return;
  const makePublic = !!req.body.public;
  if (abs === ROOT) return res.status(400).json({ error: '不能对根目录设置公开' });
  let isDir = false;
  try { isDir = fs.statSync(abs).isDirectory(); } catch { isDir = false; }
  if (!isDir) return res.status(400).json({ error: '目标不是目录' });
  const marker = path.join(abs, PUBLIC_MARKER);
  try {
    if (makePublic) fs.writeFileSync(marker, '');
    else if (fs.existsSync(marker)) fs.unlinkSync(marker);
    res.json({ ok: true, public: makePublic, public_self: makePublic, path: absToRel(abs) });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// storage usage for the volume backing ROOT (used by the Home right-click menu)
app.get('/api/storage', (req, res) => {
  if (!requireAuth(req, res)) return;
  try {
    const s = fs.statfsSync(ROOT);
    const bsize = s.frsize || s.bsize; // preferred block size for free/used math
    const total = s.blocks * bsize;
    const free = s.bavail * bsize; // available to non-privileged users
    const used = Math.max(0, total - free);
    res.json({ ok: true, total, free, used });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// recursive directory list (menu)
app.get('/api/dirs', asyncHandler(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const out = [];
  await collectDirs(ROOT, '', 0, out);
  res.json(out);
}));

// single directory with files
app.get('/api/dir', asyncHandler(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const rel = String(req.query.path || '');
  const abs = resolveOr400(res, rel);
  if (!abs) return;
  const dir = await buildDir(abs, rel, true);
  if (!dir) return res.status(404).json({ error: 'Not found' });
  dir.public = isPublic(abs); // inherited public flag (self or any ancestor marked)
  res.json(dir);
}));

// thumbnail
app.get('/api/thumb', asyncHandler(async (req, res) => {
  const rel = String(req.query.path || '');
  const size = parseInt(req.query.size || String(THUMB_DEFAULT), 10);
  const abs = resolveOr400(res, rel);
  if (!abs) return;
  if (!gateRead(req, res, abs)) return;
  await sendThumb(res, abs, rel, size);
}));

// original image / any file (stream)
app.get('/api/image', async (req, res) => {
  const rel = String(req.query.path || '');
  const abs = relToAbs(rel);
  if (!abs) return res.status(400).json({ error: 'Invalid path' });
  if (!gateRead(req, res, abs)) return;
  try {
    const stat = await fsp.stat(abs);
    if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
    if (req.query.download) {
      res.download(abs, path.basename(abs));
    } else {
      res.sendFile(abs);
    }
  } catch {
    res.status(404).json({ error: 'Not found' });
  }
});

// ---------------------------------------------------------------------------
// File management: upload / mkdir / rename / delete / zip download
// ---------------------------------------------------------------------------
function mgmtGuard(req, res) {
  if (!ALLOW_MANAGEMENT) {
    res.status(403).json({ error: 'File management is disabled' });
    return false;
  }
  if (AUTH_ENABLED && !isAuthed(req)) {
    res.status(401).json({ error: '需要登录后才能操作' });
    return false;
  }
  return true;
}

// Upload one or more files into a directory (?path=<dir>)
app.post('/api/upload', (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const dirRel = String(req.query.path || '');
  const parent = relToAbs(dirRel);
  if (!parent || !fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return res.status(400).json({ error: 'Invalid target directory' });
  }
  upload.array('files')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    if (!req.files || !req.files.length) return res.status(400).json({ error: 'No files received' });
    const saved = [];
    for (const f of req.files) {
      const name = uniqueName(parent, sanitizeName(f.originalname));
      fs.writeFileSync(path.join(parent, name), f.buffer);
      const rel = dirRel ? dirRel + '/' + name : name;
      saved.push(rel);
    }
    res.json({ ok: true, saved });
  });
});

// Fetch a file from a remote http(s) URL and store it in a directory.
// Accepts { path, urls: [..] }; downloads each, sanitizing + de-duplicating the
// filename. Resilient: one failed URL does not abort the others. Returns
// { saved: [...], failed: [{url, error}] }.
// ---------------------------------------------------------------------------
// SSRF 防护：远程下载前校验目标地址，禁止访问内网/环回/链路本地（含云元数据
// 169.254.169.254）。重定向手动跟随，每一跳都重新做 DNS 解析与 IP 校验，并限制
// 跳数，避免经重定向跳入内网。
// ---------------------------------------------------------------------------
function isBlockedIp(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    if (a === 0) return true;                       // 0.0.0.0/8
    if (a === 10) return true;                      // 私有 10/8
    if (a === 127) return true;                     // 环回
    if (a === 169 && b === 254) return true;        // 链路本地（云元数据）
    if (a === 172 && b >= 16 && b <= 31) return true; // 私有 172.16/12
    if (a === 192 && b === 168) return true;        // 私有 192.168/16
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT 100.64/10
    if (a >= 224) return true;                      // 组播/保留
    return false;
  }
  if (net.isIPv6(ip)) {
    const v = ip.toLowerCase();
    if (v === '::1' || v === '::') return true;
    if (v.startsWith('fc') || v.startsWith('fd')) return true; // 唯一本地 fc00::/7
    if (v.startsWith('fe80')) return true;          // 链路本地
    if (v.startsWith('::ffff:')) return isBlockedIp(v.slice(7)); // IPv4-mapped
    return false;
  }
  return true; // 无法识别 → 拒绝
}

async function safeFetch(urlStr, timeoutMs, redirectsLeft = 5) {
  let url;
  try { url = new URL(urlStr); } catch { throw new Error('链接格式无效'); }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new Error('仅支持 http/https 链接');
  }
  const { address } = await dns.promises.lookup(url.hostname);
  if (isBlockedIp(address)) throw new Error('目标地址被禁止（内网/本地地址）');
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  let resp;
  try {
    // 手动处理重定向，确保每一跳都重新校验目标地址
    resp = await fetch(url, { signal: ctrl.signal, redirect: 'manual' });
  } finally {
    clearTimeout(timer);
  }
  if (resp.status >= 300 && resp.status < 400) {
    if (redirectsLeft <= 0) throw new Error('重定向次数过多');
    const loc = resp.headers.get('location');
    if (!loc) throw new Error('重定向缺少 Location');
    return safeFetch(new URL(loc, url).href, timeoutMs, redirectsLeft - 1);
  }
  if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
  return resp;
}

app.post('/api/remote-fetch', asyncHandler(async (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const dirRel = String(req.body.path || '');
  const parent = resolveOr400(res, dirRel);
  if (!parent) return;
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return res.status(400).json({ error: 'Invalid target directory' });
  }
  const urls = Array.isArray(req.body.urls) ? req.body.urls.map(String) : [];
  const clean = urls.map((u) => u.trim()).filter(Boolean);
  if (!clean.length) return res.status(400).json({ error: 'No URLs provided' });

  const saved = [];
  const failed = [];
  for (const url of clean) {
    let dest = null;
    try {
      const resp = await safeFetch(url, 60000);
      const base = filenameFromUrl(url, resp.headers.get('content-disposition') || '');
      const name = uniqueName(parent, sanitizeName(base) || 'remote-file');
      dest = path.join(parent, name);
      let total = 0;
      await new Promise((resolve, reject) => {
        const rstream = Readable.fromWeb(resp.body);
        const fstream = fs.createWriteStream(dest);
        rstream.on('data', (chunk) => {
          total += chunk.length;
          if (total > MAX_UPLOAD) { rstream.destroy(); reject(new Error('文件超过大小限制')); }
        });
        rstream.on('error', reject);
        fstream.on('error', reject);
        rstream.pipe(fstream);
        fstream.on('finish', resolve);
      });
      const rel = dirRel ? dirRel + '/' + name : name;
      saved.push(rel);
    } catch (e) {
      if (dest) { try { fs.unlinkSync(dest); } catch { /* ignore */ } } // 清理残留空文件
      failed.push({ url, error: e.name === 'AbortError' ? '下载超时' : (e.message || '下载失败') });
    }
  }
  res.json({ ok: true, saved, failed });
}));

// Derive a filename from a URL + Content-Disposition header.
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
  } catch { /* fall through */ }
  return 'remote-file';
}

// Create a new directory (?path=<parent>&name=<x>)
// Create a new (optionally pre-filled) file inside a directory (?path=<dir>).
// body: { path, name, content? }. The name is sanitized; collisions are
// de-duplicated via uniqueName so an existing file is never overwritten.
app.post('/api/mkfile', asyncHandler(async (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const parent = resolveOr400(res, String(req.body.path || ''));
  if (!parent) return;
  if (!fs.existsSync(parent) || !fs.statSync(parent).isDirectory()) {
    return res.status(400).json({ error: 'Invalid target directory' });
  }
  const name = sanitizeName(String(req.body.name || ''));
  if (!name) return res.status(400).json({ error: '文件名不能为空' });
  const content = String(req.body.content || '');
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) {
    return res.status(413).json({ error: '文件内容超过编辑大小上限' });
  }
  const target = path.join(parent, uniqueName(parent, name));
  if (!target.startsWith(ROOT)) return res.status(400).json({ error: 'Invalid name' });
  fs.writeFileSync(target, content, 'utf8');
  res.json({ ok: true, path: absToRel(target) });
}));

// Read a text/code file's content for the in-browser editor. Public files may
// be previewed without auth (gateRead); everything else requires auth.
app.get('/api/file', asyncHandler(async (req, res) => {
  const abs = resolveOr400(res, String(req.query.path || ''));
  if (!abs) return;
  if (!gateRead(req, res, abs)) return;
  let stat;
  try { stat = await fsp.stat(abs); } catch { return res.status(404).json({ error: 'Not found' }); }
  if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
  if (stat.size > MAX_EDIT_BYTES) {
    return res.status(415).json({ error: '文件过大，无法在编辑器内打开（上限 5 MB）' });
  }
  if (!(await looksText(abs))) {
    return res.status(415).json({ error: '该文件不是文本文件，不支持编辑' });
  }
  const content = await fsp.readFile(abs, 'utf8');
  res.json({ ok: true, content, size: stat.size, name: path.basename(abs) });
}));

// Overwrite an existing text/code file with new content (management only).
app.post('/api/write', asyncHandler(async (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const abs = resolveOr400(res, String(req.body.path || ''));
  if (!abs) return;
  let stat;
  try { stat = await fsp.stat(abs); } catch { return res.status(404).json({ error: 'Not found' }); }
  if (stat.isDirectory()) return res.status(400).json({ error: 'Is a directory' });
  if (stat.size > MAX_EDIT_BYTES) {
    return res.status(415).json({ error: '文件过大，无法在编辑器内打开（上限 5 MB）' });
  }
  if (!(await looksText(abs))) {
    return res.status(415).json({ error: '该文件不是文本文件，不支持编辑' });
  }
  const content = String(req.body.content || '');
  if (Buffer.byteLength(content, 'utf8') > MAX_EDIT_BYTES) {
    return res.status(413).json({ error: '文件内容超过编辑大小上限' });
  }
  fs.writeFileSync(abs, content, 'utf8');
  res.json({ ok: true });
}));

app.post('/api/mkdir', asyncHandler(async (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const parent = resolveOr400(res, String(req.body.path || ''));
  if (!parent) return;
  const name = sanitizeName(req.body.name);
  if (!fs.existsSync(parent)) return res.status(400).json({ error: 'Invalid parent' });
  const target = path.join(parent, name);
  if (!target.startsWith(ROOT)) return res.status(400).json({ error: 'Invalid name' });
  if (fs.existsSync(target)) return res.status(409).json({ error: 'Already exists' });
  fs.mkdirSync(target);
  res.json({ ok: true, path: absToRel(target) });
}));

// Rename a file or directory (?path=<old>&name=<new> via body)
app.post('/api/rename', asyncHandler(async (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const oldAbs = resolveOr400(res, String(req.body.path || ''));
  if (!oldAbs) return;
  const name = sanitizeName(req.body.name);
  if (oldAbs === ROOT) return res.status(400).json({ error: 'Invalid path' });
  if (!fs.existsSync(oldAbs)) return res.status(404).json({ error: 'Not found' });
  const target = path.join(path.dirname(oldAbs), name);
  if (!target.startsWith(ROOT)) return res.status(400).json({ error: 'Invalid name' });
  if (fs.existsSync(target)) return res.status(409).json({ error: 'Already exists' });
  fs.renameSync(oldAbs, target);
  res.json({ ok: true, path: absToRel(target) });
}));

// Delete one or more paths ({ paths: [...] })
app.post('/api/delete', async (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  if (!paths.length) return res.status(400).json({ error: 'No paths' });
  let removed = 0;
  for (const p of paths) {
    const abs = relToAbs(String(p || ''));
    if (!abs || abs === ROOT || !fs.existsSync(abs)) continue;
    try { rmrf(abs); removed++; } catch { /* ignore per-item */ }
  }
  res.json({ ok: true, removed });
});

// Stream a set of { abs, name } entries as a ZIP download.
function zipItems(res, items, filename) {
  res.attachment(filename);
  const archive = archiver('zip', { zlib: { level: 6 } });
  archive.on('error', (e) => res.status(500).end(e.message));
  for (const { abs, name } of items) {
    try {
      const s = fs.statSync(abs);
      if (s.isDirectory()) archive.directory(abs, name || 'folder');
      else archive.file(abs, { name: name || path.basename(abs) });
    } catch { /* skip missing entries */ }
  }
  archive.pipe(res);
  archive.finalize();
}

// Download a directory as a ZIP (or a single file directly)
app.get('/api/zip', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const abs = resolveOr400(res, String(req.query.path || ''));
  if (!abs) return;
  let stat;
  try { stat = fs.statSync(abs); } catch { return res.status(404).json({ error: 'Not found' }); }
  if (stat.isDirectory()) {
    const base = path.basename(abs) || 'files';
    zipItems(res, [{ abs, name: base }], `${base}.zip`);
  } else {
    res.download(abs, path.basename(abs));
  }
});

// Download a set of selected files/dirs as a single ZIP (POST { paths: [...] })
app.post('/api/zip', async (req, res) => {
  if (!requireAuth(req, res)) return;
  const paths = Array.isArray(req.body.paths) ? req.body.paths : [];
  if (!paths.length) return res.status(400).json({ error: 'No paths' });
  const items = paths.map((p) => relToAbs(String(p || ''))).filter(Boolean)
    .map((a) => ({ abs: a, name: path.basename(a) }));
  if (!items.length) return res.status(400).json({ error: 'Invalid paths' });
  zipItems(res, items, 'selection.zip');
});

// ---------------------------------------------------------------------------
// Search: recursive scan across the whole file tree (limited result set)
// ---------------------------------------------------------------------------
app.get('/api/search', asyncHandler(async (req, res) => {
  if (!requireAuth(req, res)) return;
  const q = String(req.query.q || '').toLowerCase().trim();
  if (!q) return res.json([]);
  const MAX = 400;
  const results = [];
  async function walk(abs, rel) {
    if (results.length >= MAX) return;
    let entries;
    try { entries = await fsp.readdir(abs, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (results.length >= MAX) return;
      if (e.name === '.' || e.name === '..') continue;
      if (isExcluded(e.name)) continue;
      const childRel = rel ? rel + '/' + e.name : e.name;
      if (e.isDirectory()) {
        let filesCount = 0;
        try {
          filesCount = (await fsp.readdir(path.join(abs, e.name)))
            .filter((n) => n !== '.' && n !== '..' && !isExcluded(n)).length;
        } catch { filesCount = 0; }
        if (e.name.toLowerCase().includes(q)) {
          results.push({ basename: e.name, path: childRel, is_dir: true, icon: 'folder', parent: rel, files_count: filesCount });
        }
        await walk(path.join(abs, e.name), childRel);
      } else if (e.name.toLowerCase().includes(q)) {
        const ext = extOf(e.name);
        results.push({
          basename: e.name, path: childRel, is_dir: false,
          icon: catOf(ext), ext,
          thumbbable: IMAGE_EXTS.has(ext) && ext !== 'svg',
          parent: rel,
        });
      }
    }
  }
  await walk(ROOT, '');
  res.json(results);
}));

// ---------------------------------------------------------------------------
// Move / copy files or folders into a destination directory
// ---------------------------------------------------------------------------
app.post('/api/move', asyncHandler(async (req, res) => {
  if (!mgmtGuard(req, res)) return;
  const items = Array.isArray(req.body.items) ? req.body.items : [];
  const copy = !!req.body.copy;
  if (items.length === 0) return res.status(400).json({ error: 'No items' });
  const destAbs = resolveOr400(res, String(req.body.dest || ''));
  if (!destAbs) return;
  if (!fs.existsSync(destAbs) || !fs.statSync(destAbs).isDirectory()) {
    return res.status(400).json({ error: 'Invalid destination' });
  }
  let moved = 0;
  for (const p of items) {
    const srcAbs = relToAbs(String(p || ''));
    if (!srcAbs || srcAbs === ROOT || !fs.existsSync(srcAbs)) continue;
    // no moving into itself, nor into one of its own sub-directories
    if (srcAbs === destAbs || destAbs.startsWith(srcAbs + path.sep)) continue;
    const base = path.basename(srcAbs);
    const finalName = fs.existsSync(path.join(destAbs, base)) ? uniqueName(destAbs, base) : base;
    const finalTarget = path.join(destAbs, finalName);
    try {
      if (copy) await copyRecursive(srcAbs, finalTarget);
      else fs.renameSync(srcAbs, finalTarget);
      moved++;
    } catch { /* skip per-item failures */ }
  }
  res.json({ ok: true, moved });
}));

app.listen(PORT, () => {
  console.log(`📁 Filo running at http://localhost:${PORT}`);
  console.log(`   Root directory: ${ROOT}`);
  console.log(`   File management: ${ALLOW_MANAGEMENT ? 'enabled' : 'disabled'}`);
  console.log(`   Password auth: ${AUTH_ENABLED ? 'enabled (login required to enter)' : 'disabled (open)'}`);
  if (AUTH_ENABLED) console.log(`   Public dirs: mark a folder with a .public file (or use the 🌐 button) for direct, login-free file links`);
});
