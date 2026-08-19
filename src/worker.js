/**
 * wecom-relay — Cloudflare Workers port
 *
 * 原 Node 版 (server.js / wxplugin.js) 使用 http / fs / Node crypto(scrypt, aes-256-gcm)
 * 与 @wecom/crypto。本文件用 Web 标准 API 重写：
 *   - 企业微信回调加解密：Web Crypto (AES-256-CBC + SHA-1)，算法与 @wecom/crypto 完全一致
 *   - 文件存储：Workers KV（token 缓存 / 登录态 / 二维码状态等）
 *   - 管理员会话：HMAC-SHA256 签名 Cookie（无状态，避免 KV 最终一致性问题）
 *   - 定时刷新二维码：Cron Trigger 调用 scheduled()
 *   - 静态页面(index.html / admin.html / 教程图)：通过 ASSETS 绑定提供
 *
 * 所有对外 API 路径、元素 ID、回调协议与 Node 版保持兼容。
 */

const ADMIN_SESSION_MS = 8 * 60 * 60 * 1000;
const QR_REMINDER_COOLDOWN_MS = 12 * 60 * 60 * 1000;
const QR_REFRESH_MS = 6 * 24 * 60 * 60 * 1000;
const USERID_CHANGE_TTL_MS = 5 * 60 * 1000;
const WECOM_ADMIN_ORIGIN = 'https://work.weixin.qq.com';

const enc = new TextEncoder();
const dec = new TextDecoder();

// ---------- 配置（从 env 读取；敏感项走 wrangler secret） ----------
function loadConfig(env) {
  return {
    CORP_ID: String(env.WECOM_CORP_ID || '').trim(),
    APP_SECRET: String(env.WECOM_SECRET || '').trim(),
    AGENT_ID: Number.parseInt(env.WECOM_AGENT_ID || '0', 10),
    CONTACTS_SECRET: String(env.WECOM_CONTACTS_SECRET || '').trim(),
    QR_ADMIN_USERID: String(env.WECOM_QR_ADMIN_USERID || 'zhengfei').trim(),
    CALLBACK_TOKEN: String(env.WECOM_CALLBACK_TOKEN || '').trim(),
    CALLBACK_AES_KEY: String(env.WECOM_CALLBACK_AES_KEY || '').trim(),
    ADMIN_PASSWORD: String(env.ADMIN_PASSWORD || '').trim(),
  };
}

function configured(cfg) {
  return /^ww[0-9a-z]+$/i.test(cfg.CORP_ID) && cfg.APP_SECRET.length > 0 && cfg.CALLBACK_TOKEN.length > 0 && cfg.CALLBACK_AES_KEY.length === 43;
}
function appApiConfigured(cfg) {
  return /^ww[0-9a-z]+$/i.test(cfg.CORP_ID) && cfg.APP_SECRET.length > 0;
}
function contactsEditConfigured(cfg) {
  return cfg.CONTACTS_SECRET.length > 0;
}
function adminConfigured(cfg) {
  return cfg.ADMIN_PASSWORD.length >= 8;
}

// ---------- 字节 / base64 工具 ----------
function bytesToBase64(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}
function base64ToBytes(b64) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}
// 兼容 "=padding" 的 base64（企业微信 EncodingAESKey 为 43 字符，补 '=' 后 44 字符 = 32 字节）
function base64DecodeStrict(b64) {
  return base64ToBytes(b64);
}
function timingSafeEqualStr(a, b) {
  const ab = enc.encode(a);
  const bb = enc.encode(b);
  if (ab.length !== bb.length) return false;
  let diff = 0;
  for (let i = 0; i < ab.length; i++) diff |= ab[i] ^ bb[i];
  return diff === 0;
}

