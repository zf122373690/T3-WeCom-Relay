'use strict';

const http = require('http');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { decrypt, encrypt, getSignature } = require('@wecom/crypto');
const { XMLParser } = require('fast-xml-parser');
const { WxPluginManager } = require('./wxplugin');

const ROOT = __dirname;
const PORT = Number.parseInt(process.env.PORT || '18081', 10);
const CORP_ID = String(process.env.WECOM_CORP_ID || '').trim();
const APP_SECRET = String(process.env.WECOM_SECRET || '').trim();
const AGENT_ID = Number.parseInt(process.env.WECOM_AGENT_ID || '0', 10);
const CONTACTS_SECRET = String(process.env.WECOM_CONTACTS_SECRET || '').trim();
const QR_ADMIN_USERID = String(process.env.WECOM_QR_ADMIN_USERID || 'zhengfei').trim();
const CALLBACK_TOKEN = String(process.env.WECOM_CALLBACK_TOKEN || '').trim();
const CALLBACK_AES_KEY = String(process.env.WECOM_CALLBACK_AES_KEY || '').trim();
const ADMIN_PASSWORD = String(process.env.ADMIN_PASSWORD || '');
const TRUST_PROXY = process.env.TRUST_PROXY === '1';
const INDEX_FILE = path.join(ROOT, 'index.html');
const ADMIN_FILE = path.join(ROOT, 'admin.html');
const WECHAT_TUTORIAL_IMAGE = path.join(ROOT, 'assets', 'wechat-my-enterprise.png');
const LOG_DIR = path.join(ROOT, 'logs');
const DATA_DIR = path.join(ROOT, 'data');
const xmlParser = new XMLParser({ processEntities: false, trimValues: true });

let appAccessToken = { value: '', expiresAt: 0 };
let contactsAccessToken = { value: '', expiresAt: 0 };
const pendingUseridChanges = new Map();
const USERID_CHANGE_TTL_MS = 5 * 60 * 1000;
const adminSessions = new Map();
const adminLoginAttempts = new Map();
const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const QR_REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;
let wxPlugin = null;
let lastQrReminderAt = 0;

function sendJson(res, status, body) {
  const data = Buffer.from(JSON.stringify(body));
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Content-Length': data.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
  res.end(data);
}

function configured() {
  return /^ww[0-9a-z]+$/i.test(CORP_ID) && APP_SECRET.length > 0 && CALLBACK_TOKEN.length > 0 && CALLBACK_AES_KEY.length === 43;
}

function appApiConfigured() {
  return /^ww[0-9a-z]+$/i.test(CORP_ID) && APP_SECRET.length > 0;
}

function contactsEditConfigured() {
  return CONTACTS_SECRET.length > 0;
}

function adminConfigured() {
  return ADMIN_PASSWORD.length >= 8;
}

function parseCookies(req) {
  return Object.fromEntries(String(req.headers.cookie || '').split(';').map(item => {
    const offset = item.indexOf('=');
    return offset < 0 ? ['', ''] : [item.slice(0, offset).trim(), decodeURIComponent(item.slice(offset + 1))];
  }).filter(([name]) => name));
}

function adminSession(req) {
  const token = parseCookies(req).t3_admin || '';
  const session = adminSessions.get(token);
  if (!session || session.expiresAt < Date.now()) {
    if (token) adminSessions.delete(token);
    return null;
  }
  return session;
}

function requireAdmin(req) {
  if (!adminSession(req)) throw Object.assign(new Error('admin_auth_required'), { status: 401 });
}

function requestIp(req) {
  if (TRUST_PROXY) return String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || req.socket.remoteAddress || '';
  return req.socket.remoteAddress || '';
}

function sessionCookie(req, token, maxAge) {
  const forwardedHttps = TRUST_PROXY && String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim() === 'https';
  const secure = req.socket.encrypted || forwardedHttps ? '; Secure' : '';
  return `t3_admin=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${maxAge}${secure}`;
}

