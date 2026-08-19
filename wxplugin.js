'use strict';

const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const WECOM_ADMIN_ORIGIN = 'https://work.weixin.qq.com';
const QR_REFRESH_MS = 6 * 24 * 60 * 60 * 1000;
const SESSION_KEEPALIVE_MS = 15 * 60 * 1000;

function absoluteAdminUrl(value) {
  return new URL(value, WECOM_ADMIN_ORIGIN).toString();
}

function cookieValue(headers, name) {
  const source = typeof headers.getSetCookie === 'function'
    ? headers.getSetCookie().join(',')
    : String(headers.get('set-cookie') || '');
  const match = source.match(new RegExp(`(?:^|[,;]\\s*)${name}=([^;,]+)`));
  return match ? match[1] : '';
}

async function jsonRequest(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(10000) });
  const text = await response.text();
  let result;
  try { result = JSON.parse(text); } catch { throw new Error('wecom_invalid_response'); }
  if (!response.ok) throw new Error(`wecom_http_${response.status}`);
  return result;
}

class WxPluginManager {
  constructor({ dataDir, encryptionPassword }) {
    this.dataDir = dataDir;
    this.stateFile = path.join(dataDir, 'wxplugin-state.json');
    this.key = crypto.scryptSync(encryptionPassword, 't3-wecom-relay-wxplugin-v1', 32);
    this.sid = '';
    this.qrCode = '';
    this.qrUpdatedAt = 0;
    this.pendingLogins = new Map();
    this.maintenanceTimer = null;
    this.maintenanceRunning = false;
    this.lastKeepAliveAt = 0;
    this.lastKeepAliveError = '';
  }

  async init() {
    await fsp.mkdir(this.dataDir, { recursive: true });
    await this.loadState();
    this.maintenanceTimer = setInterval(() => this.maintainSession(), SESSION_KEEPALIVE_MS);
    this.maintenanceTimer.unref?.();
    if (this.sid) this.maintainSession();
  }