// ---------- 企业微信回调加解密（Web Crypto 实现，等价于 @wecom/crypto） ----------
const wecomCrypto = (() => {
  function getKeyAndIv(aesKey) {
    const keyBytes = base64DecodeStrict(aesKey + '=');
    if (keyBytes.length !== 32) throw new Error('invalid encodingAESKey');
    return { key: keyBytes, iv: keyBytes.slice(0, 16) };
  }
  async function importKey(keyBytes) {
    return crypto.subtle.importKey('raw', keyBytes, { name: 'AES-CBC' }, false, ['encrypt', 'decrypt']);
  }
  function getSignature(token, timestamp, nonce, encrypt) {
    const arr = [token, String(timestamp), String(nonce), encrypt].sort();
    return crypto.subtle.digest('SHA-1', enc.encode(arr.join(''))).then(buf => {
      const bytes = new Uint8Array(buf);
      let hex = '';
      for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0');
      return hex;
    });
  }
  async function encrypt(aesKey, message, id) {
    const { key, iv } = getKeyAndIv(aesKey);
    const cryptoKey = await importKey(key);
    const random = crypto.getRandomValues(new Uint8Array(16));
    const msgBytes = enc.encode(message);
    const idBytes = enc.encode(id);
    const lenBuf = new Uint8Array(4);
    lenBuf[0] = (msgBytes.length >>> 24) & 0xff;
    lenBuf[1] = (msgBytes.length >>> 16) & 0xff;
    lenBuf[2] = (msgBytes.length >>> 8) & 0xff;
    lenBuf[3] = msgBytes.length & 0xff;
    const plain = new Uint8Array(16 + 4 + msgBytes.length + idBytes.length);
    plain.set(random, 0);
    plain.set(lenBuf, 16);
    plain.set(msgBytes, 20);
    plain.set(idBytes, 20 + msgBytes.length);
    // Web Crypto AES-CBC 自动做 PKCS7 填充，与企业微信解密（按末尾字节去填充）完全兼容
    const ciphered = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, plain);
    return bytesToBase64(new Uint8Array(ciphered));
  }
  async function decrypt(aesKey, cipherB64) {
    const { key, iv } = getKeyAndIv(aesKey);
    const cryptoKey = await importKey(key);
    const cipherBytes = base64ToBytes(cipherB64);
    const buf = await crypto.subtle.decrypt({ name: 'AES-CBC', iv }, cryptoKey, cipherBytes);
    const bytes = new Uint8Array(buf); // 已自动去 PKCS7 填充
    const msgLen = (bytes[16] << 24) | (bytes[17] << 16) | (bytes[18] << 8) | bytes[19];
    const message = dec.decode(bytes.slice(20, 20 + msgLen));
    const id = dec.decode(bytes.slice(20 + msgLen));
    return { message, id };
  }
  return { getSignature, encrypt, decrypt };
})();

// ---------- 极简 XML 解析（覆盖回调体 <xml><Encrypt>..</Encrypt></xml> 与解密消息） ----------
function parseSimpleXml(text) {
  let body = text;
  const xmlMatch = text.match(/<xml>([\s\S]*)<\/xml>/);
  if (xmlMatch) body = xmlMatch[1];
  const out = {};
  const re = /<([A-Za-z_][\w]*)(?:\s+[^>]*)?>([\s\S]*?)<\/\1>/g;
  let m;
  while ((m = re.exec(body)) !== null) {
    const name = m[1];
    const cdata = m[2].match(/^\s*<!\[CDATA\[([\s\S]*?)\]\]>\s*$/);
    out[name] = cdata ? cdata[1] : m[2].trim();
  }
  return out;
}

// ---------- KV 抽象（未绑定 KV 时回退到内存，便于本地 dev） ----------
function makeKv(env) {
  if (env.WECOM_RELAY_KV) return env.WECOM_RELAY_KV;
  const mem = new Map();
  return {
    async get(k) { return mem.has(k) ? mem.get(k) : null; },
    async put(k, v) { mem.set(k, v); },
    async delete(k) { mem.delete(k); },
  };
}

// ---------- 响应工具 ----------
function jsonResponse(body, status = 200) {
  return Response.json(body, {
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
    status,
  });
}

