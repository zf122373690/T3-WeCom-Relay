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

### 1. 安装与登录 Wrangler

```bash
npm install        # 安装 wrangler (devDependency)
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
