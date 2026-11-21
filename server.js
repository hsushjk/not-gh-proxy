'use strict';

const http = require('http');
const https = require('https');
const net = require('net');
const dns = require('dns');
const express = require('express');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
const { URL } = require('url');

const CONFIG_PATH = path.join(__dirname, 'config.json');

const DEFAULT_CONFIG = {
  port: 3000,
  host: '0.0.0.0',
  trustProxy: '',
  site: {
    name: 'not-gh-proxy',
    title: 'not-gh-proxy',
    subtitle: 'Powered by not-gh-proxy'
  },
  dirs: {
    static: './public',
    logs: './logs'
  },
  log: {
    file: true,
    console: true,
    keepDays: 7
  },
  proxy: {
    timeout: 120000,
    maxRedirects: 5,
    userAgent: 'not-gh-proxy/1.0'
  },
  openProxy: {
    enabled: false,
    path: '1a2b3c4d',
    blockPrivateNetwork: true
  },
  allowedDomains: [
    'github.com',
    'raw.githubusercontent.com',
    'api.github.com',
    'gist.github.com',
    'gist.githubusercontent.com',
    'avatars.githubusercontent.com',
    'desktop.githubusercontent.com',
    'codeload.github.com',
    'objects.githubusercontent.com',
    'camo.githubusercontent.com',
    'media.githubusercontent.com',
    'user-images.githubusercontent.com',
    'private-user-images.githubusercontent.com',
    'github.githubassets.com',
    'githubusercontent.com',
    'githubassets.com',
    'release-assets.githubusercontent.com',
    'github-releases.githubusercontent.com'
  ]
};

function deepMerge(base, override) {
  const out = Array.isArray(base) ? base.slice() : Object.assign({}, base);
  if (!override || typeof override !== 'object') return out;
  Object.keys(override).forEach(function (key) {
    const bv = out[key];
    const ov = override[key];
    if (bv && typeof bv === 'object' && !Array.isArray(bv) &&
        ov && typeof ov === 'object' && !Array.isArray(ov)) {
      out[key] = deepMerge(bv, ov);
    } else if (ov !== undefined) {
      out[key] = ov;
    }
  });
  return out;
}

function loadConfig() {
  if (!fs.existsSync(CONFIG_PATH)) {
    try {
      fs.writeFileSync(CONFIG_PATH, JSON.stringify(DEFAULT_CONFIG, null, 2), 'utf8');
      console.log('[config] config.json not found, wrote default: ' + CONFIG_PATH);
    } catch (e) {
      console.warn('[config] cannot write default config: ' + e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  let userCfg;
  try {
    userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[config] parse config.json failed: ' + e.message);
    process.exit(1);
  }

  return deepMerge(DEFAULT_CONFIG, userCfg);
}

const CONFIG = loadConfig();

function normalizePathSegment(p) {
  return String(p == null ? '' : p).replace(/^\/+/, '').replace(/\/+$/, '');
}

function resolveDir(input, fallback) {
  if (!input) return fallback;
  return path.isAbsolute(input) ? input : path.resolve(__dirname, input);
}

const PORT = Number(CONFIG.port) || 3000;
const HOST = CONFIG.host || '0.0.0.0';
const TRUST_PROXY = CONFIG.trustProxy || '';

const SITE_NAME = CONFIG.site.name || 'not-gh-proxy';
const SITE_TITLE = CONFIG.site.title || SITE_NAME;
const SITE_SUBTITLE = CONFIG.site.subtitle || '';

const STATIC_DIR = resolveDir(CONFIG.dirs.static, path.join(__dirname, 'public'));
const LOG_DIR = resolveDir(CONFIG.dirs.logs, path.join(__dirname, 'logs'));
const ENABLE_FILE_LOG = CONFIG.log.file !== false;
const CONSOLE_LOG = CONFIG.log.console !== false;
const LOG_KEEP_DAYS = Number(CONFIG.log.keepDays) > 0 ? Number(CONFIG.log.keepDays) : 7;

const PROXY_TIMEOUT = Number(CONFIG.proxy.timeout) > 0 ? Number(CONFIG.proxy.timeout) : 120000;
const MAX_REDIRECTS = Number.isFinite(Number(CONFIG.proxy.maxRedirects))
  ? Number(CONFIG.proxy.maxRedirects) : 5;
const USER_AGENT = CONFIG.proxy.userAgent || 'not-gh-proxy/1.0';

const ENABLE_OPEN_PROXY = CONFIG.openProxy.enabled === true;
const OPEN_PROXY_PATH = normalizePathSegment(CONFIG.openProxy.path || '1a2b3c4d');
const BLOCK_PRIVATE_NETWORK = CONFIG.openProxy.blockPrivateNetwork !== false;

const ALLOWED_DOMAINS = (Array.isArray(CONFIG.allowedDomains) ? CONFIG.allowedDomains : [])
  .map(function (s) { return String(s).trim().toLowerCase(); })
  .filter(Boolean);

function isPrivateIpv4(h) {
  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (!m) return false;
  const a = parseInt(m[1], 10);
  const b = parseInt(m[2], 10);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 192 && b === 0) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a >= 224) return true;
  return false;
}

// Parse any IPv6 textual form (::, full, embedded IPv4, zone id) into 8 words.
function parseIpv6Words(input) {
  let s = String(input).toLowerCase();
  const zone = s.indexOf('%');
  if (zone !== -1) s = s.slice(0, zone);

  let v4Tail = null;
  const lastColon = s.lastIndexOf(':');
  if (lastColon !== -1 && s.indexOf('.', lastColon) !== -1) {
    const parts = s.slice(lastColon + 1).split('.');
    if (parts.length !== 4) return null;
    const nums = [];
    for (let i = 0; i < 4; i++) {
      if (!/^\d{1,3}$/.test(parts[i])) return null;
      const n = Number(parts[i]);
      if (n < 0 || n > 255) return null;
      nums.push(n);
    }
    v4Tail = [(nums[0] << 8) | nums[1], (nums[2] << 8) | nums[3]];
    s = s.slice(0, lastColon + 1) + '0:0';
  }

  const halves = s.split('::');
  if (halves.length > 2) return null;
  const left = halves[0] ? halves[0].split(':') : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(':') : [];
  const hex = /^[0-9a-f]{1,4}$/;
  for (let i = 0; i < left.length; i++) if (!hex.test(left[i])) return null;
  for (let i = 0; i < right.length; i++) if (!hex.test(right[i])) return null;

  const missing = 8 - left.length - right.length;
  if (halves.length === 2 && missing < 1) return null;
  if (halves.length === 1 && missing !== 0) return null;

  const words = [];
  for (let i = 0; i < left.length; i++) words.push(parseInt(left[i], 16));
  for (let i = 0; i < missing; i++) words.push(0);
  for (let i = 0; i < right.length; i++) words.push(parseInt(right[i], 16));
  if (words.length !== 8) return null;
  if (v4Tail) {
    words[6] = v4Tail[0];
    words[7] = v4Tail[1];
  }
  return words;
}

function wordsToIpv4(w) {
  return [w[6] >> 8, w[6] & 255, w[7] >> 8, w[7] & 255].join('.');
}

function isPrivateIp(ip) {
  if (!ip) return true;
  let h = String(ip).trim().toLowerCase();
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1);

  if (h.indexOf(':') === -1) return isPrivateIpv4(h);

  const w = parseIpv6Words(h);
  if (!w) return true; // fail closed on unparsable IPv6

  let allZero = true;
  for (let i = 0; i < 8; i++) if (w[i] !== 0) { allZero = false; break; }
  if (allZero) return true; // ::
  if (w[7] === 1 && w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0) {
    return true; // ::1
  }

  const firstFiveZero = w[0] === 0 && w[1] === 0 && w[2] === 0 && w[3] === 0 && w[4] === 0;
  if (firstFiveZero && (w[5] === 0xffff || w[5] === 0)) {
    return isPrivateIpv4(wordsToIpv4(w)); // IPv4-mapped / IPv4-compatible
  }
  if (w[0] === 0x2002) return isPrivateIpv4(wordsToIpv4(w)); // 6to4 2002::/16

  const nat64 = w[0] === 0x0064 && w[1] === 0xff9b && w[2] === 0 && w[3] === 0 && w[4] === 0 && w[5] === 0;
  if (nat64) return isPrivateIpv4(wordsToIpv4(w)); // 64:ff9b::/96

  if ((w[0] & 0xfe00) === 0xfc00) return true; // fc00::/7 unique local
  if ((w[0] & 0xffc0) === 0xfe80) return true; // fe80::/10 link local
  if ((w[0] & 0xff00) === 0xff00) return true; // ff00::/8 multicast
  return false;
}

