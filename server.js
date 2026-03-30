// ================== BACKEND - better-sqlite3 (Render compatible) ==================
require('dotenv').config();
const express = require('express');
const Database = require('better-sqlite3');
const cors = require('cors');
const fetch = require('node-fetch');
const cron = require('node-cron');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());

const db = new Database('./portfolio.db');

db.exec(`
    CREATE TABLE IF NOT EXISTS stocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'us',
        buy_price REAL NOT NULL,
        qty REAL NOT NULL,
        dividend REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS targets (
        symbol TEXT PRIMARY KEY,
        percent REAL NOT NULL
    );
    CREATE TABLE IF NOT EXISTS price_cache (
        symbol TEXT PRIMARY KEY,
        price REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        price REAL,
        date TEXT,
        UNIQUE(symbol, date)
    );
`);

const API_KEY = process.env.API_KEY;

function formatSymbol(symbol, type) {
    if (type === 'thai') return symbol.toUpperCase() + '.BK';
    return symbol.toUpperCase();
}

async function fetchPrice(symbol, type) {
    const formatted = formatSymbol(symbol, type);
    const url = `https://api.twelvedata.com/price?symbol=${formatted}&apikey=${API_KEY}`;
    const r = await fetch(url, { timeout: 10000 });
    const data = await r.json();
    if (data.price) return parseFloat(data.price);
    throw new Error(data.message || 'Price not found');
}

function saveToCache(symbol, price) {
    db.prepare(`INSERT OR REPLACE INTO price_cache(symbol, price, updated_at) VALUES(?, ?, CURRENT_TIMESTAMP)`).run(symbol.toUpperCase(), price);
    const today = new Date().toISOString().split('T')[0];
    db.prepare(`INSERT OR IGNORE INTO price_history(symbol, price, date) VALUES(?, ?, ?)`).run(symbol.toUpperCase(), price, today);
}

cron.schedule('*/5 3-21 * * 1-5', async () => {
    const rows = db.prepare(`SELECT DISTINCT symbol, type FROM stocks`).all();
    for (const row of rows) {
        try { const price = await fetchPrice(row.symbol, row.type); saveToCache(row.symbol, price); } catch {}
        await new Promise(r => setTimeout(r, 1200));
    }
});

app.get('/', (req, res) => res.json({ status: 'OK', time: new Date() }));

app.get('/price/:symbol/:type', async (req, res) => {
    const { symbol, type } = req.params;
    try {
        const price = await fetchPrice(symbol, type);
        saveToCache(symbol, price);
        res.json({ symbol: symbol.toUpperCase(), price, source: 'live' });
    } catch (e) {
        const cached = db.prepare(`SELECT price, updated_at FROM price_cache WHERE symbol=?`).get(symbol.toUpperCase());
        if (cached) return res.json({ symbol: symbol.toUpperCase(), price: cached.price, source: 'cache', updated_at: cached.updated_at });
        res.status(400).json({ error: e.message });
    }
});

app.post('/refresh-prices', async (req, res) => {
    const rows = db.prepare(`SELECT DISTINCT symbol, type FROM stocks`).all();
    let updated = 0, errors = [];
    for (const row of rows) {
        try { const price = await fetchPrice(row.symbol, row.type); saveToCache(row.symbol, price); updated++; }
        catch (e) { errors.push({ symbol: row.symbol, error: e.message }); }
        await new Promise(r => setTimeout(r, 1200));
    }
    res.json({ updated, errors });
});

app.get('/history/:symbol', (req, res) => {
    res.json(db.prepare(`SELECT date, price FROM price_history WHERE symbol=? ORDER BY date DESC LIMIT 30`).all(req.params.symbol.toUpperCase()));
});

app.post('/stock', (req, res) => {
    const { symbol, type, price, qty, dividend } = req.body;
    if (!symbol || !type || !price || !qty) return res.status(400).json({ error: 'Missing fields' });
    const result = db.prepare(`INSERT INTO stocks(symbol, type, buy_price, qty, dividend) VALUES(?,?,?,?,?)`).run(symbol.toUpperCase(), type, price, qty, dividend || 0);
    res.json({ id: result.lastInsertRowid });
});

app.get('/stocks', (req, res) => {
    res.json(db.prepare(`SELECT s.*, COALESCE(p.price, s.buy_price) as current_price, p.updated_at FROM stocks s LEFT JOIN price_cache p ON p.symbol = s.symbol ORDER BY s.symbol`).all());
});

app.delete('/stock/:id', (req, res) => {
    db.prepare(`DELETE FROM stocks WHERE id=?`).run(req.params.id);
    res.json({ ok: true });
});

app.post('/target', (req, res) => {
    const { symbol, percent } = req.body;
    db.prepare(`INSERT OR REPLACE INTO targets(symbol, percent) VALUES(?,?)`).run(symbol.toUpperCase(), percent);
    res.json({ ok: true });
});

app.get('/targets', (req, res) => res.json(db.prepare(`SELECT * FROM targets ORDER BY symbol`).all()));

