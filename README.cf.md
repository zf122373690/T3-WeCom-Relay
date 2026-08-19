# wecom-relay · Cloudflare Workers 部署指南

本目录已移植为 **Cloudflare Workers** 版本，可直接部署到 Cloudflare，无需 Docker / VPS。

## 架构变化（与原 Node/Docker 版对照）

| 原 Node 版能力 | Workers 替代 |
|---|---|
| `http.createServer` | Worker `fetch` 入口 |
| `fs` 读写状态 / 日志文件 | Workers **KV** 键值存储 |
| Node `crypto`（AES-256-CBC / SHA-1 / GCM / scrypt） | Web Crypto API（算法 100% 兼容企业微信） |
| 内存 token / 管理员会话 | KV 缓存 + HMAC-SHA256 签名 Cookie（无状态） |
| `setInterval` 定时刷新二维码 | Cron Trigger（每 6 小时） |
| 依赖 `@wecom/crypto` / `fast-xml-parser` | 内置 Web Crypto + 轻量 XML 解析，**零 npm 运行时依赖** |

> 所有对外 API 路径、HTML 元素 ID、企业微信回调协议均与原版兼容，前端 `index.html` / `admin.html` 无需改动。

## 关键文件

- `src/worker.js` — Workers 入口（替代 `server.js` + `wxplugin.js`）
- `wrangler.toml` — 部署配置（静态资源 / KV / Cron / 非敏感变量）
- `.assetsignore` — 排除 `node_modules`、`src`、配置等，**解决原 144MB workerd 上传超限报错**
- `.dev.vars.example` — 本地开发变量模板
- `README.cf.md` — 本文件

## 部署步骤

### 0. Cloudflare 控制台构建设置（Git 推送自动部署必看）

在 Cloudflare Dashboard → Workers & Pages → 你的项目 → **Settings → Build** 中：

- **Build command（构建命令）**：填 `npx wrangler deploy`
  - 不要写 `npm ci && wrangler deploy` 之类的组合。`npx wrangler` 会在构建时按需拉取 wrangler，
    且不会把 144MB 的 `workerd` 二进制写进静态资源目录（避免 25MB 上传限制）。
- **Install command（安装命令）**：保持默认即可。
  - 本仓库 `package.json` 仅含 `@wecom/crypto` / `fast-xml-parser` 两个轻量运行时依赖（供 Node/Docker 版使用），
    `npm ci` 现在只会装这 2 个小包，**不会再触发 wrangler postinstall / `--allow-scripts` 报错**。
- **部署后**首次推送即触发构建，日志里应看到 `npx wrangler deploy` 成功上传 Worker。

> 如果之前构建因 `npm ci` 失败，改完 `package.json` 推送后重新触发一次构建即可。

### 1. 安装与登录 Wrangler

```bash
npm install        # 安装 Node 版运行时依赖（@wecom/crypto / fast-xml-parser），wrangler 通过 npx 调用
npx wrangler login # 浏览器授权 Cloudflare 账号
```

### 2. 创建 KV 命名空间

```bash
npx wrangler kv namespace create WECOM_RELAY_KV
# 输出形如：
#   { "binding": "WECOM_RELAY_KV", "id": "a1b2c3d4..." }
```

把返回的 `id` 填入 `wrangler.toml` 中的：

```toml
[[kv_namespaces]]
binding = "WECOM_RELAY_KV"
id = "REPLACE_WITH_YOUR_KV_NAMESPACE_ID"   # ← 替换为上一步的 id
```

### 3. 填写非敏感配置

编辑 `wrangler.toml` 的 `[vars]` 段：

```toml
[vars]
WECOM_CORP_ID = "ww你的企业id"
WECOM_AGENT_ID = "1000001"          # 应用 AgentId（数值字符串）
WECOM_QR_ADMIN_USERID = "zhengfei"  # 收二维码过期提醒的管理员 userid
```

### 4. 设置敏感配置（Secret，不入库）

```bash
npx wrangler secret put WECOM_SECRET
npx wrangler secret put WECOM_CONTACTS_SECRET
npx wrangler secret put WECOM_CALLBACK_TOKEN
npx wrangler secret put WECOM_CALLBACK_AES_KEY   # 43 字符 EncodingAESKey
npx wrangler secret put ADMIN_PASSWORD          # 管理后台登录密码（≥8 位）
```

### 5. 本地预览

```bash
cp .dev.vars.example .dev.vars   # 填入真实值
npx wrangler dev                 # 默认 http://localhost:8787
```

### 6. 部署生产

```bash
npx wrangler deploy
# 输出你的 workers.dev 地址，例如 https://wecom-relay.<subdomain>.workers.dev
```

### 7. 验证

```bash
curl https://<你的地址>/health
# {"ok":true,"configured":true,"contactsEditConfigured":true}

# 首页
open https://<你的地址>/
# 管理后台
open https://<你的地址>/admin
```

