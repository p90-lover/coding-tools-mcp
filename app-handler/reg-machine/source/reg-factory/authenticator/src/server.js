'use strict';

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');
const { URL } = require('url');

const APP_ROOT = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(APP_ROOT, 'public');
const DATA_DIR = process.env.AUTH_DATA_DIR || path.join(APP_ROOT, 'data');
const VAULT_PATH = path.join(DATA_DIR, 'vault.json');
const HOST = process.env.AUTH_HOST || '127.0.0.1';
const PORT = Number.parseInt(process.env.AUTH_PORT || '8787', 10);
const SESSION_TTL_MS = 15 * 60 * 1000;
const MAX_BODY_BYTES = 32 * 1024;
const KDF_ITERATIONS = 600000;
const IDLE_SHUTDOWN_MS = Number.parseInt(process.env.AUTH_IDLE_SHUTDOWN_MS || '90000', 10);
const IDLE_CHECK_MS = 5000;
const AAD = Buffer.from('local-encrypted-authenticator:v1');

const sessions = new Map();
const attempts = new Map();

function nowIso() {
  return new Date().toISOString();
}

function json(res, status, body) {
  const payload = Buffer.from(JSON.stringify(body));
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': payload.length,
    ...securityHeaders()
  });
  res.end(payload);
}

function securityHeaders() {
  return {
    'cache-control': 'no-store',
    'content-security-policy': "default-src 'self'; base-uri 'none'; object-src 'none'; frame-ancestors 'none'; form-action 'self'; script-src 'self'; style-src 'self'; connect-src 'self'",
    'cross-origin-opener-policy': 'same-origin',
    'cross-origin-resource-policy': 'same-origin',
    'permissions-policy': 'camera=(), microphone=(), geolocation=(), payment=(), usb=()',
    'referrer-policy': 'no-referrer',
    'x-content-type-options': 'nosniff',
    'x-frame-options': 'DENY'
  };
}

function normalizeUsername(username) {
  return String(username || '').trim().toLowerCase();
}

function validatePassword(password) {
  return typeof password === 'string' && password.length >= 12 && password.length <= 256;
}

function validateUsername(username) {
  return /^[a-z0-9._-]{3,64}$/.test(normalizeUsername(username));
}