// ---------- 管理员会话（HMAC 签名 Cookie，无状态） ----------
async function hmacSign(data, password) {
  const key = await crypto.subtle.importKey('raw', enc.encode(password), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', key, enc.encode(data));
  return bytesToBase64(new Uint8Array(sig));
}
async function createSessionCookie(password) {
  const payload = bytesToBase64(enc.encode(JSON.stringify({ exp: Date.now() + ADMIN_SESSION_MS })));
  const sig = await hmacSign(payload, password);
  const value = `${payload}.${sig}`;
  return `t3_admin=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=${Math.floor(ADMIN_SESSION_MS / 1000)}`;
}
async function verifySession(token, password) {
  try {
    const [payload, sig] = token.split('.');
    if (!payload || !sig) return false;
    const expected = await hmacSign(payload, password);
    if (!timingSafeEqualStr(sig, expected)) return false;
    const data = JSON.parse(dec.decode(base64ToBytes(payload)));
    return data.exp && data.exp >= Date.now();
  } catch {
    return false;
  }
}
function parseCookies(request) {
  return Object.fromEntries(
    String(request.headers.get('cookie') || '')
      .split(';')
      .map(s => s.trim())
      .filter(Boolean)
      .map(item => {
        const off = item.indexOf('=');
        return off < 0 ? ['', ''] : [item.slice(0, off), decodeURIComponent(item.slice(off + 1))];
      })
      .filter(([n]) => n)
  );
}
function requestIp(request) {
  return request.headers.get('cf-connecting-ip') || String(request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || '';
}

// ---------- WeCom API 封装 ----------
async function wecomGetToken(kv, secret, cacheName, cfg, force = false) {
  const cacheKey = cacheName === 'contacts' ? 'contacts_token' : 'app_token';
  if (!force) {
    const cached = await kv.get(cacheKey);
    if (cached) {
      const parsed = JSON.parse(cached);
      if (parsed.value && Date.now() < parsed.expiresAt) return parsed.value;
    }
  }
  const url = new URL('https://qyapi.weixin.qq.com/cgi-bin/gettoken');
  url.searchParams.set('corpid', cfg.CORP_ID);
  url.searchParams.set('corpsecret', secret);
  const res = await fetch(url, { signal: AbortSignal.timeout(8000) });
  const result = await res.json();
  if (!res.ok || result.errcode !== 0 || !result.access_token) throw Object.assign(new Error('wecom_auth_failed'), { code: Number(result.errcode || -1) });
  const ttl = Math.max(60, Number(result.expires_in || 7200) - 300);
  await kv.put(cacheKey, JSON.stringify({ value: String(result.access_token), expiresAt: Date.now() + ttl * 1000 }));
  return String(result.access_token);
}
async function wecomRequest(kv, cfg, endpoint, options = {}, retry = true) {
  endpoint.searchParams.set('access_token', await wecomGetToken(kv, cfg.APP_SECRET, 'app', cfg));
  const res = await fetch(endpoint, { ...options, signal: AbortSignal.timeout(8000) });
  const result = await res.json();
  if (retry && (result.errcode === 40014 || result.errcode === 42001)) {
    await kv.put('app_token', JSON.stringify({ value: '', expiresAt: 0 }));
    await wecomGetToken(kv, cfg.APP_SECRET, 'app', cfg, true);
    return wecomRequest(kv, cfg, endpoint, options, false);
  }
  if (!res.ok || result.errcode !== 0) throw Object.assign(new Error('wecom_api_failed'), { code: Number(result.errcode || -1) });
  return result;
}
async function updateUserid(kv, cfg, userid, newUserid, retry = true) {
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/update');
  endpoint.searchParams.set('access_token', await wecomGetToken(kv, cfg.CONTACTS_SECRET, 'contacts', cfg));
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ userid, new_userid: newUserid }),
    signal: AbortSignal.timeout(8000),
  });
  const result = await res.json();
  if (retry && (result.errcode === 40014 || result.errcode === 42001)) {
    await kv.put('contacts_token', JSON.stringify({ value: '', expiresAt: 0 }));
    await wecomGetToken(kv, cfg.CONTACTS_SECRET, 'contacts', cfg, true);
    return updateUserid(kv, cfg, userid, newUserid, false);
  }
  if (!res.ok || result.errcode !== 0) throw Object.assign(new Error('userid_update_failed'), { code: Number(result.errcode || -1), detail: String(result.errmsg || '') });
}
async function getMember(kv, cfg, userid) {
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/user/get');
  endpoint.searchParams.set('userid', userid);
  const result = await wecomRequest(kv, cfg, endpoint);
  return String(result.userid || '');
}
async function convertOpenUserid(kv, cfg, openUserid) {
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/batch/openuserid_to_userid');
  const result = await wecomRequest(kv, cfg, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({ open_userid_list: [openUserid] }),
  });
  const match = Array.isArray(result.userid_list) ? result.userid_list.find(i => i.open_userid === openUserid) : null;
  return match ? String(match.userid || '') : '';
}
async function resolveUserid(kv, cfg, sender) {
  const direct = await getMember(kv, cfg, sender).catch(() => '');
  if (direct) return direct;
  const converted = await convertOpenUserid(kv, cfg, sender).catch(() => '');
  if (converted) return converted;
  throw Object.assign(new Error('userid_not_found'), { code: -2 });
}
function validNewUserid(value) {
  return /^[A-Za-z0-9._@-]+$/.test(value) && enc.encode(value).length <= 64;
}
function createConfirmationCode() {
  return String(Math.floor(Math.random() * 1000000)).padStart(6, '0');
}
function cdata(value) {
  return String(value || '').replace(/]]>/g, ']]]]><![CDATA[>');
}
async function encryptedReply(cfg, toUser, fromUser, content) {
  const timestamp = String(Math.floor(Date.now() / 1000));
  const nonce = bytesToBase64(crypto.getRandomValues(new Uint8Array(8))).slice(0, 16);
  const plain = `<xml><ToUserName><![CDATA[${cdata(toUser)}]]></ToUserName><FromUserName><![CDATA[${cdata(fromUser)}]]></FromUserName><CreateTime>${timestamp}</CreateTime><MsgType><![CDATA[text]]></MsgType><Content><![CDATA[${cdata(content)}]]></Content></xml>`;
  const ciphered = await wecomCrypto.encrypt(cfg.CALLBACK_AES_KEY, plain, cfg.CORP_ID);
  const signature = await wecomCrypto.getSignature(cfg.CALLBACK_TOKEN, timestamp, nonce, ciphered);
  return `<xml><Encrypt><![CDATA[${ciphered}]]></Encrypt><MsgSignature><![CDATA[${signature}]]></MsgSignature><TimeStamp>${timestamp}</TimeStamp><Nonce><![CDATA[${nonce}]]></Nonce></xml>`;
}