  encrypt(value) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', this.key, iv);
    const encrypted = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return {
      version: 1,
      iv: iv.toString('base64'),
      tag: cipher.getAuthTag().toString('base64'),
      data: encrypted.toString('base64')
    };
  }

  decrypt(value) {
    const decipher = crypto.createDecipheriv('aes-256-gcm', this.key, Buffer.from(value.iv, 'base64'));
    decipher.setAuthTag(Buffer.from(value.tag, 'base64'));
    return JSON.parse(Buffer.concat([
      decipher.update(Buffer.from(value.data, 'base64')),
      decipher.final()
    ]).toString('utf8'));
  }

  async loadState() {
    try {
      const stored = JSON.parse(await fsp.readFile(this.stateFile, 'utf8'));
      const state = this.decrypt(stored);
      this.sid = String(state.sid || '');
      this.qrCode = String(state.qrCode || '');
      this.qrUpdatedAt = Number(state.qrUpdatedAt || 0);
    } catch {
      this.sid = '';
      this.qrCode = '';
      this.qrUpdatedAt = 0;
    }
  }

  async saveState() {
    const tempFile = `${this.stateFile}.tmp`;
    await fsp.writeFile(tempFile, JSON.stringify(this.encrypt({
      sid: this.sid,
      qrCode: this.qrCode,
      qrUpdatedAt: this.qrUpdatedAt
    })), { encoding: 'utf8', mode: 0o600 });
    await fsp.rename(tempFile, this.stateFile);
  }

  publicStatus() {
    return {
      available: Boolean(this.qrCode),
      qrCode: this.qrCode,
      updatedAt: this.qrUpdatedAt || null
    };
  }

  adminStatus() {
    return {
      cookieAvailable: Boolean(this.sid),
      qrAvailable: Boolean(this.qrCode),
      qrUpdatedAt: this.qrUpdatedAt || null,
      lastKeepAliveAt: this.lastKeepAliveAt || null,
      lastKeepAliveError: this.lastKeepAliveError || null
    };
  }

  async maintainSession() {
    if (!this.sid || this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      if (Date.now() - this.qrUpdatedAt >= QR_REFRESH_MS) await this.refreshQrCode();
      else await this.keepSessionAlive();
      this.lastKeepAliveAt = Date.now();
      this.lastKeepAliveError = '';
    } catch (error) {
      this.lastKeepAliveError = String(error?.message || error);
    } finally {
      this.maintenanceRunning = false;
    }
  }

  async keepSessionAlive() {
    if (!this.sid) throw new Error('wecom_admin_login_required');
    const endpoint = new URL('/wework_admin/wxplugin/getDetail', WECOM_ADMIN_ORIGIN);
    const result = await jsonRequest(endpoint, { headers: { Cookie: `wwrtx.sid=${this.sid}` } });
    if (!result.data?.qrCode) throw new Error('wecom_admin_session_unavailable');
    return true;
  }

  async startLogin() {
    const endpoint = new URL('/wework_admin/wwqrlogin/mng/get_key', WECOM_ADMIN_ORIGIN);
    endpoint.searchParams.set('r', String(Date.now()));
    endpoint.searchParams.set('login_type', 'login_admin');
    const result = await jsonRequest(endpoint);
    const key = String(result.data?.qrcode_key || '');
    if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new Error('wecom_login_key_missing');
    this.pendingLogins.set(key, { expiresAt: Date.now() + 5 * 60 * 1000 });
    return { key };
  }

  async fetchLoginQr(key) {
    this.requirePendingLogin(key);
    const endpoint = new URL('/wework_admin/wwqrlogin/mng/qrcode', WECOM_ADMIN_ORIGIN);
    endpoint.searchParams.set('qrcode_key', key);
    endpoint.searchParams.set('login_type', 'login_admin');
    const response = await fetch(endpoint, { signal: AbortSignal.timeout(10000) });
    if (!response.ok) throw new Error(`wecom_qrcode_http_${response.status}`);
    return { bytes: Buffer.from(await response.arrayBuffer()), contentType: response.headers.get('content-type') || 'image/png' };
  }

  requirePendingLogin(key) {
    const pending = this.pendingLogins.get(key);
    if (!pending || pending.expiresAt < Date.now()) {
      this.pendingLogins.delete(key);
      throw new Error('wecom_login_expired');
    }
    return pending;
  }

  async pollLogin(key) {
    const pending = this.requirePendingLogin(key);
    if (pending.mobileVerification) {
      return { status: 'mobile_verification_required', message: '请输入企业微信发送的手机验证码' };
    }
    if (pending.exchanging) return { status: 'waiting', message: '正在建立企业微信管理会话' };
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

    pending.exchanging = true;
    let login;
    try {
      login = await this.exchangeLogin(String(data.auth_code), key);
    } finally {
      pending.exchanging = false;
    }
    if (login.needsMobileVerification) {
      return { status: 'mobile_verification_required', message: '企业微信要求手机验证，请先点击发送验证码' };
    }
    this.pendingLogins.delete(key);
    await this.refreshQrCode();
    return { status: 'success', message: '管理员登录成功，关注二维码已更新' };
  }

  async exchangeLogin(authCode, key) {
    const first = new URL('/wework_admin/loginpage_wx', WECOM_ADMIN_ORIGIN);
    first.searchParams.set('_r', String(crypto.randomInt(1000)));
    first.searchParams.set('wwqrlogin', '1');
    first.searchParams.set('auth_source', 'SOURCE_FROM_WEWORK');
    first.searchParams.set('code', authCode);
    first.searchParams.set('qrcode_key', key);
    const firstResponse = await fetch(first, { redirect: 'manual', signal: AbortSignal.timeout(10000) });
    const firstLocation = firstResponse.headers.get('location') || '';
    const tmpSid = cookieValue(firstResponse.headers, 'wwrtx.tmp_sid');
    if (!firstLocation || !tmpSid) throw new Error('wecom_temporary_session_missing');

    const second = new URL(absoluteAdminUrl(firstLocation));
    second.searchParams.set('redirect_uri', `${WECOM_ADMIN_ORIGIN}/wework_admin/frame`);
    const secondResponse = await fetch(second, {
      redirect: 'manual',
      headers: { Cookie: `wwrtx.tmp_sid=${tmpSid}` },
      signal: AbortSignal.timeout(10000)
    });
    const sid = cookieValue(secondResponse.headers, 'wwrtx.sid');
    if (!sid) {
      const location = secondResponse.headers.get('location') || '';
      const verificationUrl = location ? new URL(absoluteAdminUrl(location)) : null;
      const tlKey = verificationUrl?.searchParams.get('tl_key') || '';
      if (!tlKey) return { needsMobileVerification: false };
      await fetch(verificationUrl, {
        headers: { Cookie: `wwrtx.tmp_sid=${tmpSid}` },
        signal: AbortSignal.timeout(10000)
      });
      const pending = this.requirePendingLogin(key);
      pending.mobileVerification = {
        tmpSid,
        tlKey,
        referer: verificationUrl.toString()
      };
      return { needsMobileVerification: true };
    }
    this.sid = sid;
    await this.saveState();
    return { needsMobileVerification: false };
  }

  async captchaRequest(key, captcha) {
    const pending = this.requirePendingLogin(key);
    const verification = pending.mobileVerification;
    if (!verification) throw new Error('wecom_mobile_verification_not_pending');
    const response = await fetch(`${WECOM_ADMIN_ORIGIN}/wework_admin/mobile_confirm/confirm_captcha`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cookie': `wwrtx.tmp_sid=${verification.tmpSid}`,
        'Referer': verification.referer
      },
      body: JSON.stringify(captcha ? { captcha, tl_key: verification.tlKey } : { tl_key: verification.tlKey }),
      signal: AbortSignal.timeout(10000)
    });
    const text = await response.text();
    let result;
    try { result = JSON.parse(text); } catch { throw new Error('wecom_invalid_captcha_response'); }
    if (!response.ok) throw new Error(`wecom_captcha_http_${response.status}`);
    return { result, verification };
  }

  async sendMobileCaptcha(key) {
    const { result } = await this.captchaRequest(key, '');
    const error = result?.result;
    if (error) throw new Error(error.humanMessage || error.message || `wecom_captcha_${error.errCode || 'failed'}`);
    return { status: 'mobile_verification_required', message: '验证码已发送，请查看管理员手机' };
  }

  async confirmMobileCaptcha(key, code) {
    const captcha = String(code || '').trim();
    if (!/^\d{4,8}$/.test(captcha)) throw new Error('invalid_captcha');
    const { result, verification } = await this.captchaRequest(key, captcha);
    const error = result?.result;
    if (error) throw new Error(error.humanMessage || error.message || `wecom_captcha_${error.errCode || 'failed'}`);

    const endpoint = new URL('/wework_admin/login/choose_corp', WECOM_ADMIN_ORIGIN);
    endpoint.searchParams.set('tl_key', verification.tlKey);
    const response = await fetch(endpoint, {
      redirect: 'manual',
      headers: { Cookie: `wwrtx.tmp_sid=${verification.tmpSid}` },
      signal: AbortSignal.timeout(10000)
    });
    const sid = cookieValue(response.headers, 'wwrtx.sid');
    if (!sid) throw new Error('wecom_session_cookie_missing');
    this.sid = sid;
    this.pendingLogins.delete(key);
    await this.saveState();
    await this.refreshQrCode();
    return { status: 'success', message: '手机验证成功，关注二维码已更新' };
  }

  async refreshQrCode() {
    if (!this.sid) throw new Error('wecom_admin_login_required');
    const endpoint = new URL('/wework_admin/wxplugin/getDetail', WECOM_ADMIN_ORIGIN);
    const result = await jsonRequest(endpoint, { headers: { Cookie: `wwrtx.sid=${this.sid}` } });
    const qrCode = String(result.data?.qrCode || '');
    if (!qrCode) {
      this.sid = '';
      await this.saveState();
      throw new Error('wecom_admin_session_expired');
    }
    this.qrCode = qrCode;
    this.qrUpdatedAt = Date.now();
    await this.saveState();
    return this.publicStatus();
  }
}

module.exports = { WxPluginManager };