function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;
  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '[::]' || h === '::') return true;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(h)) return isPrivateIp(h);
  if (h.indexOf(':') !== -1) {
    const v6 = h.replace(/^\[|\]$/g, '');
    return isPrivateIp(v6);
  }
  return false;
}

function makeSecureLookup(enabled) {
  return function secureLookup(hostname, options, callback) {
    dns.lookup(hostname, options, function (err, address, family) {
      if (err) return callback(err);
      if (!enabled) return callback(null, address, family);

      if (options && options.all) {
        const kept = [];
        for (let i = 0; i < address.length; i++) {
          const a = address[i];
          if (isPrivateIp(a.address)) {
            return callback(new Error('DNS resolved to private address: ' + hostname + ' -> ' + a.address));
          }
          kept.push(a);
        }
        if (kept.length === 0) {
          return callback(new Error('DNS has no usable address: ' + hostname));
        }
        return callback(null, kept);
      }

      if (isPrivateIp(address)) {
        return callback(new Error('DNS resolved to private address: ' + hostname + ' -> ' + address));
      }
      callback(null, address, family);
    });
  };
}

const secureLookup = makeSecureLookup(BLOCK_PRIVATE_NETWORK);
const AGENT_OPTIONS = {
  lookup: secureLookup,
  keepAlive: true,
  maxSockets: 64,
  maxFreeSockets: 16
};
const httpAgent = new http.Agent(Object.assign({}, AGENT_OPTIONS));
const httpsAgent = new https.Agent(Object.assign({}, AGENT_OPTIONS));

const app = express();
app.disable('x-powered-by');

// Security headers for every response. Deliberately no CORS: this proxy is
// same-origin for the bundled UI, and a wildcard CORS policy would let any web
// page use it as an anonymous relay.
const SECURITY_HEADERS = {
  'X-Content-Type-Options': 'nosniff',
  'Referrer-Policy': 'no-referrer',
  'X-Frame-Options': 'DENY',
  'Permissions-Policy': 'geolocation=(), microphone=(), camera=()'
};

// Only sent for HTML we serve ourselves; proxied pages must keep their own CSP.
const PAGE_CSP = "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; " +
  "script-src 'self' 'unsafe-inline'; connect-src 'self'; base-uri 'none'; " +
  "form-action 'self'; frame-ancestors 'none'";

if (TRUST_PROXY) {
  app.set('trust proxy', TRUST_PROXY === 'true' ? true : TRUST_PROXY);
}