// ---------- WxPluginManager（KV 版，无 fs / 无 setInterval） ----------
class WxPluginManager {
  constructor(env, cfg) {
    this.kv = makeKv(env);
    this.cfg = cfg;
    this.stateKey = 'wxplugin_state';
    this.pendingKey = 'wxplugin_pending';
  }
  async deriveKey() {
    if (this._dk) return this._dk;
    const salt = enc.encode('t3-wecom-relay-wxplugin-v1');
    const baseKey = await crypto.subtle.importKey('raw', enc.encode(this.cfg.ADMIN_PASSWORD), 'PBKDF2', false, ['deriveBits']);
    const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', salt, iterations: 100000, hash: 'SHA-256' }, baseKey, 256);
    this._dk = new Uint8Array(bits);
    return this._dk;
  }
  async loadState() {
    const raw = await this.kv.get(this.stateKey);
    if (!raw) return { sid: '', qrCode: '', qrUpdatedAt: 0 };
    try {
      const aesKey = await this.deriveKey();
      const aead = await crypto.subtle.importKey('raw', aesKey, { name: 'AES-GCM' }, false, ['decrypt']);
      const stored = JSON.parse(raw);
      const iv = base64ToBytes(stored.iv);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, aead, base64ToBytes(stored.data));
      const state = JSON.parse(dec.decode(new Uint8Array(plain)));
      return { sid: String(state.sid || ''), qrCode: String(state.qrCode || ''), qrUpdatedAt: Number(state.qrUpdatedAt || 0) };
    } catch {
      return { sid: '', qrCode: '', qrUpdatedAt: 0 };
    }
  }
  async saveState(state) {
    const key = await this.deriveKey();
    const aead = await crypto.subtle.importKey('raw', key, { name: 'AES-GCM' }, false, ['encrypt']);
    const iv = crypto.getRandomValues(new Uint8Array(12));
    const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, aead, enc.encode(JSON.stringify(state)));
    await this.kv.put(this.stateKey, JSON.stringify({ iv: bytesToBase64(iv), data: bytesToBase64(new Uint8Array(cipher)) }));
  }
  async loadPending() {
    const raw = await this.kv.get(this.pendingKey);
    if (!raw) return {};
    try { return JSON.parse(raw); } catch { return {}; }
  }
  async savePending(map) {
    await this.kv.put(this.pendingKey, JSON.stringify(map));
  }
  publicStatus(state) {
    return { available: Boolean(state.qrCode), qrCode: state.qrCode, updatedAt: state.qrUpdatedAt || null };
  }
  adminStatus(state) {
    return { cookieAvailable: Boolean(state.sid), qrAvailable: Boolean(state.qrCode), qrUpdatedAt: state.qrUpdatedAt || null };
  }
  async startLogin() {
    const endpoint = new URL('/wework_admin/wwqrlogin/mng/get_key', WECOM_ADMIN_ORIGIN);
    endpoint.searchParams.set('r', String(Date.now()));
    endpoint.searchParams.set('login_type', 'login_admin');
    const result = await jsonRequest(endpoint);
    const key = String(result.data?.qrcode_key || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('wecom_login_key_missing');
    const pending = await this.loadPending();
    pending[key] = Date.now() + 5 * 60 * 1000;
    await this.savePending(pending);
    return { key };
  }
  async fetchLoginQr(key) {
    this.requirePendingLogin(await this.loadPending(), key);
    const endpoint = new URL('/wework_admin/wwqrlogin/mng/qrcode', WECOM_ADMIN_ORIGIN);
    endpoint.searchParams.set('qrcode_key', key);
    endpoint.searchParams.set('login_type', 'login_admin');
    const res = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    if (!res.ok) throw new Error(`wecom_qrcode_http_${res.status}`);
    return { bytes: new Uint8Array(await res.arrayBuffer()), contentType: res.headers.get('content-type') || 'image/png' };
  }
  requirePendingLogin(pending, key) {
    const exp = pending[key];
    if (!exp || exp < Date.now()) {
      delete pending[key];
      throw new Error('wecom_login_expired');
    }
  }
  async pollLogin(key) {
    const pending = await this.loadPending();
    this.requirePendingLogin(pending, key);
    const endpoint = new URL('/wework_admin/wwqrlogin/check', WECOM_ADMIN_ORIGIN);
    endpoint.searchParams.set('r', String(Date.now()));
    endpoint.searchParams.set('status', '');
    endpoint.searchParams.set('qrcode_key', key);
    const result = await jsonRequest(endpoint);
    const data = result.data;
    if (!data) return { status: 'expired', message: '登录二维码已过期' };
    const status = String(data.status || '');
    if (status === 'QRCODE_SCAN_NEVER') return { status: 'waiting', message: '等待管理员扫码' };
    if (status === 'QRCODE_SCAN_ING') return { status: 'scanned', message: '已扫码，请在企业微信确认登录' };
    if (status === 'QRCODE_SCAN_FAIL') return { status: 'cancelled', message: '登录已取消' };
    if (status !== 'QRCODE_SCAN_SUCC' || !data.auth_code) return { status: 'waiting', message: '等待确认' };
    const login = await this.exchangeLogin(String(data.auth_code), key);
    if (login.needsMobileVerification) return { status: 'mobile_verification_required', message: '企业微信要求手机验证码，本服务未保存登录 Cookie' };
    delete pending[key];
    await this.savePending(pending);
    const state = await this.loadState();
    if (state.sid) await this.refreshQrCode();
    return { status: 'success', message: '管理员登录成功，关注二维码已更新' };
  }
  async exchangeLogin(authCode, key) {
    const first = new URL('/wework_admin/loginpage_wx', WECOM_ADMIN_ORIGIN);
    first.searchParams.set('_r', String(Math.floor(Math.random() * 1000)));
    first.searchParams.set('wwqrlogin', '1');
    first.searchParams.set('auth_source', 'SOURCE_FROM_WEWORK');
    first.searchParams.set('code', authCode);
    first.searchParams.set('qrcode_key', key);
    const firstRes = await fetch(first, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const firstLocation = firstRes.headers.get('location') || '';
    const tmpSid = cookieValue(firstRes.headers, 'wwrtx.tmp_sid');
    if (!firstLocation || !tmpSid) throw new Error('wecom_temporary_session_missing');
    const second = new URL(new URL(firstLocation, WECOM_ADMIN_ORIGIN).toString());
    second.searchParams.set('redirect_uri', `${WECOM_ADMIN_ORIGIN}/wework_admin/frame`);
    const secondRes = await fetch(second, { redirect: 'manual', headers: { Cookie: `wwrtx.tmp_sid=${tmpSid}` }, signal: AbortSignal.timeout(10000) });
    const sid = cookieValue(secondRes.headers, 'wwrtx.sid');
    if (!sid) {
      const location = secondRes.headers.get('location') || '';
      return { needsMobileVerification: location.includes('tl_key=') };
    }
    const state = await this.loadState();
    state.sid = sid;
    await this.saveState(state);
    return { needsMobileVerification: false };
  }
  async refreshQrCode() {
    const state = await this.loadState();
    if (!state.sid) throw new Error('wecom_admin_login_required');
    const endpoint = new URL('/wework_admin/wxplugin/getDetail', WECOM_ADMIN_ORIGIN);
    const result = await jsonRequest(endpoint, { headers: { Cookie: `wwrtx.sid=${state.sid}` } });
    const qrCode = String(result.data?.qrCode || '');
    if (!qrCode) {
      state.sid = '';
      await this.saveState(state);
      throw new Error('wecom_admin_session_expired');
    }
    state.qrCode = qrCode;
    state.qrUpdatedAt = Date.now();
    await this.saveState(state);
    return this.publicStatus(state);
  }
}
async function jsonRequest(url, options = {}) {
  const res = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const text = await res.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('wecom_invalid_response'); }
  if (!res.ok) throw new Error(`wecom_http_${res.status}`);
  return result;
}
function cookieValue(headers, name) {
  const source = typeof headers.getSetCookie === 'function' ? headers.getSetCookie().join(',') : String(headers.get('set-cookie') || '');
  const match = source.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
  return match ? match[1] : '';
}

