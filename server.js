// ================== BACKEND - FIXED & IMPROVED ==================
// Install: npm install express sqlite3 cors node-fetch dotenv node-cron
// Run: node server.js
// .env file: API_KEY=your_twelvedata_api_key

require('dotenv').config();
const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const fetch = require('node-fetch');
const cron = require('node-cron');

const app = express();
app.use(cors());
app.use(express.json());

const db = new sqlite3.Database('./portfolio.db');

// ===== CREATE TABLES =====
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS stocks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT NOT NULL,
        type TEXT NOT NULL DEFAULT 'us',
        buy_price REAL NOT NULL,
        qty REAL NOT NULL,
        dividend REAL DEFAULT 0,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    db.run(`CREATE TABLE IF NOT EXISTS targets (
        symbol TEXT PRIMARY KEY,
        percent REAL NOT NULL
    )`);

    // FIX: เพิ่มตาราง price_cache เพื่อเก็บราคาล่าสุด
    db.run(`CREATE TABLE IF NOT EXISTS price_cache (
        symbol TEXT PRIMARY KEY,
        price REAL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    )`);

    // FIX: เพิ่มตาราง price_history สำหรับ daily snapshot
    db.run(`CREATE TABLE IF NOT EXISTS price_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        symbol TEXT,
        price REAL,
        date TEXT,
        UNIQUE(symbol, date)
    )`);
});

const API_KEY = process.env.API_KEY;

// FIX: แยก format symbol ออกมาชัดเจน
function formatSymbol(symbol, type) {
    if (type === 'thai') return symbol.toUpperCase() + '.BK';
    return symbol.toUpperCase();
}

// ===== FETCH PRICE FROM TWELVEDATA =====
async function fetchPrice(symbol, type) {
    const formatted = formatSymbol(symbol, type);
    const url = `https://api.twelvedata.com/price?symbol=${formatted}&apikey=${API_KEY}`;
    try {
        const r = await fetch(url, { timeout: 10000 });
        const data = await r.json();
        if (data.price) return parseFloat(data.price);
        throw new Error(data.message || 'Price not found');
    } catch (e) {
        throw new Error(`Cannot fetch ${formatted}: ${e.message}`);
    }
}

// ===== SAVE PRICE TO CACHE =====
function saveToCache(symbol, price) {
    db.run(
        `INSERT OR REPLACE INTO price_cache(symbol, price, updated_at) VALUES(?,?, CURRENT_TIMESTAMP)`,
        [symbol.toUpperCase(), price]
    );
    // Save to history (once per day)
    const today = new Date().toISOString().split('T')[0];
    db.run(
        `INSERT OR IGNORE INTO price_history(symbol, price, date) VALUES(?,?,?)`,
        [symbol.toUpperCase(), price, today]
    );
}

// ===== AUTO REFRESH ALL PRICES (CRON) =====
// รันทุก 5 นาที ในวันจันทร์-ศุกร์ ช่วง 9:00-17:00 (Thailand UTC+7)
// ตลาดไทย: 10:00-17:00 UTC+7  → 03:00-10:00 UTC
// ตลาด US:  09:30-16:00 ET     → 14:30-21:00 UTC
cron.schedule('*/5 3-21 * * 1-5', async () => {
    console.log('⏰ Auto-refresh prices...');
    db.all(`SELECT DISTINCT symbol, type FROM stocks`, [], async (err, rows) => {
        if (err || !rows.length) return;
        for (const row of rows) {
            try {
                const price = await fetchPrice(row.symbol, row.type);
                saveToCache(row.symbol, price);
                console.log(`✅ ${row.symbol}: ${price}`);
            } catch (e) {
                console.error(`❌ ${row.symbol}: ${e.message}`);
            }
            // Delay 1.2s ระหว่างแต่ละ call (free plan = 8 req/min)
            await new Promise(r => setTimeout(r, 1200));
        }
    });
});

// ===== DAILY SNAPSHOT AT MARKET CLOSE =====
// ทุกวันจันทร์-ศุกร์ เวลา 17:05 (Thailand time = 10:05 UTC)
cron.schedule('5 10 * * 1-5', async () => {
    console.log('📸 Daily snapshot...');
    db.all(`SELECT DISTINCT symbol, type FROM stocks`, [], async (err, rows) => {
        if (err || !rows.length) return;
        for (const row of rows) {
            try {
                const price = await fetchPrice(row.symbol, row.type);
                saveToCache(row.symbol, price);
            } catch (e) {
                console.error(`Snapshot error ${row.symbol}: ${e.message}`);
            }
            await new Promise(r => setTimeout(r, 1200));
        }
    });
});

