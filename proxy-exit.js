// proxy-exit.js — 正向 HTTP CONNECT 代理，跑在「拥有固定公网 IP 的服务器」（如 frp VPS）上。
//
// 用途：内网 / 家宽 / frp 部署的 relay 直接调用企微 API 时，源 IP 是内网机器出口（家宽动态 IP），
// 会被企微拒（errcode 60020）。把本代理跑在固定公网 IP 的 VPS 上，relay 设
//   WECOM_API_PROXY=http://<vps-ip>:<port>
// 后，所有企微 API 调用经本 VPS 出口发出，企微看到的源 IP 即变为该 VPS 固定 IP，加入白名单即可。
//
// 安全：仅放行 qyapi.weixin.qq.com 的 CONNECT，避免被当作开放代理滥用。
// 运行：PROXY_PORT=8899 node proxy-exit.js   （建议用 pm2 / systemd / nohup 守护）

'use strict';

const http = require('http');
const net = require('net');

const PORT = Number.parseInt(process.env.PROXY_PORT || '8899', 10);
const ALLOWED_HOST = 'qyapi.weixin.qq.com';

const server = http.createServer((req, res) => {
  if (req.method !== 'CONNECT') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Only CONNECT supported');
  }
  const [host, portStr] = req.url.split(':');
  if (host !== ALLOWED_HOST) {
    console.warn('[proxy] blocked non-wecom host:', req.url);
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden: only qyapi.weixin.qq.com allowed');
  }
  const port = Number.parseInt(portStr || '443', 10);
  const upstream = net.connect(port, host, () => {
    res.writeHead(200);
    req.socket.pipe(upstream);
    upstream.pipe(req.socket);
  });
  upstream.on('error', () => req.socket.destroy());
  req.socket.on('error', () => upstream.destroy());
  upstream.on('close', () => req.socket.destroyed || req.socket.destroy());
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`[proxy] listening on 0.0.0.0:${PORT}, forwarding only to ${ALLOWED_HOST}`);
});
