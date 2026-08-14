// src/img.js — 图片尺寸解析（头部字节，免依赖）+ 缩略图 cf 选项生成。

// 从图片头部字节解析宽高（PNG / JPEG / GIF / WebP / BMP / ICO）。
// buf 为 ArrayBuffer 或 Uint8Array。解析失败返回 null。
export function imageDimensions(buf) {
  const v = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  if (v.length < 12) return null;

  // PNG
  if (v[0] === 0x89 && v[1] === 0x50 && v[2] === 0x4e && v[3] === 0x47) {
    const w = (v[16] << 24) | (v[17] << 16) | (v[18] << 8) | v[19];
    const h = (v[20] << 24) | (v[21] << 16) | (v[22] << 8) | v[23];
    return { width: w, height: h };
  }
  // GIF
  if (v[0] === 0x47 && v[1] === 0x49 && v[2] === 0x46) {
    return { width: v[6] | (v[7] << 8), height: v[8] | (v[9] << 8) };
  }
  // WebP (RIFF....WEBP)
  if (v[0] === 0x52 && v[1] === 0x49 && v[2] === 0x46 && v[3] === 0x46 &&
      v[8] === 0x57 && v[9] === 0x45 && v[10] === 0x42 && v[11] === 0x50) {
    const fmt = String.fromCharCode(v[12], v[13], v[14], v[15]);
    if (fmt === 'VP8X' && v.length >= 30) {
      const w = 1 + ((v[24] & 0x3f) | (v[25] << 6) | (v[26] << 14));
      const h = 1 + ((v[27] & 0x3f) | (v[28] << 6) | (v[29] << 14));
      return { width: w, height: h };
    }
    if ((fmt === 'VP8 ' || fmt === 'VP8L') && v.length >= 26) {
      const w = (v[26] | (v[27] << 8)) & 0x3fff;
      const h = (v[28] | (v[29] << 8)) & 0x3fff;
      return { width: w, height: h };
    }
    return null;
  }
  // JPEG
  if (v[0] === 0xff && v[1] === 0xd8) {
    let off = 2;
    while (off < v.length - 9) {
      if (v[off] !== 0xff) break;
      const marker = v[off + 1];
      if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) {
        const h = (v[off + 5] << 8) | v[off + 6];
        const w = (v[off + 7] << 8) | v[off + 8];
        return { width: w, height: h };
      }
      const segLen = (v[off + 2] << 8) | v[off + 3];
      off += 2 + segLen;
    }
    return null;
  }
  // BMP
  if (v[0] === 0x42 && v[1] === 0x4d && v.length >= 26) {
    const w = v[18] | (v[19] << 8) | (v[20] << 16) | (v[21] << 24);
    const h = v[22] | (v[23] << 8) | (v[24] << 16) | (v[25] << 24);
    return { width: w, height: Math.abs(h) };
  }
  // ICO
  if (v[0] === 0x00 && v[1] === 0x00 && v[2] === 0x01 && v[3] === 0x00 && v.length >= 10) {
    const w = v[6] || 256;
    const h = v[7] || 256;
    return { width: w, height: h };
  }
  return null;
}

// 触发 Cloudflare 边缘图片缩放的 cf 选项（配合 fetch 使用）。
export function imageCfOptions(size) {
  return {
    cf: {
      image: {
        width: size,
        height: size,
        fit: 'scale-down',
      },
    },
  };
}
