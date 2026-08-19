# 飞牛 fnOS 部署指南（最快路径）

fnOS 为 Debian 底 + 自带 Docker，全程 SSH 约 5 分钟。

## 第 0 步：先做两个前提检查（1 分钟，很重要）

```bash
curl -4 ip.sb        # 查看本机出口公网 IP
```

- **出站**：上面查到的 IP 必须能加入企业微信「企业可信 IP」白名单，且**保持不变**。家宽动态 IP 或无公网 IP（CGNAT）会导致 errcode 60020 反复出现。
- **入站**：企业微信回调要能访问 `https://你的域名/wecom/callback`，需要公网 IP + 端口转发（443），或内网穿透。
- 注意：内网穿透只解决「回调进得来」；出站调 API 的源 IP 仍是 NAS 的上网出口 IP，穿透帮不了出站。

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

1. 把第 0 步查到的出口 IP 加入：管理后台 → 应用管理 → 你的自建应用 → **企业可信 IP**。
2. 回调 URL 填：`https://wx.dkb.cc.cd/wecom/callback`。
3. 域名验证：`WW_verify_*.txt` 已在仓库根目录，反代生效后可直接访问。

## 常见坑

| 现象 | 原因 / 处理 |
|---|---|
| errcode 60020 | 出口 IP 不在白名单，或家宽 IP 变了 → 需固定 IP，否则回退到固定 IP 服务器部署 |
| 回调收不到 | 家宽无公网 IP（CGNAT），端口转发不可用 → 内网穿透解决入站，但出站问题依旧 |
| `docker compose` 不存在 | 旧版 Docker 无 compose 插件 → `sudo apt install docker-compose-plugin` 或升级 fnOS |
