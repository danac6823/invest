// 豐盛之路 — 每日自動抓價，產出 prices.json 供 PWA 讀取
// 來源：TWSE(上市收盤) / TPEx(上櫃收盤) / Yahoo(VOO 美元價) / open.er-api(USD→TWD) / 鉅亨(基金淨值)
// 任一來源失敗不影響其他；失敗的代號沿用上一次 prices.json 的值。
import { readFileSync, writeFileSync } from 'node:fs';

const OUT = new URL('../prices.json', import.meta.url);

// 要抓的台股代號（上市＋上櫃都放這裡，自動分流）
const TW_CODES = [
  '0050','006208','00692','00850',          // 台股大盤
  '00646','00662','00757','00830',          // 美股ETF(台掛牌)
  '2330','2454','2317','2308','2412',       // 個股
  '2882','2881','2891','2884','2603','2303','5904',
  '0056','00878','00919','00929','00940','00713', // 高股息
  '00679B','00937B',                        // 債券(上櫃)
];
// 基金：app 代號 → 鉅亨 cnyesId
const FUNDS = { '5808': 'A09012', '8602': 'A36004' };

const UA = { 'User-Agent': 'Mozilla/5.0 (price-updater; github-actions)' };

function rocToIso(s) { // '1151105' → '2026-11-05'
  const m = String(s || '').match(/^(\d{2,3})(\d{2})(\d{2})$/);
  if (!m) return null;
  return `${Number(m[1]) + 1911}-${m[2]}-${m[3]}`;
}
function tsToIso(ts) { // unix 秒 → 'YYYY-MM-DD'（台北時間）
  if (!ts) return null;
  return new Date(ts * 1000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}
async function getJson(url) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error(`${r.status} ${url}`);
  return r.json();
}

// 讀上一次的結果當底，抓不到的代號保留舊值；hist = 近 130 天日收盤（供 app 畫走勢、算近3月高低）
let prices = {};
let hist = {};
let divs = {};
let prevJson = '';
try {
  prevJson = readFileSync(OUT, 'utf8');
  const prev = JSON.parse(prevJson);
  prices = prev.prices || {};
  hist = prev.hist || {};
  divs = prev.divs || {};
} catch {}
const before = JSON.stringify({ prices, hist, divs });

