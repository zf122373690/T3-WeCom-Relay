# 飞牛 fnOS 部署指南（最快路径）

fnOS 为 Debian 底 + 自带 Docker，全程 SSH 约 5 分钟。

## 第 0 步：先做两个前提检查（1 分钟，很重要）

```bash
curl -4 ip.sb        # 查看本机出口公网 IP
```

- **出站**：上面查到的 IP 必须能加入企业微信「企业可信 IP」白名单，且**保持不变**。家宽动态 IP 或无公网 IP（CGNAT）会导致 errcode 60020 反复出现。
- **入站**：企业微信回调要能访问 `https://你的域名/wecom/callback`，需要公网 IP + 端口转发（443），或内网穿透。
- 注意：内网穿透只解决「回调进得来」；出站调 API 的源 IP 仍是 NAS 的上网出口 IP，穿透帮不了出站。

> **家宽 / 内网 frp 部署必看（解决 60020 的关键）**：若飞牛是家宽动态 IP、或经 frp 暴露，出站 API 看到的源 IP 会随拨号变化 → 60020 反复。此时不要去白名单里加飞牛的 IP，而是让出站请求从「固定公网 IP 的服务器」（如 frp VPS）发出：
> 1. 在 frp VPS 上跑本仓库的 `proxy-exit.js`（仅放行 `qyapi.weixin.qq.com` 的正向代理）；
> 2. 飞牛这边 `.env` 设 `WECOM_API_PROXY=http://<vps-ip>:<port>`；
> 3. 把 **frp VPS 的公网 IP** 加入企微「企业可信 IP」。
> 详见下方「第 2.5 步：出站代理（家宽 / frp 部署）」。

## 第 1 步：SSH 安装

fnOS 控制面板开启 SSH（终端机/SSH），然后电脑上：

```bash
ssh 用户名@飞牛IP

# NAS 上执行：
sudo apt update && sudo apt install -y git        # fnOS 是 Debian 底
mkdir -p /vol1/docker && cd /vol1/docker
git clone https://github.com/zf122373690/T3-WeCom-Relay.git wecom-relay
# GitHub 直连慢时可用加速前缀（前缀失效就换一个）：
# git clone https://gh-proxy.com/https://github.com/zf122373690/T3-WeCom-Relay.git wecom-relay

cd wecom-relay
cp .env.example .env
nano .env        # 填入 WECOM_SECRET / CONTACTS_SECRET / ADMIN_PASSWORD 等
sudo docker compose up -d --build
```

## 第 2 步：验证

```bash
curl -I http://127.0.0.1:18081/       # 返回 200 即启动成功
sudo docker compose logs -f           # 看运行日志
```

之后在 fnOS 桌面「Docker」应用里即可图形化看到并管理该容器（重启策略已是 `unless-stopped`，NAS 重启自动拉起）。

> 端口默认绑定 `127.0.0.1:18081`（仅本机反代可访问）。如需局域网直接访问，把 `docker-compose.yml` 里 ports 改成 `"18081:18081"`，但**不要**直接暴露公网。

## 第 2.5 步：出站代理（家宽 / frp 部署必做）

**目标**：让企微 API 出站请求从 frp VPS 的固定公网 IP 发出。

**(a) 在 frp VPS 上跑代理**（与飞牛是两台机器）：

```bash
# 在 frp VPS 上
git clone https://github.com/zf122373690/T3-WeCom-Relay.git relay-proxy && cd relay-proxy
PROXY_PORT=8899 nohup node proxy-exit.js > proxy.log 2>&1 &
# 或用 pm2：npm i -g pm2 && pm2 start proxy-exit.js --name wecom-proxy
```

- `proxy-exit.js` 只放行 `qyapi.weixin.qq.com` 的 CONNECT，相对安全；若仍担心，用 VPS 防火墙把 8899 仅对飞牛出口 IP 开放。
- VPS 安全组 / 防火墙需放行 `8899`（或你选的端口）。

**(b) 飞牛 `.env` 里加一行**（容器内会自动读取）：

```
WECOM_API_PROXY=http://<frp-vps-ip>:8899
```

改完重启容器：`sudo docker compose up -d`（env_file 变更需重建读取；直接 `restart` 不够，用 `up -d` 会按新 .env 重启）。

**(c) 把 frp VPS 的公网 IP 加入企微「企业可信 IP」**（不是飞牛的 IP）。

## 第 3 步：域名与 HTTPS（回调必需）

反代工具任选其一（都跑在飞牛上，反代到 `127.0.0.1:18081`）：

- **Lucky**（推荐，fnOS Docker 里装，中文界面，自动申请 HTTPS 证书）
- **nginx** 参考配置：

```nginx
server {
    listen 443 ssl;
    server_name wx.dkb.cc.cd;
    ssl_certificate     /path/fullchain.pem;
    ssl_certificate_key /path/privkey.pem;
    location / {
        proxy_pass http://127.0.0.1:18081;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

`.env` 里设 `TRUST_PROXY=1`。

## 第 4 步：企业微信侧配置

1. 把**出站代理所在服务器（frp VPS）的公网 IP** 加入：管理后台 → 应用管理 → 你的自建应用 → **企业可信 IP**。
   （若未使用出站代理、直接由飞牛出站，则加飞牛的出口 IP；但家宽动态 IP 会反复 60020，不推荐。）
2. 回调 URL 填：`https://wx.dkb.cc.cd/wecom/callback`。
3. 域名验证：`WW_verify_*.txt` 已在仓库根目录，反代生效后可直接访问。

## 日常更新（拉取新代码并重建）

代码有更新时，在飞牛上：

```bash
cd /vol1/docker/wecom-relay
git pull
sudo docker compose up -d --build      # 重新构建镜像并重启，读取最新 .env
```

> 若只改了 `.env`，无需 `git pull`，直接 `sudo docker compose up -d` 即可（env_file 变更会触发重启并加载新变量）。

## 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| errcode 60020 | 出站源 IP 不在白名单。家宽/动态 IP 请用「第 2.5 步」出站代理；固定 IP 服务器直接把该 IP 加白名单 |
| 提醒按钮报「提醒发送失败」 | 已修复为显示具体 errcode；按 errcode 处理（60020=IP 白名单，40014/42001=Secret/Token） |
| 回调收不到 | 家宽无公网 IP（CGNAT），端口转发不可用 → 内网穿透解决入站，但出站问题依旧需代理 |
| `docker compose` 不存在 | 旧版 Docker 无 compose 插件 → `sudo apt install docker-compose-plugin` 或升级 fnOS |