function adminLoginAllowed(ip) {
  const now = Date.now();
  const attempts = (adminLoginAttempts.get(ip) || []).filter(at => now - at < 15 * 60 * 1000);
  adminLoginAttempts.set(ip, attempts);
  return attempts.length < 5;
}

function recordAdminLoginFailure(ip) {
  const attempts = adminLoginAttempts.get(ip) || [];
  attempts.push(Date.now());
  adminLoginAttempts.set(ip, attempts);
}

function validAdminPassword(value) {
  const left = Buffer.from(String(value || ''), 'utf8');
  const right = Buffer.from(ADMIN_PASSWORD, 'utf8');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function safeEqual(left, right) {
  const a = Buffer.from(String(left || '')), b = Buffer.from(String(right || ''));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

async function readBody(req) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > 16384) throw Object.assign(new Error('payload_too_large'), { status: 413 });
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

async function writeLog(result, detail = '') {
  const now = new Date();
  const date = now.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' });
  const time = now.toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' });
  await fsp.appendFile(path.join(LOG_DIR, `callback_${date}.log`), `[${time}] ${result}${detail ? ` ${detail}` : ''}\n`, 'utf8').catch(() => {});
}

async function getToken(secret, cacheName, force = false) {
  const cache = cacheName === 'contacts' ? contactsAccessToken : appAccessToken;
  if (!force && cache.value && Date.now() < cache.expiresAt) return cache.value;
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  endpoint.searchParams.set('corpid', CORP_ID);
  endpoint.searchParams.set('corpsecret', secret);
  const response = await fetch(endpoint, { signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  if (!response.ok || result.errcode !== 0 || !result.access_token) throw Object.assign(new Error('wecom_auth_failed'), { code: Number(result.errcode || -1) });
  const ttl = Math.max(60, Number(result.expires_in || 7200) - 300);
  const next = { value: String(result.access_token), expiresAt: Date.now() + ttl * 1000 };
  if (cacheName === 'contacts') contactsAccessToken = next;
  else appAccessToken = next;
  return next.value;
}

async function wecomRequest(endpoint, options = {}, retry = true) {
  endpoint.searchParams.set('access_token', await getToken(APP_SECRET, 'app'));
  const response = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(8000) });
  const result = await response.json();
  if (retry && (result.errcode === 40014 || result.errcode === 42001)) {
    appAccessToken = { value: '', expiresAt: 0 };
    await getToken(APP_SECRET, 'app', true);
    return wecomRequest(endpoint, options, false);
  }
  if (!response.ok || result.errcode !== 0) throw Object.assign(new Error('wecom_api_failed'), { code: Number(result.errcode || -1) });
  return result;
}

async function sendQrAdminReminder() {
  if (!appApiConfigured() || !Number.isInteger(AGENT_ID) || AGENT_ID <= 0 || !QR_ADMIN_USERID) {
    throw Object.assign(new Error('reminder_not_configured'), { status: 503 });
  }
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send');
  const status = wxPlugin?.publicStatus() || { available: false, updatedAt: null };
  const updated = status.updatedAt
    ? new Date(status.updatedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
    : '尚未生成';
  await wecomRequest(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      touser: QR_ADMIN_USERID,
      msgtype: 'text',
      agentid: AGENT_ID,
      text: { content: `微信插件关注二维码需要管理员检查或更新。\n当前二维码更新时间：${updated}\n请登录中转站管理页面 /admin 处理。` },
      safe: 0,
      enable_duplicate_check: 1,
      duplicate_check_interval: 1800
    })
  });
}

async function updateUserid(userid, newUserid, retry = true) {
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/update');
  endpoint.searchParams.set('access_token', await getToken(CONTACTS_SECRET, 'contacts'));
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ userid, new_userid: newUserid }),
    signal: AbortSignal.timeout(8000)
  });
  const result = await response.json();
  if (retry && (result.errcode === 40014 || result.errcode === 42001)) {
    contactsAccessToken = { value: '', expiresAt: 0 };
    await getToken(CONTACTS_SECRET, 'contacts', true);
    return updateUserid(userid, newUserid, false);
  }
  if (!response.ok || result.errcode !== 0) {
    throw Object.assign(new Error('userid_update_failed'), {
      code: Number(result.errcode || -1),
      detail: String(result.errmsg || '')
    });
  }
}