const HIST_DAYS = 130;
function cutoffIso() {
  return new Date(Date.now() - HIST_DAYS * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
}
function upsertHist(code, d, p) {
  p = Number(p);
  if (!d || !(p > 0)) return;
  const arr = hist[code] || (hist[code] = []);
  const i = arr.findIndex(x => x.d === d);
  if (i >= 0) arr[i].p = p; else arr.push({ d, p });
}
function trimHist() {
  const cs = cutoffIso();
  for (const k of Object.keys(hist)) {
    hist[k] = hist[k].filter(x => x.d >= cs).sort((a, b) => (a.d < b.d ? -1 : 1));
    if (!hist[k].length) delete hist[k];
  }
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

const errors = [];
const setPx = (code, p, d, src, extra) => {
  p = Number(p);
  if (!(p > 0)) return;
  prices[code] = Object.assign({ p, d: d || null, src }, extra || {});
};

// ── 1. 台股上市（TWSE）──────────────────────────────
try {
  const rows = await getJson('https://openapi.twse.com.tw/v1/exchangeReport/STOCK_DAY_ALL');
  const map = new Map(rows.map(r => [r.Code, r]));
  for (const code of TW_CODES) {
    const r = map.get(code);
    if (r && Number(r.ClosingPrice) > 0) setPx(code, r.ClosingPrice, rocToIso(r.Date), 'twse');
  }
} catch (e) { errors.push('twse: ' + e.message); }

// ── 2. 台股上櫃（TPEx，補上市沒抓到的）───────────────
try {
  const missing = TW_CODES.filter(c => !prices[c] || prices[c].src === 'tpex');
  if (missing.length) {
    const rows = await getJson('https://www.tpex.org.tw/openapi/v1/tpex_mainboard_daily_close_quotes');
    const map = new Map(rows.map(r => [r.SecuritiesCompanyCode, r]));
    for (const code of missing) {
      const r = map.get(code);
      if (r && Number(r.Close) > 0) setPx(code, r.Close, rocToIso(r.Date), 'tpex');
    }
  }
} catch (e) { errors.push('tpex: ' + e.message); }

// ── 3. VOO（Yahoo 美元價 × USD/TWD 匯率 → 台幣/股）───
try {
  const y = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/VOO?range=5d&interval=1d');
  const meta = y.chart.result[0].meta;
  const usd = Number(meta.regularMarketPrice);
  let fx = 0;
  try {
    const fxj = await getJson('https://open.er-api.com/v6/latest/USD');
    fx = Number(fxj.rates && fxj.rates.TWD);
  } catch {}
  if (!(fx > 0)) { // 備援：Yahoo 匯率
    const t = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/TWD=X?range=1d&interval=1d');
    fx = Number(t.chart.result[0].meta.regularMarketPrice);
  }
  if (usd > 0 && fx > 0) {
    setPx('VOO', Math.round(usd * fx * 100) / 100, tsToIso(meta.regularMarketTime), 'yahoo', {
      usd: Math.round(usd * 100) / 100, fx: Math.round(fx * 1000) / 1000,
    });
  }
} catch (e) { errors.push('voo: ' + e.message); }

// ── 4. 基金淨值（鉅亨）───────────────────────────────
for (const [code, cnyesId] of Object.entries(FUNDS)) {
  try {
    const j = await getJson(`https://fund.api.cnyes.com/fund/api/v2/funds/${cnyesId}`);
    const it = j.items || {};
    setPx(code, it.nav, tsToIso(it.priceDate), 'cnyes');
  } catch (e) { errors.push(`fund ${code}: ` + e.message); }
}

// ── 4b. 除權息（上市＋上櫃預告表）：持股代號的現金股利，累積保留近 120 天＋未來 60 天 ──
{
  const codeSet = new Set(TW_CODES);
  const upsertDiv = (code, d, cash) => {
    cash = Number(cash);
    if (!d || !(cash > 0)) return;
    const a = divs[code] || (divs[code] = []);
    const i = a.findIndex(x => x.d === d);
    if (i >= 0) a[i].cash = cash; else a.push({ d, cash });
  };
  try {
    const rows = await getJson('https://openapi.twse.com.tw/v1/exchangeReport/TWT48U_ALL');
    for (const r of rows) {
      if (!codeSet.has(r.Code)) continue;
      if (String(r.Exdividend || '').indexOf('息') < 0) continue; // 只記現金股利（除權不產生現金）
      upsertDiv(r.Code, rocToIso(r.Date), r.CashDividend);
    }
  } catch (e) { errors.push('div-twse: ' + e.message); }
  try {
    const rows = await getJson('https://www.tpex.org.tw/openapi/v1/tpex_exright_prepost');
    for (const r of rows) {
      if (!codeSet.has(r.SecuritiesCompanyCode)) continue;
      if (String(r.ExRrightsExDividend || '').indexOf('息') < 0) continue;
      upsertDiv(r.SecuritiesCompanyCode, rocToIso(r.ExRrightsExDividendDate), r.CashDividend);
    }
  } catch (e) { errors.push('div-tpex: ' + e.message); }
  const lo = new Date(Date.now() - 120 * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  const hi = new Date(Date.now() + 60 * 864e5).toLocaleDateString('sv-SE', { timeZone: 'Asia/Taipei' });
  for (const k of Object.keys(divs)) {
    divs[k] = divs[k].filter(x => x.d >= lo && x.d <= hi).sort((a, b) => (a.d < b.d ? -1 : 1));
    if (!divs[k].length) delete divs[k];
  }
}

// ── 5. 歷史回補（node fetch-prices.mjs --backfill，一次性）──
if (process.argv.includes('--backfill')) {
  const rocSlashToIso = s => { // '115/10/01' → '2026-10-01'
    const m = String(s || '').match(/^(\d{2,3})\/(\d{2})\/(\d{2})$/);
    return m ? `${Number(m[1]) + 1911}-${m[2]}-${m[3]}` : null;
  };
  // 近 5 個月的月份清單
  const months = [];
  const now = new Date();
  for (let k = 0; k < 5; k++) {
    const d = new Date(now.getFullYear(), now.getMonth() - k, 1);
    months.push({ ym: `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}01`, slash: `${d.getFullYear()}/${String(d.getMonth() + 1).padStart(2, '0')}/01` });
  }
  // 上市：逐檔逐月
  const tpexLeft = [];
  for (const code of TW_CODES) {
    let got = 0;
    for (const m of months) {
      try {
        const j = await getJson(`https://www.twse.com.tw/rwd/zh/afterTrading/STOCK_DAY?date=${m.ym}&stockNo=${code}&response=json`);
        for (const row of j.data || []) {
          const d = rocSlashToIso(row[0]), close = Number(String(row[6]).replace(/,/g, ''));
          if (d && close > 0) { upsertHist(code, d, close); got++; }
        }
      } catch {}
      await sleep(250);
    }
    if (!got) tpexLeft.push(code);
    else console.log(`backfill twse ${code}: ok`);
  }
  // 上櫃：上市抓不到的再試櫃買
  for (const code of tpexLeft) {
    let got = 0;
    for (const m of months) {
      try {
        const j = await getJson(`https://www.tpex.org.tw/www/zh-tw/afterTrading/tradingStock?code=${code}&date=${m.slash}&response=json`);
        for (const row of (j.tables && j.tables[0] && j.tables[0].data) || []) {
          const d = rocSlashToIso(row[0]), close = Number(String(row[6]).replace(/,/g, ''));
          if (d && close > 0) { upsertHist(code, d, close); got++; }
        }
      } catch {}
      await sleep(250);
    }
    console.log(`backfill tpex ${code}: ${got ? 'ok' : 'NO DATA'}`);
  }
  // VOO：Yahoo 6 個月收盤 × 當日匯率
  try {
    const y = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/VOO?range=6mo&interval=1d');
    const r = y.chart.result[0];
    const fxj = await getJson('https://query1.finance.yahoo.com/v8/finance/chart/TWD=X?range=6mo&interval=1d');
    const fr = fxj.chart.result[0];
    const fxByDate = {};
    (fr.timestamp || []).forEach((ts, i) => { const v = fr.indicators.quote[0].close[i]; if (v > 0) fxByDate[tsToIso(ts)] = v; });
    const curFx = Number(prices.VOO && prices.VOO.fx) || 0;
    let lastFx = curFx;
    (r.timestamp || []).forEach((ts, i) => {
      const usd = r.indicators.quote[0].close[i];
      const d = tsToIso(ts);
      const fx = fxByDate[d] || lastFx;
      if (fxByDate[d]) lastFx = fxByDate[d];
      if (usd > 0 && fx > 0) upsertHist('VOO', d, Math.round(usd * fx * 100) / 100);
    });
    console.log('backfill voo: ok');
  } catch (e) { console.log('backfill voo: ' + e.message); }
  // 基金：鉅亨 NAV 歷史
  for (const [code, cnyesId] of Object.entries(FUNDS)) {
    try {
      const j = await getJson(`https://fund.api.cnyes.com/fund/api/v1/funds/${cnyesId}/nav?size=200`);
      const it = j.items || {};
      (it.tradeDate || []).forEach((ts, i) => { const nav = (it.nav || [])[i]; if (nav > 0) upsertHist(code, tsToIso(ts), nav); });
      console.log(`backfill fund ${code}: ok`);
    } catch (e) { console.log(`backfill fund ${code}: ` + e.message); }
  }
}

// 今天的收盤也進歷史
for (const [code, e] of Object.entries(prices)) upsertHist(code, e.d, e.p);
trimHist();

// ── 輸出（價格沒變就不動檔案，避免無意義的 commit）───
if (JSON.stringify({ prices, hist, divs }) === before && prevJson) {
  console.log('no price change, skip write', errors.length ? `(errors: ${errors.join('; ')})` : '');
} else {
  const out = {
    updated: new Date().toISOString(),
    errors: errors.length ? errors : undefined,
    prices,
    hist,
    divs: Object.keys(divs).length ? divs : undefined,
  };
  writeFileSync(OUT, JSON.stringify(out) + '\n');
  console.log(`OK ${Object.keys(prices).length} codes`, errors.length ? `(errors: ${errors.join('; ')})` : '');
}
