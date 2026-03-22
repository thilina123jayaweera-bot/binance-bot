process.on('uncaughtException', err => {
  console.error('Uncaught:', err.message);
});

require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;
const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';

app.use(cors());
app.use(express.json());

function sign(str) {
  return crypto.createHmac('sha256', API_SECRET).update(str).digest('hex');
}

function call(base, path, method, params, signed) {
  return new Promise((resolve, reject) => {
    try {
      let qs = Object.entries(params || {})
        .map(([k, v]) => k + '=' + encodeURIComponent(v)).join('&');
      if (signed) {
        qs += (qs ? '&' : '') + 'timestamp=' + Date.now();
        qs += '&signature=' + sign(qs);
      }
      const fullPath = qs ? path + '?' + qs : path;
      const url = new URL(base + fullPath);
      const req = https.request({
        hostname: url.hostname,
        path: url.pathname + url.search,
        method: method || 'GET',
        headers: {
          'X-MBX-APIKEY': API_KEY,
          'Content-Type': 'application/json'
        }
      }, res => {
        let data = '';
        res.on('data', c => data += c);
        res.on('end', () => {
          try { resolve(JSON.parse(data)); }
          catch (e) { resolve({ error: data }); }
        });
      });
      req.on('error', reject);
      req.end();
    } catch (e) {
      reject(e);
    }
  });
}

app.get('/', (req, res) => res.json({
  status: 'online',
  server: 'Binance AI Bot',
  keysLoaded: !!(API_KEY && API_SECRET),
  time: new Date().toISOString()
}));

app.get('/api/ip', (req, res) => res.json({
  ip: req.headers['x-forwarded-for'] || req.socket.remoteAddress
}));

app.get('/api/test', async (req, res) => {
  try {
    if (!API_KEY) return res.json({ error: 'No API key' });
    const r = await call('https://api.binance.com', '/api/v3/account', 'GET', {}, true);
    if (r.code) return res.json({ error: r.msg, code: r.code });
    res.json({ connected: true, canTrade: r.canTrade, accountType: r.accountType });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/balance', async (req, res) => {
  try {
    const r = await call('https://api.binance.com', '/api/v3/account', 'GET', {}, true);
    if (r.code) return res.json({ error: r.msg });
    const bals = r.balances.filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({ asset: b.asset, free: +b.free, locked: +b.locked, total: +b.free + +b.locked }));
    const usdt = bals.find(b => b.asset === 'USDT');
    res.json({ connected: true, balances: bals, totalUSDT: (usdt ? usdt.total : 0).toFixed(2) });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/prices', async (req, res) => {
  try {
    const syms = (req.query.symbols || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
    const prices = await Promise.all(syms.map(s =>
      call('https://api.binance.com', '/api/v3/ticker/24hr', 'GET', { symbol: s })
    ));
    res.json({ prices: prices.map(p => ({ symbol: p.symbol, price: +p.lastPrice, change24h: +p.priceChangePercent })) });
  } catch (e) { res.json({ error: e.message }); }
});

app.get('/api/orders/open', async (req, res) => {
  try {
    const params = req.query.symbol ? { symbol: req.query.symbol } : {};
    const r = await call('https://api.binance.com', '/api/v3/openOrders', 'GET', params, true);
    if (r.code) return res.json({ error: r.msg });
    res.json({ orders: r, count: r.length });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/order/spot', async (req, res) => {
  try {
    const { symbol, side, type, quantity, price } = req.body;
    if (!symbol || !side || !quantity) return res.json({ error: 'Missing fields' });
    const params = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: (type || 'MARKET').toUpperCase(),
      quantity: parseFloat(quantity).toFixed(6)
    };
    if (params.type === 'LIMIT') {
      params.timeInForce = 'GTC';
      params.price = parseFloat(price).toFixed(2);
    }
    const r = await call('https://api.binance.com', '/api/v3/order', 'POST', params, true);
    if (r.code) return res.json({ error: r.msg, code: r.code });
    res.json({ success: true, orderId: r.orderId, status: r.status });
  } catch (e) { res.json({ error: e.message }); }
});

app.post('/api/futures/order', async (req, res) => {
  try {
    const { symbol, side, type, quantity, leverage } = req.body;
    if (!symbol || !side || !quantity) return res.json({ error: 'Missing fields' });
    if (leverage && +leverage > 1) {
      await call('https://fapi.binance.com', '/fapi/v1/leverage', 'POST',
        { symbol: symbol.toUpperCase(), leverage: +leverage }, true);
    }
    const params = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: (type || 'MARKET').toUpperCase(),
      quantity: parseFloat(quantity).toFixed(3)
    };
    const r = await call('https://fapi.binance.com', '/fapi/v1/order', 'POST', params, true);
    if (r.code) return res.json({ error: r.msg, code: r.code });
    res.json({ success: true, orderId: r.orderId, status: r.status });
  } catch (e) { res.json({ error: e.message }); }
});

app.listen(PORT, '0.0.0.0', () => {
  console.log('Server running on port ' + PORT);
  console.log('Keys: ' + (API_KEY ? 'LOADED' : 'MISSING'));
});