// ---------- 文本指令处理 ----------
async function handleTextCommand(kv, cfg, userid, body) {
  const text = String(body || '').trim();
  const changeMatch = text.match(/^修改ID\s+(.+)$/i);
  if (changeMatch) {
    if (!contactsEditConfigured(cfg)) return '账号 ID 修改功能尚未配置，请联系管理员。';
    const newUserid = changeMatch[1].trim();
    if (!validNewUserid(newUserid)) return '新账号 ID 只能使用字母、数字及 . _ @ -，长度为 1~64 字节。';
    if (newUserid.toLowerCase() === userid.toLowerCase()) return '新账号 ID 不能与当前账号 ID 相同。';
    const code = createConfirmationCode();
    await kv.put(`change:${userid}`, JSON.stringify({ newUserid, code, expiresAt: Date.now() + USERID_CHANGE_TTL_MS }));
    return `账号 ID 只能修改一次，成功后不可撤销。\n当前：${userid}\n新 ID：${newUserid}\n如确认修改，请在 5 分钟内发送：确认修改 ${code}`;
  }
  const confirmMatch = text.match(/^确认修改\s+(\d{6})$/);
  if (confirmMatch) {
    if (!contactsEditConfigured(cfg)) return '账号 ID 修改功能尚未配置，请联系管理员。';
    const raw = await kv.get(`change:${userid}`);
    if (!raw) return '确认请求不存在或已过期，请重新发送“修改ID 新账号ID”。';
    const pending = JSON.parse(raw);
    if (pending.expiresAt < Date.now()) {
      await kv.delete(`change:${userid}`);
      return '确认请求不存在或已过期，请重新发送“修改ID 新账号ID”。';
    }
    if (!timingSafeEqualStr(confirmMatch[1], pending.code)) return '确认码不正确，未执行修改。';
    await kv.delete(`change:${userid}`);
    try {
      await updateUserid(kv, cfg, userid, pending.newUserid);
      console.log(`[WECOM] USERID_CHANGE_OK ${userid} -> ${pending.newUserid}`);
      return `账号 ID 已修改为：${pending.newUserid}`;
    } catch (error) {
      console.log(`[WECOM] USERID_CHANGE_FAIL code=${error.code || -1}`);
      return `账号 ID 修改失败，错误码：${error.code || -1}。请确认该账号由系统自动生成且尚未修改过。`;
    }
  }
  return `你的成员 ID：${userid}\n修改账号 ID 请发送：修改ID 新账号ID`;
}