// ===== ROUTES =====

app.get('/', (req, res) => res.json({ status: 'OK', time: new Date() }));

// GET PRICE (with cache fallback)
app.get('/price/:symbol/:type', async (req, res) => {
    const { symbol, type } = req.params;
    const key = symbol.toUpperCase();
    try {
        const price = await fetchPrice(symbol, type);
        saveToCache(key, price);
        res.json({ symbol: key, price, source: 'live' });
    } catch (e) {
        // Fallback to cache
        db.get(`SELECT price, updated_at FROM price_cache WHERE symbol=?`, [key], (err, row) => {
            if (row) return res.json({ symbol: key, price: row.price, source: 'cache', updated_at: row.updated_at });
            res.status(400).json({ error: e.message });
        });
    }
});

// REFRESH ALL PRICES MANUALLY
app.post('/refresh-prices', async (req, res) => {
    db.all(`SELECT DISTINCT symbol, type FROM stocks`, [], async (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        if (!rows.length) return res.json({ updated: 0 });
        
        let updated = 0, errors = [];
        for (const row of rows) {
            try {
                const price = await fetchPrice(row.symbol, row.type);
                saveToCache(row.symbol, price);
                updated++;
            } catch (e) {
                errors.push({ symbol: row.symbol, error: e.message });
            }
            await new Promise(r => setTimeout(r, 1200));
        }
        res.json({ updated, errors });
    });
});

// GET PRICE HISTORY
app.get('/history/:symbol', (req, res) => {
    db.all(
        `SELECT date, price FROM price_history WHERE symbol=? ORDER BY date DESC LIMIT 30`,
        [req.params.symbol.toUpperCase()],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// ADD STOCK
app.post('/stock', (req, res) => {
    const { symbol, type, price, qty, dividend } = req.body;
    if (!symbol || !type || !price || !qty) {
        return res.status(400).json({ error: 'Missing required fields' });
    }
    db.run(
        `INSERT INTO stocks(symbol, type, buy_price, qty, dividend) VALUES(?,?,?,?,?)`,
        [symbol.toUpperCase(), type, price, qty, dividend || 0],
        function (err) {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ id: this.lastID });
        }
    );
});

// GET ALL STOCKS (with current price from cache)
app.get('/stocks', (req, res) => {
    db.all(
        `SELECT s.*, COALESCE(p.price, s.buy_price) as current_price, p.updated_at
         FROM stocks s
         LEFT JOIN price_cache p ON p.symbol = s.symbol
         ORDER BY s.symbol`,
        [],
        (err, rows) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json(rows);
        }
    );
});

// UPDATE STOCK
app.put('/stock/:id', (req, res) => {
    const { price, qty, dividend } = req.body;
    db.run(
        `UPDATE stocks SET buy_price=?, qty=?, dividend=? WHERE id=?`,
        [price, qty, dividend || 0, req.params.id],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        }
    );
});

// DELETE STOCK
app.delete('/stock/:id', (req, res) => {
    db.run(`DELETE FROM stocks WHERE id=?`, [req.params.id], (err) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json({ ok: true });
    });
});

// SET TARGET
app.post('/target', (req, res) => {
    const { symbol, percent } = req.body;
    if (!symbol || percent === undefined) return res.status(400).json({ error: 'Missing fields' });
    db.run(
        `INSERT OR REPLACE INTO targets(symbol, percent) VALUES(?,?)`,
        [symbol.toUpperCase(), percent],
        (err) => {
            if (err) return res.status(500).json({ error: err.message });
            res.json({ ok: true });
        }
    );
});

app.get('/targets', (req, res) => {
    db.all(`SELECT * FROM targets ORDER BY symbol`, [], (err, rows) => {
        if (err) return res.status(500).json({ error: err.message });
        res.json(rows);
    });
});