function safeCompareBase64(a, b) {
  const left = Buffer.from(a || '', 'base64');
  const right = Buffer.from(b || '', 'base64');
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function randomBase64(bytes) {
  return crypto.randomBytes(bytes).toString('base64');
}

function hashUsername(username, saltBase64) {
  return crypto
    .createHash('sha256')
    .update(Buffer.from(saltBase64, 'base64'))
    .update('\0')
    .update(normalizeUsername(username))
    .digest('base64');
}

function deriveKey(username, password, saltBase64, iterations = KDF_ITERATIONS) {
  const material = Buffer.from(`${normalizeUsername(username)}\0${password}`, 'utf8');
  return crypto.pbkdf2Sync(material, Buffer.from(saltBase64, 'base64'), iterations, 32, 'sha512');
}

function encryptVault(vault, key) {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  cipher.setAAD(AAD);
  const encrypted = Buffer.concat([
    cipher.update(JSON.stringify(vault), 'utf8'),
    cipher.final()
  ]);

  return {
    alg: 'aes-256-gcm',
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    data: encrypted.toString('base64')
  };
}

function decryptVault(encryptedVault, key) {
  const decipher = crypto.createDecipheriv(
    'aes-256-gcm',
    key,
    Buffer.from(encryptedVault.iv, 'base64')
  );
  decipher.setAAD(AAD);
  decipher.setAuthTag(Buffer.from(encryptedVault.tag, 'base64'));
  const decrypted = Buffer.concat([
    decipher.update(Buffer.from(encryptedVault.data, 'base64')),
    decipher.final()
  ]);

  const vault = JSON.parse(decrypted.toString('utf8'));
  if (!vault || vault.version !== 1 || !Array.isArray(vault.entries)) {
    throw new Error('Invalid vault format');
  }
  return vault;
}

function loadVaultFile() {
  if (!fs.existsSync(VAULT_PATH)) {
    return null;
  }
  return JSON.parse(fs.readFileSync(VAULT_PATH, 'utf8'));
}

function saveVaultFile(record) {
  fs.mkdirSync(DATA_DIR, { recursive: true, mode: 0o700 });
  const tempPath = `${VAULT_PATH}.${process.pid}.tmp`;
  fs.writeFileSync(tempPath, `${JSON.stringify(record, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tempPath, VAULT_PATH);
}

function createVaultRecord(username, password) {
  if (!validateUsername(username)) {
    throw new Error('Username must be 3-64 characters and use only letters, numbers, dots, dashes, or underscores.');
  }
  if (!validatePassword(password)) {
    throw new Error('Password must be 12-256 characters.');
  }

  const usernameSalt = randomBase64(16);
  const kdfSalt = randomBase64(32);
  const key = deriveKey(username, password, kdfSalt);
  const vault = {
    version: 1,
    createdAt: nowIso(),
    updatedAt: nowIso(),
    entries: []
  };

  return {
    record: {
      version: 1,
      createdAt: nowIso(),
      updatedAt: nowIso(),
      username: {
        normalization: 'trim-lowercase',
        salt: usernameSalt,
        hash: hashUsername(username, usernameSalt)
      },
      kdf: {
        name: 'pbkdf2-sha512',
        iterations: KDF_ITERATIONS,
        salt: kdfSalt,
        keyLength: 32
      },
      vault: encryptVault(vault, key)
    },
    key,
    vault
  };
}

function unlockVault(username, password) {
  const record = loadVaultFile();
  if (!record) {
    throw new Error('Vault is not set up yet.');
  }
  if (!safeCompareBase64(hashUsername(username, record.username.salt), record.username.hash)) {
    throw new Error('Invalid username or password.');
  }

  const key = deriveKey(username, password, record.kdf.salt, record.kdf.iterations);
  try {
    return { record, key, vault: decryptVault(record.vault, key) };
  } catch {
    throw new Error('Invalid username or password.');
  }
}

function persistSessionVault(session) {
  const record = loadVaultFile();
  if (!record) {
    throw new Error('Vault is not set up yet.');
  }
  session.vault.updatedAt = nowIso();
  record.updatedAt = nowIso();
  record.vault = encryptVault(session.vault, session.key);
  saveVaultFile(record);
}

function parseCookies(req) {
  const cookies = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const index = part.indexOf('=');
    if (index === -1) continue;
    cookies[part.slice(0, index).trim()] = decodeURIComponent(part.slice(index + 1).trim());
  }
  return cookies;
}

function makeSession(res, key, vault) {
  const sid = crypto.randomBytes(32).toString('base64url');
  sessions.set(sid, { key, vault, lastSeen: Date.now() });
  res.setHeader('set-cookie', `authenticator_session=${sid}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${Math.floor(SESSION_TTL_MS / 1000)}`);
}

function clearSession(req, res) {
  const sid = parseCookies(req).authenticator_session;
  if (sid) {
    sessions.delete(sid);
  }
  res.setHeader('set-cookie', 'authenticator_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0');
}

function getSession(req) {
  const sid = parseCookies(req).authenticator_session;
  if (!sid) return null;
  const session = sessions.get(sid);
  if (!session) return null;
  if (Date.now() - session.lastSeen > SESSION_TTL_MS) {
    sessions.delete(sid);
    return null;
  }
  session.lastSeen = Date.now();
  return session;
}

function requireSession(req, res) {
  const session = getSession(req);
  if (!session) {
    json(res, 401, { error: 'Login required.' });
    return null;
  }
  return session;
}

function clientKey(req) {
  return req.socket.remoteAddress || 'local';
}

function checkRateLimit(req) {
  const key = clientKey(req);
  const windowMs = 10 * 60 * 1000;
  const current = attempts.get(key) || { count: 0, resetAt: Date.now() + windowMs };
  if (Date.now() > current.resetAt) {
    current.count = 0;
    current.resetAt = Date.now() + windowMs;
  }
  current.count += 1;
  attempts.set(key, current);
  return current.count <= 8;
}

function resetRateLimit(req) {
  attempts.delete(clientKey(req));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    const contentType = String(req.headers['content-type'] || '').split(';')[0].trim();
    if (contentType !== 'application/json') {
      reject(new Error('Expected application/json.'));
      return;
    }

    let size = 0;
    const chunks = [];
    req.on('data', chunk => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch {
        reject(new Error('Invalid JSON body.'));
      }
    });
    req.on('error', reject);
  });
}

function requireAppRequest(req, res) {
  if (req.method === 'GET') return true;
  if (req.headers['x-requested-with'] !== 'local-authenticator') {
    json(res, 403, { error: 'Invalid request source.' });
    return false;
  }
  return true;
}

function base32ToBuffer(input) {
  const clean = String(input || '').toUpperCase().replace(/[\s=-]/g, '');
  if (!clean || !/^[A-Z2-7]+$/.test(clean)) {
    throw new Error('Secret must be valid Base32.');
  }

  let bits = '';
  for (const char of clean) {
    const value = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'.indexOf(char);
    bits += value.toString(2).padStart(5, '0');
  }

  const bytes = [];
  for (let index = 0; index + 8 <= bits.length; index += 8) {
    bytes.push(Number.parseInt(bits.slice(index, index + 8), 2));
  }
  return Buffer.from(bytes);
}

function normalizeSecret(secret) {
  const clean = String(secret || '').toUpperCase().replace(/[\s=-]/g, '');
  base32ToBuffer(clean);
  return clean;
}

function hotp(secret, counter, digits = 6, algorithm = 'SHA1') {
  const key = base32ToBuffer(secret);
  const counterBuffer = Buffer.alloc(8);
  const high = Math.floor(counter / 0x100000000);
  const low = counter >>> 0;
  counterBuffer.writeUInt32BE(high, 0);
  counterBuffer.writeUInt32BE(low, 4);

  const hmac = crypto
    .createHmac(String(algorithm).toLowerCase().replace('-', ''), key)
    .update(counterBuffer)
    .digest();
  const offset = hmac[hmac.length - 1] & 0x0f;
  const code = (
    ((hmac[offset] & 0x7f) << 24) |
    ((hmac[offset + 1] & 0xff) << 16) |
    ((hmac[offset + 2] & 0xff) << 8) |
    (hmac[offset + 3] & 0xff)
  ) % (10 ** digits);

  return String(code).padStart(digits, '0');
}

function totp(secret, options = {}, timestamp = Date.now()) {
  const period = Number(options.period || 30);
  const digits = Number(options.digits || 6);
  const algorithm = String(options.algorithm || 'SHA1').toUpperCase();
  if (![6, 7, 8].includes(digits)) {
    throw new Error('Digits must be 6, 7, or 8.');
  }
  if (![15, 30, 60].includes(period)) {
    throw new Error('Period must be 15, 30, or 60 seconds.');
  }
  if (!['SHA1', 'SHA256', 'SHA512'].includes(algorithm)) {
    throw new Error('Algorithm must be SHA1, SHA256, or SHA512.');
  }

  const seconds = Math.floor(timestamp / 1000);
  const counter = Math.floor(seconds / period);
  return {
    code: hotp(secret, counter, digits, algorithm),
    remaining: period - (seconds % period),
    period,
    digits,
    algorithm
  };
}

function parseOtpAuthUrl(value) {
  if (!value || !String(value).trim().toLowerCase().startsWith('otpauth://')) {
    return null;
  }
  const parsed = new URL(String(value).trim());
  if (parsed.hostname !== 'totp') {
    throw new Error('Only otpauth://totp URLs are supported.');
  }

  const labelText = decodeURIComponent(parsed.pathname.replace(/^\//, ''));
  const parts = labelText.includes(':') ? labelText.split(':') : ['', labelText];
  return {
    issuer: parsed.searchParams.get('issuer') || parts[0] || '',
    label: parts.slice(1).join(':') || labelText,
    secret: parsed.searchParams.get('secret') || '',
    digits: Number(parsed.searchParams.get('digits') || 6),
    period: Number(parsed.searchParams.get('period') || 30),
    algorithm: String(parsed.searchParams.get('algorithm') || 'SHA1').toUpperCase()
  };
}

function normalizeRecoveryCodes(value) {
  if (value === undefined || value === null || value === '') {
    return [];
  }

  const raw = Array.isArray(value) ? value : String(value).split(/\r?\n/);
  const codes = raw
    .map(code => String(code).trim())
    .filter(Boolean);

  if (codes.length > 100) {
    throw new Error('Recovery codes are limited to 100 lines.');
  }
  for (const code of codes) {
    if (code.length > 120) {
      throw new Error('Each recovery code must be 120 characters or less.');
    }
  }

  return codes;
}

function normalizeAccessToken(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  const token = String(value).trim();
  if (token.length > 4096) {
    throw new Error('OAuth token must be 4096 characters or less.');
  }
  return token;
}

function normalizeRecoveryUrl(value) {
  if (value === undefined || value === null || value === '') {
    return '';
  }

  const text = String(value).trim();
  if (text.length > 2048) {
    throw new Error('Recovery fetch URL must be 2048 characters or less.');
  }

  let parsed;
  try {
    parsed = new URL(text);
  } catch {
    throw new Error('Recovery fetch URL must be a valid URL.');
  }

  if (parsed.protocol !== 'https:') {
    throw new Error('Recovery fetch URL must use HTTPS.');
  }

  return parsed.toString();
}

function normalizeOauthDetails(body) {
  return {
    accessToken: normalizeAccessToken(body.oauthToken || body.accessToken),
    recoveryUrl: normalizeRecoveryUrl(body.recoveryUrl)
  };
}

function cleanEntryInput(body) {
  const fromUrl = parseOtpAuthUrl(body.otpauth || body.secret);
  const raw = fromUrl || body;
  const label = String(raw.label || raw.account || '').trim();
  const issuer = String(raw.issuer || '').trim();
  if (!label || label.length > 80) {
    throw new Error('Account label is required and must be 80 characters or less.');
  }
  if (issuer.length > 80) {
    throw new Error('Issuer must be 80 characters or less.');
  }

  const secret = normalizeSecret(raw.secret);
  const options = totp(secret, raw);
  return {
    id: crypto.randomUUID(),
    issuer,
    label,
    secret,
    digits: options.digits,
    period: options.period,
    algorithm: options.algorithm,
    recoveryCodes: [],
    oauth: normalizeOauthDetails(body),
    createdAt: nowIso()
  };
}

function publicEntry(entry) {
  const current = totp(entry.secret, entry);
  const recoveryCodes = Array.isArray(entry.recoveryCodes) ? entry.recoveryCodes : [];
  const oauth = entry.oauth || {};
  return {
    id: entry.id,
    issuer: entry.issuer,
    label: entry.label,
    digits: entry.digits,
    period: entry.period,
    algorithm: entry.algorithm,
    code: current.code,
    remaining: current.remaining,
    hasRecoveryCodes: recoveryCodes.length > 0,
    recoveryCodeCount: recoveryCodes.length,
    hasOauthConfig: Boolean(oauth.accessToken && oauth.recoveryUrl),
    createdAt: entry.createdAt
  };
}

function findEntry(session, id) {
  return session.vault.entries.find(entry => entry.id === id);
}

function publicEntryDetails(entry) {
  const oauth = entry.oauth || {};
  return {
    id: entry.id,
    issuer: entry.issuer,
    label: entry.label,
    recoveryCodes: Array.isArray(entry.recoveryCodes) ? entry.recoveryCodes : [],
    oauthToken: oauth.accessToken || '',
    recoveryUrl: oauth.recoveryUrl || ''
  };
}

function applyEntryDetails(entry, body) {
  entry.recoveryCodes = normalizeRecoveryCodes(body.recoveryCodes);
  entry.oauth = normalizeOauthDetails(body);
}

function extractRecoveryCodesFromPayload(payload) {
  if (!payload) {
    return [];
  }
  if (Array.isArray(payload)) {
    return payload;
  }

  const candidates = [
    payload.recoveryCodes,
    payload.recovery_codes,
    payload.codes,
    payload.backupCodes,
    payload.backup_codes
  ];

  for (const candidate of candidates) {
    if (Array.isArray(candidate)) {
      return candidate;
    }
  }

  if (payload.data && typeof payload.data === 'object') {
    return extractRecoveryCodesFromPayload(payload.data);
  }
  if (payload.result && typeof payload.result === 'object') {
    return extractRecoveryCodesFromPayload(payload.result);
  }

  return [];
}

async function fetchRecoveryCodesFromProvider(entry) {
  const oauth = entry.oauth || {};
  if (!oauth.accessToken) {
    throw new Error('OAuth token is required before fetching recovery codes.');
  }
  if (!oauth.recoveryUrl) {
    throw new Error('Recovery fetch URL is required before fetching recovery codes.');
  }

  const response = await fetch(oauth.recoveryUrl, {
    method: 'GET',
    headers: {
      accept: 'application/json',
      authorization: `Bearer ${oauth.accessToken}`
    }
  });

  if (!response.ok) {
    throw new Error(`Recovery fetch failed with status ${response.status}.`);
  }

  const payload = await response.json().catch(() => {
    throw new Error('Recovery fetch did not return valid JSON.');
  });
  const codes = normalizeRecoveryCodes(extractRecoveryCodesFromPayload(payload));
  if (!codes.length) {
    throw new Error('No recovery codes were found in the provider response.');
  }

  return codes;
}

function routeStatic(req, res, pathname) {
  const relativePath = pathname === '/' ? 'index.html' : pathname.slice(1);
  const fullPath = path.resolve(PUBLIC_DIR, relativePath);
  if (!fullPath.startsWith(`${PUBLIC_DIR}${path.sep}`) && fullPath !== path.join(PUBLIC_DIR, 'index.html')) {
    json(res, 404, { error: 'Not found.' });
    return;
  }

  fs.readFile(fullPath, (error, data) => {
    if (error) {
      json(res, 404, { error: 'Not found.' });
      return;
    }
    const ext = path.extname(fullPath).toLowerCase();
    const types = {
      '.html': 'text/html; charset=utf-8',
      '.css': 'text/css; charset=utf-8',
      '.js': 'application/javascript; charset=utf-8',
      '.svg': 'image/svg+xml'
    };
    res.writeHead(200, {
      'content-type': types[ext] || 'application/octet-stream',
      'content-length': data.length,
      ...securityHeaders()
    });
    res.end(data);
  });
}

async function handleApi(req, res, pathname) {
  if (!requireAppRequest(req, res)) return;

  if (req.method === 'GET' && pathname === '/api/status') {
    json(res, 200, {
      setup: Boolean(loadVaultFile()),
      unlocked: Boolean(getSession(req))
    });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/register') {
    if (loadVaultFile()) {
      json(res, 409, { error: 'Vault already exists.' });
      return;
    }
    if (!checkRateLimit(req)) {
      json(res, 429, { error: 'Too many attempts. Try again later.' });
      return;
    }
    try {
      const body = await readJson(req);
      const { record, key, vault } = createVaultRecord(body.username, body.password);
      saveVaultFile(record);
      makeSession(res, key, vault);
      resetRateLimit(req);
      json(res, 201, { ok: true });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/login') {
    if (!checkRateLimit(req)) {
      json(res, 429, { error: 'Too many attempts. Try again later.' });
      return;
    }
    try {
      const body = await readJson(req);
      const { key, vault } = unlockVault(body.username, body.password);
      makeSession(res, key, vault);
      resetRateLimit(req);
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 401, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname === '/api/logout') {
    clearSession(req, res);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'GET' && pathname === '/api/entries') {
    const session = requireSession(req, res);
    if (!session) return;
    json(res, 200, { entries: session.vault.entries.map(publicEntry) });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/entries') {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const body = await readJson(req);
      const entry = cleanEntryInput(body);
      session.vault.entries.push(entry);
      persistSessionVault(session);
      json(res, 201, { entry: publicEntry(entry) });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/entries/') && pathname.endsWith('/details')) {
    const session = requireSession(req, res);
    if (!session) return;
    const id = pathname.split('/').at(-2);
    const entry = findEntry(session, id);
    if (!entry) {
      json(res, 404, { error: 'Entry not found.' });
      return;
    }
    json(res, 200, publicEntryDetails(entry));
    return;
  }

  if (req.method === 'PATCH' && pathname.startsWith('/api/entries/') && pathname.endsWith('/details')) {
    const session = requireSession(req, res);
    if (!session) return;
    const id = pathname.split('/').at(-2);
    const entry = findEntry(session, id);
    if (!entry) {
      json(res, 404, { error: 'Entry not found.' });
      return;
    }
    try {
      const body = await readJson(req);
      applyEntryDetails(entry, body);
      persistSessionVault(session);
      json(res, 200, publicEntryDetails(entry));
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'POST' && pathname.startsWith('/api/entries/') && pathname.endsWith('/fetch-recovery')) {
    const session = requireSession(req, res);
    if (!session) return;
    const id = pathname.split('/').at(-2);
    const entry = findEntry(session, id);
    if (!entry) {
      json(res, 404, { error: 'Entry not found.' });
      return;
    }
    try {
      entry.recoveryCodes = await fetchRecoveryCodesFromProvider(entry);
      persistSessionVault(session);
      json(res, 200, publicEntryDetails(entry));
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  if (req.method === 'GET' && pathname.startsWith('/api/entries/') && pathname.endsWith('/recovery')) {
    const session = requireSession(req, res);
    if (!session) return;
    const id = pathname.split('/').at(-2);
    const entry = findEntry(session, id);
    if (!entry) {
      json(res, 404, { error: 'Entry not found.' });
      return;
    }
    json(res, 200, {
      issuer: entry.issuer,
      label: entry.label,
      recoveryCodes: Array.isArray(entry.recoveryCodes) ? entry.recoveryCodes : []
    });
    return;
  }

  if (req.method === 'DELETE' && pathname.startsWith('/api/entries/')) {
    const session = requireSession(req, res);
    if (!session) return;
    const id = pathname.split('/').pop();
    const before = session.vault.entries.length;
    session.vault.entries = session.vault.entries.filter(entry => entry.id !== id);
    if (session.vault.entries.length === before) {
      json(res, 404, { error: 'Entry not found.' });
      return;
    }
    persistSessionVault(session);
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === 'POST' && pathname === '/api/change-password') {
    const session = requireSession(req, res);
    if (!session) return;
    try {
      const body = await readJson(req);
      const current = loadVaultFile();
      if (!current) throw new Error('Vault is not set up yet.');
      unlockVault(body.currentUsername, body.currentPassword);
      if (!validateUsername(body.username)) throw new Error('Username is invalid.');
      if (!validatePassword(body.password)) throw new Error('Password must be 12-256 characters.');

      const usernameSalt = randomBase64(16);
      const kdfSalt = randomBase64(32);
      const key = deriveKey(body.username, body.password, kdfSalt);
      current.username = {
        normalization: 'trim-lowercase',
        salt: usernameSalt,
        hash: hashUsername(body.username, usernameSalt)
      };
      current.kdf = {
        name: 'pbkdf2-sha512',
        iterations: KDF_ITERATIONS,
        salt: kdfSalt,
        keyLength: 32
      };
      current.updatedAt = nowIso();
      current.vault = encryptVault(session.vault, key);
      saveVaultFile(current);
      session.key = key;
      json(res, 200, { ok: true });
    } catch (error) {
      json(res, 400, { error: error.message });
    }
    return;
  }

  json(res, 404, { error: 'Not found.' });
}

function createServer() {
  let lastActivityAt = Date.now();
  let idleTimer = null;
  let shuttingDown = false;
  const sockets = new Set();

  const server = http.createServer((req, res) => {
    lastActivityAt = Date.now();
    const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
    if (url.pathname.startsWith('/api/')) {
      handleApi(req, res, url.pathname).catch(error => {
        json(res, 500, { error: error.message || 'Internal server error.' });
      });
      return;
    }
    if (req.method !== 'GET') {
      json(res, 405, { error: 'Method not allowed.' });
      return;
    }
    routeStatic(req, res, url.pathname);
  });

  function shutdownIfIdle() {
    if (shuttingDown) {
      return;
    }
    if (Date.now() - lastActivityAt < IDLE_SHUTDOWN_MS) {
      return;
    }

    shuttingDown = true;
    clearInterval(idleTimer);
    server.close(() => {
      process.exit(0);
    });
    for (const socket of sockets) {
      socket.destroy();
    }
    setTimeout(() => process.exit(0), 2000).unref();
  }

  server.on('connection', socket => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
  });

  idleTimer = setInterval(shutdownIfIdle, IDLE_CHECK_MS);
  idleTimer.unref();

  return server;
}

function start() {
  if (HOST !== '127.0.0.1' && HOST !== 'localhost') {
    throw new Error('Refusing to bind outside loopback. Set AUTH_HOST=127.0.0.1 or localhost.');
  }
  createServer().listen(PORT, HOST, () => {
    console.log(`Encrypted authenticator running at http://${HOST}:${PORT}`);
  });
}

if (require.main === module) {
  start();
}

module.exports = {
  base32ToBuffer,
  cleanEntryInput,
  createServer,
  createVaultRecord,
  decryptVault,
  deriveKey,
  encryptVault,
  hashUsername,
  hotp,
  normalizeSecret,
  parseOtpAuthUrl,
  totp,
  unlockVault
};
