require('dotenv').config();
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const https = require('https');

const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors({ origin: '*' }));
app.use(express.json());

const API_KEY = process.env.BINANCE_API_KEY || '';
const API_SECRET = process.env.BINANCE_API_SECRET || '';
const BINANCE_BASE = 'https://api.binance.com';
const FUTURES_BASE = 'https://fapi.binance.com';

function sign(q) {
  return crypto.createHmac('sha256', API_SECRET).update(q).digest('hex');
}

function binanceReq(base, path, method='GET', params={}, signed=false) {
  return new Promise((resolve, reject) => {
    let qs = Object.entries(params).map(([k,v])=>`${k}=${encodeURIComponent(v)}`).join('&');
    if(signed) {
      const ts = Date.now();
      qs += (qs?'&':'') + `timestamp=${ts}`;
      qs += `&signature=${sign(qs)}`;
    }
    const fullPath = qs ? `${path}?${qs}` : path;
    const url = new URL(base + fullPath);
    const options = {
      hostname: url.hostname,
      path: url.pathname + url.search,
      method,
      headers: { 'X-MBX-APIKEY': API_KEY, 'Content-Type': 'application/json' }
    };
    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => { try { resolve(JSON.parse(data)); } catch(e) { reject(e); } });
    });
    req.on('error', reject);
    req.end();
  });
}

app.get('/', (req, res) => res.json({
  status: 'online',
  server: 'Binance AI Bot',
  keysLoaded: !!(API_KEY && API_SECRET),
  time: new Date().toISOString()
}));

app.get('/api/test', async (req, res) => {
  try {
    if(!API_KEY || !API_SECRET) return res.status(400).json({error:'API keys not set in environment variables'});
    const result = await binanceReq(BINANCE_BASE, '/api/v3/account', 'GET', {}, true);
    if(result.code) return res.status(400).json({error: result.msg});
    res.json({connected: true, accountType: result.accountType, canTrade: result.canTrade});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/balance', async (req, res) => {
  try {
    const account = await binanceReq(BINANCE_BASE, '/api/v3/account', 'GET', {}, true);
    if(account.code) return res.status(400).json({error: account.msg});
    const balances = account.balances
      .filter(b => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0)
      .map(b => ({asset:b.asset, free:parseFloat(b.free), locked:parseFloat(b.locked), total:parseFloat(b.free)+parseFloat(b.locked)}));
    const usdt = balances.find(b=>b.asset==='USDT');
    res.json({connected:true, balances, totalUSDT:(usdt?usdt.total:0).toFixed(2), canTrade:account.canTrade});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/prices', async (req, res) => {
  try {
    const symbols = (req.query.symbols||'BTCUSDT,ETHUSDT,SOLUSDT,BNBUSDT,LINKUSDT').split(',');
    const prices = await Promise.all(symbols.map(s => binanceReq(BINANCE_BASE,'/api/v3/ticker/24hr','GET',{symbol:s})));
    res.json({prices: prices.map(p=>({symbol:p.symbol, price:parseFloat(p.lastPrice), change24h:parseFloat(p.priceChangePercent), volume:parseFloat(p.quoteVolume)}))});
  } catch(e) { res.status(500).json({error: e.message}); }
});

app.get('/api/orders/open', async (req, res) => {
  try {
    const orders = await binanceReq(BINANCE_BASE,'/api/v3/openOrders','GET',req.query.symbol?{symbol:req.query.symbol}:{},true);
    if(orders.code) return res.status(400).json({error:orders.msg});
    res.json({orders, count:orders.length});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/order/spot', async (req, res) => {
  try {
    const {symbol,side,type,quantity,price} = req.body;
    if(!symbol||!side||!type||!quantity) return res.status(400).json({error:'Missing fields'});
    const params = {symbol:symbol.toUpperCase(), side:side.toUpperCase(), type:type.toUpperCase(), quantity:parseFloat(quantity).toFixed(6)};
    if(type.toUpperCase()==='LIMIT'){params.timeInForce='GTC';params.price=parseFloat(price).toFixed(2);}
    const order = await binanceReq(BINANCE_BASE,'/api/v3/order','POST',params,true);
    if(order.code) return res.status(400).json({error:order.msg});
    res.json({success:true, orderId:order.orderId, status:order.status});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.post('/api/futures/order', async (req, res) => {
  try {
    const {symbol,side,type,quantity,leverage} = req.body;
    if(!symbol||!side||!type||!quantity) return res.status(400).json({error:'Missing fields'});
    if(leverage && parseInt(leverage)>1) {
      await binanceReq(FUTURES_BASE,'/fapi/v1/leverage','POST',{symbol:symbol.toUpperCase(),leverage:parseInt(leverage)},true);
    }
    const params = {symbol:symbol.toUpperCase(), side:side.toUpperCase(), type:type.toUpperCase(), quantity:parseFloat(quantity).toFixed(3)};
    const order = await binanceReq(FUTURES_BASE,'/fapi/v1/order','POST',params,true);
    if(order.code) return res.status(400).json({error:order.msg});
    res.json({success:true, orderId:order.orderId, status:order.status});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.get('/api/futures/positions', async (req, res) => {
  try {
    const account = await binanceReq(FUTURES_BASE,'/fapi/v2/account','GET',{},true);
    if(account.code) return res.status(400).json({error:account.msg});
    const positions = account.positions.filter(p=>parseFloat(p.positionAmt)!==0).map(p=>({
      symbol:p.symbol, side:parseFloat(p.positionAmt)>0?'LONG':'SHORT',
      size:Math.abs(parseFloat(p.positionAmt)), entryPrice:parseFloat(p.entryPrice),
      unrealizedPnl:parseFloat(p.unrealizedProfit), leverage:parseInt(p.leverage)
    }));
    res.json({positions, totalWalletBalance:parseFloat(account.totalWalletBalance)});
  } catch(e) { res.status(500).json({error:e.message}); }
});

app.listen(PORT, () => console.log(`Binance AI Bot running on port ${PORT} | Keys: ${!!(API_KEY&&API_SECRET)?'LOADED':'NOT SET'}`));
