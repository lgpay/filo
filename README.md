# Filo · Cloudflare Workers + R2 版

Filo 是一个轻量图库 / 文件管理器。本目录是 **可部署到 Cloudflare Workers** 的移植版本：

- **存储**：[Cloudflare R2](https://www.cloudflare.com/products/r2/)（对象存储，S3 兼容）
- **运行**：Cloudflare Workers（纯 Web 标准 API，无服务器、无运维）
- **前端**：原生 HTML/CSS/JS，由 Workers Static Assets 托管
- **缩略图**：Cloudflare Image Resizing（边缘按需缩放）

前端逻辑与 Node.js 版完全一致，所有请求都打向同一套 `/api/*` 接口，因此浏览、灯箱、上传、编辑器、右键菜单、搜索、ZIP 下载等功能全部可用。

---

## 功能

- 目录浏览（网格视图 / 列表视图）、侧边栏目录树
- 图片灯箱（缩放、幻灯片、下载、键盘导航）
- 文件/文件夹上传（本地 + 远程 URL）、新建、重命名、删除、移动/复制
- 文本/代码文件**在线编辑器**（行号、Tab 缩进、Ctrl/⌘+S 保存）
- 全文**搜索**
- 多文件**打包下载（ZIP）**
- 目录**公开分享**：标记 `.public` 后，该目录及子项可被**免登录直链**访问
- 密码保护（可选）

---

## 架构

```
                 ┌──────────────────────────────────────────┐
   浏览器 ──────► │  Cloudflare Worker (src/worker.js)        │
                 │   /api/* → 业务逻辑（路由 + R2 读写）       │
                 │   其余    → Static Assets（public/ 前端）    │
                 └───────┬──────────────────┬────────────────┘
                         │                  │
                    ┌────▼─────┐      ┌──────▼────────┐
                    │  R2 桶    │      │ Image Resizing│（缩略图边缘缩放）
                    │ filo-files│      └───────────────┘
                    └──────────┘
```

**R2 目录树用 key 前缀模拟**：

| 概念 | R2 表示 |
|------|---------|
| 文件 | key = `相对路径`，如 `Travel/photo-1.jpg` |
| 目录 | 目录下对象的 key 共享前缀 `<dir>/`，并用零字节标记对象 `<dir>/` 让空目录可见 |
| 公开 | 零字节对象 `<dir>/.public`（祖先链任一含此标记即公开直链） |

---

## 前置条件

- 一个 Cloudflare 账号（免费版即可）
- 已安装 Node.js（≥ 18）与 [Wrangler](https://developers.cloudflare.com/workers/wrangler/install/)
- 登录：`wrangler login`

---

## 部署步骤

### 通过 Cloudflare Workers 连接 GitHub 部署（推荐）

1. 将本目录内容推送到 GitHub 仓库。
2. 在 Cloudflare Dashboard 打开 **Workers & Pages → Create application → Import a repository**，授权并选择该 GitHub 仓库。
3. 构建方式选择 **Workers**，部署配置使用仓库中的 `wrangler.toml`。
4. 首次部署前在 Cloudflare Worker 的 Settings → Variables and Secrets 中添加：
   - Secret：`ACCESS_PASSWORD`（建议设置，作为 Filo 访问和管理密码）
5. 在 Worker 的 Settings → Bindings 中确认 R2 绑定：`FILO_STORAGE` → `filo-media`。

以后推送到 GitHub 后，由 Cloudflare Workers Git 集成自动构建和部署，不需要 GitHub Actions。

密码属于 Cloudflare Worker Secret，不要写进 GitHub、`wrangler.toml` 或 `.dev.vars`。

### 发布前检查

```bash
npm install
npm run check
git status --short
```

仓库不应提交：

- `node_modules/`
- `.wrangler/`
- `.dev.vars`
- `.env`
- 任何密码、API Token 或 R2 凭据

### 1. 创建 R2 存储桶

```bash
wrangler r2 bucket create filo-files
```

### 2. （可选）设置访问密码

不设置 = 完全开放（任何人可浏览/下载）。设置后需要密码才能进入，管理操作也需要登录：

```bash
wrangler secret put ACCESS_PASSWORD
# 交互式输入密码
```

> 写操作开关由 `wrangler.toml` 的 `FILO_ALLOW_MANAGEMENT` 控制（默认开启）。

### 3. 部署

```bash
npm install
wrangler deploy
```

部署完成后会得到一个 `https://filo-media.<subdomain>.workers.dev` 地址。

### 4. 开启图片缩放（缩略图）

缩略图依赖 **Cloudflare Image Resizing**。在 Cloudflare 控制台
`Images → Image Resizing` 中开启该功能（各套餐均可开，按请求计费）。
若不开，缩略图会自动**降级为原图直出**（功能正常，只是不缩放、带宽略大）。

`wrangler.toml` 中 `FILO_IMAGE_RESIZE = "true"` 控制是否启用；本地 `wrangler dev` 无边缘缩放，会自动走降级。

### 5. （可选）绑定自定义域

在 Workers 设置里添加 Custom Domain / Route，例如 `files.example.com`。

---

## 本地开发

```bash
npm install

# 启动本地 Worker（含本地 R2 模拟 + 静态资源）
wrangler dev
# 打开 http://localhost:8787
```

### 灌入示例文件

方式 A — 通过 Worker 自身上传接口（推荐，本地也适用）：

```bash
# 启动 wrangler dev 后，用脚本登录并逐文件上传 ../filo/sample-files
node scripts/local-seed.mjs   # 见下方"测试"说明
```

方式 B — 直接写 R2 桶（需已部署到账号）：

```bash
FILO_STORAGE_BUCKET=filo-files FILO_SEED_SOURCE=/path/to/files bash scripts/seed.sh
```

---

## 配置项

通过 `wrangler.toml` 的 `[vars]`（非敏感）或 `wrangler secret put`（敏感）设置：

| 变量 | 默认 | 说明 |
|------|------|------|
| `ACCESS_PASSWORD` | 空 | Filo 访问密码；空 = 开放 |
| `ALLOW_MANAGEMENT` | `true` | 是否允许上传/删除/编辑等写操作 |
| `IMAGE_RESIZE` | `true` | 是否用 Cloudflare Image Resizing 生成缩略图 |
| `THUMB_SIZE` | `320` | 缩略图尺寸 |
| `THUMB_RETINA` | `480` | 高清缩略图尺寸 |
| `MENU_MAX_DEPTH` | `5` | 侧边栏目录树最大递归深度 |
| `ROOT_NAME` | `Filo` | 根目录显示名 |
| `MAX_UPLOAD_MB` | `100` | 单文件上传大小上限 |
| `QUOTA_BYTES` | 空 | 显示的存储配额 |

本地覆盖变量可用 `.dev.vars` 文件（已被 `.gitignore` 忽略，**切勿提交**）：

```
ACCESS_PASSWORD=请使用 Cloudflare Worker Secret 设置，不要写入文件
ALLOW_MANAGEMENT=true
IMAGE_RESIZE=false
```

---

## 与 Node.js 版（/workspace/filo）的差异

| 项 | Node 版 | Workers + R2 版 |
|----|---------|-----------------|
| 存储 | 本地文件系统 | Cloudflare R2 |
| 缩略图 | sharp 本地生成 + 磁盘缓存 | Cloudflare Image Resizing 边缘缩放（带原图降级） |
| 前端更新 | `index.html` 缓存内存，需重启 | 每次 `wrangler deploy` 即生效，无需重启 |
| 目录 | 真实目录 | R2 前缀 + 零字节标记对象（对用户透明） |
| 存储统计 | `statfs` 实时容量 | R2 已用字节 + 对象数（可选配额） |
| ZIP | archiver 流式 | client-zip 流式打包 |
| 部署 | 自有服务器 | `wrangler deploy`（全球边缘） |

---

## 安全说明

- **公开分享**：标记 `.public` 的目录及其子项可被**任何人免登录访问**（直链形如 `https://<你的域名>/api/image?path=...`）。请勿在公开目录放置敏感文件。
- **远程上传（URL 抓取）**：Workers 无本地 DNS 接口，无法像 Node 版那样做内网 IP 阻断。代码已限制仅 `http/https`、限制大小与超时，但在多租户环境下仍建议仅在可信场景开启 `FILO_ALLOW_MANAGEMENT`。
- **密码**：使用 HMAC-SHA256 令牌 + HttpOnly Cookie，常数时间比较防时序攻击。密码通过 `wrangler secret` 注入，不落入代码仓库。
