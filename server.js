'use strict';

const express = require('express');
const axios = require('axios');
const cors = require('cors');
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
    'githubassets.com'
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
      console.log('[config] 未找到 config.json，已生成默认配置: ' + CONFIG_PATH);
    } catch (e) {
      console.warn('[config] 无法写入默认配置文件: ' + e.message);
    }
    return JSON.parse(JSON.stringify(DEFAULT_CONFIG));
  }

  let userCfg;
  try {
    userCfg = JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf8'));
  } catch (e) {
    console.error('[config] 解析 config.json 失败: ' + e.message);
    console.error('[config] 请检查 JSON 语法，进程退出。');
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

const app = express();

if (TRUST_PROXY) {
  app.set('trust proxy', TRUST_PROXY === 'true' ? true : TRUST_PROXY);
}

if (ENABLE_FILE_LOG && !fs.existsSync(LOG_DIR)) {
  fs.mkdirSync(LOG_DIR, { recursive: true });
}

function writeLog(level, message, data) {
  const timestamp = new Date().toISOString();
  let logEntry = '[' + timestamp + '] [' + level + '] ' + message;
  if (data) logEntry += ' | ' + JSON.stringify(data);

  if (CONSOLE_LOG) console.log(logEntry);
  if (!ENABLE_FILE_LOG) return;

  try {
    const dateStr = timestamp.slice(0, 10);
    const logFile = path.join(LOG_DIR, 'not-gh-proxy-' + dateStr + '.log');
    fs.appendFile(logFile, logEntry + '\n', 'utf8', function () { /* ignore */ });
  } catch (e) { /* ignore */ }
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

function isPrivateHostname(hostname) {
  const h = String(hostname || '').toLowerCase();
  if (!h) return true;

  if (h === 'localhost' || h.endsWith('.localhost')) return true;
  if (h === '0.0.0.0' || h === '[::]' || h === '::') return true;

  if (h.indexOf(':') !== -1) {
    const v6 = h.replace(/^\[|\]$/g, '');
    if (v6 === '::1') return true;
    if (/^f[cd][0-9a-f]{2}:/i.test(v6)) return true;
    if (/^fe80:/i.test(v6)) return true;
    return false;
  }

  const m = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (m) {
    const a = parseInt(m[1], 10);
    const b = parseInt(m[2], 10);
    if (a === 0 || a === 10 || a === 127) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a >= 224) return true;
    return false;
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

app.use(cors());

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
      writeLog('ERROR', '请求失败', logData);
    } else if (req.url.indexOf('http://') !== -1 || req.url.indexOf('https://') !== -1) {
      writeLog('INFO', '代理请求', logData);
    } else {
      writeLog('DEBUG', '静态请求', logData);
    }
  });

  next();
});

const FORWARD_RES_HEADERS = [
  'content-type',
  'content-disposition',
  'content-length',
  'content-encoding',
  'accept-ranges',
  'etag',
  'last-modified',
  'cache-control'
];

async function proxyRequest(req, res, targetUrl) {
  const startTime = Date.now();
  stats.proxyRequests++;
  getTodayStats().proxy++;

  if (isBlockedTarget(targetUrl)) {
    stats.errors++;
    getTodayStats().errors++;
    writeLog('WARN', '拒绝内网目标: ' + targetUrl);
    if (!res.headersSent) {
      res.status(403).json({ error: '禁止访问内网地址' });
    }
    return;
  }

  writeLog('INFO', '代理开始: ' + targetUrl);

  let upstream;
  try {
    const reqHeaders = {
      'User-Agent': USER_AGENT,
      'Accept': req.headers['accept'] || '*/*',
      'Accept-Encoding': req.headers['accept-encoding'] || 'identity',
      'Accept-Language': req.headers['accept-language'] || 'en-US,en;q=0.9'
    };
    if (req.headers['range']) reqHeaders['Range'] = req.headers['range'];
    if (req.headers['if-none-match']) reqHeaders['If-None-Match'] = req.headers['if-none-match'];
    if (req.headers['if-modified-since']) reqHeaders['If-Modified-Since'] = req.headers['if-modified-since'];

    upstream = await axios({
      method: 'GET',
      url: targetUrl,
      responseType: 'stream',
      decompress: false,
      timeout: PROXY_TIMEOUT,
      maxRedirects: MAX_REDIRECTS,
      validateStatus: function () { return true; },
      headers: reqHeaders
    });
  } catch (error) {
    stats.errors++;
    getTodayStats().errors++;

    writeLog('ERROR', '代理失败: ' + targetUrl, {
      message: error.message,
      duration: (Date.now() - startTime) + 'ms'
    });

    if (!res.headersSent) {
      const status = error.response ? error.response.status : 502;
      res.status(status).json({
        error: '代理请求失败',
        message: error.message,
        url: targetUrl
      });
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
    writeLog('ERROR', '上游流错误: ' + targetUrl, { message: err.message });
    if (!res.headersSent) {
      res.status(502).json({ error: '上游流错误' });
    } else if (!res.writableEnded) {
      res.destroy(err);
    }
  });

  res.on('close', function () {
    if (!res.writableEnded) {
      try { upstream.data.destroy(); } catch (e) { /* ignore */ }
    }
  });

  res.on('finish', function () {
    writeLog('INFO', '代理完成: ' + targetUrl, {
      duration: (Date.now() - startTime) + 'ms',
      status: upstream.status
    });
  });

  upstream.data.pipe(res);
}

