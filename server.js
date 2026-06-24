// ═══════════════════════════════════════════════════════════════════════
// NEXUS PROXY — minimal CORS relay for Binance demo-fapi
// ═══════════════════════════════════════════════════════════════════════
//
// PURPOSE
// Browsers block direct POSTs from arbitrary origins to demo-fapi.binance.com
// because Binance's testnet endpoint does not return permissive CORS headers.
// This proxy sits between the bot and Binance, adds the CORS headers the
// browser needs, and relays the request. The browser sees a same-origin
// (or properly-CORS'd) response and trusts it.
//
// SECURITY
// - The bot signs requests with HMAC-SHA256 in the BROWSER, before sending
//   to this proxy. The proxy never sees the raw secret.
// - The proxy forwards the signed query string and the X-MBX-APIKEY header
//   verbatim. It does not log, store, or modify credentials.
// - You can lock this proxy down to a single allowed origin (your bot's
//   GitHub Pages URL) by setting ALLOWED_ORIGIN below.
//
// USAGE
// Bot calls: https://<your-fly-app>.fly.dev/proxy/<path>?<query>
// Proxy hits: https://demo-fapi.binance.com/<path>?<query>
//
// Example:
//   Bot → https://nexus-proxy.fly.dev/proxy/fapi/v1/order
//   Proxy → https://demo-fapi.binance.com/fapi/v1/order
//
// ═══════════════════════════════════════════════════════════════════════

const http = require('http');
const https = require('https');
const { URL } = require('url');

// NEXUS live-data routes (/ping, /data/*) — added alongside the order proxy.
const handleNexusData = require('./nexus-data-routes');

const PORT = process.env.PORT || 8080;
const TARGET_HOST = 'demo-fapi.binance.com';

// Lock the proxy to a specific origin. Change this to your GitHub Pages URL.
// Use '*' during testing to allow any origin (less secure).
const ALLOWED_ORIGIN = process.env.ALLOWED_ORIGIN || '*';

// Headers that browsers may send and we want to forward to Binance
const SAFE_REQUEST_HEADERS = [
  'x-mbx-apikey',
  'content-type',
  'accept',
];

function corsHeaders(reqOrigin) {
  return {
    'Access-Control-Allow-Origin': ALLOWED_ORIGIN === '*' ? (reqOrigin || '*') : ALLOWED_ORIGIN,
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'X-MBX-APIKEY, Content-Type, Accept',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

const server = http.createServer((req, res) => {
  const reqOrigin = req.headers.origin;

  // ── NEXUS data routes (/ping, /data/*) — handled first, returns if owned ──
  if (handleNexusData(req, res)) return;

  // ── Preflight (OPTIONS) ─────────────────────────────────────────────
  if (req.method === 'OPTIONS') {
    res.writeHead(204, corsHeaders(reqOrigin));
    res.end();
    return;
  }

  // ── Health check ────────────────────────────────────────────────────
  if (req.url === '/' || req.url === '/health') {
    res.writeHead(200, { ...corsHeaders(reqOrigin), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({
      status: 'ok',
      proxy: 'nexus-proxy',
      target: TARGET_HOST,
      time: new Date().toISOString(),
    }));
    return;
  }

  // ── Only requests under /proxy/ are forwarded ───────────────────────
  if (!req.url.startsWith('/proxy/')) {
    res.writeHead(404, { ...corsHeaders(reqOrigin), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: 'Not Found', hint: 'Use /proxy/<binance-path>' }));
    return;
  }

  // Strip the /proxy prefix
  const targetPath = req.url.replace(/^\/proxy/, '');

  // Build forwarded headers — only forward safe headers
  const forwardHeaders = {};
  for (const name of SAFE_REQUEST_HEADERS) {
    const v = req.headers[name];
    if (v !== undefined) forwardHeaders[name] = v;
  }
  // We must set a host header
  forwardHeaders['host'] = TARGET_HOST;

  // ── Forward the request body if any ─────────────────────────────────
  const bodyChunks = [];
  req.on('data', chunk => bodyChunks.push(chunk));
  req.on('end', () => {
    const body = Buffer.concat(bodyChunks);

    const options = {
      hostname: TARGET_HOST,
      port: 443,
      path: targetPath,
      method: req.method,
      headers: forwardHeaders,
    };

    const upstream = https.request(options, upstreamRes => {
      // Pass through Binance's response status + body, but with OUR CORS headers
      const responseHeaders = {
        ...corsHeaders(reqOrigin),
        'Content-Type': upstreamRes.headers['content-type'] || 'application/json',
      };
      // Pass through Binance's rate limit headers if present (useful for the bot)
      ['x-mbx-used-weight', 'x-mbx-used-weight-1m', 'x-mbx-order-count-1m', 'x-mbx-order-count-10s'].forEach(h => {
        if (upstreamRes.headers[h]) responseHeaders[h] = upstreamRes.headers[h];
      });

      res.writeHead(upstreamRes.statusCode || 502, responseHeaders);
      upstreamRes.pipe(res);
    });

    upstream.on('error', err => {
      console.error('Upstream error:', err.message);
      res.writeHead(502, { ...corsHeaders(reqOrigin), 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ code: -9998, msg: 'Proxy upstream error: ' + err.message }));
    });

    if (body.length > 0) upstream.write(body);
    upstream.end();
  });

  req.on('error', err => {
    console.error('Request error:', err.message);
    res.writeHead(400, { ...corsHeaders(reqOrigin), 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ code: -9997, msg: 'Proxy request error: ' + err.message }));
  });
});

server.listen(PORT, '0.0.0.0', () => {
  console.log(`Nexus proxy listening on :${PORT} → ${TARGET_HOST}`);
  console.log(`Allowed origin: ${ALLOWED_ORIGIN}`);
});