function validNewUserid(value) {
  return /^[A-Za-z0-9._@-]+$/.test(value) && Buffer.byteLength(value, 'utf8') <= 64;
}

function createConfirmationCode() {
  return String(crypto.randomInt(0, 1000000)).padStart(6, '0');
}

async function handleTextCommand(userid, body) {
  const text = String(body || '').trim();
  const changeMatch = text.match(/^修改ID\s+(.+)$/i);
  if (changeMatch) {
    if (!contactsEditConfigured()) return '账号 ID 修改功能尚未配置，请联系管理员。';
    const newUserid = changeMatch[1].trim();
    if (!validNewUserid(newUserid)) return '新账号 ID 只能使用字母、数字及 . _ @ -，长度为 1~64 字节。';
    if (newUserid.toLowerCase() === userid.toLowerCase()) return '新账号 ID 不能与当前账号 ID 相同。';
    const code = createConfirmationCode();
    pendingUseridChanges.set(userid, { newUserid, code, expiresAt: Date.now() + USERID_CHANGE_TTL_MS });
    return `账号 ID 只能修改一次，成功后不可撤销。\n当前：${userid}\n新 ID：${newUserid}\n如确认修改，请在 5 分钟内发送：确认修改 ${code}`;
  }

  const confirmMatch = text.match(/^确认修改\s+(\d{6})$/);
  if (confirmMatch) {
    if (!contactsEditConfigured()) return '账号 ID 修改功能尚未配置，请联系管理员。';
    const pending = pendingUseridChanges.get(userid);
    if (!pending || pending.expiresAt < Date.now()) {
      pendingUseridChanges.delete(userid);
      return '确认请求不存在或已过期，请重新发送“修改ID 新账号ID”。';
    }
    if (!safeEqual(confirmMatch[1], pending.code)) return '确认码不正确，未执行修改。';
    pendingUseridChanges.delete(userid);
    try {
      await updateUserid(userid, pending.newUserid);
      await writeLog('USERID_CHANGE_OK');
      return `账号 ID 已修改为：${pending.newUserid}`;
    } catch (error) {
      await writeLog('USERID_CHANGE_FAIL', `code=${error.code || -1}`);
      return `账号 ID 修改失败，错误码：${error.code || -1}。请确认该账号由系统自动生成且尚未修改过。`;
    }
  }

  return `你的成员 ID：${userid}\n修改账号 ID 请发送：修改ID 新账号ID`;
}

async function getMember(userid) {
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/get');
  endpoint.searchParams.set('userid', userid);
  const result = await wecomRequest(endpoint);
  return String(result.userid || '');
}

async function convertOpenUserid(openUserid) {
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/batch/openuserid_to_userid');
  const result = await wecomRequest(endpoint, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify({ open_userid_list: [openUserid] }) });
  const match = Array.isArray(result.userid_list) ? result.userid_list.find(item => item.open_userid === openUserid) : null;
  return match ? String(match.userid || '') : '';
}

async function resolveUserid(sender) {
  const direct = await getMember(sender).catch(() => '');
  if (direct) return direct;
  const converted = await convertOpenUserid(sender).catch(() => '');
  if (converted) return converted;
  throw Object.assign(new Error('userid_not_found'), { code: -2 });
}

function callbackSignatureValid(url, ciphered) {
  const signature = url.searchParams.get('msg_signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  return signature && timestamp && nonce && safeEqual(signature, getSignature(CALLBACK_TOKEN, timestamp, nonce, ciphered));
}

function cdata(value) { return String(value || '').replace(/]]>/g, ']]]]><![CDATA[>'); }

