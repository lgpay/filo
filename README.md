# Filo

> 轻量级文件管理系统 · 目录树浏览 · 缩略图网格 · 预览灯箱 · 完整文件管理

[![License: MIT](https://img.shields.io/badge/License-MIT-blue.svg)](LICENSE)
[![Node](https://img.shields.io/badge/Node.js-18%2B-brightgreen.svg)](#快速开始)
[![Demo](https://img.shields.io/badge/demo-filo.gz3.agentos--app.net-orange.svg)](https://filo.gz3.agentos-app.net)

**Filo** 是一个用 **Node.js + 原生 JavaScript（无前端框架）** 构建的轻量级文件管理系统：支持目录树浏览、缩略图网格、预览灯箱，并内置上传 / 新建 / 移动 / 复制 / 重命名 / 删除 / ZIP 下载等完整的文件管理操作。

它最初受 [Files Gallery](https://files.gallery) 启发，但定位已从「图片相册」演进为通用的「文件管理」——既能管理图片（自动生成缩略图），也能管理任意类型的文件（以类型图标呈现）。

---

## ✨ 功能

- 📁 **侧边栏文件树**：递归目录骨架，点击文件夹展开 / 收起，展开后**懒加载该目录下的文件**作为叶子节点（文件夹图标在前、文件在后）；点击文件可直接预览（图片开灯箱）或打开，当前路径所在分支自动展开并高亮。
- 🖼️ **缩略图网格**：懒加载、文件夹优先、文件类型图标（图片自动缩略，其他文件用类型图标）。
- 🔍 **全盘递归搜索**：按文件名搜索整个文件树，结果跨目录展示并可直接跳转 / 预览。
- ⇅ **排序**：按名称 / 日期 / 大小 / 类型。
- ⊞ **布局切换**：默认网格 / 小图 / 大图 / 列表。
- 💡 **预览灯箱**：上一张 / 下一张、键盘导航（← → Esc F S Z）、全屏、下载、**幻灯片播放**、**滚轮缩放 / 拖拽平移**、**底部缩略图条**、相邻图片预加载。
- 📤 **文件管理**（登录后可用）：上传（含拖拽、**进度条**）、新建文件夹、**移动 / 复制**、重命名、删除、单文件下载、整目录 / 多选 ZIP 下载。
- 🔒 **密码鉴权**：设置 `GALLERY_PASSWORD` 后必须登录才能进入；登录后管理员可将某个目录设为**公开**，公开目录的文件可免登录直连分享。
- 🔗 **复制直连**：在公开目录中右键文件，选择「复制直连」即可把免登录的文件直链复制到剪贴板，方便分享给无需登录的人。
- ❓ **快捷键帮助**：按 `?` 查看快捷键。
- 🛡️ **路径安全**：禁止路径穿越。
- ⚡ **缩略图缓存**：图片缩略图生成后写入 `.cache/thumbs/`，避免重复处理。

> 文件管理默认开启。线上使用时应设置 `GALLERY_PASSWORD`；若完全不想公开文件直链，只需不将任何目录设为公开，或不设置 `GALLERY_PASSWORD`（此时所有人均可进入，等同一个完全开放的文件夹）。

---

## 🚀 快速开始

```bash
git clone https://github.com/lgpay/filo.git
cd filo
npm install
npm start
```

默认浏览 `./sample-files`。首次运行仓库里没有示例数据，可二选一：

- 生成一组占位示例图（推荐，便于体验全部功能）：

  ```bash
  node generate-samples.mjs
  ```

- 或直接指向你自己的目录：

  ```bash
  GALLERY_ROOT=/path/to/your/files npm start
  ```

打开 http://localhost:8080 即可浏览。

---

## 🖥️ 在线演示

线上演示（需密码登录，示例 `Nature` 目录已设为公开可直连）：

**https://filo.gz3.agentos-app.net**

> 演示站密码仅用于公开体验，部署时请务必通过 `GALLERY_PASSWORD` 设置你自己的密码。

---

## ⚙️ 环境变量

| 变量 | 默认值 | 说明 |
|------|--------|------|
| `GALLERY_ROOT` | `./sample-files` | 文件根目录 |
| `PORT` | `8080` | 服务端口 |
| `ALLOW_FILE_MANAGEMENT` | `true` | 是否启用上传 / 删除 / 重命名等管理功能 |
| `GALLERY_PASSWORD` | - | 设置后启用密码鉴权，必须登录才能进入 |
| `MAX_UPLOAD_MB` | `200` | 单次上传最大体积（MB） |
| `MENU_MAX_DEPTH` | `5` | 侧边栏目录树最大深度 |

指定自己的文件目录：

```bash
GALLERY_ROOT=/path/to/files PORT=3000 npm start
```

或修改 `package.json` 的 `start` 脚本。

---

## 🔐 密码鉴权

设置 `GALLERY_PASSWORD` 后：

- **未登录用户无法进入系统**（`/api/dirs`、`/api/dir`、`/api/search`、`/api/zip`、所有写操作均返回 401）。
- **公开目录例外**：登录后点击工具栏的 🌐 按钮，可将当前目录设为公开。该目录（及所有子目录）内的文件可通过 `/api/image?path=...` 和 `/api/thumb?path=...` 免登录直连访问，便于分享。
- 取消公开：再次点击 🌐 按钮即可移除当前目录的 `.public` 标记。
- 根目录不能设为公开。

```bash
GALLERY_PASSWORD=your-password npm start
```

---

## 📡 API

| 接口 | 说明 |
|------|------|
| `GET /api/config` | 前端配置 |
| `GET /api/dirs` | 目录树（扁平数组，前端自动构建树） |
| `GET /api/dir?path=Travel` | 单个目录及其文件列表 |
| `GET /api/search?q=cat` | 递归搜索文件树（返回文件与目录） |
| `GET /api/thumb?path=Travel/photo-1.png&size=320` | 缩略图（图片） |
| `GET /api/image?path=Travel/photo-1.png` | 原文件 |
| `GET /api/image?path=...&download=1` | 单文件下载 |
| `POST /api/upload?path=Travel` | 上传一个或多个文件 |
| `POST /api/mkdir` | 新建目录 `{ path, name }` |
| `POST /api/rename` | 重命名 `{ path, name }` |
| `POST /api/move` | 移动 / 复制 `{ items: [...], dest: "dir", copy: false }` |
| `POST /api/delete` | 删除 `{ paths: [...] }` |
| `GET /api/zip?path=Travel` | 打包下载某个目录 |
| `POST /api/zip` | 打包下载多选文件 `{ paths: [...] }` |
| `POST /api/public` | 设置 / 取消目录公开 `{ path: "Travel", public: true }` |

---

## 📁 项目结构

```
filo/
├── server.js            # Node.js 后端（目录扫描、缩略图、文件管理 API）
├── generate-samples.mjs # 生成示例文件（可选）
├── package.json
├── public/
│   ├── index.html
│   ├── css/style.css
│   └── js/app.js
└── sample-files/        # 示例文件（由 generate-samples.mjs 生成，已 gitignore）
```

> `sample-files/` 不在版本库中，运行 `node generate-samples.mjs` 生成占位示例图，或用 `GALLERY_ROOT` 指向你自己的目录。

---

## 📸 截图

截图存放于 `screenshots/` 目录（已在 `.gitignore` 中排除，不随仓库发布）。如需在 README 中展示，请补充图片后使用 `git add -f screenshots/` 强制加入版本库。

---

## 📄 许可证

[MIT](LICENSE) © 2026 Filo Contributors
