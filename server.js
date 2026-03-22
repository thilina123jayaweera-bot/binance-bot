require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 8080;

app.use(cors({ origin: '*' }));
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const BINANCE_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';

function sign(q) {
  return crypto.createHmac('sha256', API_SECRET).update(q).digest('hex');
}

function binanceReq(base, path, method, params, signed) {
  return new Promise((resolve, reject) => {
    let qs = Object.entries(params||{})
      .map(([k,v]) => k+'='+encodeURIComponent(v)).join('&');
    if(signed) {
      const ts = Date.now();
      qs += (qs?'&':'') + 'timestamp='+ts;
      qs += '&signature='+sign(qs);
    }
    const fullPath = qs ? path+'?'+qs : path;
    const url = new URL(base + fullPath);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method: method||'GET',
      headers: {
        'X-MBX-APIKEY': API_KEY,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(new Error('Parse error: '+data)); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'online',
    server: 'Binance AI Bot',
    keysLoaded: !!(API_KEY && API_SECRET),
    port: PORT,
    time: new Date().toISOString()
  });
});

// Get outbound IP
app.get('/api/ip', (req, res) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  res.json({ ip });
});

// Test Binance connection
app.get('/api/test', async (req, res) => {
  try {
    if(!API_KEY || !API_SECRET)
      return res.status(400).json({ error: 'API keys not set' });
    const result = await binanceReq(BINANCE_BASE, '/api/v3/account', 'GET', {}, true);
    if(result.code)
      return res.status(400).json({ error: result.msg, code: result.code });
    res.json({
      connected: true,
      accountType: result.accountType,
      canTrade: result.canTrade,
      canDeposit: result.canDeposit
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get balance
app.get('/api/balance', async (req, res) => {
  try {
    const account = await binanceReq(BINANCE_BASE, '/api/v3/account', 'GET', {}, true);
    if(account.code)
      return res.status(400).json({ error: account.msg });
    const balances = account.balances
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({
        asset: b.asset,
        free: parseFloat(b.free),
        locked: parseFloat(b.locked),
        total: parseFloat(b.free) + parseFloat(b.locked)
      }));
    const usdt = balances.find(b => b.asset === 'USDT');
    res.json({
      connected: true,
      balances,
      totalUSDT: (usdt ? usdt.total : 0).toFixed(2),
      canTrade: account.canTrade
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get prices
app.get('/api/prices', async (req, res) => {
  try {
    const symbols = (req.query.symbols || 'BTCUSDT,ETHUSDT,SOLUSDT').split(',');
    const prices = await Promise.all(
      symbols.map(s => binanceReq(BINANCE_BASE, '/api/v3/ticker/24hr', 'GET', { symbol: s }))
    );
    res.json({
      prices: prices.map(p => ({
        symbol: p.symbol,
        price: parseFloat(p.lastPrice),
        change24h: parseFloat(p.priceChangePercent),
        volume: parseFloat(p.quoteVolume)
      }))
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get open orders
app.get('/api/orders/open', async (req, res) => {
  try {
    const params = req.query.symbol ? { symbol: req.query.symbol } : {};
    const orders = await binanceReq(BINANCE_BASE, '/api/v3/openOrders', 'GET', params, true);
    if(orders.code) return res.status(400).json({ error: orders.msg });
    res.json({ orders, count: orders.length });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Place spot order
app.post('/api/order/spot', async (req, res) => {
  try {
    const { symbol, side, type, quantity, price } = req.body;
    if(!symbol || !side || !type || !quantity)
      return res.status(400).json({ error: 'Missing fields: symbol, side, type, quantity' });
    const params = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: parseFloat(quantity).toFixed(6)
    };
    if(type.toUpperCase() === 'LIMIT') {
      params.timeInForce = 'GTC';
      params.price = parseFloat(price).toFixed(2);
    }
    const order = await binanceReq(BINANCE_BASE, '/api/v3/order', 'POST', params, true);
    if(order.code) return res.status(400).json({ error: order.msg, code: order.code });
    res.json({ success: true, orderId: order.orderId, status: order.status, symbol: order.symbol });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Place futures order
app.post('/api/futures/order', async (req, res) => {
  try {
    const { symbol, side, type, quantity, leverage } = req.body;
    if(!symbol || !side || !type || !quantity)
      return res.status(400).json({ error: 'Missing fields' });
    if(leverage && parseInt(leverage) > 1) {
      await binanceReq(FUTURES_BASE, '/fapi/v1/leverage', 'POST',
        { symbol: symbol.toUpperCase(), leverage: parseInt(leverage) }, true);
    }
    const params = {
      symbol: symbol.toUpperCase(),
      side: side.toUpperCase(),
      type: type.toUpperCase(),
      quantity: parseFloat(quantity).toFixed(3)
    };
    const order = await binanceReq(FUTURES_BASE, '/fapi/v1/order', 'POST', params, true);
    if(order.code) return res.status(400).json({ error: order.msg, code: order.code });
    res.json({ success: true, orderId: order.orderId, status: order.status });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Get futures positions
app.get('/api/futures/positions', async (req, res) => {
  try {
    const account = await binanceReq(FUTURES_BASE, '/fapi/v2/account', 'GET', {}, true);
    if(account.code) return res.status(400).json({ error: account.msg });
    const positions = (account.positions || [])
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol: p.symbol,
        side: parseFloat(p.positionAmt) > 0 ? 'LONG' : 'SHORT',
        size: Math.abs(parseFloat(p.positionAmt)),
        entryPrice: parseFloat(p.entryPrice),
        unrealizedPnl: parseFloat(p.unrealizedProfit),
        leverage: parseInt(p.leverage)
      }));
    res.json({
      positions,
      totalWalletBalance: parseFloat(account.totalWalletBalance || 0)
    });
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// Start server
app.listen(PORT, '0.0.0.0', () => {
  console.log('Binance AI Bot running on port ' + PORT);
  console.log('Keys loaded: ' + !!(API_KEY && API_SECRET));
});