app.get('/rebalance', (req, res) => {
    const stocks = db.prepare(`SELECT s.*, COALESCE(p.price, s.buy_price) as current_price FROM stocks s LEFT JOIN price_cache p ON p.symbol = s.symbol`).all();
    const targets = db.prepare(`SELECT * FROM targets`).all();
    const targetMap = {};
    targets.forEach(t => targetMap[t.symbol] = t.percent);
    const total = stocks.reduce((s, x) => s + (x.current_price * x.qty), 0);
    const result = stocks.map(s => {
        const value = s.current_price * s.qty;
        const weight = total > 0 ? (value / total) * 100 : 0;
        const target = targetMap[s.symbol] || 0;
        const adjustValue = ((target / 100) * total) - value;
        const adjustQty = s.current_price > 0 ? adjustValue / s.current_price : 0;
        const pl = value - (s.buy_price * s.qty);
        const plPct = s.buy_price > 0 ? ((s.current_price - s.buy_price) / s.buy_price) * 100 : 0;
        return { id: s.id, symbol: s.symbol, type: s.type, buy_price: s.buy_price, current_price: s.current_price, qty: s.qty, value: parseFloat(value.toFixed(2)), weight: parseFloat(weight.toFixed(2)), target, adjust_value: parseFloat(adjustValue.toFixed(2)), adjust_qty: parseFloat(adjustQty.toFixed(4)), pl: parseFloat(pl.toFixed(2)), pl_pct: parseFloat(plPct.toFixed(2)), dividend: s.dividend };
    });
    const totalCost = stocks.reduce((s, x) => s + (x.buy_price * x.qty), 0);
    const totalDiv = stocks.reduce((s, x) => s + ((x.dividend || 0) * x.qty), 0);
    res.json({ total, total_cost: parseFloat(totalCost.toFixed(2)), total_pl: parseFloat((total - totalCost).toFixed(2)), total_pl_pct: totalCost > 0 ? parseFloat(((total - totalCost) / totalCost * 100).toFixed(2)) : 0, annual_dividend: parseFloat(totalDiv.toFixed(2)), dividend_yield: total > 0 ? parseFloat((totalDiv / total * 100).toFixed(2)) : 0, result });
});

app.post('/smart-buy', async (req, res) => {
    const { symbol, type, date, budget_thb, dividend } = req.body;
    if (!symbol || !type || !date || !budget_thb) return res.status(400).json({ error: 'Missing fields' });
    try {
        const formatted = formatSymbol(symbol, type);
        const priceData = await (await fetch(`https://api.twelvedata.com/time_series?symbol=${formatted}&interval=1day&start_date=${date}&end_date=${date}&apikey=${API_KEY}`, { timeout: 10000 })).json();
        let stockPriceUSD;
        if (priceData.values && priceData.values.length > 0) {
            stockPriceUSD = parseFloat(priceData.values[0].close);
        } else {
            const d = new Date(date); d.setDate(d.getDate() - 5);
            const fbData = await (await fetch(`https://api.twelvedata.com/time_series?symbol=${formatted}&interval=1day&start_date=${d.toISOString().split('T')[0]}&end_date=${date}&outputsize=5&apikey=${API_KEY}`, { timeout: 10000 })).json();
            if (fbData.values && fbData.values.length > 0) stockPriceUSD = parseFloat(fbData.values[0].close);
            else return res.status(400).json({ error: `ไม่พบราคา ${formatted} วันที่ ${date}` });
        }
        let fxRate = 1, fxSource = 'หุ้นไทย';
        if (type === 'us') {
            try {
                const fxData = await (await fetch(`https://api.twelvedata.com/time_series?symbol=USD/THB&interval=1day&start_date=${date}&end_date=${date}&apikey=${API_KEY}`, { timeout: 10000 })).json();
                if (fxData.values && fxData.values.length > 0) { fxRate = parseFloat(fxData.values[0].close); fxSource = `Twelvedata ${date}`; }
                else { const n = await (await fetch(`https://api.twelvedata.com/price?symbol=USD/THB&apikey=${API_KEY}`)).json(); fxRate = n.price ? parseFloat(n.price) : 34.5; fxSource = 'อัตราปัจจุบัน'; }
            } catch { fxRate = 34.5; fxSource = 'ค่าประมาณ'; }
        }
        const stockPriceTHB = stockPriceUSD * fxRate;
        const qtyExact = budget_thb / stockPriceTHB;
        const qty3dec = parseFloat(qtyExact.toFixed(3)); // เศษหุ้น 3 ตำแหน่ง
        const actualCost = qty3dec * stockPriceTHB;
        res.json({ symbol: formatted, type, date, budget_thb: parseFloat(budget_thb), stock_price_usd: parseFloat(stockPriceUSD.toFixed(4)), fx_rate: parseFloat(fxRate.toFixed(4)), fx_source: fxSource, stock_price_thb: parseFloat(stockPriceTHB.toFixed(4)), qty_exact: parseFloat(qtyExact.toFixed(6)), qty_floor: qty3dec, actual_cost_thb: parseFloat(actualCost.toFixed(2)), remainder_thb: parseFloat((budget_thb - actualCost).toFixed(2)), ready_to_add: { symbol: symbol.toUpperCase(), type, price: parseFloat(stockPriceTHB.toFixed(2)), qty: qty3dec, dividend: parseFloat(dividend || 0) } });
    } catch (e) { res.status(500).json({ error: e.message }); }
});

app.listen(3000, () => console.log('✅ Server running at http://localhost:3000'));