### 8. 配置企业微信回调 URL

在企业微信管理后台「应用 → 接收消息 → 设置 API 接收」中填写：

- URL：`https://<你的地址>/wecom/callback`
- Token / EncodingAESKey：与第 4 步 secret 一致

保存时企业微信会发 GET 校验，Worker 自动解密 `echostr` 返回明文即通过。

## 绕过「企业可信 IP」白名单（反代方案）

企业微信自建应用的「企业可信 IP」会校验**调用方（你的服务器）出口 IP**。Cloudflare Workers 出口 IP 动态共享、无法固定，因此 `message/send`、`user/get` 等 API 会返回 `errcode: 60020`（访问 IP 不在白名单）。即使把白名单清空仍不生效时，需用**固定 IP 反代**：

**原理**：Worker 把发往 `qyapi.weixin.qq.com` 的请求改发到你自己的一台固定 IP 服务器（反代域名），由该服务器转发到企微。把该服务器 IP 加入企微「企业可信 IP」白名单即可。

> 注意：仅 `qyapi.weixin.qq.com` 的 API 调用受白名单限制；管理后台扫码登录那批 `wework_admin` 网页会话请求不受限，无需反代。

### A. 搭建反代（固定 IP 服务器，如 1 核小机 / 现有 VPS）

参考仓库根目录 `nginx-proxy.example.conf`：

```bash
# 1. 复制并修改：server_name / 证书路径 / token
cp nginx-proxy.example.conf /etc/nginx/conf.d/wecom-proxy.conf
vim /etc/nginx/conf.d/wecom-proxy.conf     # 把 REPLACE_WITH_YOUR_PROXY_TOKEN 改成随机长串
nginx -t && systemctl reload nginx
# 2. 把反代域名（如 proxy.yourdomain.com）解析到该服务器
# 3. 将该服务器公网 IP 加入企微 → 自建应用 → 企业可信 IP
```

### B. 在 Cloudflare 配置反代

Dashboard → 你的 Worker → 设置 → 变量和密钥（或 `wrangler.toml` 的 `[vars]`）：

- `PROXY_URL` = `https://proxy.yourdomain.com`（你的反代域名，须 https）
- `PROXY_TOKEN` = 与 nginx 里一致的随机长串（反代鉴权，防止被他人滥用）

设置后推一次提交触发重建，Worker 即改走反代。`PROXY_URL` 留空则保持直连。

### C. 验证

重建成功后，`/health` 不受影响；之前报 `60020` / `查询失败，错误码 -2` 的提醒与收消息功能应恢复正常。

## Cron 说明

`wrangler.toml` 已配置 `crons = ["0 */6 * * *"]`（每 6 小时）。触发逻辑：
仅当管理员此前已扫码登录（KV 中存在 `wwrtx.sid`）且二维码超过 6 天未更新时，自动调用企业微信刷新关注二维码。

## 已知限制

1. **KV 最终一致性**：新写入的二维码 / 登录态在边缘节点可能有秒级延迟，不影响功能。
2. **手机验证码登录**：若企业微信要求短信验证码完成管理员登录，Worker 无法自动处理，会返回明确提示，需人工在管理后台扫码。
3. **无本地文件日志**：日志输出到 Workers 可观测性（`wrangler tail` 或 Dashboard → Logs）。
4. **免费额度**：KV 写入 / 读取计入 Workers 请求与 KV 操作额度，低频自用场景完全够用。

## 与原版并存的说明

`package.json` 的 `main` 仍指向 `server.js`（保留 Node 版运行能力），但 Workers 部署以 `wrangler.toml` 的 `main = "src/worker.js"` 为准，二者互不干扰。

## 故障排查

### 在 Dashboard 加完 Secret 后没生效 / 重部署报 `internal_error`
Cloudflare 对「仅变更 Secret 的单独重部署」偶尔会返回 `internal_error`（平台已知坑），**不是代码问题**。
最稳妥的修复是触发一次干净的整包重建：向仓库 push 任意提交，GitHub → Cloudflare 流水线会重新 `npx wrangler deploy`。
Dashboard 里设的 Secret 是**账号级配置**，重建后会自动重新挂上，不会丢失。

### 想看运行时真实报错（替代笼统的 `internal_error`）
1. Dashboard → 你的 Worker → **Logs（实时日志）**：访问 `/health` 或首页时，worker 的 `console.error` 会把真实异常打印在这里。
2. 或本地 `npx wrangler tail` 实时看日志。
3. 部署失败的话，去 **Deployments** 里点开那条构建记录看完整构建日志。

### 验证清单
- `/health` 返回 `configured: true` 即表示 corp id / secret / callback 三件套均已就位。
- 若 `configured: false`，按返回的字段逐项补齐对应 Secret。
- 管理后台 `/admin` 登录需要 `ADMIN_PASSWORD` 这个 Secret（≥8 位）已设置。
