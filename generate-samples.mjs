// Generates a set of demo image files (incl. nested folders) so Filo works out of the box.
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUT = path.join(__dirname, 'sample-files');
fs.mkdirSync(OUT, { recursive: true });

const palettes = [
  ['#ff6b6b', '#ffd93d'], ['#6bcB77', '#4d96ff'], ['#c77dff', '#ff8fab'],
  ['#00b4d8', '#90e0ef'], ['#f72585', '#7209b7'], ['#fb8500', '#ffb703'],
  ['#2a9d8f', '#e9c46a'], ['#e63946', '#a8dadc'],
];

function svgLabel(w, h, text, c1, c2) {
  return Buffer.from(`
  <svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <defs><linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0%" stop-color="${c1}"/><stop offset="100%" stop-color="${c2}"/>
    </linearGradient></defs>
    <rect width="100%" height="100%" fill="url(#g)"/>
    <text x="50%" y="50%" font-family="sans-serif" font-size="${Math.round(h/8)}"
      fill="white" font-weight="700" text-anchor="middle" dominant-baseline="middle"
      style="text-shadow:0 2px 8px rgba(0,0,0,.35)">${text}</text>
  </svg>`);
}

const sizes = [
  [1600, 1067], [1200, 1600], [1920, 1080], [800, 800],
  [1500, 1000], [1000, 1500], [1400, 933], [1280, 720],
];

async function make(name, sub, size, pi) {
  const [w, h] = size;
  const [c1, c2] = palettes[pi % palettes.length];
  const dir = sub ? path.join(OUT, sub) : OUT;
  fs.mkdirSync(dir, { recursive: true });
  await sharp(svgLabel(w, h, name.replace(/\.\w+$/, ''), c1, c2))
    .png()
    .toFile(path.join(dir, name));
}

const tasks = [];
// root images
const rootNames = ['sunrise', 'mountain', 'ocean', 'forest', 'city', 'desert', 'lake', 'flower'];
rootNames.forEach((n, i) => tasks.push(make(`${n}.png`, null, sizes[i % sizes.length], i)));

// nested folders
const folders = ['Travel', 'Nature', 'Abstract'];
folders.forEach((f, fi) => {
  for (let i = 0; i < 6; i++) {
    tasks.push(make(`photo-${i + 1}.png`, f, sizes[(i + fi) % sizes.length], i + fi));
  }
});

await Promise.all(tasks);
console.log('✓ Sample files generated in', OUT);