// FIX: REBALANCE ที่คำนวณถูกต้อง - แสดงทั้งมูลค่าและจำนวนหุ้น
app.get('/rebalance', (req, res) => {
    db.all(
        `SELECT s.*, COALESCE(p.price, s.buy_price) as current_price
         FROM stocks s
         LEFT JOIN price_cache p ON p.symbol = s.symbol`,
        [],
        (err, stocks) => {
            if (err) return res.status(500).json({ error: err.message });
            db.all(`SELECT * FROM targets`, [], (err2, targets) => {
                if (err2) return res.status(500).json({ error: err2.message });

                const targetMap = {};
                targets.forEach(t => targetMap[t.symbol] = t.percent);

                // FIX: ใช้ current_price แทน buy_price
                const total = stocks.reduce((s, x) => s + (x.current_price * x.qty), 0);

                const result = stocks.map(s => {
                    const value = s.current_price * s.qty;
                    const weight = total > 0 ? (value / total) * 100 : 0;
                    const target = targetMap[s.symbol] || 0;
                    const targetValue = (target / 100) * total;
                    const adjustValue = targetValue - value;
                    // FIX: คำนวณจำนวนหุ้นที่ต้องซื้อ/ขาย
                    const adjustQty = s.current_price > 0 ? adjustValue / s.current_price : 0;
                    const pl = value - (s.buy_price * s.qty);
                    const plPct = s.buy_price > 0 ? ((s.current_price - s.buy_price) / s.buy_price) * 100 : 0;

                    return {
                        id: s.id,
                        symbol: s.symbol,
                        type: s.type,
                        buy_price: s.buy_price,
                        current_price: s.current_price,
                        qty: s.qty,
                        value: parseFloat(value.toFixed(2)),
                        weight: parseFloat(weight.toFixed(2)),
                        target,
                        adjust_value: parseFloat(adjustValue.toFixed(2)),
                        adjust_qty: parseFloat(adjustQty.toFixed(4)),
                        pl: parseFloat(pl.toFixed(2)),
                        pl_pct: parseFloat(plPct.toFixed(2)),
                        dividend: s.dividend,
                    };
                });

                // Portfolio summary
                const totalDividend = stocks.reduce((s, x) => s + ((x.dividend || 0) * x.qty), 0);
                const totalCost = stocks.reduce((s, x) => s + (x.buy_price * x.qty), 0);

                res.json({
                    total,
                    total_cost: parseFloat(totalCost.toFixed(2)),
                    total_pl: parseFloat((total - totalCost).toFixed(2)),
                    total_pl_pct: totalCost > 0 ? parseFloat(((total - totalCost) / totalCost * 100).toFixed(2)) : 0,
                    annual_dividend: parseFloat(totalDividend.toFixed(2)),
                    dividend_yield: total > 0 ? parseFloat((totalDividend / total * 100).toFixed(2)) : 0,
                    result
                });
            });
        }
    );
});