function encryptedReply(toUser, fromUser, content) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = crypto.randomBytes(8).toString('hex');
  const plain = `<xml><ToUserName><![CDATA[${cdata(toUser)}]]></ToUserName><FromUserName><![CDATA[${cdata(fromUser)}]]></FromUserName><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${cdata(content)}]]></Content></xml>`;
  const ciphered = encrypt(CALLBACK_AES_KEY, plain, CORP_ID);
  const signature = getSignature(CALLBACK_TOKEN, timestamp, nonce, ciphered);
  return `<xml><Encrypt><![CDATA[${ciphered}]]></Encrypt><MsgSignature><![CDATA[${signature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}

async function callback(req, res, url) {
  if (!configured()) return sendJson(res, 503, { error: 'service_not_configured' });
  if (req.method === 'GET') {
    const ciphered = url.searchParams.get('echostr') || '';
    if (!ciphered || !callbackSignatureValid(url, ciphered)) return sendJson(res, 403, { error: 'invalid_signature' });
    const result = decrypt(CALLBACK_AES_KEY, ciphered);
    if (result.id !== CORP_ID) return sendJson(res, 403, { error: 'invalid_corp_id' });
    const output = Buffer.from(String(result.message));
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8', 'Content-Length': output.length });
    return res.end(output);
  }
  if (req.method !== 'POST') return sendJson(res, 405, { error: 'method_not_allowed' });
  const outer = xmlParser.parse(await readBody(req));
  const ciphered = String(outer.xml?.Encrypt || '');
  if (!ciphered || !callbackSignatureValid(url, ciphered)) return sendJson(res, 403, { error: 'invalid_signature' });
  const decrypted = decrypt(CALLBACK_AES_KEY, ciphered);
  if (decrypted.id !== CORP_ID) return sendJson(res, 403, { error: 'invalid_corp_id' });
  const message = xmlParser.parse(String(decrypted.message)).xml || {};
  const sender = String(message.FromUserName || message.OpenUserId || '').trim();
  const body = String(message.Content || '').trim();
  if (!sender) return sendJson(res, 400, { error: 'missing_sender' });
  let text;
  try {
    const userid = await resolveUserid(sender);
    text = await handleTextCommand(userid, body);
    await writeLog('OK', `userid=${userid}`);
  } catch (error) {
    text = `查询失败，错误码：${error.code || -1}`;
    await writeLog('FAIL', `code=${error.code || -1}`);
  }
  const reply = Buffer.from(encryptedReply(sender, String(message.ToUserName || CORP_ID), text));
  res.writeHead(200, { 'Content-Type': 'application/xml; charset=utf-8', 'Content-Length': reply.length });
  return res.end(reply);
}

async function adminApi(req, res, url, pathname) {
  if (!adminConfigured() || !wxPlugin) return sendJson(res, 503, { error: 'admin_not_configured' });
  if (pathname === '/api/admin/login' && req.method === 'POST') {
    const ip = requestIp(req);
    if (!adminLoginAllowed(ip)) return sendJson(res, 429, { error: 'too_many_attempts' });
    const body = JSON.parse(await readBody(req) || '{}');
    if (!validAdminPassword(body.password)) {
      recordAdminLoginFailure(ip);
      return sendJson(res, 401, { error: 'invalid_credentials' });
    }
    adminLoginAttempts.delete(ip);
    const token = crypto.randomBytes(32).toString('base64url');
    adminSessions.set(token, { expiresAt: Date.now() + ADMIN_SESSION_MS });
    res.setHeader('Set-Cookie', sessionCookie(req, token, Math.floor(ADMIN_SESSION_MS / 1000)));
    return sendJson(res, 200, { ok: true });
  }

  requireAdmin(req);
  if (pathname === '/api/admin/logout' && req.method === 'POST') {
    const token = parseCookies(req).t3_admin || '';
    if (token) adminSessions.delete(token);
    res.setHeader('Set-Cookie', sessionCookie(req, '', 0));
    return sendJson(res, 200, { ok: true });
  }
  if (pathname === '/api/admin/status' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, wxplugin: wxPlugin.adminStatus() });
  }
  if (pathname === '/api/admin/wxplugin/login/start' && req.method === 'POST') {
    return sendJson(res, 200, await wxPlugin.startLogin());
  }
  if (pathname === '/api/admin/wxplugin/login/qrcode' && req.method === 'GET') {
    const image = await wxPlugin.fetchLoginQr(url.searchParams.get('key') || '');
    res.writeHead(200, { 'Content-Type': image.contentType, 'Content-Length': image.bytes.length, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' });
    return res.end(image.bytes);
  }
  if (pathname === '/api/admin/wxplugin/login/status' && req.method === 'GET') {
    return sendJson(res, 200, await wxPlugin.pollLogin(url.searchParams.get('key') || ''));
  }
  if (pathname === '/api/admin/wxplugin/login/captcha/send' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    return sendJson(res, 200, await wxPlugin.sendMobileCaptcha(body.key || ''));
  }
  if (pathname === '/api/admin/wxplugin/login/captcha/confirm' && req.method === 'POST') {
    const body = JSON.parse(await readBody(req) || '{}');
    return sendJson(res, 200, await wxPlugin.confirmMobileCaptcha(body.key || '', body.code || ''));
  }
  if (pathname === '/api/admin/wxplugin/refresh' && req.method === 'POST') {
    return sendJson(res, 200, await wxPlugin.refreshQrCode());
  }
  return sendJson(res, 404, { error: 'not_found' });
}

async function route(req, res) {
  const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  if (pathname === '/' && req.method === 'GET') {
    const html = await fsp.readFile(INDEX_FILE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store' });
    return res.end(html);
  }
  if (pathname === '/admin' && req.method === 'GET') {
    const html = await fsp.readFile(ADMIN_FILE);
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Content-Length': html.length, 'Cache-Control': 'no-store', 'X-Frame-Options': 'DENY' });
    return res.end(html);
  }
  if (pathname === '/assets/wechat-my-enterprise.png' && req.method === 'GET') {
    const image = await fsp.readFile(WECHAT_TUTORIAL_IMAGE);
    res.writeHead(200, { 'Content-Type': 'image/png', 'Content-Length': image.length, 'Cache-Control': 'public, max-age=604800, immutable', 'X-Content-Type-Options': 'nosniff' });
    return res.end(image);
  }
  if (pathname === '/api/wxplugin/qrcode' && req.method === 'GET') {
    if (!wxPlugin) return sendJson(res, 200, { available: false });
    return sendJson(res, 200, wxPlugin.publicStatus());
  }
  if (pathname === '/api/wxplugin/remind-admin' && req.method === 'POST') {
    const remaining = QR_REMINDER_COOLDOWN_MS - (Date.now() - lastQrReminderAt);
    if (remaining > 0) {
      return sendJson(res, 429, { error: 'reminder_cooldown', retryAfter: Math.ceil(remaining / 1000) });
    }
    await sendQrAdminReminder();
    lastQrReminderAt = Date.now();
    return sendJson(res, 200, { ok: true });
  }
  if (pathname.startsWith('/api/admin/')) return adminApi(req, res, url, pathname);
  if (pathname === '/health' && req.method === 'GET') {
    return sendJson(res, 200, { ok: true, configured: configured(), contactsEditConfigured: contactsEditConfigured() });
  }
  if (pathname === '/wecom/callback') return callback(req, res, url);
  return sendJson(res, 404, { error: 'not_found' });
}

async function createServer() {
  await fsp.mkdir(LOG_DIR, { recursive: true });
  if (adminConfigured() && !wxPlugin) {
    wxPlugin = new WxPluginManager({ dataDir: DATA_DIR, encryptionPassword: ADMIN_PASSWORD });
    await wxPlugin.init();
  }
  return http.createServer((req, res) => route(req, res).catch(error => {
    if (!error.status || error.status >= 500) console.error('[WECOM] request failed:', error.message);
    if (!res.headersSent) sendJson(res, error.status || 500, { error: error.status ? error.message : 'internal_error' });
    else res.destroy(error);
  }));
}

if (require.main === module) {
  createServer().then(server => server.listen(PORT, '0.0.0.0', () => console.log(`[WECOM] callback listening on 0.0.0.0:${PORT}`))).catch(error => { console.error('[WECOM] startup failed:', error); process.exitCode = 1; });
}

module.exports = { createServer };
