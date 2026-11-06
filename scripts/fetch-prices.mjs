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
  '2882','2881','2891','2884','2603','2303',
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

// 讀上一次的結果當底，抓不到的代號保留舊值
let prices = {};
try { prices = JSON.parse(readFileSync(OUT, 'utf8')).prices || {}; } catch {}

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

// ── 輸出 ────────────────────────────────────────────
const out = {
  updated: new Date().toISOString(),
  errors: errors.length ? errors : undefined,
  prices,
};
writeFileSync(OUT, JSON.stringify(out, null, 1) + '\n');
console.log(`OK ${Object.keys(prices).length} codes`, errors.length ? `(errors: ${errors.join('; ')})` : '');