function extractUrlFromPath(urlPath) {
  let cleanPath = urlPath;
  if (cleanPath.charAt(0) === '/') cleanPath = cleanPath.substring(1);
  try {
    cleanPath = decodeURIComponent(cleanPath);
  } catch (e) { /* ignore */ }
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
    openProxy: ENABLE_OPEN_PROXY,
    openProxyPath: ENABLE_OPEN_PROXY ? OPEN_PROXY_PATH : null
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
      return res.status(403).json({ error: '仅允许 GitHub 相关链接' });
    }
    writeLog('INFO', '查询参数代理: ' + queryUrl);
    return proxyRequest(req, res, queryUrl);
  }
  res.sendFile(path.join(STATIC_DIR, 'index.html'));
});

app.use(express.static(STATIC_DIR));

app.use(function (req, res) {
  const urlPath = req.url;

  let isOpenMode = false;
  let remainder = urlPath;

  if (OPEN_PROXY_PATH) {
    const exact = '/' + OPEN_PROXY_PATH;
    const prefix = exact + '/';

    if (urlPath === exact || urlPath.indexOf(prefix) === 0) {
      if (!ENABLE_OPEN_PROXY) {
        writeLog('WARN', '开放代理已禁用: ' + urlPath);
        return res.status(404).send('Not Found');
      }
      isOpenMode = true;
      remainder = urlPath === exact ? '/' : urlPath.slice(exact.length);
    }
  }

  const queryUrl = getQueryUrl(req);
  if (queryUrl) {
    if (isOpenMode) {
      writeLog('INFO', '查询参数代理 (开放): ' + queryUrl);
      return proxyRequest(req, res, queryUrl);
    }
    if (!isAllowedGitHubUrl(queryUrl)) {
      return res.status(403).json({ error: '仅允许 GitHub 相关链接' });
    }
    writeLog('INFO', '查询参数代理: ' + queryUrl);
    return proxyRequest(req, res, queryUrl);
  }

  const cleanPath = extractUrlFromPath(remainder);

  if (isOpenMode) {
    if (looksLikeHttpUrl(cleanPath)) {
      writeLog('INFO', '路径代理 (开放): ' + cleanPath);
      return proxyRequest(req, res, cleanPath);
    }
    writeLog('WARN', '开放模式下非有效链接: ' + cleanPath);
    return res.status(400).json({ error: '请提供完整的 http:// 或 https:// 链接' });
  }

  if (isAllowedGitHubUrl(cleanPath)) {
    return proxyRequest(req, res, cleanPath);
  }

  if (looksLikeHttpUrl(cleanPath)) {
    writeLog('WARN', '拒绝非 GitHub 链接: ' + cleanPath);
    return res.status(403).json({ error: '仅允许 GitHub 相关链接' });
  }

  writeLog('WARN', '404 Not Found: ' + urlPath);
  res.status(404).send('Not Found');
});

app.listen(PORT, HOST, function () {
  writeLog('INFO', 'not-gh-proxy 启动成功', {
    port: PORT,
    host: HOST,
    staticDir: STATIC_DIR,
    logDir: ENABLE_FILE_LOG ? LOG_DIR : '(disabled)',
    siteTitle: SITE_TITLE,
    openProxy: ENABLE_OPEN_PROXY,
    openProxyPath: ENABLE_OPEN_PROXY ? OPEN_PROXY_PATH : '(disabled)',
    blockPrivateNetwork: BLOCK_PRIVATE_NETWORK,
    allowedDomains: ALLOWED_DOMAINS
  });

  console.log('not-gh-proxy 运行在 http://' + HOST + ':' + PORT);
  console.log('配置文件: ' + CONFIG_PATH);
  console.log('静态文件目录: ' + STATIC_DIR);
  console.log('日志目录: ' + (ENABLE_FILE_LOG ? LOG_DIR : '(disabled)'));
  console.log('站点标题: ' + SITE_TITLE);
  console.log('开放代理: ' + (ENABLE_OPEN_PROXY ? '开启 (/' + OPEN_PROXY_PATH + '/)' : '关闭'));
  console.log('屏蔽内网: ' + BLOCK_PRIVATE_NETWORK);
  console.log('允许域名: ' + ALLOWED_DOMAINS.join(', '));
  console.log('健康检查: /health');
  console.log('统计信息: /stats');
});

setInterval(function () {
  pruneDailyStats(LOG_KEEP_DAYS);
}, 6 * 60 * 60 * 1000);