// server.js
import express from "express";
import axios from "axios";
import path from "path";
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const SOURCE_URL =
  process.env.SOURCE_URL ||
  "";

const CORS_PROXY =
  process.env.CORS_PROXY ||
  "";

// Store results dengan kategori terpisah
let urlDatabase = {
  all: [],           // Semua URL yang pernah diproses
  success: new Set(), // URL sukses (baik direct maupun proxy)
  failed: new Set(),  // URL gagal total
  pending: new Set()  // URL dalam antrian
};

// Detail sukses untuk membedakan direct/proxy
let successDetails = new Map(); // Map<url, {method: 'direct'|'proxy', timestamp, responseSize}>

let processingHistory = [];
const MAX_HISTORY = 1000;

// Statistik lengkap
let stats = {
  totalProcessed: 0,
  success: 0,
  failed: 0,
  directSuccess: 0,
  proxySuccess: 0,
  uniqueUrls: 0,
  startTime: new Date(),
  lastProcessed: null,
  successRate: 0
};

// ────────────── PARSER ──────────────
function parseList(txt) {
  return (txt || "")
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function isJson(body) {
  if (!body) return false;
  try {
    JSON.parse(body);
    return true;
  } catch {
    return false;
  }
}

function isCaptcha(body) {
  if (!body) return false;
  const t = body.toLowerCase();
  return (
    t.includes("captcha") ||
    t.includes("verify you are human") ||
    t.includes("verification") ||
    t.includes("robot") ||
    t.includes("cloudflare")
  );
}

const fetchText = async (url) => {
  try {
    const resp = await axios.get(url, {
      headers: { "User-Agent": "Mozilla/5.0" },
      timeout: 20000,
      validateStatus: () => true,
      responseType: "text",
    });

    return {
      ok: true,
      text:
        typeof resp.data === "string"
          ? resp.data
          : JSON.stringify(resp.data),
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
};

const buildProxyUrl = (u) => `${CORS_PROXY}/${u}`;

// ────────────── LOGIKA BERTINGKAT ──────────────
async function checkUrl(url) {
  // Tandai sebagai pending
  urlDatabase.pending.add(url);
  
  const result = {
    url,
    direct: null,
    proxy: null,
    finalStatus: null,
    method: null,
    timestamp: new Date().toISOString()
  };

  // LANGKAH 1: Coba Direct
  console.log(`🔄 Mencoba DIRECT: ${url}`);
  const direct = await fetchText(url);
  const directOk = direct.ok && !isCaptcha(direct.text) && isJson(direct.text);
  
  result.direct = {
    ok: directOk,
    error: direct.error,
    captcha: direct.text ? isCaptcha(direct.text) : false
  };

  if (directOk) {
    // SUKSES via DIRECT
    console.log(`✅ DIRECT SUKSES: ${url}`);
    result.finalStatus = 'success';
    result.method = 'direct';
    addToDatabase(url, 'success', 'direct', {
      responseSize: direct.text.length,
      method: 'direct'
    });
    return result;
  }

  // LANGKAH 2: Jika Direct gagal, coba Proxy
  console.log(`🔄 Mencoba PROXY: ${url}`);
  const proxied = await fetchText(buildProxyUrl(url));
  const proxyOk =
    proxied.ok && !isCaptcha(proxied.text) && isJson(proxied.text);

  result.proxy = {
    ok: proxyOk,
    error: proxied.error,
    captcha: proxied.text ? isCaptcha(proxied.text) : false
  };

  if (proxyOk) {
    // SUKSES via PROXY
    console.log(`✅ PROXY SUKSES: ${url}`);
    result.finalStatus = 'success';
    result.method = 'proxy';
    addToDatabase(url, 'success', 'proxy', {
      responseSize: proxied.text.length,
      method: 'proxy'
    });
    return result;
  }

  // LANGKAH 3: Keduanya gagal
  console.log(`❌ GAGAL TOTAL: ${url}`);
  result.finalStatus = 'failed';
  result.method = null;
  
  // Kumpulkan detail error
  const errorDetails = {
    directError: !direct.ok ? direct.error : (direct.text ? 'Not JSON or Captcha' : null),
    proxyError: !proxied.ok ? proxied.error : (proxied.text ? 'Not JSON or Captcha' : null),
    directCaptcha: direct.text ? isCaptcha(direct.text) : false,
    proxyCaptcha: proxied.text ? isCaptcha(proxied.text) : false
  };
  
  addToDatabase(url, 'failed', null, errorDetails);
  return result;
}

// ────────────── DATABASE MANAGEMENT ──────────────
function addToDatabase(url, status, method = null, details = {}) {
  const timestamp = new Date().toISOString();
  
  // Tambah ke semua URL jika belum ada
  if (!urlDatabase.all.includes(url)) {
    urlDatabase.all.push(url);
    stats.uniqueUrls = urlDatabase.all.length;
  }
  
  // Hapus dari pending
  urlDatabase.pending.delete(url);
  
  // Tambah ke kategori sesuai status
  if (status === 'success') {
    urlDatabase.success.add(url);
    urlDatabase.failed.delete(url);
    
    // Simpan detail metode sukses
    successDetails.set(url, {
      method,
      timestamp,
      ...details
    });
    
    if (method === 'direct') {
      stats.directSuccess++;
    } else if (method === 'proxy') {
      stats.proxySuccess++;
    }
    stats.success++;
    
  } else if (status === 'failed') {
    urlDatabase.failed.add(url);
    urlDatabase.success.delete(url);
    successDetails.delete(url);
    stats.failed++;
  }
  
  // Tambah ke history
  processingHistory.unshift({
    url,
    status,
    method,
    timestamp,
    details
  });
  
  // Batasi history
  if (processingHistory.length > MAX_HISTORY) {
    processingHistory = processingHistory.slice(0, MAX_HISTORY);
  }
  
  // Update statistik
  stats.totalProcessed++;
  stats.lastProcessed = timestamp;
  const totalAttempts = stats.success + stats.failed;
  stats.successRate = totalAttempts > 0 ? ((stats.success / totalAttempts) * 100).toFixed(2) : 0;
}

// Export database dengan metode terpisah
function exportDatabase(format = 'json') {
  // Pisahkan success berdasarkan metode
  const directUrls = [];
  const proxyUrls = [];
  
  for (const url of urlDatabase.success) {
    const details = successDetails.get(url);
    if (details && details.method === 'direct') {
      directUrls.push(url);
    } else if (details && details.method === 'proxy') {
      proxyUrls.push(url);
    }
  }
  
  if (format === 'txt') {
    return {
      success: Array.from(urlDatabase.success).join('\n'),
      direct: directUrls.join('\n'),
      proxy: proxyUrls.join('\n'),
      failed: Array.from(urlDatabase.failed).join('\n'),
      all: urlDatabase.all.join('\n')
    };
  }
  
  return {
    stats,
    counts: {
      total: urlDatabase.all.length,
      success: urlDatabase.success.size,
      failed: urlDatabase.failed.size,
      pending: urlDatabase.pending.size,
      direct: directUrls.length,
      proxy: proxyUrls.length
    },
    urls: {
      success: Array.from(urlDatabase.success),
      direct: directUrls,
      proxy: proxyUrls,
      failed: Array.from(urlDatabase.failed),
      pending: Array.from(urlDatabase.pending)
    },
    successDetails: Object.fromEntries(successDetails),
    history: processingHistory.slice(0, 100)
  };
}

// Reset database
function resetDatabase() {
  urlDatabase = {
    all: [],
    success: new Set(),
    failed: new Set(),
    pending: new Set()
  };
  
  successDetails.clear();
  processingHistory = [];
  
  stats = {
    totalProcessed: 0,
    success: 0,
    failed: 0,
    directSuccess: 0,
    proxySuccess: 0,
    uniqueUrls: 0,
    startTime: new Date(),
    lastProcessed: null,
    successRate: 0
  };
}

// ────────────── HIT URL (MAIN FUNCTION) ──────────────
async function hitUrl(url) {
  return await checkUrl(url);
}

// ────────────── PARALLEL WORKER ──────────────
async function mainLoop() {
  const WORKERS = 20;

  while (true) {
    try {
      const listResp = await fetchText(SOURCE_URL);
      const urls = listResp.ok ? parseList(listResp.text) : [];

      if (urls.length === 0) {
        console.log("❌ SOURCE kosong, ulangi…");
        await new Promise(resolve => setTimeout(resolve, 5000));
        continue;
      }

      console.log(`📌 Memuat ${urls.length} URL…`);
      console.log(`📊 Statistik: Total=${stats.totalProcessed}, Success=${stats.success}, Failed=${stats.failed} (Direct=${stats.directSuccess}, Proxy=${stats.proxySuccess})`);

      let current = 0;

      async function worker() {
        while (true) {
          let u = urls[current++];
          if (!u) break;
          await hitUrl(u);
        }
      }

      const pool = [];
      for (let i = 0; i < WORKERS; i++) {
        pool.push(worker());
      }

      await Promise.all(pool);
      
      // Istirahat sebentar sebelum loop berikutnya
      await new Promise(resolve => setTimeout(resolve, 1000));
      
    } catch (err) {
      console.log("❌ ERROR LOOP:", err.message);
      await new Promise(resolve => setTimeout(resolve, 5000));
    }
  }
}

// ────────────── HTTP ENDPOINTS ──────────────
const app = express();

// Serve static files
app.use(express.static('public'));

// API endpoint untuk dashboard
app.get("/api/stats", (req, res) => {
  // Hitung direct dan proxy dari successDetails
  let directCount = 0;
  let proxyCount = 0;
  
  for (const [_, details] of successDetails) {
    if (details.method === 'direct') directCount++;
    else if (details.method === 'proxy') proxyCount++;
  }
  
  res.json({
    stats,
    counts: {
      success: urlDatabase.success.size,
      failed: urlDatabase.failed.size,
      pending: urlDatabase.pending.size,
      total: urlDatabase.all.length,
      direct: directCount,
      proxy: proxyCount
    }
  });
});

// API endpoint untuk history
app.get("/api/history", (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const status = req.query.status;
  
  let history = processingHistory;
  if (status) {
    history = history.filter(h => h.status === status);
  }
  
  res.json(history.slice(0, limit));
});

// API endpoint untuk mendapatkan URL berdasarkan kategori
app.get("/api/urls/:category", (req, res) => {
  const category = req.params.category;
  const format = req.query.format || 'json';
  
  let urls;
  switch(category) {
    case 'success':
      urls = Array.from(urlDatabase.success);
      break;
    case 'direct':
      // Khusus direct success
      urls = [];
      for (const url of urlDatabase.success) {
        const details = successDetails.get(url);
        if (details && details.method === 'direct') {
          urls.push(url);
        }
      }
      break;
    case 'proxy':
      // Khusus proxy success
      urls = [];
      for (const url of urlDatabase.success) {
        const details = successDetails.get(url);
        if (details && details.method === 'proxy') {
          urls.push(url);
        }
      }
      break;
    case 'failed':
      urls = Array.from(urlDatabase.failed);
      break;
    case 'pending':
      urls = Array.from(urlDatabase.pending);
      break;
    case 'all':
      urls = urlDatabase.all;
      break;
    default:
      return res.status(400).json({ error: 'Invalid category' });
  }
  
  if (format === 'txt') {
    res.setHeader('Content-Type', 'text/plain');
    res.send(urls.join('\n'));
  } else {
    res.json({ 
      category, 
      count: urls.length, 
      urls,
      details: category === 'success' ? Object.fromEntries(
        urls.map(url => [url, successDetails.get(url)])
      ) : null
    });
  }
});

// API endpoint untuk detail URL tertentu
app.get("/api/url/:url", (req, res) => {
  const url = decodeURIComponent(req.params.url);
  
  const details = successDetails.get(url);
  const isSuccess = urlDatabase.success.has(url);
  const isFailed = urlDatabase.failed.has(url);
  const isPending = urlDatabase.pending.has(url);
  
  res.json({
    url,
    exists: urlDatabase.all.includes(url),
    status: isSuccess ? 'success' : (isFailed ? 'failed' : (isPending ? 'pending' : 'unknown')),
    method: details ? details.method : null,
    details: details || null
  });
});

// API endpoint untuk export semua data
app.get("/api/export/:format?", (req, res) => {
  const format = req.params.format || 'json';
  const data = exportDatabase(format);
  
  if (format === 'txt') {
    res.setHeader('Content-Type', 'text/plain');
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    
    // Hitung statistik
    const directCount = data.direct.split('\n').filter(Boolean).length;
    const proxyCount = data.proxy.split('\n').filter(Boolean).length;
    const failedCount = data.failed.split('\n').filter(Boolean).length;
    const successCount = data.success.split('\n').filter(Boolean).length;
    
    res.send(`
# URL DATABASE EXPORT - ${timestamp}
# =================================================

## STATISTIK
# Total Success: ${successCount} (Direct: ${directCount}, Proxy: ${proxyCount})
# Total Failed: ${failedCount}
# Total All: ${data.all.split('\n').filter(Boolean).length}

## DIRECT SUCCESS (${directCount} URLs)
${data.direct}

## PROXY SUCCESS (${proxyCount} URLs)
${data.proxy}

## FAILED (${failedCount} URLs)
${data.failed}

## ALL URLS (${data.all.split('\n').filter(Boolean).length} URLs)
${data.all}
    `);
  } else {
    res.json(data);
  }
});

// API endpoint untuk reset database
app.post("/api/reset", (req, res) => {
  resetDatabase();
  res.json({ message: 'Database reset successfully', stats });
});

// API endpoint untuk config
app.get("/api/config", (req, res) => {
  res.json({
    sourceUrl: SOURCE_URL,
    corsProxy: CORS_PROXY,
    workers: 20,
    maxHistory: MAX_HISTORY,
    uptime: process.uptime()
  });
});

// Serve HTML dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () =>
  console.log(`🌐 Web server OK on port ${PORT}`)
);

// Mulai mesin
mainLoop();