// ===== SMART BUY =====
// ดึงราคาหุ้นย้อนหลัง + อัตราแลกเปลี่ยน แล้วคำนวณจำนวนหุ้นที่ได้อัตโนมัติ
app.post('/smart-buy', async (req, res) => {
    const { symbol, type, date, budget_thb, dividend } = req.body;
    // date format: YYYY-MM-DD

    if (!symbol || !type || !date || !budget_thb) {
        return res.status(400).json({ error: 'กรุณากรอก symbol, type, date, budget_thb' });
    }

    try {
        const formatted = formatSymbol(symbol, type);

        // ─── 1. ดึงราคาหุ้นย้อนหลัง ───
        // Twelvedata: /time_series endpoint สำหรับราคาย้อนหลัง
        const priceUrl = `https://api.twelvedata.com/time_series?symbol=${formatted}&interval=1day&start_date=${date}&end_date=${date}&apikey=${API_KEY}`;
        const priceRes = await fetch(priceUrl, { timeout: 10000 });
        const priceData = await priceRes.json();

        let stockPriceUSD = null;
        let stockCurrency = 'USD';

        if (priceData.values && priceData.values.length > 0) {
            // ใช้ราคาปิด (close) ของวันนั้น
            stockPriceUSD = parseFloat(priceData.values[0].close);
            stockCurrency = priceData.meta?.currency || 'USD';
        } else {
            // ถ้าวันหยุด — ลองดึง 5 วันก่อนหน้าแล้วเอาวันล่าสุดที่มี
            const d = new Date(date);
            d.setDate(d.getDate() - 5);
            const startFallback = d.toISOString().split('T')[0];
            const fallbackUrl = `https://api.twelvedata.com/time_series?symbol=${formatted}&interval=1day&start_date=${startFallback}&end_date=${date}&outputsize=5&apikey=${API_KEY}`;
            const fbRes = await fetch(fallbackUrl, { timeout: 10000 });
            const fbData = await fbRes.json();

            if (fbData.values && fbData.values.length > 0) {
                // เอาวันล่าสุดที่มีข้อมูล (ใกล้วันที่ระบุมากที่สุด)
                stockPriceUSD = parseFloat(fbData.values[0].close);
                stockCurrency = fbData.meta?.currency || 'USD';
            } else {
                return res.status(400).json({
                    error: `ไม่พบราคาหุ้น ${formatted} ในวันที่ ${date} (อาจเป็นวันหยุด หรือ symbol ผิด)`,
                    twelvedata_response: priceData
                });
            }
        }

        let stockPriceTHB = stockPriceUSD;
        let fxRate = 1;
        let fxSource = 'ไม่ต้องแปลง (หุ้นไทย)';

        // ─── 2. แปลงอัตราแลกเปลี่ยน USD → THB (เฉพาะหุ้น US) ───
        if (type === 'us' || stockCurrency === 'USD') {
            try {
                // ดึง USD/THB ย้อนหลังจาก Twelvedata
                const fxUrl = `https://api.twelvedata.com/time_series?symbol=USD/THB&interval=1day&start_date=${date}&end_date=${date}&apikey=${API_KEY}`;
                const fxRes = await fetch(fxUrl, { timeout: 10000 });
                const fxData = await fxRes.json();

                if (fxData.values && fxData.values.length > 0) {
                    fxRate = parseFloat(fxData.values[0].close);
                    fxSource = `Twelvedata ณ ${date}`;
                } else {
                    // fallback: ดึง 5 วันก่อนหน้า
                    const d2 = new Date(date);
                    d2.setDate(d2.getDate() - 5);
                    const fxFallbackUrl = `https://api.twelvedata.com/time_series?symbol=USD/THB&interval=1day&start_date=${d2.toISOString().split('T')[0]}&end_date=${date}&outputsize=5&apikey=${API_KEY}`;
                    const fxFb = await fetch(fxFallbackUrl, { timeout: 10000 });
                    const fxFbData = await fxFb.json();
                    if (fxFbData.values && fxFbData.values.length > 0) {
                        fxRate = parseFloat(fxFbData.values[0].close);
                        fxSource = `Twelvedata ใกล้เคียง ${date}`;
                    } else {
                        // fallback สุดท้าย: ใช้อัตราปัจจุบัน
                        const fxNow = await fetch(`https://api.twelvedata.com/price?symbol=USD/THB&apikey=${API_KEY}`);
                        const fxNowData = await fxNow.json();
                        if (fxNowData.price) {
                            fxRate = parseFloat(fxNowData.price);
                            fxSource = 'อัตราปัจจุบัน (fallback)';
                        } else {
                            fxRate = 34.5; // hardcode fallback
                            fxSource = 'ค่าประมาณ 34.5 (ไม่พบข้อมูล)';
                        }
                    }
                }
                stockPriceTHB = stockPriceUSD * fxRate;
            } catch (fxErr) {
                fxRate = 34.5;
                fxSource = 'ค่าประมาณ 34.5 (เกิด error)';
                stockPriceTHB = stockPriceUSD * fxRate;
            }
        }

        // ─── 3. คำนวณจำนวนหุ้น ───
        const qty = budget_thb / stockPriceTHB;
        const qtyFloor = Math.floor(qty); // จำนวนเต็ม (ซื้อได้จริง)
        const actualCost = qtyFloor * stockPriceTHB;
        const remainder = budget_thb - actualCost;

        res.json({
            symbol: formatted,
            type,
            date,
            budget_thb: parseFloat(budget_thb),
            stock_price_usd: parseFloat(stockPriceUSD.toFixed(4)),
            fx_rate: parseFloat(fxRate.toFixed(4)),
            fx_source: fxSource,
            stock_price_thb: parseFloat(stockPriceTHB.toFixed(4)),
            qty_exact: parseFloat(qty.toFixed(6)),
            qty_floor: qtyFloor,
            actual_cost_thb: parseFloat(actualCost.toFixed(2)),
            remainder_thb: parseFloat(remainder.toFixed(2)),
            dividend: parseFloat(dividend || 0),
            // ข้อมูลสำหรับ auto-add ลงพอร์ต
            ready_to_add: {
                symbol: symbol.toUpperCase(),
                type,
                price: parseFloat(stockPriceTHB.toFixed(2)),
                qty: qtyFloor,
                dividend: parseFloat(dividend || 0)
            }
        });

    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

app.listen(3000, () => console.log('✅ Server running at http://localhost:3000'));
