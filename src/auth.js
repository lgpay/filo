// src/auth.js — 基于 Web Crypto 的密码鉴权（无 Node crypto 依赖）。
//
// 令牌 = HMAC-SHA256(secret='filo|'+FILO_ACCESS_PASSWORD, msg='authed')。
// 登录时校验密码 == FILO_ACCESS_PASSWORD，成功则下发令牌 cookie。

const COOKIE = 'filo_auth';

const PASSWORD_KEY = 'ACCESS_PASSWORD';

function accessPassword(env) {
  return String(env[PASSWORD_KEY] || '');
}

export function authEnabled(env) {
  return accessPassword(env).length > 0;
}

// 常数时间字符串比较（防时序攻击）
function timingSafeEqualStr(a, b) {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
export function timingSafeEqual(a, b) {
  return timingSafeEqualStr(a, b);
}

export function verifyPassword(env, pw) {
  if (!authEnabled(env)) return false;
  return timingSafeEqualStr(accessPassword(env), pw);
}

async function hmac(secret, msg) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(msg));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function tokenFor(env) {
  return hmac('filo|' + accessPassword(env), 'authed');
}

export function getCookie(request, name) {
  const raw = request.headers.get('Cookie') || '';
  for (const part of raw.split(';')) {
    const i = part.indexOf('=');
    if (i < 0) continue;
    const k = part.slice(0, i).trim();
    const val = part.slice(i + 1).trim();
    if (k === name) return decodeURIComponent(val);
  }
  return null;
}

export async function isAuthed(request, env) {
  if (!authEnabled(env)) return true;
  const c = getCookie(request, COOKIE);
  if (!c) return false;
  const expected = await tokenFor(env);
  return timingSafeEqualStr(c, expected);
}

// 写鉴权 cookie（value 为空表示清除）
export function setAuthCookie(headers, token) {
  const maxAge = token ? 60 * 60 * 24 * 30 : 0; // 30 天
  const parts = [`${COOKIE}=${token || ''}`, 'Path=/', `Max-Age=${maxAge}`, 'HttpOnly', 'SameSite=Lax'];
  if (!token) parts.push('Expires=Thu, 01 Jan 1970 00:00:00 GMT');
  headers.append('Set-Cookie', parts.join('; '));
}