if (ENABLE_FILE_LOG && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

const SENSITIVE_QUERY_RE = /([?&])(access_token|refresh_token|id_token|client_secret|private_token|token|auth|authorization|password|passwd|secret|api_key|apikey|key|signature|sig|x-amz-signature|x-amz-credential|session|jwt|assertion|code|state)=([^&#\s"']*)/gi;
const ENCODED_URL_PARAM_RE = /([?&]url=)([^&"\s]*)/gi;

// Mask credentials in tokens, cookies, signed URLs and userinfo before logging.
function redactUrl(input) {
  if (typeof input !== 'string') return input;
  const masked = input.replace(SENSITIVE_QUERY_RE, function (m, sep, name) {
    return sep + name + '=***';
  });
  return masked.replace(/\/\/[^/@\s]+@/g, '//***@');
}

// Raw request URLs keep the nested target percent-encoded (?url=https%3A%2F%2F...),
// so the plain regex above cannot see the secret inside it. Decode, mask, re-encode.
function redactRawUrl(input) {
  if (typeof input !== 'string') return input;
  return input.replace(ENCODED_URL_PARAM_RE, function (m, prefix, value) {
    let decoded = value;
    try { decoded = decodeURIComponent(value); } catch (e) {}
    return prefix + encodeURIComponent(redactUrl(decoded));
  });
}

let logStream = null;
let logStreamDate = null;

function pruneLogFiles() {
  if (!ENABLE_FILE_LOG) return;
  fs.readdir(LOG_DIR, function (err, files) {
    if (err || !files) return;
    const names = files.filter(function (f) {
      return /^(?:not-gh-proxy|ghproxy)-\d{4}-\d{2}-\d{2}\.log$/.test(f);
    }).sort();
    const excess = names.length - LOG_KEEP_DAYS;
    for (let i = 0; i < excess; i++) {
      fs.unlink(path.join(LOG_DIR, names[i]), function () {});
    }
  });
}

function getLogStream(dateStr) {
  if (logStream && logStreamDate === dateStr && !logStream.destroyed) return logStream;
  if (logStream && !logStream.destroyed) {
    try { logStream.end(); } catch (e) {}
  }
  logStreamDate = dateStr;
  logStream = fs.createWriteStream(
    path.join(LOG_DIR, 'not-gh-proxy-' + dateStr + '.log'),
    { flags: 'a' }
  );
  logStream.on('error', function () {
    logStream = null;
    logStreamDate = null;
  });
  pruneLogFiles();
  return logStream;
}

function writeLog(level, message, data) {
  const timestamp = new Date().toISOString();
  let logEntry = '[' + timestamp + '] [' + level + '] ' + redactRawUrl(redactUrl(message));
  if (data) logEntry += ' | ' + redactRawUrl(redactUrl(JSON.stringify(data)));

  if (CONSOLE_LOG) {
    if (level === 'ERROR') console.error(logEntry);
    else if (level === 'WARN') console.warn(logEntry);
    else console.log(logEntry);
  }
  if (!ENABLE_FILE_LOG) return;

  try {
    getLogStream(timestamp.slice(0, 10)).write(logEntry + '\n');
  } catch (e) {}
}

function isAllowedGitHubUrl(input) {
  if (typeof input !== 'string' || input.length === 0) return false;

  let u;
  try {
    u = new URL(input);
  } catch (e) {
    return false;
  }

  if (u.protocol !== 'http:' && u.protocol !== 'https:') return false;

  const host = u.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) return false;

  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return false;
  if (host.indexOf(':') !== -1) return false;

  for (let i = 0; i < ALLOWED_DOMAINS.length; i++) {
    const domain = ALLOWED_DOMAINS[i];
    if (host === domain) return true;
    if (host.length > domain.length && host.slice(-(domain.length + 1)) === '.' + domain) {
      return true;
    }
  }
  return false;
}

function isBlockedTarget(targetUrl) {
  if (!BLOCK_PRIVATE_NETWORK) return false;
  try {
    const u = new URL(targetUrl);
    return isPrivateHostname(u.hostname);
  } catch (e) {
    return true;
  }
}

const stats = {
  totalRequests: 0,
  proxyRequests: 0,
  errors: 0,
  startTime: new Date().toISOString(),
  lastRequestTime: null,
  dailyStats: {}
};

function getTodayKey() {
  return new Date().toISOString().slice(0, 10);
}

function getTodayStats() {
  const today = getTodayKey();
  if (!stats.dailyStats[today]) {
    stats.dailyStats[today] = { requests: 0, proxy: 0, errors: 0 };
  }
  return stats.dailyStats[today];
}

function pruneDailyStats(keepDays) {
  const keys = Object.keys(stats.dailyStats).sort();
  const limit = keys.length - (keepDays || 7);
  for (let i = 0; i < limit; i++) {
    delete stats.dailyStats[keys[i]];
  }
}

app.use(function (req, res, next) {
  for (const name in SECURITY_HEADERS) res.setHeader(name, SECURITY_HEADERS[name]);
  next();
});

app.use(function (req, res, next) {
  const startTime = Date.now();

  stats.totalRequests++;
  stats.lastRequestTime = new Date().toISOString();
  getTodayStats().requests++;

  res.on('finish', function () {
    const duration = Date.now() - startTime;
    const logData = {
      method: req.method,
      url: req.url,
      ip: req.ip || (req.socket && req.socket.remoteAddress),
      status: res.statusCode,
      duration: duration + 'ms',
      userAgent: req.headers['user-agent'] || 'unknown'
    };

    if (res.statusCode >= 400) {
      writeLog('ERROR', 'request failed', logData);
    } else if (req.url.indexOf('http://') !== -1 || req.url.indexOf('https://') !== -1) {
      writeLog('INFO', 'proxy request', logData);
    } else {
      writeLog('DEBUG', 'static request', logData);
    }
  });

  next();
});

const FORWARD_RES_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'content-encoding',
  'content-range',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control',
  'location',
  'git-protocol',
  'www-authenticate',
  'x-ratelimit-limit',
  'x-ratelimit-remaining',
  'x-ratelimit-reset',
  'x-ratelimit-used',
  'x-ratelimit-resource',
  'retry-after',
  'link',
  'x-github-request-id'
];

const PASS_REQ_HEADERS = [
  'range',
  'if-match',
  'if-none-match',
  'if-modified-since',
  'if-unmodified-since',
  'if-range',
  'content-type',
  'authorization',
  'proxy-authorization',
  'cookie',
  'git-protocol',
  'x-git-protocol'
];

const HOP_BY_HOP_HEADERS = {
  'connection': true,
  'keep-alive': true,
  'proxy-authenticate': true,
  'proxy-authorization': true,
  'te': true,
  'trailer': true,
  'transfer-encoding': true,
  'upgrade': true
};

const REDIRECT_STATUSES = [301, 302, 303, 307, 308];
const CREDENTIAL_HEADERS = ['authorization', 'proxy-authorization', 'cookie'];

const MAX_BUFFER_BODY = 16 * 1024 * 1024;

// Credentials may only be replayed to the exact same origin (scheme + host + port).
// Comparing hostname alone would keep Authorization on an https -> http downgrade.
function sameOrigin(a, b) {
  try {
    const ua = new URL(a);
    const ub = new URL(b);
    return ua.origin === ub.origin;
  } catch (e) {
    return false;
  }
}

function readBody(req, maxBytes) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let total = 0;
    let finished = false;
    function finish(err, buf) {
      if (finished) return;
      finished = true;
      if (err) reject(err); else resolve(buf);
    }
    req.on('data', function (c) {
      if (finished) return;
      total += c.length;
      if (total > maxBytes) {
        req.removeAllListeners('data');
        finish(new Error('BODY_TOO_LARGE'));
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () { finish(null, Buffer.concat(chunks, total)); });
    req.on('error', function (e) { finish(e); });
  });
}

async function proxyRequest(req, res, targetUrl, options) {
  const startTime = Date.now();
  stats.proxyRequests++;
  getTodayStats().proxy++;

  const strictMode = !options || options.strict !== false;

  if (isBlockedTarget(targetUrl)) {
    stats.errors++;
    getTodayStats().errors++;
    writeLog('WARN', 'blocked private target: ' + targetUrl);
    if (!res.headersSent) {
      res.status(403).json({ error: 'private address not allowed' });
    }
    return;
  }
  if (strictMode && !isAllowedGitHubUrl(targetUrl)) {
    stats.errors++;
    getTodayStats().errors++;
    writeLog('WARN', 'blocked non-whitelist target: ' + targetUrl);
    if (!res.headersSent) {
      res.status(403).json({ error: 'only GitHub links allowed' });
    }
    return;
  }

  // Abort the upstream request as soon as the client goes away, instead of
  // letting the socket keep streaming into a dead response.
  const controller = new AbortController();
  res.on('close', function () {
    if (!res.writableEnded) controller.abort();
  });

  const method = (req.method || 'GET').toUpperCase();
  const hasBody = method !== 'GET' && method !== 'HEAD';
  const canFollowRedirect = method === 'GET' || method === 'HEAD';

  writeLog('INFO', 'proxy start: ' + method + ' ' + targetUrl);

  const baseHeaders = {
    'User-Agent': USER_AGENT,
    'Accept': req.headers['accept'] || '*/*',
    'Accept-Encoding': req.headers['accept-encoding'] || 'identity',
    'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9'
  };

  if (!strictMode) {
    for (const k in req.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS[lk]) continue;
      if (lk === 'host') continue;
      if (lk === 'proxy-connection') continue;
      if (lk.indexOf('x-forwarded-') === 0) continue;
      baseHeaders[k] = req.headers[k];
    }
  } else {
    for (let i = 0; i < PASS_REQ_HEADERS.length; i++) {
      const h = PASS_REQ_HEADERS[i];
      if (req.headers[h] !== undefined) {
        baseHeaders[h] = req.headers[h];
      }
    }
  }

  delete baseHeaders['host'];
  delete baseHeaders['Host'];
  delete baseHeaders['content-length'];
  delete baseHeaders['Content-Length'];
  delete baseHeaders['proxy-connection'];
  delete baseHeaders['Proxy-Connection'];

  let bodyData = null;
  if (hasBody) {
    const cl = parseInt(req.headers['content-length'] || '0', 10);
    if (cl > 0 && cl <= MAX_BUFFER_BODY) {
      try {
        const buf = await readBody(req, MAX_BUFFER_BODY);
        bodyData = buf;
      } catch (e) {
        stats.errors++;
        getTodayStats().errors++;
        writeLog('ERROR', 'read body failed: ' + targetUrl, { message: e.message });
        try { req.resume(); } catch (e2) {}
        if (!res.headersSent) res.status(400).json({ error: 'read body failed' });
        return;
      }
    } else {
      bodyData = req;
    }
  }

  // Streaming path used to drop Content-Length and silently switch the request
  // to chunked encoding. Keep the client's framing when it declared a length.
  if (hasBody && bodyData === req && req.headers['content-length'] !== undefined) {
    baseHeaders['content-length'] = req.headers['content-length'];
  }

  let currentUrl = targetUrl;
  let redirectCount = 0;
  let upstream = null;
  let lastError = null;

  while (true) {
    if (redirectCount > 0) {
      if (isBlockedTarget(currentUrl)) {
        stats.errors++;
        getTodayStats().errors++;
        writeLog('WARN', 'blocked redirect to private: ' + currentUrl);
        if (!res.headersSent) {
          res.status(403).json({ error: 'redirect to private address not allowed' });
        }
        return;
      }
      if (strictMode && !isAllowedGitHubUrl(currentUrl)) {
        stats.errors++;
        getTodayStats().errors++;
        writeLog('WARN', 'blocked redirect to non-whitelist: ' + currentUrl);
        if (!res.headersSent) {
          res.status(403).json({ error: 'redirect target not allowed' });
        }
        return;
      }
    }

    const reqHeaders = Object.assign({}, baseHeaders);

    const axiosOpts = {
      method: method,
      url: currentUrl,
      responseType: 'stream',
      decompress: false,
      timeout: PROXY_TIMEOUT,
      signal: controller.signal,
      maxRedirects: 0,
      validateStatus: function () { return true; },
      headers: reqHeaders,
      httpAgent: httpAgent,
      httpsAgent: httpsAgent
    };

    if (hasBody && redirectCount === 0 && bodyData !== null) {
      axiosOpts.data = bodyData;
    }

    try {
      upstream = await axios(axiosOpts);
    } catch (error) {
      if (controller.signal.aborted) return; // client already gone
      lastError = error;
      upstream = null;
      break;
    }

    const location = upstream.headers && upstream.headers['location'];
    const isRedirect = REDIRECT_STATUSES.indexOf(upstream.status) !== -1 &&
                       location && canFollowRedirect;

    if (!isRedirect) break;

    if (redirectCount >= MAX_REDIRECTS) {
      writeLog('WARN', 'too many redirects: ' + currentUrl + ' -> ' + location);
      break;
    }

    let nextUrl;
    try {
      nextUrl = new URL(location, currentUrl).toString();
    } catch (e) {
      writeLog('WARN', 'cannot parse Location: ' + location);
      break;
    }

    try {
      if (upstream.data) {
        if (typeof upstream.data.resume === 'function') upstream.data.resume();
        if (typeof upstream.data.destroy === 'function') upstream.data.destroy();
      }
    } catch (e) {}

    if (!sameOrigin(currentUrl, nextUrl)) {
      for (let i = 0; i < CREDENTIAL_HEADERS.length; i++) {
        delete baseHeaders[CREDENTIAL_HEADERS[i]];
      }
    }

    writeLog('INFO', 'proxy redirect: ' + currentUrl + ' -> ' + nextUrl);
    currentUrl = nextUrl;
    redirectCount++;
    upstream = null;
  }

  if (!upstream) {
    stats.errors++;
    getTodayStats().errors++;

    const msg = lastError ? lastError.message : 'no response after redirect';
    const isPrivateDns = /private address/.test(msg);

    writeLog('ERROR', 'proxy failed: ' + targetUrl, {
      message: msg,
      duration: (Date.now() - startTime) + 'ms'
    });

    if (hasBody && bodyData === req && typeof req.resume === 'function') {
      try { req.resume(); } catch (e) {}
    }

    if (!res.headersSent) {
      if (isPrivateDns) {
        res.status(403).json({ error: 'private address not allowed', message: msg });
      } else {
        res.status(502).json({
          error: 'proxy failed',
          message: msg,
          url: targetUrl
        });
      }
    }
    return;
  }

  for (let i = 0; i < FORWARD_RES_HEADERS.length; i++) {
    const h = FORWARD_RES_HEADERS[i];
    if (upstream.headers[h] !== undefined) {
      res.setHeader(h, upstream.headers[h]);
    }
  }

  res.status(upstream.status);

  upstream.data.on('error', function (err) {
    writeLog('ERROR', 'upstream stream error: ' + currentUrl, { message: err.message });
    if (!res.headersSent) {
      res.status(502).json({ error: 'upstream stream error' });
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  });

  res.on('close', function () {
    if (!res.writableEnded) {
      try { upstream.data.destroy(); } catch (e) {}
    }
  });

  res.on('finish', function () {
    writeLog('INFO', 'proxy done: ' + targetUrl, {
      duration: (Date.now() - startTime) + 'ms',
      status: upstream.status,
      redirects: redirectCount
    });
  });

  upstream.data.pipe(res);
}

function handleConnect(req, clientSocket, head) {
  const startTime = Date.now();

  if (!ENABLE_OPEN_PROXY) {
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  stats.proxyRequests++;
  getTodayStats().proxy++;

  let host, port;
  try {
    const idx = req.url.lastIndexOf(':');
    const rawPort = idx === -1 ? '443' : req.url.slice(idx + 1);
    host = idx === -1 ? req.url : req.url.slice(0, idx);
    port = /^\d{1,5}$/.test(rawPort) ? parseInt(rawPort, 10) : NaN;
  } catch (e) {
    host = '';
    port = NaN;
  }

  if (!host || !Number.isInteger(port) || port < 1 || port > 65535) {
    clientSocket.write('HTTP/1.1 400 Bad Request\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  if (isPrivateHostname(host)) {
    stats.errors++;
    getTodayStats().errors++;
    writeLog('WARN', 'CONNECT blocked private: ' + host + ':' + port);
    clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
    clientSocket.destroy();
    return;
  }

  dns.lookup(host, { all: true }, function (err, addresses) {
    if (err || !addresses || addresses.length === 0) {
      stats.errors++;
      getTodayStats().errors++;
      writeLog('ERROR', 'CONNECT DNS failed: ' + host, { message: err && err.message });
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      return;
    }
    for (let i = 0; i < addresses.length; i++) {
      if (isPrivateIp(addresses[i].address)) {
        stats.errors++;
        getTodayStats().errors++;
        writeLog('WARN', 'CONNECT DNS private: ' + host + ' -> ' + addresses[i].address);
        clientSocket.write('HTTP/1.1 403 Forbidden\r\n\r\n');
        clientSocket.destroy();
        return;
      }
    }

    let target;
    try {
      target = net.connect(port, addresses[0].address, function () {
        clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        if (head && head.length) target.write(head);
        target.pipe(clientSocket);
        clientSocket.pipe(target);
        writeLog('INFO', 'CONNECT established: ' + host + ':' + port);
      });
    } catch (e) {
      stats.errors++;
      getTodayStats().errors++;
      writeLog('ERROR', 'CONNECT cannot connect: ' + host + ':' + port, { message: e.message });
      clientSocket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      clientSocket.destroy();
      return;
    }

    target.on('error', function (e) {
      stats.errors++;
      getTodayStats().errors++;
      writeLog('ERROR', 'CONNECT upstream error: ' + host + ':' + port, { message: e.message });
      try { clientSocket.destroy(); } catch (e2) {}
    });
    target.on('close', function () {
      writeLog('INFO', 'CONNECT closed: ' + host + ':' + port, {
        duration: (Date.now() - startTime) + 'ms'
      });
    });
    clientSocket.on('error', function () {
      try { target.destroy(); } catch (e2) {}
    });
    clientSocket.on('close', function () {
      try { target.destroy(); } catch (e2) {}
    });
  });
}

function resolveUpgradeTarget(req) {
  const urlPath = req.url || '/';
  const pathOnly = urlPath.split('?')[0];

  let isOpenMode = false;
  let remainder = pathOnly;

  if (OPEN_PROXY_PATH) {
    const exact = '/' + OPEN_PROXY_PATH;
    const prefix = exact + '/';
    if (pathOnly === exact || pathOnly.indexOf(prefix) === 0) {
      if (!ENABLE_OPEN_PROXY) return { error: 404 };
      isOpenMode = true;
      remainder = pathOnly === exact ? '/' : pathOnly.slice(exact.length);
    }
  }

  const queryUrl = getQueryUrl(req);
  if (queryUrl) {
    if (isOpenMode) return { targetUrl: queryUrl, strict: false };
    if (!isAllowedGitHubUrl(queryUrl)) return { error: 403 };
    return { targetUrl: queryUrl, strict: true };
  }

  const cleanPath = extractUrlFromPath(remainder);

  if (isOpenMode) {
    if (!looksLikeHttpUrl(cleanPath)) return { error: 400 };
    return { targetUrl: cleanPath, strict: false };
  }

  if (isAllowedGitHubUrl(cleanPath)) {
    return { targetUrl: cleanPath, strict: true };
  }
  return { error: 404 };
}

function handleUpgrade(req, socket, head) {
  const startTime = Date.now();

  let resolved;
  try {
    resolved = resolveUpgradeTarget(req);
  } catch (e) {
    resolved = { error: 500 };
  }

  if (!resolved || resolved.error) {
    const code = resolved && resolved.error ? resolved.error : 500;
    const msg = code === 403 ? 'Forbidden' :
                code === 400 ? 'Bad Request' :
                code === 404 ? 'Not Found' : 'Internal Server Error';
    try { socket.write('HTTP/1.1 ' + code + ' ' + msg + '\r\n\r\n'); } catch (e) {}
    socket.destroy();
    return;
  }

  const targetUrl = resolved.targetUrl;
  const strictMode = resolved.strict;

  if (isBlockedTarget(targetUrl)) {
    stats.errors++;
    getTodayStats().errors++;
    writeLog('WARN', 'WebSocket blocked private: ' + targetUrl);
    try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e) {}
    socket.destroy();
    return;
  }

  stats.proxyRequests++;
  getTodayStats().proxy++;

  let u;
  try {
    u = new URL(targetUrl);
  } catch (e) {
    try { socket.write('HTTP/1.1 400 Bad Request\r\n\r\n'); } catch (e2) {}
    socket.destroy();
    return;
  }

  if (strictMode && !isAllowedGitHubUrl(targetUrl)) {
    try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch (e2) {}
    socket.destroy();
    return;
  }

  const isTls = u.protocol === 'https:';
  const mod = isTls ? https : http;
  const agent = isTls ? httpsAgent : httpAgent;
  const port = u.port ? parseInt(u.port, 10) : (isTls ? 443 : 80);

  const headers = {};
  if (!strictMode) {
    for (const k in req.headers) {
      const lk = k.toLowerCase();
      if (HOP_BY_HOP_HEADERS[lk]) continue;
      headers[k] = req.headers[k];
    }
  } else {
    headers['user-agent'] = USER_AGENT;
    headers['accept'] = req.headers['accept'] || '*/*';
    headers['accept-language'] = req.headers['accept-language'] || 'en-US,en;q=0.9';
    headers['origin'] = req.headers['origin'] || '';
    headers['sec-websocket-key'] = req.headers['sec-websocket-key'] || '';
    headers['sec-websocket-version'] = req.headers['sec-websocket-version'] || '';
    headers['sec-websocket-protocol'] = req.headers['sec-websocket-protocol'] || '';
    headers['sec-websocket-extensions'] = req.headers['sec-websocket-extensions'] || '';
    headers['authorization'] = req.headers['authorization'] || '';
    headers['cookie'] = req.headers['cookie'] || '';
    for (const k in headers) if (headers[k] === '') delete headers[k];
  }
  headers['host'] = u.host;
  headers['connection'] = 'Upgrade';
  headers['upgrade'] = req.headers['upgrade'] || 'websocket';

  writeLog('INFO', 'WebSocket proxy start: ' + targetUrl);

  const proxyReq = mod.request({
    hostname: u.hostname,
    port: port,
    path: u.pathname + u.search,
    method: req.method || 'GET',
    headers: headers,
    agent: agent
  });

  proxyReq.on('upgrade', function (proxyRes, proxySocket, proxyHead) {
    let resLine = 'HTTP/1.1 ' + proxyRes.statusCode + ' ' +
                  (proxyRes.statusMessage || 'Switching Protocols') + '\r\n';
    for (const k in proxyRes.headers) {
      resLine += k + ': ' + proxyRes.headers[k] + '\r\n';
    }
    resLine += '\r\n';
    try { socket.write(resLine); } catch (e) {}

    if (proxyHead && proxyHead.length) proxySocket.unshift(proxyHead);
    if (head && head.length) proxySocket.write(head);

    proxySocket.pipe(socket);
    socket.pipe(proxySocket);

    proxySocket.on('error', function (e) {
      writeLog('ERROR', 'WebSocket upstream error: ' + targetUrl, { message: e.message });
      try { socket.destroy(); } catch (e2) {}
    });
    socket.on('error', function () {
      try { proxySocket.destroy(); } catch (e2) {}
    });
    socket.on('close', function () {
      try { proxySocket.destroy(); } catch (e2) {}
    });
    proxySocket.on('close', function () {
      // Tear down the client side too, otherwise half-open tunnels leak.
      try { socket.destroy(); } catch (e2) {}
      writeLog('INFO', 'WebSocket closed: ' + targetUrl, {
        duration: (Date.now() - startTime) + 'ms'
      });
    });
  });

  proxyReq.on('response', function (proxyRes) {
    stats.errors++;
    getTodayStats().errors++;
    writeLog('WARN', 'WebSocket upstream refused upgrade: ' + targetUrl, { status: proxyRes.statusCode });
    let resLine = 'HTTP/1.1 ' + proxyRes.statusCode + ' ' +
                  (proxyRes.statusMessage || 'Error') + '\r\n';
    for (const k in proxyRes.headers) {
      resLine += k + ': ' + proxyRes.headers[k] + '\r\n';
    }
    resLine += '\r\n';
    try { socket.write(resLine); } catch (e) {}
    proxyRes.on('error', function () {
      try { socket.destroy(); } catch (e2) {}
    });
    socket.on('close', function () {
      try { proxyRes.destroy(); } catch (e2) {}
    });
    proxyRes.pipe(socket);
  });

  proxyReq.on('error', function (e) {
    stats.errors++;
    getTodayStats().errors++;
    writeLog('ERROR', 'WebSocket proxy failed: ' + targetUrl, { message: e.message });
    try {
      socket.write('HTTP/1.1 502 Bad Gateway\r\n\r\n');
      socket.destroy();
    } catch (e2) {}
  });

  proxyReq.end();
}

function extractUrlFromPath(urlPath) {
  let cleanPath = urlPath;
  if (cleanPath.charAt(0) === '/') cleanPath = cleanPath.substring(1);

  try {
    const decoded = decodeURI(cleanPath);
    if (decoded.indexOf('http://') === 0 || decoded.indexOf('https://') === 0) {
      return decoded;
    }
  } catch (e) {}

  try {
    const decoded = decodeURIComponent(cleanPath);
    if (decoded.indexOf('http://') === 0 || decoded.indexOf('https://') === 0) {
      return decoded;
    }
  } catch (e) {}

  return cleanPath;
}

function getQueryUrl(req) {
  const v = req.query && req.query.url;
  if (Array.isArray(v)) return typeof v[0] === 'string' ? v[0] : null;
  return typeof v === 'string' ? v : null;
}

function looksLikeHttpUrl(s) {
  return typeof s === 'string' &&
    (s.indexOf('http://') === 0 || s.indexOf('https://') === 0);
}

app.get('/config', function (req, res) {
  res.json({
    siteName: SITE_NAME,
    siteTitle: SITE_TITLE,
    siteSubtitle: SITE_SUBTITLE,
    openProxy: ENABLE_OPEN_PROXY
  });
});

app.get('/health', function (req, res) {
  const today = getTodayKey();
  const ts = stats.dailyStats[today] || { requests: 0, proxy: 0, errors: 0 };

  res.json({
    status: 'ok',
    uptime: process.uptime(),
    startTime: stats.startTime,
    lastRequestTime: stats.lastRequestTime,
    totalRequests: stats.totalRequests,
    proxyRequests: stats.proxyRequests,
    errors: stats.errors,
    today: {
      date: today,
      requests: ts.requests,
      proxy: ts.proxy,
      errors: ts.errors
    },
    timestamp: new Date().toISOString()
  });
});

app.get('/stats', function (req, res) {
  const today = getTodayKey();
  const ts = stats.dailyStats[today] || { requests: 0, proxy: 0, errors: 0 };

  res.json({
    totalRequests: stats.totalRequests,
    proxyRequests: stats.proxyRequests,
    errors: stats.errors,
    today: {
      date: today,
      requests: ts.requests,
      proxy: ts.proxy,
      errors: ts.errors
    },
    uptime: process.uptime(),
    startTime: stats.startTime,
    lastRequestTime: stats.lastRequestTime
  });
});

app.get('/', function (req, res) {
  const queryUrl = getQueryUrl(req);
  if (queryUrl) {
    if (!isAllowedGitHubUrl(queryUrl)) {
      return res.status(403).json({ error: 'only GitHub links allowed' });
    }
    writeLog('INFO', 'query param proxy: ' + queryUrl);
    return proxyRequest(req, res, queryUrl, { strict: true });
  }
  res.setHeader('Content-Security-Policy', PAGE_CSP);
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.use(express.static(STATIC_DIR, {
  setHeaders: function (res, filePath) {
    if (/\.html?$/i.test(filePath)) {
      res.setHeader('Content-Security-Policy', PAGE_CSP);
    }
  }
}));

app.use(function (req, res) {
  const urlPath = req.url;
  const pathOnly = urlPath.split('?')[0];

  let isOpenMode = false;
  let remainder = pathOnly;

  if (OPEN_PROXY_PATH) {
    const exact = '/' + OPEN_PROXY_PATH;
    const prefix = exact + '/';

    if (pathOnly === exact || pathOnly.indexOf(prefix) === 0) {
      if (!ENABLE_OPEN_PROXY) {
        writeLog('WARN', 'open proxy disabled: ' + pathOnly);
        return res.status(404).send('Not Found');
      }
      isOpenMode = true;
      remainder = pathOnly === exact ? '/' : pathOnly.slice(exact.length);
    }
  }

  const queryUrl = getQueryUrl(req);
  if (queryUrl) {
    if (isOpenMode) {
      writeLog('INFO', 'query param proxy (open): ' + queryUrl);
      return proxyRequest(req, res, queryUrl, { strict: false });
    }
    if (!isAllowedGitHubUrl(queryUrl)) {
      return res.status(403).json({ error: 'only GitHub links allowed' });
    }
    writeLog('INFO', 'query param proxy: ' + queryUrl);
    return proxyRequest(req, res, queryUrl, { strict: true });
  }

  const cleanPath = extractUrlFromPath(remainder);

  if (isOpenMode) {
    if (looksLikeHttpUrl(cleanPath)) {
      writeLog('INFO', 'path proxy (open): ' + cleanPath);
      return proxyRequest(req, res, cleanPath, { strict: false });
    }
    writeLog('WARN', 'open mode invalid link: ' + cleanPath);
    return res.status(400).json({ error: 'provide full http:// or https:// link' });
  }

  if (isAllowedGitHubUrl(cleanPath)) {
    return proxyRequest(req, res, cleanPath, { strict: true });
  }

  if (looksLikeHttpUrl(cleanPath)) {
    writeLog('WARN', 'non-GitHub link rejected: ' + cleanPath);
    return res.status(403).json({ error: 'only GitHub links allowed' });
  }

  writeLog('WARN', '404 Not Found: ' + urlPath);
  res.status(404).send('Not Found');
});

const server = http.createServer(app);
server.on('connect', handleConnect);
server.on('upgrade', handleUpgrade);
server.on('clientError', function (err, socket) {
  if (!socket || !socket.writable || (err && err.code === 'ECONNRESET')) {
    if (socket) socket.destroy();
    return;
  }
  try {
    socket.end('HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n');
  } catch (e) {
    socket.destroy();
  }
});

server.listen(PORT, HOST, function () {
  writeLog('INFO', 'not-gh-proxy started', {
    port: PORT,
    host: HOST,
    staticDir: STATIC_DIR,
    logDir: ENABLE_FILE_LOG ? LOG_DIR : '(disabled)',
    siteTitle: SITE_TITLE,
    openProxy: ENABLE_OPEN_PROXY,
    openProxyPath: ENABLE_OPEN_PROXY ? OPEN_PROXY_PATH : '(disabled)',
    blockPrivateNetwork: BLOCK_PRIVATE_NETWORK,
    dnsCheck: BLOCK_PRIVATE_NETWORK,
    connect: ENABLE_OPEN_PROXY,
    websocket: true,
    allowedDomains: ALLOWED_DOMAINS
  });

  console.log('not-gh-proxy running at http://' + HOST + ':' + PORT);
  console.log('config: ' + CONFIG_PATH);
  console.log('static: ' + STATIC_DIR);
  console.log('logs: ' + (ENABLE_FILE_LOG ? LOG_DIR : '(disabled)'));
  console.log('site title: ' + SITE_TITLE);
  console.log('open proxy: ' + (ENABLE_OPEN_PROXY ? 'on (/' + OPEN_PROXY_PATH + '/)' : 'off'));
  console.log('block private: ' + BLOCK_PRIVATE_NETWORK + ' (incl. DNS check)');
  console.log('CONNECT: ' + (ENABLE_OPEN_PROXY ? 'on' : 'off'));
  console.log('WebSocket: on');
  console.log('allowed domains: ' + ALLOWED_DOMAINS.join(', '));
  console.log('health: /health');
  console.log('stats: /stats');
});

setInterval(function () {
  pruneDailyStats(LOG_KEEP_DAYS);
}, 6 * 60 * 60 * 1000).unref();

let shuttingDown = false;

function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;

  try { writeLog('INFO', 'shutting down: ' + reason); } catch (e) {}
  if (CONSOLE_LOG) console.log('[shutdown] ' + reason);

  // Hard deadline: never hang forever on half-open proxy tunnels.
  const force = setTimeout(function () { process.exit(1); }, 10000);
  force.unref();

  try { server.close(); } catch (e) {}
  if (typeof server.closeIdleConnections === 'function') server.closeIdleConnections();
  setTimeout(function () {
    if (typeof server.closeAllConnections === 'function') server.closeAllConnections();
  }, 2000).unref();

  try { httpAgent.destroy(); } catch (e) {}
  try { httpsAgent.destroy(); } catch (e) {}

  setTimeout(function () {
    if (logStream && !logStream.destroyed) {
      try { logStream.end(); } catch (e) {}
    }
    process.exit(0);
  }, 300);
}

process.on('SIGINT', function () { shutdown('SIGINT'); });
process.on('SIGTERM', function () { shutdown('SIGTERM'); });

// Last-resort safety net: log and keep serving for per-connection errors that
// escaped a handler, instead of taking the whole proxy down.
process.on('uncaughtException', function (err) {
  const msg = err && err.message ? err.message : String(err);
  try { writeLog('ERROR', 'uncaughtException: ' + msg); } catch (e) {}
  if (err && (err.code === 'ERR_SOCKET_BAD_PORT' ||
              err.code === 'ECONNRESET' ||
              err.code === 'EPIPE' ||
              err.code === 'ERR_STREAM_PREMATURE_CLOSE')) {
    return;
  }
  shutdown('uncaughtException');
});

process.on('unhandledRejection', function (reason) {
  const msg = reason && reason.message ? reason.message : String(reason);
  try { writeLog('ERROR', 'unhandledRejection: ' + msg); } catch (e) {}
});
