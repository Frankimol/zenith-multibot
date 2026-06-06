// ═══════════════════════════════════════════════════════════════
// ZENITH MULTIBOT — Server (Render.com)
// Lógica: EMA9/21 + RSI14 + MACD + ADX + Volumen + ATR
// Modos: DEMO / LIVE | Auto ejecución en Binance via API
// ═══════════════════════════════════════════════════════════════

const express = require('express');
const crypto = require('crypto');
const https = require('https');
const cors = require('cors');

const app = express();
app.use(cors({
  origin: '*',
  methods: ['GET','POST','OPTIONS'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.options('*', cors());
app.use(express.json());

// ── CONFIGURACIÓN ───────────────────────────────────────────────
const CONFIG = {
  BINANCE_API_KEY: process.env.BINANCE_API_KEY || '',
  BINANCE_SECRET:  process.env.BINANCE_SECRET  || '',
  MODE:            process.env.BOT_MODE         || 'DEMO',
  MAX_SLOTS:       parseInt(process.env.MAX_SLOTS || '4'),
  SLOT_PCT:        parseFloat(process.env.SLOT_PCT || '0.20'),
  SCAN_INTERVAL:   parseInt(process.env.SCAN_INTERVAL || '60000'),
  TIMEFRAME:       process.env.TIMEFRAME || '15m',
  MIN_VOLUME_USDC: parseFloat(process.env.MIN_VOLUME || '500000'),
};

const SCAN_PAIRS = [
  'BTCUSDC','ETHUSDC','BNBUSDC','SOLUSDC','XRPUSDC',
  'ADAUSDC','DOGEUSDC','AVAXUSDC','DOTUSDC','MATICUSDC',
  'LINKUSDC','UNIUSDC','ATOMUSDC','LTCUSDC','ETCUSDC',
  'XLMUSDC','ALGOUSDC','VETUSDC','FILUSDC','TRXUSDC',
  'NEARUSDC','FTMUSDC','SANDUSDC','MANAUSDC','AAVEUSDC',
  'GRTUSDC','ENJUSDC','CHZUSDC','ZILUSDC','BATUSDC'
];

let state = {
  mode:'DEMO', running:false, slots:[], closedTrades:[],
  balance:{ total:1000, free:1000, inTrade:0 },
  log:[], stats:{ wins:0, losses:0, totalPnl:0, trades:0 },
  lastScan:null, btcPrice:0, btcPctChange1h:0,
};

let scanInterval = null;

function addLog(msg, type='INFO') {
  const entry = { time: new Date().toISOString(), msg, type };
  state.log.unshift(entry);
  if (state.log.length > 200) state.log.pop();
  console.log(`[${type}] ${msg}`);
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }// ── BINANCE API ─────────────────────────────────────────────────
function binanceRequest(path, params={}, method='GET', signed=false) {
  return new Promise((resolve, reject) => {
    let query = Object.entries(params).map(([k,v])=>`${k}=${v}`).join('&');
    if (signed) {
      params.timestamp = Date.now();
      query = Object.entries(params).map(([k,v])=>`${k}=${v}`).join('&');
      const sig = crypto.createHmac('sha256', CONFIG.BINANCE_SECRET)
                        .update(query).digest('hex');
      query += `&signature=${sig}`;
    }
    const options = {
      hostname: 'api.binance.com',
      path: path + (query ? '?'+query : ''),
      method,
      headers: {
        'X-MBX-APIKEY': CONFIG.BINANCE_API_KEY,
        'Content-Type': 'application/json'
      }
    };
    const req = https.request(options, res => {
      let data = '';
      res.on('data', d => data += d);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function getKlines(symbol, interval='15m', limit=100) {
  try {
    const data = await binanceRequest('/api/v3/klines', { symbol, interval, limit });
    return data.map(k => ({
      open:parseFloat(k[1]), high:parseFloat(k[2]),
      low:parseFloat(k[3]), close:parseFloat(k[4]), volume:parseFloat(k[5]),
    }));
  } catch(e) { return null; }
}

async function get24hVolume(symbol) {
  try {
    const data = await binanceRequest('/api/v3/ticker/24hr', { symbol });
    return parseFloat(data.quoteVolume || 0);
  } catch(e) { return 0; }
}

async function getLiveBalance() {
  if (state.mode === 'DEMO') return state.balance.free;
  try {
    const data = await binanceRequest('/api/v3/account', {}, 'GET', true);
    const usdc = data.balances?.find(b => b.asset === 'USDC');
    return parseFloat(usdc?.free || 0);
  } catch(e) { return 0; }
}

async function placeOrder(symbol, side, quantity, price) {
  if (state.mode === 'DEMO') {
    addLog(`[DEMO] ORDER ${side} ${quantity.toFixed(6)} ${symbol} @ ${price}`, 'TRADE');
    return { orderId: 'DEMO_' + Date.now(), status: 'FILLED', price };
  }
  try {
    const params = {
      symbol, side, type:'LIMIT', timeInForce:'GTC',
      quantity: quantity.toFixed(6),
      price: price.toFixed(8),
      recvWindow: 5000,
    };
    return await binanceRequest('/api/v3/order', params, 'POST', true);
  } catch(e) {
    addLog(`Error orden ${side} ${symbol}: ${e.message}`, 'ERROR');
    return null;
  }
}

// ── INDICADORES ─────────────────────────────────────────────────
function calcEMA(data, period) {
  const k = 2 / (period + 1);
  let ema = data[0];
  const result = [ema];
  for (let i = 1; i < data.length; i++) {
    ema = data[i] * k + ema * (1 - k);
    result.push(ema);
  }
  return result;
}

function calcRSI(closes, period=14) {
  if (closes.length < period + 1) return 50;
  let gains = 0, losses = 0;
  for (let i = 1; i <= period; i++) {
    const diff = closes[i] - closes[i-1];
    if (diff > 0) gains += diff; else losses -= diff;
  }
  let avgGain = gains / period;
  let avgLoss = losses / period;
  for (let i = period + 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    avgGain = (avgGain * (period-1) + (diff>0?diff:0)) / period;
    avgLoss = (avgLoss * (period-1) + (diff<0?-diff:0)) / period;
  }
  if (avgLoss === 0) return 100;
  return 100 - (100 / (1 + avgGain/avgLoss));
}

function calcMACD(closes) {
  const ema12 = calcEMA(closes, 12);
  const ema26 = calcEMA(closes, 26);
  const macdLine = ema12.map((v,i) => v - ema26[i]);
  const signal = calcEMA(macdLine.slice(26), 9);
  const last = macdLine.length - 1;
  const sigLast = signal.length - 1;
  return {
    macd: macdLine[last], signal: signal[sigLast],
    histogram: macdLine[last] - signal[sigLast],
    prevHistogram: macdLine[last-1] - signal[sigLast-1],
  };
}

function calcATR(candles, period=14) {
  const trs = [];
  for (let i = 1; i < candles.length; i++) {
    const hl  = candles[i].high - candles[i].low;
    const hpc = Math.abs(candles[i].high - candles[i-1].close);
    const lpc = Math.abs(candles[i].low  - candles[i-1].close);
    trs.push(Math.max(hl, hpc, lpc));
  }
  let atr = trs.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i = period; i < trs.length; i++) {
    atr = (atr * (period-1) + trs[i]) / period;
  }
  return atr;
}

function calcADX(candles, period=14) {
  if (candles.length < period * 2) return { adx:0, diPlus:0, diMinus:0 };
  const dmPlus=[], dmMinus=[], tr=[];
  for (let i=1; i<candles.length; i++) {
    const up   = candles[i].high  - candles[i-1].high;
    const down = candles[i-1].low - candles[i].low;
    dmPlus.push(up > down && up > 0 ? up : 0);
    dmMinus.push(down > up && down > 0 ? down : 0);
    const hl  = candles[i].high - candles[i].low;
    const hpc = Math.abs(candles[i].high - candles[i-1].close);
    const lpc = Math.abs(candles[i].low  - candles[i-1].close);
    tr.push(Math.max(hl, hpc, lpc));
  }
  let sTR  = tr.slice(0,period).reduce((a,b)=>a+b,0);
  let sDMp = dmPlus.slice(0,period).reduce((a,b)=>a+b,0);
  let sDMm = dmMinus.slice(0,period).reduce((a,b)=>a+b,0);
  const dx=[];
  for (let i=period; i<tr.length; i++) {
    sTR  = sTR  - sTR/period  + tr[i];
    sDMp = sDMp - sDMp/period + dmPlus[i];
    sDMm = sDMm - sDMm/period + dmMinus[i];
    const diP = (sDMp/sTR)*100;
    const diM = (sDMm/sTR)*100;
    dx.push({ dxv: Math.abs(diP-diM)/(diP+diM)*100, diP, diM });
  }
  const lastDx = dx[dx.length-1];
  const adx = dx.slice(-period).reduce((a,b)=>a+b.dxv,0)/period;
  return { adx, diPlus:lastDx.diP, diMinus:lastDx.diM };
}

function calcVolumeEMA(candles, period=20) {
  const vols = candles.map(c=>c.volume);
  const ema  = calcEMA(vols, period);
  return ema[ema.length-1];
}

function calcBollingerBands(closes, period=20, stdDev=2) {
  const slice  = closes.slice(-period);
  const middle = slice.reduce((a,b)=>a+b,0)/period;
  const variance = slice.reduce((a,b)=>a+(b-middle)**2,0)/period;
  const std = Math.sqrt(variance);
  return { upper:middle+stdDev*std, middle, lower:middle-stdDev*std };
}// ── LÓGICA DE SEÑAL (5 capas) ───────────────────────────────────
function analyzeCandles(candles, symbol) {
  if (!candles || candles.length < 60) return null;

  const closes  = candles.map(c=>c.close);
  const current = candles[candles.length-1];

  const ema9   = calcEMA(closes, 9);
  const ema21  = calcEMA(closes, 21);
  const ema200 = calcEMA(closes, 200);
  const e9     = ema9[ema9.length-1];
  const e21    = ema21[ema21.length-1];
  const e200   = ema200[ema200.length-1];
  const prevE9 = ema9[ema9.length-2];
  const prevE21= ema21[ema21.length-2];

  const rsi  = calcRSI(closes, 14);
  const macd = calcMACD(closes);
  const adx  = calcADX(candles, 14);
  const atr  = calcATR(candles, 14);
  const volEMA   = calcVolumeEMA(candles, 20);
  const volRatio = current.volume / volEMA;
  const price    = current.close;

  // TREND MODE (ADX > 25)
  if (adx.adx >= 25) {
    const emaCrossUp    = prevE9 <= prevE21 && e9 > e21;
    const emaTrendUp    = e9 > e21;
    const rsiOk         = rsi > 52;
    const macdOk        = macd.histogram > 0 && macd.histogram > macd.prevHistogram;
    const priceAbove200 = price > e200;
    const volOk         = volRatio >= 1.2;
    const diOk          = adx.diPlus > adx.diMinus;

    if ((emaCrossUp || emaTrendUp) && rsiOk && macdOk && priceAbove200 && volOk && diOk) {
      return {
        signal: 'LONG',
        reason: `TREND | ADX:${adx.adx.toFixed(1)} RSI:${rsi.toFixed(1)} VOL:${volRatio.toFixed(2)}x`,
        price, atr,
        tp1:  price + atr * 1.7,
        tp2:  price + atr * 2.7,
        sl:   price - atr * 1.0,
        mode: 'TREND',
        indicators: { rsi, adx:adx.adx, macdHist:macd.histogram, volRatio, e9, e21, e200 }
      };
    }
  }

  // REVERSION MODE (ADX < 20)
  if (adx.adx < 20) {
    const bb          = calcBollingerBands(closes, 20, 2);
    const oversold    = rsi < 32;
    const atLowerBB   = price <= bb.lower * 1.005;
    const macdTurning = macd.histogram > macd.prevHistogram && macd.histogram < 0;
    const volOk       = volRatio >= 1.1;

    if (oversold && atLowerBB && macdTurning && volOk) {
      return {
        signal: 'LONG',
        reason: `REVERSION | ADX:${adx.adx.toFixed(1)} RSI:${rsi.toFixed(1)} BB_LOW VOL:${volRatio.toFixed(2)}x`,
        price, atr,
        tp1:  bb.middle * 1.002,
        tp2:  bb.upper  * 0.998,
        sl:   price - atr * 0.8,
        mode: 'REVERSION',
        indicators: { rsi, adx:adx.adx, macdHist:macd.histogram, volRatio }
      };
    }
  }

  return null;
}

// ── GESTOR DE POSICIONES ────────────────────────────────────────
function getActiveSlots()  { return state.slots.filter(s=>s.status==='OPEN'); }
function hasPair(symbol)   { return getActiveSlots().some(s=>s.symbol===symbol); }
function slotsAvailable()  { return getActiveSlots().length < CONFIG.MAX_SLOTS; }

function correlatedPairOpen(symbol) {
  const largeCaps = ['BTCUSDC','ETHUSDC','BNBUSDC'];
  const openLarge = getActiveSlots().filter(s=>largeCaps.includes(s.symbol)).length;
  if (largeCaps.includes(symbol) && openLarge >= 2) return true;
  return false;
}

async function openPosition(symbol, signal) {
  if (!slotsAvailable())          { addLog(`Sin slots: ${symbol}`,'WARN'); return; }
  if (hasPair(symbol))            { return; }
  if (correlatedPairOpen(symbol)) { addLog(`Correlación bloqueada: ${symbol}`,'WARN'); return; }
  if (state.btcPctChange1h < -3)  { addLog(`BTC cayendo >3% — pausando entradas`,'WARN'); return; }

  const balance   = state.mode==='DEMO' ? state.balance.free : await getLiveBalance();
  const slotValue = balance * CONFIG.SLOT_PCT;
  if (slotValue < 5) { addLog(`Balance insuficiente para ${symbol}`,'WARN'); return; }

  const qty = slotValue / signal.price;
  addLog(`🟢 ABRIENDO ${symbol} | ${signal.reason} | Precio:${signal.price.toFixed(4)} SL:${signal.sl.toFixed(4)} TP1:${signal.tp1.toFixed(4)}`, 'TRADE');

  const order = await placeOrder(symbol, 'BUY', qty, signal.price);
  if (!order) return;

  const slot = {
    id: Date.now(), symbol, side:'LONG',
    entryPrice: signal.price, qty, slotValue,
    tp1: signal.tp1, tp2: signal.tp2, sl: signal.sl,
    atr: signal.atr, mode: signal.mode, reason: signal.reason,
    status: 'OPEN', openTime: Date.now(), tp1Hit: false,
    indicators: signal.indicators, pnl: 0,
  };
  state.slots.push(slot);

  if (state.mode === 'DEMO') {
    state.balance.free    -= slotValue;
    state.balance.inTrade += slotValue;
  }
}

async function closePosition(slot, price, reason) {
  const pnlPct = (price - slot.entryPrice) / slot.entryPrice * 100;
  const pnlUSD = (price - slot.entryPrice) * slot.qty;
  const won    = pnlPct > 0;

  addLog(`${won?'🟢':'🔴'} CERRANDO ${slot.symbol} | ${reason} | PnL:${pnlPct.toFixed(2)}% (${pnlUSD.toFixed(4)} USDC)`, 'TRADE');

  await placeOrder(slot.symbol, 'SELL', slot.qty, price);

  slot.status      = 'CLOSED';
  slot.closeTime   = Date.now();
  slot.closePrice  = price;
  slot.closePnl    = pnlPct;
  slot.closeReason = reason;

  state.stats.trades++;
  if (won) state.stats.wins++; else state.stats.losses++;
  state.stats.totalPnl += pnlUSD;

  if (state.mode === 'DEMO') {
    const returned = slot.slotValue * (1 + pnlPct/100);
    state.balance.free    += returned;
    state.balance.inTrade -= slot.slotValue;
    state.balance.total    = state.balance.free + state.balance.inTrade;
  }

  state.closedTrades.unshift({ ...slot });
  if (state.closedTrades.length > 100) state.closedTrades.pop();
  state.slots = state.slots.filter(s=>s.id!==slot.id);
}

async function checkExits() {
  const open = getActiveSlots();
  for (const slot of open) {
    const candles = await getKlines(slot.symbol, CONFIG.TIMEFRAME, 3);
    if (!candles) continue;
    const price   = candles[candles.length-1].close;
    slot.pnl      = (price - slot.entryPrice) / slot.entryPrice * 100;
    const elapsed = (Date.now() - slot.openTime) / 60000;
    const timeout = CONFIG.TIMEFRAME === '5m' ? 120 : CONFIG.TIMEFRAME === '15m' ? 240 : 480;

    let closeReason = null;

    if (price <= slot.sl) {
      closeReason = 'STOP_LOSS';
    } else if (!slot.tp1Hit && price >= slot.tp1) {
      slot.tp1Hit  = true;
      slot.sl      = slot.entryPrice; // breakeven
      slot.slotValue *= 0.5;
      slot.qty     *= 0.5;
      addLog(`🟡 TP1 ${slot.symbol} @ ${price.toFixed(4)} (+${slot.pnl.toFixed(2)}%) — SL a breakeven`, 'TRADE');
      continue;
    } else if (slot.tp1Hit && price >= slot.tp2) {
      closeReason = 'TP2';
    } else if (elapsed >= timeout) {
      closeReason = 'TIMEOUT';
    }

    if (closeReason) await closePosition(slot, price, closeReason);
    await sleep(300);
  }
}// ── BTC REFERENCIA ──────────────────────────────────────────────
async function updateBTCReference() {
  try {
    const candles = await getKlines('BTCUSDC', '1h', 3);
    if (candles && candles.length >= 2) {
      const last = candles[candles.length-1].close;
      const prev = candles[candles.length-2].close;
      state.btcPrice      = last;
      state.btcPctChange1h= (last-prev)/prev*100;
    }
  } catch(e) {}
}

// ── CICLO PRINCIPAL ─────────────────────────────────────────────
async function scanCycle() {
  if (!state.running) return;
  state.lastScan = new Date().toISOString();
  addLog(`🔍 Escaneando ${SCAN_PAIRS.length} pares...`, 'SCAN');

  await updateBTCReference();
  await checkExits();

  if (!slotsAvailable()) {
    addLog(`Slots llenos (${getActiveSlots().length}/${CONFIG.MAX_SLOTS})`, 'INFO');
    return;
  }

  let signalsFound = 0;
  for (const pair of SCAN_PAIRS) {
    if (!state.running) break;
    if (hasPair(pair)) { await sleep(200); continue; }

    const vol24h = await get24hVolume(pair);
    if (vol24h < CONFIG.MIN_VOLUME_USDC) { await sleep(150); continue; }

    const candles = await getKlines(pair, CONFIG.TIMEFRAME, 210);
    if (!candles) { await sleep(300); continue; }

    const signal = analyzeCandles(candles, pair);
    if (signal) {
      signalsFound++;
      addLog(`📡 Señal ${pair}: ${signal.reason}`, 'SIGNAL');
      await openPosition(pair, signal);
      if (!slotsAvailable()) break;
    }
    await sleep(400);
  }

  addLog(`Scan completado. Señales:${signalsFound} Slots:${getActiveSlots().length}/${CONFIG.MAX_SLOTS}`, 'SCAN');
}

// ── API REST ────────────────────────────────────────────────────
app.get('/status', (req,res) => {
  res.json({
    running: state.running, mode: state.mode,
    slots: state.slots, closedTrades: state.closedTrades.slice(0,30),
    balance: state.balance, stats: state.stats,
    log: state.log.slice(0,50), lastScan: state.lastScan,
    btcPrice: state.btcPrice, btcChange1h: state.btcPctChange1h,
    config: {
      maxSlots: CONFIG.MAX_SLOTS, slotPct: CONFIG.SLOT_PCT,
      timeframe: CONFIG.TIMEFRAME, scanInterval: CONFIG.SCAN_INTERVAL,
    }
  });
});

app.post('/start', (req,res) => {
  if (state.running) { res.json({ok:false,msg:'Ya corriendo'}); return; }
  state.running = true;
  addLog('▶️ Bot INICIADO', 'SYSTEM');
  scanCycle();
  scanInterval = setInterval(scanCycle, CONFIG.SCAN_INTERVAL);
  res.json({ok:true, msg:'Bot iniciado'});
});

app.post('/stop', (req,res) => {
  state.running = false;
  if (scanInterval) clearInterval(scanInterval);
  addLog('⏹️ Bot DETENIDO', 'SYSTEM');
  res.json({ok:true, msg:'Bot detenido'});
});

app.post('/mode', (req,res) => {
  const { mode } = req.body;
  if (!['DEMO','LIVE'].includes(mode)) { res.json({ok:false,msg:'Modo inválido'}); return; }
  state.mode = mode;
  addLog(`🔄 Modo cambiado a ${mode}`, 'SYSTEM');
  res.json({ok:true, msg:`Modo: ${mode}`});
});

app.post('/config', (req,res) => {
  const { maxSlots, slotPct, timeframe, scanInterval:si } = req.body;
  if (maxSlots)  CONFIG.MAX_SLOTS     = parseInt(maxSlots);
  if (slotPct)   CONFIG.SLOT_PCT      = parseFloat(slotPct);
  if (timeframe) CONFIG.TIMEFRAME     = timeframe;
  if (si)        CONFIG.SCAN_INTERVAL = parseInt(si);
  addLog(`⚙️ Config actualizada`, 'SYSTEM');
  res.json({ok:true, config:{ maxSlots:CONFIG.MAX_SLOTS, slotPct:CONFIG.SLOT_PCT, timeframe:CONFIG.TIMEFRAME }});
});

app.post('/close/:id', async (req,res) => {
  const slot = state.slots.find(s=>s.id===parseInt(req.params.id));
  if (!slot) { res.json({ok:false,msg:'Slot no encontrado'}); return; }
  const candles = await getKlines(slot.symbol, CONFIG.TIMEFRAME, 2);
  const price   = candles ? candles[candles.length-1].close : slot.entryPrice;
  await closePosition(slot, price, 'MANUAL');
  res.json({ok:true, msg:`${slot.symbol} cerrado manualmente`});
});

app.post('/reset-demo', (req,res) => {
  state.balance      = { total:1000, free:1000, inTrade:0 };
  state.stats        = { wins:0, losses:0, totalPnl:0, trades:0 };
  state.slots        = [];
  state.closedTrades = [];
  state.log          = [];
  addLog('🔄 Demo reseteado a 1000 USDC', 'SYSTEM');
  res.json({ok:true});
});

app.get('/ping', (req,res) => res.send('pong'));

// ── ARRANQUE ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  addLog(`🚀 Zenith MultiBot en puerto ${PORT} | Modo: ${CONFIG.MODE}`, 'SYSTEM');
});