// ---------- 回调验证 / 处理 ----------
async function callbackSignatureValid(cfg, url, ciphered) {
  const signature = url.searchParams.get('msg_signature') || '';
  const timestamp = url.searchParams.get('timestamp') || '';
  const nonce = url.searchParams.get('nonce') || '';
  if (!signature || !timestamp || !nonce || !ciphered) return false;
  const expected = await wecomCrypto.getSignature(cfg.CALLBACK_TOKEN, timestamp, nonce, ciphered);
  return timingSafeEqualStr(signature, expected);
}
async function handleCallback(request, env, cfg, kv) {
  const url = new URL(request.url);
  if (!configured(cfg)) return jsonResponse({ error: 'service_not_configured' }, 503);
  if (request.method === 'GET') {
    const ciphered = url.searchParams.get('echostr') || '';
    if (!await callbackSignatureValid(cfg, url, ciphered)) return jsonResponse({ error: 'invalid_signature' }, 403);
    const result = await wecomCrypto.decrypt(cfg.CALLBACK_AES_KEY, ciphered);
    if (result.id !== cfg.CORP_ID) return jsonResponse({ error: 'invalid_corp_id' }, 403);
    const output = enc.encode(result.message);
    return new Response(output, { status: 200, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
  }
  if (request.method !== 'POST') return jsonResponse({ error: 'method_not_allowed' }, 405);
  const outer = parseSimpleXml(await request.text());
  const ciphered = String(outer.Encrypt || '');
  if (!ciphered || !await callbackSignatureValid(cfg, url, ciphered)) return jsonResponse({ error: 'invalid_signature' }, 403);
  const decrypted = await wecomCrypto.decrypt(cfg.CALLBACK_AES_KEY, ciphered);
  if (decrypted.id !== cfg.CORP_ID) return jsonResponse({ error: 'invalid_corp_id' }, 403);
  const message = parseSimpleXml(decrypted.message);
  const sender = String(message.FromUserName || message.OpenUserId || '').trim();
  const body = String(message.Content || '').trim();
  if (!sender) return jsonResponse({ error: 'missing_sender' }, 400);
  let text;
  try {
    const userid = await resolveUserid(kv, cfg, sender);
    text = await handleTextCommand(kv, cfg, userid, body);
    console.log(`[WECOM] OK userid=${userid}`);
  } catch (error) {
    text = `查询失败，错误码：${error.code || -1}`;
    console.log(`[WECOM] FAIL code=${error.code || -1}`);
  }
  const reply = enc.encode(await encryptedReply(cfg, sender, String(message.ToUserName || cfg.CORP_ID), text));
  return new Response(reply, { status: 200, headers: { 'Content-Type': 'application/xml; charset=utf-8' } });
}

// ---------- 提醒管理员 ----------
async function sendQrAdminReminder(env, cfg) {
  if (!appApiConfigured(cfg) || !Number.isInteger(cfg.AGENT_ID) || cfg.AGENT_ID <= 0 || !cfg.QR_ADMIN_USERID) throw Object.assign(new Error('reminder_not_configured'), { status: 503 });
  const kv = makeKv(env);
  const wx = new WxPluginManager(env, cfg);
  const status = wx.publicStatus(await wx.loadState());
  const updated = status.updatedAt ? new Date(status.updatedAt).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' }) : '尚未生成';
  const endpoint = new URL('https://qyapi.weixin.qq.com/cgi-bin/message/send');
  await wecomRequest(kv, cfg, endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json; charset=utf-8' },
    body: JSON.stringify({
      touser: cfg.QR_ADMIN_USERID,
      msgtype: 'text',
      agentid: cfg.AGENT_ID,
      text: { content: `微信插件关注二维码需要管理员检查或更新。\n当前二维码更新时间：${updated}\n请登录中转站管理页面 /admin 处理。` },
      safe: 0,
      enable_duplicate_check: 1,
      duplicate_check_interval: 1800,
    }),
  });
}

// ---------- 管理后台 API ----------
async function adminApi(request, env, cfg, kv, url, pathname) {
  if (!adminConfigured(cfg)) return jsonResponse({ error: 'admin_not_configured' }, 503);
  const wx = new WxPluginManager(env, cfg);
  if (pathname === '/api/admin/login' && request.method === 'POST') {
    const ip = requestIp(request);
    const attemptsRaw = await kv.get(`ratelimit:${ip}`);
    const attempts = attemptsRaw ? JSON.parse(attemptsRaw).filter(t => Date.now() - t < 15 * 60 * 1000) : [];
    if (attempts.length >= 5) return jsonResponse({ error: 'too_many_attempts' }, 429);
    const body = await request.json().catch(() => ({}));
    const ok = body.password && timingSafeEqualStr(body.password, cfg.ADMIN_PASSWORD);
    if (!ok) {
      attempts.push(Date.now());
      await kv.put(`ratelimit:${ip}`, JSON.stringify(attempts));
      return jsonResponse({ error: 'invalid_credentials' }, 401);
    }
    await kv.delete(`ratelimit:${ip}`);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': await createSessionCookie(cfg.ADMIN_PASSWORD) },
    });
  }
  // 以下接口需要有效会话
  const cookies = parseCookies(request);
  const token = cookies.t3_admin || '';
  if (!await verifySession(token, cfg.ADMIN_PASSWORD)) return jsonResponse({ error: 'admin_auth_required' }, 401);
  if (pathname === '/api/admin/logout' && request.method === 'POST') {
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'Set-Cookie': 't3_admin=; Path=/; HttpOnly; SameSite=Strict; Secure; Max-Age=0' },
    });
  }
  if (pathname === '/api/admin/status' && request.method === 'GET') {
    return jsonResponse({ ok: true, wxplugin: wx.adminStatus(await wx.loadState()) });
  }
  if (pathname === '/api/admin/wxplugin/login/start' && request.method === 'POST') {
    return jsonResponse(await wx.startLogin());
  }
  if (pathname === '/api/admin/wxplugin/login/qrcode' && request.method === 'GET') {
    const image = await wx.fetchLoginQr(url.searchParams.get('key') || '');
    return new Response(image.bytes, { status: 200, headers: { 'Content-Type': image.contentType, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' } });
  }
  if (pathname === '/api/admin/wxplugin/login/status' && request.method === 'GET') {
    return jsonResponse(await wx.pollLogin(url.searchParams.get('key') || ''));
  }
  if (pathname === '/api/admin/wxplugin/refresh' && request.method === 'POST') {
    return jsonResponse(await wx.refreshQrCode());
  }
  return jsonResponse({ error: 'not_found' }, 404);
}

// ---------- 静态资源（通过 ASSETS 绑定提供；同时补安全头） ----------
async function serveAsset(request, env, pathname) {
  const assetResp = await env.ASSETS.fetch(request);
  const headers = new Headers(assetResp.headers);
  if (pathname === '/admin') headers.set('X-Frame-Options', 'DENY');
  headers.set('Cache-Control', 'no-store');
  return new Response(assetResp.body, { status: assetResp.status, headers });
}

// ---------- 路由 ----------
async function route(request, env) {
  const cfg = loadConfig(env);
  const kv = makeKv(env);
  const url = new URL(request.url);
  const pathname = url.pathname.replace(/\/$/, '') || '/';
  const method = request.method;

  // 静态资源
  if (method === 'GET' && (pathname === '/' || pathname === '/admin' || pathname.startsWith('/assets/'))) {
    return serveAsset(request, env, pathname);
  }
  // 公开二维码状态
  if (pathname === '/api/wxplugin/qrcode' && method === 'GET') {
    const wx = new WxPluginManager(env, cfg);
    return jsonResponse(wx.publicStatus(await wx.loadState()));
  }
  // 提醒管理员
  if (pathname === '/api/wxplugin/remind-admin' && method === 'POST') {
    const raw = await kv.get('last_qr_reminder');
    const last = raw ? Number(raw) : 0;
    const remaining = QR_REMINDER_COOLDOWN_MS - (Date.now() - last);
    if (remaining > 0) return jsonResponse({ error: 'reminder_cooldown', retryAfter: Math.ceil(remaining / 1000) }, 429);
    await sendQrAdminReminder(env, cfg);
    await kv.put('last_qr_reminder', String(Date.now()));
    return jsonResponse({ ok: true });
  }
  // 管理后台
  if (pathname.startsWith('/api/admin/')) return adminApi(request, env, cfg, kv, url, pathname);
  // 健康检查
  if (pathname === '/health' && method === 'GET') {
    return jsonResponse({ ok: true, configured: configured(cfg), contactsEditConfigured: contactsEditConfigured(cfg) });
  }
  // 企业微信回调
  if (pathname === '/wecom/callback') return handleCallback(request, env, cfg, kv);
  // 未匹配路径：GET 回退到静态资源（含根目录验证文件 WW_verify_*.txt），其余 404
  if (method === 'GET') return serveAsset(request, env, pathname);
  return jsonResponse({ error: 'not_found' }, 404);
}

export default {
  async fetch(request, env, ctx) {
    try {
      return await route(request, env);
    } catch (error) {
      console.error('[WECOM] request failed:', error.message);
      const status = error.status || 500;
      return jsonResponse({ error: status >= 500 ? 'internal_error' : error.message }, status);
    }
  },
  async scheduled(event, env, ctx) {
    const cfg = loadConfig(env);
    if (!adminConfigured(cfg)) return;
    const wx = new WxPluginManager(env, cfg);
    const state = await wx.loadState();
    if (state.sid && Date.now() - state.qrUpdatedAt >= QR_REFRESH_MS) {
      ctx.waitUntil(wx.refreshQrCode().catch(e => console.error('[WECOM] cron refresh failed:', e.message)));
    }
  },
};
