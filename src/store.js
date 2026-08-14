// src/store.js — Filo 在 Cloudflare Workers + R2 上的"虚拟文件系统"抽象。
//
// R2 是扁平 KV 对象存储，目录树用「key 前缀」模拟：
//   - 文件：       key = 相对路径，如  Travel/photo-1.jpg
//   - 目录标记：   零字节对象  <dir>/   （让空目录可见、可被遍历发现）
//   - 公开标记：   零字节对象  <dir>/.public （祖先链任一含此标记即公开直链）
//   - 隐藏项：     .public / .dir / 以 _files 开头的 key 不显示为文件

const IMAGE_EXTS = new Set([
  'gif', 'jpg', 'jpeg', 'jpc', 'jp2', 'jpx', 'jb2', 'png', 'swf', 'psd',
  'bmp', 'tiff', 'tif', 'wbmp', 'xbm', 'ico', 'webp', 'avif', 'svg',
  'heic', 'heif', 'dng',
]);
const VIDEO_EXTS = new Set(['mp4', 'm4v', 'webm', 'ogv', 'mov', 'mkv', 'm3u8']);
const AUDIO_EXTS = new Set(['mp3', 'm4a', 'aac', 'ogg', 'oga', 'wav', 'flac']);
const DOC_EXTS = new Set(['pdf', 'txt', 'md', 'json', 'csv', 'log', 'xml', 'html', 'htm']);
const MAX_EDIT_BYTES = 5 * 1024 * 1024; // 编辑器上限 5MB
// 目录列表阶段只按扩展名判断是否可能可编辑，真正打开时再做内容嗅探。
const EDITABLE_EXTS = new Set([
  'txt', 'md', 'json', 'csv', 'log', 'xml', 'html', 'htm', 'css', 'js', 'mjs',
  'cjs', 'ts', 'tsx', 'jsx', 'vue', 'svelte', 'yaml', 'yml', 'toml', 'ini',
  'conf', 'sh', 'bash', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'sql',
]);

const PUBLIC_MARKER = '.public';
const isHidden = (name) => name === PUBLIC_MARKER || name === '.dir' || name.startsWith('._files');

export {
  IMAGE_EXTS, VIDEO_EXTS, AUDIO_EXTS, DOC_EXTS, MAX_EDIT_BYTES,
};

// ---------------------------------------------------------------------------
// 基础工具
// ---------------------------------------------------------------------------
export function isExcluded(name) {
  return name.startsWith('_files') || (name.startsWith('.') && name !== '.');
}
export function extOf(name) {
  const i = name.lastIndexOf('.');
  return i < 0 ? '' : name.slice(i + 1).toLowerCase();
}
function catOf(ext) {
  if (IMAGE_EXTS.has(ext)) return 'image';
  if (VIDEO_EXTS.has(ext)) return 'video';
  if (AUDIO_EXTS.has(ext)) return 'audio';
  if (DOC_EXTS.has(ext)) return 'doc';
  return 'file';
}
export function splitPath(rel) {
  return String(rel || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter(Boolean);
}
// 规范化用户传入的相对路径：去首尾斜杠、丢弃 . 与 ..
export function safeRel(rel) {
  return String(rel || '')
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .split('/')
    .filter((s) => s && s !== '.')
    .join('/');
}
export function mimeFromExt(name) {
  const ext = extOf(name);
  if (IMAGE_EXTS.has(ext)) return ext === 'svg' ? 'image/svg+xml' : `image/${ext === 'jpg' ? 'jpeg' : ext}`;
  if (VIDEO_EXTS.has(ext)) return `video/${ext}`;
  if (AUDIO_EXTS.has(ext)) return `audio/${ext}`;
  if (ext === 'pdf') return 'application/pdf';
  if (ext === 'json') return 'application/json';
  if (['md', 'txt', 'log', 'csv', 'xml', 'html', 'htm'].includes(ext)) return 'text/plain; charset=utf-8';
  return 'application/octet-stream';
}

// ---------------------------------------------------------------------------
// 低层 R2 操作
// ---------------------------------------------------------------------------
async function headObject(bucket, rel) {
  if (!rel) return null;
  try { return await bucket.head(rel); } catch { return null; }
}
export { headObject };

async function hasChildren(bucket, rel) {
  const prefix = rel ? rel + '/' : '';
  try {
    const r = await bucket.list({ prefix, limit: 1 });
    return r.objects.length > 0;
  } catch { return false; }
}

export async function dirExists(bucket, rel) {
  if (!rel) return true; // 根永远存在
  if (await headObject(bucket, rel + '/')) return true;
  return hasChildren(bucket, rel);
}

export async function getObject(bucket, rel, opts) {
  try { return await bucket.get(rel, opts); } catch { return null; }
}

// 列出某目录的直接子项
export async function listDir(bucket, rel) {
  const first = await listDirPage(bucket, rel, 1000);
  const dirs = [...first.dirs];
  const files = [...first.files];
  let cursor = first.cursor;
  while (cursor) {
    const page = await listDirPage(bucket, rel, 1000, cursor);
    dirs.push(...page.dirs);
    files.push(...page.files);
    cursor = page.cursor;
  }
  return { dirs, files };
}

// 分页列出目录直接子项，cursor 可直接传回下一次请求。
export async function listDirPage(bucket, rel, limit = 200, cursor) {
  const prefix = rel ? rel + '/' : '';
  const r = await bucket.list({ prefix, delimiter: '/', limit, cursor });
  const dirs = [];
  const files = [];
  for (const dp of r.delimitedPrefixes) {
    const name = dp.slice(prefix.length).replace(/\/+$/, '');
    if (name && !isHidden(name)) dirs.push(name);
  }
  for (const o of r.objects) {
    if (o.key === prefix) continue;
    const name = o.key.slice(prefix.length);
    if (!name || name.includes('/')) continue;
    if (isExcluded(name)) continue;
    files.push({ name, obj: o });
  }
  return { dirs, files, cursor: r.cursor || null };
}

// 确保某目录（及其所有祖先）存在"目录标记"对象，使空目录也可被浏览/发现
export async function ensureDir(bucket, rel) {
  const parts = splitPath(rel);
  let acc = '';
  for (const p of parts) {
    acc = acc ? acc + '/' + p : p;
    const marker = acc + '/';
    if (!(await headObject(bucket, marker))) await bucket.put(marker, new Uint8Array(0));
  }
}

// 写入对象，自动推断 content-type（图片显示依赖正确的 MIME）
export async function putObject(bucket, rel, body, opts = {}) {
  const ct = opts.contentType || mimeFromExt(rel);
  await bucket.put(rel, body, { contentType: ct });
}

// ---------------------------------------------------------------------------
// 公开标记（.public）
// ---------------------------------------------------------------------------
export async function dirIsPublicSelf(bucket, rel) {
  return !!(await headObject(bucket, (rel ? rel + '/' : '') + PUBLIC_MARKER));
}
export async function isPublic(bucket, rel) {
  const parts = splitPath(rel);
  let acc = '';
  const chain = [''];
  for (const p of parts) { acc = acc ? acc + '/' + p : p; chain.push(acc); }
  for (const c of chain) {
    if (await headObject(bucket, (c ? c + '/' : '') + PUBLIC_MARKER)) return true;
  }
  return false;
}
export async function setPublic(bucket, rel, make) {
  if (!rel) return false; // 根目录禁止设公开
  const marker = rel + '/' + PUBLIC_MARKER;
  if (make) await bucket.put(marker, new Uint8Array(0));
  else { const o = await headObject(bucket, marker); if (o) await bucket.delete(marker); }
  return make;
}

// ---------------------------------------------------------------------------
// 文本嗅探（决定文件是否可在编辑器打开）
// ---------------------------------------------------------------------------
export async function looksText(bucket, rel) {
  try {
    const head = await bucket.get(rel, { range: { offset: 0, length: 8192 } });
    if (!head) return false;
    const buf = new Uint8Array(await head.arrayBuffer());
    if (buf.length === 0) return true;
    if (buf.indexOf(0) !== -1) return false; // NUL ⇒ 二进制
    let nontext = 0;
    for (let i = 0; i < buf.length; i++) {
      const c = buf[i];
      if ((c < 0x09) || (c > 0x0d && c < 0x20) || c === 0x7f) nontext++;
    }
    return nontext / buf.length < 0.30;
  } catch { return false; }
}

// ---------------------------------------------------------------------------
// 构建文件 / 目录数据（形状与原 server.js 保持一致，前端无需改动）
// ---------------------------------------------------------------------------
async function buildFile(bucket, rel, obj, cfg) {
  if (!obj) return null;
  const basename = rel.split('/').pop();
  const ext = extOf(basename);
  const file = {
    basename, ext,
    fileperms: '0644',
    filetype: 'file',
    filesize: obj.size,
    is_readable: true,
    is_writeable: true,
    is_link: false,
    is_dir: false,
    mtime: Math.floor(obj.uploaded.getTime() / 1000),
    path: rel,
    url_path: '/api/image?path=' + encodeURIComponent(rel),
  };

  if (IMAGE_EXTS.has(ext) && ext !== 'svg') {
    file.mime = `image/${ext}`;
    file.icon = 'image';
    // 图片尺寸解析改为前端按需加载，避免打开目录时逐张读取 R2。
  } else if (VIDEO_EXTS.has(ext)) { file.mime = `video/${ext}`; file.icon = 'video'; }
  else if (AUDIO_EXTS.has(ext)) { file.mime = `audio/${ext}`; file.icon = 'audio'; }
  else if (DOC_EXTS.has(ext)) { file.mime = ext === 'pdf' ? 'application/pdf' : 'text/plain'; file.icon = 'doc'; }
  else { file.icon = 'file'; }

  // 仅按扩展名快速标记；打开编辑器时 /api/file 仍会执行真实文本检测。
  file.editable = obj.size <= MAX_EDIT_BYTES && EDITABLE_EXTS.has(ext);
  return file;
}

export async function buildDir(bucket, rel, withFiles, cfg) {
  const basename = rel ? rel.split('/').pop() : (cfg.ROOT_NAME || 'Filo');
  // 目录 mtime 不是图库基本功能，避免为目录标记额外执行 R2 head 请求。
  const marker = null;
  const dir = {
    basename,
    fileperms: '0755',
    filetype: 'dir',
    is_readable: true,
    is_writeable: true,
    is_link: false,
    is_dir: true,
    mime: 'directory',
    mtime: marker ? Math.floor(marker.uploaded.getTime() / 1000) : 0,
    path: rel,
    files_count: 0,
    dirsize: 0,
    images_count: 0,
    url_path: '/api/dir?path=' + encodeURIComponent(rel),
    public_self: cfg.AUTH_ENABLED ? await dirIsPublicSelf(bucket, rel) : false,
  };
  if (cfg.AUTH_ENABLED) dir.public = await isPublic(bucket, rel);

  const { dirs, files } = await listDir(bucket, rel);
  if (!withFiles) {
    dir.files_count = dirs.length + files.length;
    return dir;
  }

  const out = {};
  const dirObjs = await Promise.all(dirs.map((name) => {
    const childRel = rel ? rel + '/' + name : name;
    return buildDir(bucket, childRel, false, cfg);
  }));
  for (const f of dirObjs) {
    if (f) { out[f.basename] = f; dir.files_count++; }
  }
  const fileObjs = await Promise.all(
    files.map((f) => buildFile(
      bucket,
      rel ? rel + '/' + f.name : f.name,
      f.obj,
      cfg,
    ))
  );
  for (const f of fileObjs) {
    if (!f) continue;
    out[f.basename] = f;
    dir.files_count++;
    dir.dirsize += f.filesize || 0;
    if (f.icon === 'image') dir.images_count++;
  }
  const sorted = Object.values(out).sort((a, b) =>
    a.is_dir !== b.is_dir ? (a.is_dir ? -1 : 1)
      : a.basename.localeCompare(b.basename, undefined, { numeric: true, sensitivity: 'base' })
  );
  dir.files = {};
  for (const f of sorted) dir.files[f.basename] = f;
  return dir;
}

// 递归菜单树（深度受 MENU_MAX_DEPTH 限制）
export async function collectDirs(bucket, rel, depth, out, cfg) {
  if (depth > cfg.MENU_MAX_DEPTH) return;
  const { dirs } = await listDir(bucket, rel);
  const children = await Promise.all(dirs.map(async (name) => {
    const childRel = rel ? rel + '/' + name : name;
    const d = await buildDir(bucket, childRel, false, cfg);
    return d ? { d, childRel } : null;
  }));
  const subs = [];
  for (const item of children) {
    if (item) { out.push(item.d); subs.push(item.childRel); }
  }
  await Promise.all(subs.map((cr) => collectDirs(bucket, cr, depth + 1, out, cfg)));
}

// ---------------------------------------------------------------------------
// 写操作：删除 / 移动 / 复制 / 重命名 / 去重
// ---------------------------------------------------------------------------
export async function deleteItems(bucket, rels) {
  let removed = 0;
  for (const rel of rels) {
    if (!rel) continue;
    const marker = rel + '/';
    const isDir = (await headObject(bucket, marker)) || (await hasChildren(bucket, rel));
    if (isDir) {
      let cursor;
      do {
        const r = await bucket.list({ prefix: marker, cursor });
        for (const o of r.objects) { await bucket.delete(o.key); removed++; }
        cursor = r.cursor;
      } while (cursor);
    } else {
      const o = await headObject(bucket, rel);
      if (o) { await bucket.delete(rel); removed++; }
    }
  }
  return removed;
}

async function childExists(bucket, dest, name) {
  const key = dest ? dest + '/' + name : name;
  if (await headObject(bucket, key)) return true;
  if (await headObject(bucket, key + '/')) return true;
  return false;
}
export async function uniqueName(bucket, dest, base) {
  let candidate = base;
  let i = 1;
  while (await childExists(bucket, dest, candidate)) {
    const dot = base.lastIndexOf('.');
    candidate = dot > 0 ? base.slice(0, dot) + ` (${i})` + base.slice(dot) : `${base} (${i})`;
    i++;
  }
  return candidate;
}

async function copyObject(bucket, source, destination) {
  const obj = await bucket.get(source);
  if (!obj) throw new Error(`源对象不存在: ${source}`);
  const options = {};
  if (obj.httpMetadata) options.httpMetadata = obj.httpMetadata;
  if (obj.customMetadata) options.customMetadata = obj.customMetadata;
  await bucket.put(destination, obj.body, options);
}

export async function moveItems(bucket, items, dest, copy) {
  let moved = 0;
  for (const rel of items) {
    if (!rel) continue;
    const srcMarker = rel + '/';
    const isDir = (await headObject(bucket, srcMarker)) || (await hasChildren(bucket, rel));
    const base = rel.split('/').pop();
    const finalName = await uniqueName(bucket, dest, base);
    const finalRel = dest ? dest + '/' + finalName : finalName;

    if (isDir) {
      if (isDir && (rel === dest || (dest + '/').startsWith(rel + '/'))) continue; // 禁止移入自身或子目录
      const srcs = [];
      let cursor;
      do {
        const r = await bucket.list({ prefix: srcMarker, cursor });
        for (const o of r.objects) srcs.push(o.key);
        cursor = r.cursor;
      } while (cursor);
      for (const k of srcs) {
        const rest = k.slice(srcMarker.length);
        await copyObject(bucket, k, finalRel + '/' + rest);
      }
    } else {
      await copyObject(bucket, rel, finalRel);
    }

    if (!copy) {
      if (isDir) {
        let cursor;
        do {
          const r = await bucket.list({ prefix: srcMarker, cursor });
          for (const o of r.objects) await bucket.delete(o.key);
          cursor = r.cursor;
        } while (cursor);
      } else {
        await bucket.delete(rel);
      }
    }
    moved++;
  }
  return moved;
}

export async function renameItem(bucket, rel, newName) {
  const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
  const finalName = await uniqueName(bucket, parent, newName);
  const newRel = parent ? parent + '/' + finalName : finalName;
  const srcMarker = rel + '/';
  const isDir = (await headObject(bucket, srcMarker)) || (await hasChildren(bucket, rel));

  if (isDir) {
    const marker = await headObject(bucket, srcMarker);
    if (marker) await copyObject(bucket, srcMarker, newRel + '/');
    let cursor;
    do {
      const r = await bucket.list({ prefix: srcMarker, cursor });
      for (const o of r.objects) {
        if (o.key === srcMarker) continue;
        await copyObject(bucket, o.key, newRel + '/' + o.key.slice(srcMarker.length));
      }
      cursor = r.cursor;
    } while (cursor);
  } else {
    await copyObject(bucket, rel, newRel);
  }
  await deleteItems(bucket, [rel]);
  return newRel;
}

// ---------------------------------------------------------------------------
// 搜索（全桶扫描，文件名 + 目录名，限 400 条）
// ---------------------------------------------------------------------------
export async function search(bucket, q) {
  const results = [];
  const MAX = 400;
  const dirResults = new Map();
  let cursor;
  do {
    const r = await bucket.list({ cursor });
    for (const o of r.objects) {
      if (o.key.endsWith('/')) continue;
      if (isExcluded(o.key.split('/').pop())) continue;
      const parts = o.key.split('/');
      const name = parts.pop();
      const ext = extOf(name);
      const parent = parts.join('/');
      if (name.toLowerCase().includes(q)) {
        results.push({
          basename: name, path: o.key, is_dir: false,
          icon: catOf(ext), ext, thumbbable: IMAGE_EXTS.has(ext) && ext !== 'svg', parent,
        });
      }
      let acc = '';
      for (let i = 0; i < parts.length; i++) {
        acc = acc ? acc + '/' + parts[i] : parts[i];
        if (parts[i].toLowerCase().includes(q) && !dirResults.has(acc)) {
          dirResults.set(acc, {
            basename: parts[i], path: acc, is_dir: true, icon: 'folder',
            parent: i === 0 ? '' : parts.slice(0, i).join('/'),
          });
        }
      }
    }
    cursor = r.cursor;
  } while (cursor && results.length < MAX);
  for (const d of dirResults.values()) {
    if (results.length >= MAX) break;
    results.push(d);
  }
  return results;
}

// R2 无配额概念：返回已用字节 + 对象数；可设 QUOTA_BYTES 展示配额
export async function storageStats(bucket, quotaBytes) {
  let total = 0;
  let count = 0;
  let cursor;
  do {
    const r = await bucket.list({ cursor });
    for (const o of r.objects) {
      if (o.key.endsWith('/')) continue;
      total += o.size;
      count++;
    }
    cursor = r.cursor;
  } while (cursor);
  const quota = quotaBytes ? parseInt(quotaBytes, 10) : null;
  return {
    ok: true, total, used: total,
    free: quota ? Math.max(0, quota - total) : null, count, quota,
  };
}
