/* Malee Price & Promo Tracker – reads the Google Sheet live on every page load. No external libraries. */
(function () {
'use strict';
// ---- Config: change SHEET_ID to point at another Google Sheet ----
const SHEET_ID = '1s8FluaDLUY4n52ULE5F1o3yRFEDKs-WR6YRM3V_Bi0Q';
const TABS = ['SKU_Pairs', 'Price_Log', 'Promo_Log', 'Settings'];
const OPTIONAL_TABS = ['Bands', 'Retailers']; // channel bands + retailer→channel map (page still works without them)
const MALEE = 'Malee';
const FIXED_COLORS = { malee: '#1F5FBF', cocomax: '#0F9D8A', tipco: '#E8710A' };
const PALETTE = ['#7B4FC9', '#C2185B', '#5D7A1F', '#8D6E63', '#00838F', '#AD1457'];
const sheetUrl = 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/edit';
const gvizUrl = (tab) => 'https://docs.google.com/spreadsheets/d/' + SHEET_ID + '/gviz/tq?tqx=out:csv&headers=1&sheet=' + encodeURIComponent(tab) + '&_=' + Date.now();

// ---------- helpers ----------
const $ = (id) => document.getElementById(id);
const esc = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const num = (v) => { if (v === '' || v == null) return null; const n = Number(String(v).replace(/[,฿\s]/g, '')); return isFinite(n) ? n : null; };
const baht = (n) => n == null ? '–' : '฿' + (Math.abs(n - Math.round(n)) < 0.005 ? Math.round(n).toLocaleString('en-US') : n.toFixed(2));
const fix1 = (n) => n == null ? '–' : n.toFixed(1);
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const dnum = (d) => Date.UTC(+d.slice(0, 4), +d.slice(5, 7) - 1, +d.slice(8, 10)) / 864e5; // day number
const dstr = (n) => new Date(n * 864e5).toISOString().slice(0, 10);
const nice = (d) => d ? (+d.slice(8, 10)) + ' ' + MONTHS[+d.slice(5, 7) - 1] : '';
const niceY = (d) => d ? nice(d) + ' ' + d.slice(0, 4) : '';

function parseCSV(text) {
  const rows = []; let row = [], f = '', q = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (q) { if (c === '"') { if (text[i + 1] === '"') { f += '"'; i++; } else q = false; } else f += c; }
    else if (c === '"') q = true;
    else if (c === ',') { row.push(f); f = ''; }
    else if (c === '\n') { row.push(f); rows.push(row); row = []; f = ''; }
    else if (c !== '\r') f += c;
  }
  if (f !== '' || row.length) { row.push(f); rows.push(row); }
  if (!rows.length) return [];
  const head = rows[0].map((h) => h.trim());
  return rows.slice(1).filter((r) => r.some((x) => x !== '')).map((r) => {
    const o = {}; head.forEach((h, i) => { if (h) o[h] = (r[i] || '').trim(); }); return o;
  });
}

// ---------- state ----------
const S = { tab: 'week', channel: 'All', retailer: 'All', pair: 'All', comp: 'All', avail: 'All', days: 60, metric: 'ppm', logPage: 0, logSort: { k: 'check_datetime', dir: -1 }, logQuery: '' };
let D = null; // processed data

function brandColor(brand) {
  const k = String(brand).toLowerCase();
  if (FIXED_COLORS[k]) return FIXED_COLORS[k];
  if (!D.extraColors[k]) D.extraColors[k] = PALETTE[Object.keys(D.extraColors).length % PALETTE.length];
  return D.extraColors[k];
}
const brandPill = (b) => '<span class="pill" style="background:' + brandColor(b) + '">' + esc(b) + '</span>';

// ---------- load ----------
async function load() {
  $('loading').classList.remove('hidden'); $('error').classList.add('hidden');
  document.querySelectorAll('.panel').forEach((p) => p.classList.add('hidden'));
  try {
    const texts = await Promise.all(TABS.map(async (t) => {
      const r = await fetch(gvizUrl(t), { cache: 'no-store' });
      if (!r.ok) throw new Error('Tab "' + t + '" returned HTTP ' + r.status);
      const txt = await r.text();
      if (/^\s*<(!doctype|html)/i.test(txt)) throw new Error('Tab "' + t + '" is not readable (the Sheet may be private).');
      return txt;
    }));
    const raw = {}; TABS.forEach((t, i) => (raw[t] = parseCSV(texts[i])));
    const opt = await Promise.all(OPTIONAL_TABS.map(async (t) => { try { const r = await fetch(gvizUrl(t), { cache: 'no-store' }); return r.ok ? parseCSV(await r.text()) : []; } catch (e) { return []; } }));
    OPTIONAL_TABS.forEach((t, i) => { const rows = opt[i]; const need = t === 'Bands' ? 'band_low' : 'channel'; raw[t] = rows.length && need in rows[0] ? rows : []; });
    D = process(raw);
    if (!D.prices.length) throw new Error('Price_Log has no rows yet.');
    $('loading').classList.add('hidden');
    buildFilters(); renderHeader(); render();
  } catch (e) {
    console.error(e);
    $('loading').classList.add('hidden'); $('error').classList.remove('hidden');
    $('errorMsg').textContent = e.message || String(e);
  }
}

function process(raw) {
  const settings = {}; raw.Settings.forEach((r) => { if (r.key) settings[r.key] = r.value; });
  const band = { low: num(settings.band_low) ?? 95, high: num(settings.band_high) ?? 105, margin: num(settings.near_band_margin) ?? 2, channel: 'All', source: 'default' };
  const chanOf = {}; const channels = [];
  raw.Retailers.forEach((r) => { if (r.retailer && r.channel) { chanOf[r.retailer] = r.channel; if (!channels.includes(r.channel)) channels.push(r.channel); } });
  raw.SKU_Pairs.forEach((r) => { if (r.retailer && r.channel && !chanOf[r.retailer]) { chanOf[r.retailer] = r.channel; if (!channels.includes(r.channel)) channels.push(r.channel); } });
  const bands = raw.Bands.filter((r) => r.channel && num(r.band_low) != null && num(r.band_high) != null).map((r) => ({ channel: r.channel, pair: (r.pair_id || 'ALL').trim() || 'ALL', low: num(r.band_low), high: num(r.band_high), margin: num(r.near_margin) ?? band.margin, data_type: r.data_type }));
  bands.forEach((b) => { if (b.channel !== 'ALL' && !channels.includes(b.channel)) channels.push(b.channel); });
  // lookup order: channel + pair → channel + ALL → global default (Settings)
  const bandFor = (channel, pair) => {
    const hit = bands.find((b) => b.channel === channel && b.pair === pair) || bands.find((b) => b.channel === channel && b.pair === 'ALL');
    return hit ? { low: hit.low, high: hit.high, margin: hit.margin, channel, source: hit.pair === 'ALL' ? 'channel' : 'channel+pair', data_type: hit.data_type } : Object.assign({}, band, { channel: channel || 'Unassigned' });
  };
  const pairs = {}; const comps = []; const sizes = {};
  raw.SKU_Pairs.forEach((r) => {
    if (!r.pair_id) return;
    const pid = r.pair_id;
    if (!pairs[pid]) pairs[pid] = { id: pid, category: r.category, malee_sku: r.malee_sku, competitors: {}, retailers: {} };
    const comp = r.competitor_brand;
    if (comp) pairs[pid].competitors[comp] = r.competitor_sku;
    sizes[pid + '|' + MALEE] = num(r.malee_size_ml) || 1000;
    if (comp) sizes[pid + '|' + comp] = num(r.competitor_size_ml) || 1000;
    if (r.retailer) {
      pairs[pid].retailers[r.retailer] = { malee_url: r.malee_url, competitor_url: r.competitor_url, note: r.note };
      if (comp) comps.push({ key: pid + '|' + comp + '|' + r.retailer, pair: pid, comp, retailer: r.retailer, malee_url: r.malee_url, competitor_url: r.competitor_url, note: r.note, mAvail: availVal(r.malee_availability), kAvail: availVal(r.competitor_availability), availNote: r.availability_note || '' });
    }
  });
  const prices = raw.Price_Log.filter((r) => r.check_id && r.check_datetime).map((r) => {
    const o = Object.assign({}, r);
    o.date = r.check_datetime.slice(0, 10);
    o.reg = num(r.regular_price_thb); o.promo = num(r.promo_price_thb); o.eff = num(r.effective_price_thb);
    o.pack = num(r.pack_units) || 1; o.unit = num(r.unit_price_thb); if (o.unit == null && o.eff != null) o.unit = o.eff / o.pack;
    o.ppm = num(r.price_per_100ml); const size = sizes[r.pair_id + '|' + r.brand] || 1000; if (o.ppm == null && o.unit != null) o.ppm = o.unit / (size / 100);
    // a REAL row with no price whose mechanic/note says 'Not sold here' records that the retailer does not carry the SKU
    o.notSold = o.eff == null && o.unit == null && o.reg == null && /not sold/i.test((r.promo_mechanic || '') + ' ' + (r.note || ''));
    o.onPromo = !o.notSold && !!(r.promo_mechanic || o.promo != null);
    return o;
  });
  // add comparisons that exist only in Price_Log (e.g. new pair added there first)
  const seen = new Set(comps.map((c) => c.key));
  prices.forEach((p) => {
    if (p.brand === MALEE) return;
    const k = p.pair_id + '|' + p.brand + '|' + p.retailer;
    if (!seen.has(k)) { seen.add(k); comps.push({ key: k, pair: p.pair_id, comp: p.brand, retailer: p.retailer, mAvail: 'listed', kAvail: 'listed', availNote: '' }); if (!pairs[p.pair_id]) pairs[p.pair_id] = { id: p.pair_id, category: p.pair_id, malee_sku: '', competitors: { [p.brand]: p.sku }, retailers: {} }; }
  });
  // daily series: latest check per (pair|brand|retailer) per date
  const series = {};
  prices.slice().sort((a, b) => a.check_datetime.localeCompare(b.check_datetime)).forEach((p) => {
    const k = p.pair_id + '|' + p.brand + '|' + p.retailer;
    (series[k] = series[k] || {})[p.date] = p;
  });
  // a row is superseded when a later check of the same SKU at the same retailer on the same day exists (only the latest counts)
  prices.forEach((p) => { p.superseded = series[p.pair_id + '|' + p.brand + '|' + p.retailer][p.date] !== p; });
  const promos = raw.Promo_Log.filter((r) => r.promo_id).map((r) => Object.assign({}, r, { depth: num(r.depth_pct) }));
  const newest = prices.reduce((m, p) => (p.check_datetime > m.check_datetime ? p : m), prices[0]);
  const anchor = newest ? newest.date : dstr(Math.floor(Date.now() / 864e5));
  const firstDate = prices.reduce((m, p) => (p.date < m ? p.date : m), anchor);
  const retailers = [...new Set(comps.map((c) => c.retailer).concat(prices.map((p) => p.retailer)))];
  const order = ['Big C', 'Tops', 'Makro', "Lotus's"];
  retailers.sort((a, b) => ((order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)) || a.localeCompare(b));
  comps.forEach((c) => { c.channel = chanOf[c.retailer] || 'Unassigned'; c.band = bandFor(c.channel, c.pair); });
  // availability: a side is 'not sold' when SKU_Pairs says not_sold, or its latest check is a 'Not sold here' row
  const lastOf = (k) => { const s = series[k]; if (!s) return null; const ds = Object.keys(s).filter((d) => d <= anchor).sort(); return ds.length ? s[ds[ds.length - 1]] : null; };
  comps.forEach((c) => {
    const lm = lastOf(c.pair + '|' + MALEE + '|' + c.retailer), lk = lastOf(c.pair + '|' + c.comp + '|' + c.retailer);
    c.mSold = c.mAvail !== 'not_sold' && !(lm && lm.notSold);
    c.kSold = c.kAvail !== 'not_sold' && !(lk && lk.notSold);
    c.avail = c.mSold && c.kSold ? 'both' : c.mSold ? 'malee_only' : c.kSold ? 'comp_only' : 'none';
  });
  if (comps.some((c) => c.channel === 'Unassigned') && !channels.includes('Unassigned')) channels.push('Unassigned');
  comps.sort((a, b) => a.pair.localeCompare(b.pair) || retailers.indexOf(a.retailer) - retailers.indexOf(b.retailer) || a.comp.localeCompare(b.comp));
  return { settings, band, bands, channels, chanOf, pairs, comps, prices, series, promos, newest, anchor, firstDate, retailers, sizes, extraColors: {} };
}

// ---------- comparison logic ----------
function statusOf(idx, b) {
  b = b || D.band;
  if (idx == null) return 'grey';
  if (idx > b.high || idx < b.low) return 'red';
  if (idx >= b.high - b.margin || idx <= b.low + b.margin) return 'amber';
  return 'green';
}
const STATUS_TEXT = { red: 'Out of band', amber: 'Near band edge', green: 'In band', grey: 'No comparison' };
const AVAIL_ORDER = ['both', 'malee_only', 'comp_only', 'none'];
const AVAIL_TEXT = { both: 'Both sold', malee_only: 'Malee only', comp_only: 'Competitor only', none: 'Not sold' };
function availVal(v) { v = String(v || '').trim().toLowerCase().replace(/[\s-]+/g, '_'); return v === 'not_sold' || v === 'unknown' ? v : 'listed'; }
const nsTag = (brand, c) => '<span class="tag ns" title="' + esc(brand + ' is not sold here, so there is no price and no index.' + (c && c.availNote ? ' ' + c.availNote : '')) + '">Not sold here</span>';
// a side's row counts only if that SKU is sold at the retailer and the row is not a 'Not sold here' record
const sideNS = (c, brand, raw) => (brand === MALEE ? !c.mSold : !c.kSold) || !!(raw && raw.notSold);
const sideRow = (c, brand, raw) => sideNS(c, brand, raw) ? null : raw;
function getRow(pair, brand, retailer, date) { const s = D.series[pair + '|' + brand + '|' + retailer]; return s ? s[date] : null; }
function latestRow(pair, brand, retailer, upto) {
  const s = D.series[pair + '|' + brand + '|' + retailer]; if (!s) return null;
  const ds = Object.keys(s).filter((d) => !upto || d <= upto).sort(); return ds.length ? s[ds[ds.length - 1]] : null;
}
function compSeries(c, fromDate, toDate) {
  const out = [];
  for (let n = dnum(fromDate); n <= dnum(toDate); n++) {
    const d = dstr(n); const rm = getRow(c.pair, MALEE, c.retailer, d), rk = getRow(c.pair, c.comp, c.retailer, d);
    const m = sideRow(c, MALEE, rm), k = sideRow(c, c.comp, rk); const mNS = sideNS(c, MALEE, rm), kNS = sideNS(c, c.comp, rk);
    out.push({ date: d, m, k, mNS, kNS, idx: !mNS && !kNS && m && k && m.ppm && k.ppm ? (m.ppm / k.ppm) * 100 : null });
  }
  return out;
}
function latestCompare(c) {
  const mRaw = latestRow(c.pair, MALEE, c.retailer, D.anchor), kRaw = latestRow(c.pair, c.comp, c.retailer, D.anchor);
  const mNS = sideNS(c, MALEE, mRaw), kNS = sideNS(c, c.comp, kRaw); const m = mNS ? null : mRaw, k = kNS ? null : kRaw;
  const idx = !mNS && !kNS && m && k && m.ppm && k.ppm ? (m.ppm / k.ppm) * 100 : null; // index only when both sides have a price
  return { m, k, mRaw, kRaw, mNS, kNS, ns: mNS || kNS, idx, status: statusOf(idx, c.band) };
}
// Malee unit price that gives a given index against a competitor unit price
function maleePriceFor(c, compUnit, index) {
  const ms = D.sizes[c.pair + '|' + MALEE] || 1000, ks = D.sizes[c.pair + '|' + c.comp] || 1000;
  return (compUnit / ks) * ms * (index / 100);
}
// One-line recommended action (suggestion, not a fact), from band + promo end dates + counter-move maths
function promoDepth(row) {
  if (row.reg != null && row.promo != null && row.reg > 0) return '−' + Math.round(((row.reg - row.promo) / row.reg) * 100) + '%';
  return row.promo_mechanic || 'promo';
}
const nsWho = (c, L) => L.mNS && L.kNS ? 'Neither SKU is' : (L.kNS ? c.comp : 'Malee') + ' is';
function headline(c, L) {
  const b = c.band;
  if (L.ns) return 'No comparison: ' + nsWho(c, L) + ' not sold at ' + c.retailer;
  if (!L.m || !L.k) return 'Check the ' + (!L.k ? c.comp : 'Malee') + ' listing at ' + c.retailer;
  const maxP = maleePriceFor(c, L.k.unit, b.high);
  const kEnd = L.k.onPromo && L.k.promo_end_date ? dnum(L.k.promo_end_date) - dnum(TODAY) : null;
  const mEnd = L.m.onPromo && L.m.promo_end_date ? dnum(L.m.promo_end_date) - dnum(TODAY) : null;
  const inDays = (n) => n <= 0 ? 'today' : 'in ' + n + (n === 1 ? ' day' : ' days');
  const compLimit = L.m.unit / maleePriceFor(c, 1, b.high);
  if (L.idx > b.high) {
    if (L.k.onPromo && kEnd != null && kEnd <= 3) return 'Hold price; ' + c.comp + ' promo ends ' + inDays(kEnd);
    if (L.k.onPromo) return 'Match ' + c.comp + '\u2019s ' + promoDepth(L.k) + ' at ' + c.retailer + (L.k.promo_end_date ? ' until ' + nice(L.k.promo_end_date) : '') + ' (Malee ' + baht(Math.floor(maxP * 100) / 100) + ' or less)';
    return 'Cut Malee to ' + baht(Math.floor(maxP * 100) / 100) + ' at ' + c.retailer + ' to get back in band';
  }
  if (L.idx < b.low) {
    if (L.m.onPromo) return 'Ease the Malee promo at ' + c.retailer + '; Malee can go up to ' + baht(maxP) + (mEnd != null ? ' (promo ends ' + inDays(mEnd) + ')' : '');
    return 'Room to raise Malee to ' + baht(maxP) + ' at ' + c.retailer;
  }
  if (L.idx >= b.high - b.margin) {
    if (L.k.onPromo && kEnd != null) return 'Hold price; ' + c.comp + ' promo ends ' + inDays(kEnd);
    return 'Hold price; watch ' + c.comp + ' \u2013 below ' + baht(compLimit) + ' puts Malee out of band';
  }
  if (L.idx <= b.low + b.margin) {
    if (L.m.onPromo && mEnd != null) return 'Hold price; Malee promo ends ' + inDays(mEnd);
    return 'Hold price; room to raise Malee up to ' + baht(maxP);
  }
  return 'Hold price; in band' + (L.k.onPromo && kEnd != null ? ' (' + c.comp + ' promo ends ' + inDays(kEnd) + ')' : '');
}
function suggestion(c, L) {
  const b = c.band;
  if (L.ns) return { kind: 'No comparison', text: nsWho(c, L) + ' not sold at ' + c.retailer + ', so there is no index and no band status.' };
  if (!L.m || !L.k) return { kind: 'Check', text: 'No ' + (!L.k ? c.comp : 'Malee') + ' price found at ' + c.retailer + ' – check the listing.' };
  const maxP = maleePriceFor(c, L.k.unit, b.high), minP = maleePriceFor(c, L.k.unit, b.low);
  const compPromo = L.k.onPromo, end = L.k.promo_end_date;
  if (L.idx > b.high) {
    const target = Math.floor(maxP * 100) / 100;
    if (compPromo) return { kind: 'Match', text: c.comp + ' is on promo' + (end ? ' until ' + nice(end) : '') + '. Run a Malee promo at <b>' + baht(target) + ' or less</b>' + (end ? ' until ' + nice(end) : '') + ' (cut ' + baht(L.m.unit - target) + ') to get back to index ' + b.high + ', or hold if the promo is short.' };
    return { kind: 'Counter', text: 'Malee is ' + baht(L.m.unit - L.k.unit) + ' above ' + c.comp + '. Bring Malee to <b>' + baht(target) + ' or less</b> (cut ' + baht(L.m.unit - target) + ') to return to the band.' };
  }
  if (L.idx < b.low) return { kind: 'Hold', text: 'Malee is well below ' + c.comp + '. You could keep the price, or raise it up to <b>' + baht(Math.floor(maxP * 100) / 100) + '</b> and stay in band (index ≤ ' + b.high + ').' };
  if (L.idx >= b.high - b.margin) return { kind: 'Watch', text: 'In band but close to the top. If ' + c.comp + ' drops below <b>' + baht(L.m.unit / (b.high / 100) * ((D.sizes[c.pair + '|' + c.comp] || 1000) / (D.sizes[c.pair + '|' + MALEE] || 1000))) + '</b>, Malee goes out of band.' };
  if (L.idx <= b.low + b.margin) return { kind: 'Watch', text: 'In band but close to the bottom. Malee has room up to <b>' + baht(maxP) + '</b>.' };
  return { kind: 'Hold', text: 'In band – no move needed. Malee can stay between <b>' + baht(minP) + '–' + baht(maxP) + '</b>.' };
}

const bandLabel = (c) => 'Band ' + c.band.low + '–' + c.band.high + ' · ' + c.band.channel + (c.band.source === 'default' ? ' (default)' : '');
const bandChip = (c) => '<span class="bandchip" title="Price-index band used here (lookup: channel + pair → channel + ALL → default). ' + (c.band.data_type === 'MOCKUP' ? 'MOCKUP band, to be set by Marketing.' : '') + '">' + esc(bandLabel(c)) + '</span>';
// ---------- filters ----------
// Faceted filters: each dropdown lists only values that exist given the OTHER selections (from SKU_Pairs + Retailers data)
const FDIMS = [
  { k: 'channel', id: 'fChannel', name: 'Channel', all: 'All channels', get: (c) => c.channel },
  { k: 'retailer', id: 'fRetailer', name: 'Retailer', all: 'All retailers', get: (c) => c.retailer },
  { k: 'pair', id: 'fPair', name: 'SKU pair', all: 'All SKU pairs', get: (c) => c.pair },
  { k: 'comp', id: 'fComp', name: 'Competitor', all: 'All competitors', get: (c) => c.comp },
  { k: 'avail', id: 'fAvail', name: 'Availability', all: 'All', get: (c) => c.avail },
];
const matchesExcept = (c, skip) => FDIMS.every((f) => f.k === skip || S[f.k] === 'All' || f.get(c) === S[f.k]);
function filteredComps() { return D.comps.filter((c) => matchesExcept(c, null)); }
const pairLabel = (pid) => { const p = D.pairs[pid]; return p ? pid + ' · ' + (p.category || '') : pid; };
const pairTitle = (c) => { const p = D.pairs[c.pair]; return (p && p.category ? p.category : c.pair) + ': Malee vs ' + c.comp; };
function optLabel(f, v) { return f.k === 'pair' ? pairLabel(v) : f.k === 'avail' ? AVAIL_TEXT[v] || v : v; }
function optOrder(f, vals) {
  const ref = f.k === 'channel' ? D.channels : f.k === 'retailer' ? D.retailers : f.k === 'avail' ? AVAIL_ORDER : null;
  return vals.sort((a, b) => ref ? ((ref.indexOf(a) + 1 || 99) - (ref.indexOf(b) + 1 || 99)) || a.localeCompare(b) : a.localeCompare(b));
}
// changedKey = the filter the user just changed (kept); any other selection that no longer has rows is reset to All with a note
function buildFilters(changedKey) {
  const resets = [];
  for (let guard = 0; guard < FDIMS.length + 1; guard++) {
    // a selection is invalid when no pair has that value together with the other selections (then the result would be empty)
    const bad = FDIMS.filter((f) => S[f.k] !== 'All' && !D.comps.some((c) => matchesExcept(c, f.k) && f.get(c) === S[f.k]));
    if (!bad.length) break;
    // reset the least recently touched invalid filter first (never the one just changed, unless it is invalid on its own)
    const f = bad.find((x) => x.k !== changedKey) || bad[0];
    resets.push(f.name + ' "' + optLabel(f, S[f.k]) + '"'); S[f.k] = 'All';
  }
  const opt = (v, l, sel) => '<option value="' + esc(v) + '"' + (v === sel ? ' selected' : '') + '>' + esc(l) + '</option>';
  FDIMS.forEach((f) => {
    const cnt = {}; let total = 0;
    D.comps.forEach((c) => { if (matchesExcept(c, f.k)) { const v = f.get(c); cnt[v] = (cnt[v] || 0) + 1; total++; } });
    $(f.id).innerHTML = opt('All', f.all + ' (' + total + ')', S[f.k]) + optOrder(f, Object.keys(cnt)).map((v) => opt(v, optLabel(f, v) + ' (' + cnt[v] + ')', S[f.k])).join('');
  });
  const note = $('filterNote');
  if (resets.length) { note.textContent = resets.join(', ') + ' had no matching pairs with the other filters, so it was reset to All.'; note.classList.remove('hidden'); }
  else note.classList.add('hidden');
  return resets;
}
function renderLegend() {
  $('legend').innerHTML = '<span class="lg-title">Proof:</span>' + ['shot', 'none', 'unv', 'mock'].map((k) => '<span class="proof ' + PROOF[k].cls + '" title="' + esc(PROOF[k].tip) + '"><span class="pi">' + PROOF[k].icon + '</span>' + PROOF[k].label + '</span>').join('') +
    '<span class="lg-sep"></span><span class="lg-title">Freshness:</span><span class="checked">checked today 15:37</span> = time of the latest check (Bangkok) · <span class="tag stale">Stale</span> = older than ' + staleDays() + ' days';
}
function renderHeader() {
  renderLegend();
  const n = D.newest; const t = n.check_datetime.slice(11, 16);
  $('lastUpdated').textContent = niceY(n.date) + (t ? ', ' + t : '') + ' (Bangkok)';
  const rs = new Set(D.prices.filter((p) => p.date === D.anchor).map((p) => p.retailer));
  $('retailerCount').textContent = rs.size + ' of ' + D.retailers.length + ' retailers checked on ' + nice(D.anchor);
  $('openSheet').href = sheetUrl;
}

// ---------- tab: This Week ----------
function promoTagHTML(row, brand) {
  if (!row || !row.onPromo) return '';
  const col = brandColor(brand);
  return '<span class="promo-tag" style="color:' + col + ';border-color:' + col + '33;background:' + col + '12">' + esc(brand) + ': ' + esc(row.promo_mechanic || 'Promo') + (row.promo_end_date ? ' · until ' + nice(row.promo_end_date) + ' · <b>' + countdown(row.promo_end_date) + '</b>' : '') + '</span>';
}
// ---------- freshness + proof ----------
const TODAY = new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Bangkok' }); // YYYY-MM-DD in Bangkok
const staleDays = () => num(D.settings.stale_after_days) ?? 7;
const ageDays = (row) => row ? dnum(TODAY) - dnum(row.date) : null;
const isStale = (row) => !!row && ageDays(row) > staleDays();
function checkedText(row) {
  if (!row) return '';
  const a = ageDays(row); const t = row.check_datetime.slice(11, 16);
  return 'checked ' + (a === 0 ? 'today ' + t : a === 1 ? 'yesterday ' + t : nice(row.date) + (row.date.slice(0, 4) !== TODAY.slice(0, 4) ? ' ' + row.date.slice(0, 4) : ''));
}
const staleTag = (row) => isStale(row) ? ' <span class="tag stale" title="Latest check is older than ' + staleDays() + ' days (stale_after_days in Settings)">Stale</span>' : '';
const freshHTML = (row) => row ? '<span class="checked" title="' + esc(row.check_datetime) + ' (Bangkok)">' + checkedText(row) + '</span>' + staleTag(row) : '';
const PROOF = {
  shot: { icon: '📷', label: 'Screenshot', cls: 'p-shot', tip: 'A screenshot of the retailer page is saved for this price' },
  none: { icon: '○', label: 'No proof yet', cls: 'p-none', tip: 'Real public price, but no screenshot saved yet' },
  unv: { icon: '?', label: 'Unverified', cls: 'p-unv', tip: 'Price from a search snippet or store-dependent page; not confirmed' },
  mock: { icon: 'M', label: 'Mockup', cls: 'p-mock', tip: 'Made-up history for the mockup, not a real price' },
};
function proofKind(row) {
  if (!row) return null;
  if (row.screenshot_url) return 'shot';
  if (row.data_type === 'MOCKUP') return 'mock';
  if (/\[unverified\]/i.test(row.note)) return 'unv';
  return 'none';
}
function proofIcon(row, short) {
  const k = proofKind(row); if (!k) return ''; const p = PROOF[k];
  const inner = '<span class="pi">' + p.icon + '</span>' + (short ? '' : p.label);
  const tip = p.tip + (row.note ? ' – ' + row.note : '');
  return k === 'shot' ? '<a class="proof ' + p.cls + '" href="' + esc(row.screenshot_url) + '" target="_blank" rel="noopener" title="' + esc(tip) + '">' + inner + '</a>'
    : '<span class="proof ' + p.cls + '" title="' + esc(tip) + '">' + inner + '</span>';
}
function flags(row) {
  if (!row) return '';
  return proofIcon(row) + (/out of stock/i.test(row.note) ? ' <span class="tag warn">Out of stock</span>' : '');
}
const priceMeta = (row) => row ? '<span class="pmeta">' + freshHTML(row) + ' ' + flags(row) + '</span>' : '';
function countdown(end) {
  if (!end) return '';
  const n = dnum(end) - dnum(TODAY);
  return n < 0 ? 'ended ' + nice(end) : n === 0 ? 'ends today' : 'ends in ' + n + (n === 1 ? ' day' : ' days');
}
function weekEvents(comps) {
  const from = dstr(dnum(D.anchor) - 6); const ev = [];
  const keys = new Set(); comps.forEach((c) => { if (c.mSold) keys.add(c.pair + '|' + MALEE + '|' + c.retailer); if (c.kSold) keys.add(c.pair + '|' + c.comp + '|' + c.retailer); });
  keys.forEach((k) => {
    const s = D.series[k]; if (!s) return; const ds = Object.keys(s).sort(); const [pair, brand, retailer] = k.split('|');
    for (let i = 1; i < ds.length; i++) {
      const d = ds[i]; if (d < from || d > D.anchor) continue; const a = s[ds[i - 1]], cur = s[d]; if (a.notSold || cur.notSold) continue;
      const base = { date: d, brand, retailer, pair, row: cur };
      if (!a.onPromo && cur.onPromo) ev.push(Object.assign(base, { type: 'start', label: 'Promo started', text: (cur.promo_mechanic || 'Promo') + ': ' + baht(a.unit) + ' → ' + baht(cur.unit) + (cur.promo_end_date ? ', until ' + nice(cur.promo_end_date) : '') }));
      else if (a.onPromo && !cur.onPromo) ev.push(Object.assign(base, { type: 'end', label: 'Promo ended', text: (a.promo_mechanic || 'Promo') + ' ended: ' + baht(a.unit) + ' → ' + baht(cur.unit) }));
      else if (a.unit != null && cur.unit != null && Math.abs(a.unit - cur.unit) >= 0.01) ev.push(Object.assign(base, { type: 'move', label: 'Price moved', text: baht(a.unit) + ' → ' + baht(cur.unit) + (cur.onPromo ? ' (' + (cur.promo_mechanic || 'promo') + ')' : '') }));
    }
  });
  return ev.sort((a, b2) => b2.date.localeCompare(a.date) || a.retailer.localeCompare(b2.retailer));
}
function alertCard(c, L, reasons) {
  const sg = suggestion(c, L); const gap = L.m && L.k ? L.m.unit - L.k.unit : null;
  const gapTxt = gap == null ? '–' : Math.abs(gap) < 0.005 ? 'Same price' : 'Malee ' + baht(Math.abs(gap)) + (gap > 0 ? ' dearer' : ' cheaper');
  const P = (lbl, row, color) => '<div class="big"><span class="lbl">' + esc(lbl) + '</span><span class="num" style="color:' + color + '">' + baht(row && row.unit) + '</span>' + (row ? '<span class="bmeta">' + freshHTML(row) + '</span><span class="bmeta">' + flags(row) + '</span>' : '<span class="bmeta">not listed</span>') + '</div>';
  return '<div class="card ' + L.status + '">' +
    '<div class="action" title="Recommended action – a suggestion, not a fact">' + esc(headline(c, L)) + '</div>' +
    '<div class="card-head"><div><div class="card-title">' + esc(c.retailer) + ' · ' + esc(pairTitle(c)) + '</div><div class="card-sub">' + esc((D.pairs[c.pair] || {}).malee_sku || '') + ' vs ' + esc((D.pairs[c.pair] || {}).competitors ? D.pairs[c.pair].competitors[c.comp] || '' : '') + '</div></div>' +
    '<span class="status ' + L.status + '">' + STATUS_TEXT[L.status] + '</span></div>' +
    '<div style="margin-top:6px;display:flex;gap:6px;flex-wrap:wrap">' + bandChip(c) + reasons.map((r) => '<span class="reason">' + esc(r) + '</span>').join('') + (isStale(L.m) || isStale(L.k) ? '<span class="tag stale">Stale</span>' : '') + '</div>' +
    '<div class="big-row">' + P('Malee', L.m, brandColor(MALEE)) + P(c.comp, L.k, brandColor(c.comp)) +
    '<div class="big"><span class="lbl" title="Malee price per 100 ml ÷ competitor price per 100 ml × 100">Index</span><span class="num idx ' + L.status + '">' + fix1(L.idx) + '</span></div>' +
    '<div class="big"><span class="lbl">Gap</span><span class="num small">' + gapTxt + '</span></div></div>' +
    '<div class="promos">' + (promoTagHTML(L.m, MALEE) + promoTagHTML(L.k, c.comp) || '<span class="card-sub">No active promos</span>') + '</div>' +
    '<div class="move"><span class="sugg">Why (a suggestion, not a fact)</span><b>' + sg.kind + ':</b> ' + sg.text + '</div>' +
    '<div class="card-foot">' + (L.m ? '<a href="' + esc(L.m.source_url) + '" target="_blank" rel="noopener">Malee page</a>' : '') + (L.k ? ' <a href="' + esc(L.k.source_url) + '" target="_blank" rel="noopener">' + esc(c.comp) + ' page</a>' : '') + '</div></div>';
}
function renderWeek() {
  const used = {}; filteredComps().filter((c) => c.avail === 'both').forEach((c) => { used[bandLabel(c) + (c.band.source === 'channel+pair' ? ' (' + c.pair + ')' : '')] = 1; });
  $('bandText').innerHTML = 'Only pairs that are out of band, near a band edge, or changed this week are shown here. Bands differ by channel and pair (MOCKUP, to be set by Marketing): <b>' + (Object.keys(used).map(esc).join('; ') || '–') + '</b>.';
  const comps = filteredComps();
  const cs = comps.map((c) => ({ c, L: latestCompare(c) }));
  const rank = { red: 0, amber: 1, green: 2, grey: 3 };
  cs.sort((a, b2) => rank[a.L.status] - rank[b2.L.status] || (b2.L.idx || 0) - (a.L.idx || 0));
  const ev = weekEvents(comps);
  // "Changed this week" = competitor promo started/ended, or the index moved by 1+ point vs a week ago
  const weekAgo = dstr(dnum(D.anchor) - 7); const changed = {}; const lastEv = {};
  cs.forEach(({ c, L }) => {
    const mine = ev.filter((e) => e.pair === c.pair && e.retailer === c.retailer && (e.brand === MALEE || e.brand === c.comp));
    if (!mine.length) return;
    const m0 = latestRow(c.pair, MALEE, c.retailer, weekAgo), k0 = latestRow(c.pair, c.comp, c.retailer, weekAgo);
    const idx0 = m0 && k0 && m0.ppm && k0.ppm ? (m0.ppm / k0.ppm) * 100 : null;
    const compPromoEv = mine.some((e) => e.brand === c.comp && e.type !== 'move');
    const idxMove = L.idx != null && idx0 != null ? L.idx - idx0 : null;
    if (compPromoEv || idxMove == null || Math.abs(idxMove) >= 1) { changed[c.key] = { n: mine.length, idx0, idxMove }; lastEv[c.key] = mine[0]; }
  });
  const alerts = cs.filter(({ L }) => L.status === 'red' || L.status === 'amber');
  const quiet = cs.filter(({ c, L }) => !L.ns && !(L.status === 'red' || L.status === 'amber') && changed[c.key]);
  const nOut = cs.filter((x) => x.L.status === 'red').length, nNear = cs.filter((x) => x.L.status === 'amber').length, nOk = cs.filter((x) => x.L.status === 'green').length, nNa = cs.length - nOut - nNear - nOk;
  $('alertCount').textContent = cs.length ? '(' + (alerts.length + quiet.length) + ' of ' + cs.length + ' pairs need a look)' : '';
  const cards = alerts.map(({ c, L }) => alertCard(c, L, changed[c.key] ? ['Changed this week'] : [])).join('');
  const quietHTML = quiet.length ? '<div class="quiet"><div class="quiet-head">Changed this week, still in band (' + quiet.length + ')</div>' + quiet.map(({ c, L }) => {
    const ch = changed[c.key]; const e = lastEv[c.key]; const sg = suggestion(c, L);
    return '<div class="quiet-row"><span class="status green">In band</span><b>' + esc(c.retailer) + '</b> · ' + esc(pairTitle(c)) + ' ' + bandChip(c) +
      '<span class="qi">Index ' + (ch.idx0 != null ? fix1(ch.idx0) + ' → ' : '') + '<b>' + fix1(L.idx) + '</b></span>' +
      '<span class="card-sub">' + (e ? esc(e.brand) + ': ' + e.label.toLowerCase() + ' (' + nice(e.date) + ')' : '') + '</span>' +
      '<span class="qmove"><b class="qaction" title="Recommended action – a suggestion, not a fact">' + esc(headline(c, L)) + '</b> · Malee ' + baht(L.m && L.m.unit) + ' ' + priceMeta(L.m) + ' · ' + esc(c.comp) + ' ' + baht(L.k && L.k.unit) + ' ' + priceMeta(L.k) + '</span></div>';
  }).join('') + '</div>' : '';
  $('alerts').innerHTML = !cs.length ? '<div class="empty">No SKU pairs match the filters.</div>' : (alerts.length || quiet.length) ? (cards ? '<div class="cards">' + cards + '</div>' : '') + quietHTML : '<div class="empty">' + (nOk ? (nOk === cs.length ? 'All ' : '') + nOk + (nOk === 1 ? ' pair is' : ' pairs are') + ' in band and nothing important changed this week.' : 'Nothing to act on.') + (nNa ? ' ' + nNa + (nNa === 1 ? ' pair has' : ' pairs have') + ' no comparison (a SKU is not sold here or has no price) – see Today\u2019s status.' : '') + '</div>';

  $('changes').innerHTML = ev.length ? ev.map((e) => '<li><span class="when">' + nice(e.date) + '</span><span class="ev ' + e.type + '">' + e.label + '</span>' + brandPill(e.brand) +
    '<span class="what"><b>' + esc(e.retailer) + '</b> · ' + esc(pairLabel(e.pair)) + ' — ' + e.text + '</span>' + priceMeta(e.row) +
    ' <a href="' + esc(e.row.source_url) + '" target="_blank" rel="noopener">source</a></li>').join('') : '<li><span class="what">No price or promo changes in the last 7 days for this selection.</span></li>';

  // today's table: full status of every pair, collapsed by default
  $('todaySummary').innerHTML = 'Show all pairs today (' + cs.length + ') <span class="sum-counts"><span class="status red">' + nOut + ' out of band</span> <span class="status amber">' + nNear + ' near edge</span> <span class="status green">' + nOk + ' in band</span>' + (nNa ? ' <span class="status grey">' + nNa + ' no comparison</span>' : '') + '</span>';
  const head = '<tr><th>Retailer</th><th>SKU pair</th><th>Competitor</th><th class="num">Malee</th><th class="num">Competitor</th><th class="num">Gap ฿</th><th class="num">Index</th><th>Status</th><th>Band</th><th>Promos</th><th>Checked</th><th>Proof</th></tr>';
  $('todayTable').innerHTML = head + cs.map(({ c, L }) => {
    const gap = L.m && L.k ? L.m.unit - L.k.unit : null;
    return '<tr><td><b>' + esc(c.retailer) + '</b><div class="card-sub">' + esc(c.channel) + '</div></td><td>' + esc(pairLabel(c.pair)) + '</td><td>' + brandPill(c.comp) + '</td>' +
      '<td class="num">' + (L.mNS ? nsTag('Malee', c) : baht(L.m && L.m.unit)) + '</td><td class="num">' + (L.kNS ? nsTag(c.comp, c) : baht(L.k && L.k.unit)) + '</td>' +
      '<td class="num">' + (gap == null ? '–' : (gap > 0 ? '+' : gap < 0 ? '−' : '') + baht(Math.abs(gap))) + '</td>' +
      '<td class="num"><b class="idx ' + L.status + '">' + fix1(L.idx) + '</b></td><td><span class="status ' + L.status + '"' + (L.ns ? ' title="' + esc(headline(c, L)) + '"' : '') + '>' + STATUS_TEXT[L.status] + '</span></td><td>' + (L.ns ? '<span class="card-sub">–</span>' : bandChip(c)) + '</td>' +
      '<td>' + (promoTagHTML(L.m, MALEE) + ' ' + promoTagHTML(L.k, c.comp)).trim() + '</td>' +
      '<td class="small-cell">' + (L.mRaw ? 'Malee ' + freshHTML(L.mRaw) : '') + (L.kRaw ? '<br>' + esc(c.comp) + ' ' + freshHTML(L.kRaw) : '') + '</td><td class="small-cell">' + (L.mRaw ? proofIcon(L.mRaw, true) : '') + ' ' + (L.kRaw ? proofIcon(L.kRaw, true) : '') + (/out of stock/i.test((L.m || {}).note) ? ' <span class="tag warn">Malee out of stock</span>' : '') + '</td></tr>';
  }).join('');
}

// ---------- tab: Promo Pattern ----------
function promoEnd(p) { return p.end_date || D.anchor; }
function renderPromo() {
  const cs = filteredComps(); const keyset = new Set(cs.filter((c) => c.kSold).map((c) => c.pair + '|' + c.comp + '|' + c.retailer));
  const compPromos = D.promos.filter((p) => p.brand !== MALEE && keyset.has(p.pair_id + '|' + p.brand + '|' + p.retailer));
  const histDays = dnum(D.anchor) - dnum(D.firstDate) + 1;
  $('patternSub').textContent = 'Based on all ' + histDays + ' days of history (' + nice(D.firstDate) + ' – ' + nice(D.anchor) + ') for the selected retailer, pair and competitor. Includes MOCKUP history.';
  const durs = compPromos.filter((p) => p.end_date).map((p) => dnum(p.end_date) - dnum(p.start_date) + 1);
  const depths = compPromos.map((p) => p.depth).filter((x) => x != null);
  const wd = {}; compPromos.forEach((p) => { const w = new Date(dnum(p.start_date) * 864e5).getUTCDay(); wd[w] = (wd[w] || 0) + 1; });
  const topWd = Object.entries(wd).sort((a, b) => b[1] - a[1])[0];
  const rc = {}; compPromos.forEach((p) => (rc[p.retailer] = (rc[p.retailer] || 0) + 1));
  const topR = Object.entries(rc).sort((a, b) => b[1] - a[1])[0];
  const nComboRetail = new Set(cs.map((c) => c.retailer + c.comp)).size || 1;
  const per30 = compPromos.length / nComboRetail / (histDays / 30);
  const avg = (a) => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const stat = (lbl, val, note) => '<div class="stat"><div class="lbl">' + lbl + '</div><div class="num">' + val + '</div><div class="note">' + note + '</div></div>';
  $('patternCards').innerHTML = compPromos.length ? [
    stat('Promo frequency', per30.toFixed(1), 'promos per 30 days, per retailer'),
    stat('Average depth', avg(depths) == null ? '–' : '−' + avg(depths).toFixed(1) + '%', 'average discount off regular price'),
    stat('Average length', avg(durs) == null ? '–' : avg(durs).toFixed(1) + ' days', 'promos with a known end date'),
    stat('Usual start day', topWd ? WEEKDAYS[topWd[0]] : '–', topWd ? topWd[1] + ' of ' + compPromos.length + ' promos' : ''),
    stat('Most active retailer', topR ? esc(topR[0]) : '–', topR ? topR[1] + ' promos' : ''),
  ].join('') : '<div class="empty">No competitor promos found for this selection.</div>';

  renderCalc();

  // timelines
  const from = dstr(dnum(D.anchor) - S.days + 1); const to = D.anchor; const span = dnum(to) - dnum(from) + 1;
  const pos = (d) => ((Math.max(dnum(d), dnum(from)) - dnum(from)) / span) * 100;
  const ticks = []; for (let n = dnum(from); n <= dnum(to); n += Math.max(1, Math.round(span / 8))) ticks.push(dstr(n));
  $('timelines').innerHTML = cs.length ? cs.map((c) => {
    const lane = (brand) => {
      if (brand === MALEE ? !c.mSold : !c.kSold) return '<div class="lane"><div class="lane-name" style="color:' + brandColor(brand) + '">' + esc(brand) + '</div><div class="lane-track ns-track">' + nsTag(brand, c) + '</div></div>';
      const ps = D.promos.filter((p) => p.brand === brand && p.pair_id === c.pair && p.retailer === c.retailer && promoEnd(p) >= from && p.start_date <= to);
      const col = brandColor(brand);
      return '<div class="lane"><div class="lane-name" style="color:' + col + '">' + esc(brand) + '</div><div class="lane-track">' + ps.map((p) => {
        const l = pos(p.start_date), r = ((Math.min(dnum(promoEnd(p)), dnum(to)) - dnum(from) + 1) / span) * 100;
        const tip = esc(brand + ' · ' + p.mechanic + ' · ' + nice(p.start_date) + ' – ' + (p.end_date ? nice(p.end_date) : 'ongoing') + ' · ' + p.data_type + (p.note ? ' · ' + p.note : ''));
        return '<div class="blk' + (p.end_date ? '' : ' ongoing') + '" data-tip="' + tip + '" style="left:' + l + '%;width:' + Math.max(r - l, 1.2) + '%;background:' + col + (p.data_type === 'MOCKUP' ? 'cc' : '') + '">' + (p.depth != null ? '−' + Math.round(p.depth) + '%' : 'promo') + '</div>';
      }).join('') + '</div></div>';
    };
    const ser = compSeries(c, from, to);
    const strip = '<div class="lane"><div class="lane-name" style="color:var(--muted)">Index status</div><div class="lane-track thin">' + ser.map((s) => '<div class="day ' + (s.idx == null ? 'none' : statusOf(s.idx, c.band)) + '" data-tip="' + esc(nice(s.date) + ': ' + (s.mNS || s.kNS ? 'no comparison (not sold here)' : 'index ' + (s.idx == null ? 'n/a' : s.idx.toFixed(1)))) + '"></div>').join('') + '</div></div>';
    const axis = '<div class="axis"><div></div><div class="axis-track">' + ticks.map((t) => '<span style="left:' + ((dnum(t) - dnum(from) + 0.5) / span) * 100 + '%">' + nice(t) + '</span>').join('') + '</div></div>';
    return '<div class="tl"><div class="tl-head"><div class="tl-title">' + esc(c.retailer) + ' · ' + esc(pairTitle(c)) + ' ' + bandChip(c) + '</div><div class="legend"><span><i style="background:#9fd3ad"></i>In band</span><span><i style="background:#f6c26b"></i>Near edge</span><span><i style="background:#e57368"></i>Out of band</span><span><i style="background:repeating-linear-gradient(45deg,#999 0 3px,#ccc 3px 6px)"></i>Ongoing</span></div></div>' +
      lane(MALEE) + lane(c.comp) + strip + axis + '</div>';
  }).join('') : '<div class="empty">No SKU pairs match the filters.</div>';
}
function renderCalc() {
  const cs = filteredComps().filter((c) => c.avail === 'both'); if (!cs.length) { $('calc').innerHTML = '<div class="empty">No pair in this selection has both SKUs sold at the retailer, so there is nothing to calculate.</div>'; return; }
  let sel = cs.find((c) => c.key === S.calcKey) || cs.find((c) => latestCompare(c).k) || cs[0]; S.calcKey = sel.key;
  const L = latestCompare(sel);
  const compPrice = S.calcPriceKey === sel.key && S.calcPrice != null ? S.calcPrice : (L.k ? L.k.unit : null);
  $('calc').innerHTML = '<div class="inputs">' +
    '<label>SKU pair &amp; retailer<select id="cSel">' + cs.map((c) => '<option value="' + esc(c.key) + '"' + (c.key === sel.key ? ' selected' : '') + '>' + esc(c.retailer + ' · ' + pairTitle(c)) + '</option>').join('') + '</select></label>' +
    '<label>' + esc(sel.comp) + ' price per unit (฿)<input id="cPrice" type="number" step="0.5" min="0" value="' + (compPrice == null ? '' : +compPrice.toFixed(2)) + '"></label>' +
    '<div class="card-sub">Prefilled with the latest ' + esc(sel.comp) + ' price' + (L.k ? ' (' + baht(L.k.unit) + ', ' + freshHTML(L.k) + ' ' + flags(L.k) + ')' : '') + '. Type a promo price to test it.</div></div>' +
    '<div class="result" id="cResult"></div>';
  $('cSel').onchange = (e) => { S.calcKey = e.target.value; S.calcPrice = null; renderCalc(); };
  $('cPrice').oninput = (e) => { S.calcPrice = num(e.target.value); S.calcPriceKey = sel.key; calcResult(sel, L); };
  calcResult(sel, L);
}
function calcResult(c, L) {
  const b = c.band; const p = S.calcPriceKey === c.key && S.calcPrice != null ? S.calcPrice : (L.k ? L.k.unit : null);
  if (p == null || p <= 0) { $('cResult').innerHTML = '<div class="empty">Enter a competitor price.</div>'; return; }
  const lo = maleePriceFor(c, p, b.low), hi = maleePriceFor(c, p, b.high); const cur = L.m ? L.m.unit : null;
  const idx = cur != null ? (cur / maleePriceFor(c, p, 100)) * 100 : null; const st = statusOf(idx, b);
  let move = 'No Malee price found.';
  if (cur != null) {
    if (cur > hi) move = 'Malee needs to come down by <b>' + baht(cur - hi) + '</b> to ' + baht(hi) + ' to stay in band.';
    else if (cur < lo) move = 'Malee is below the band. It could go up by <b>' + baht(lo - cur) + '</b> or more (up to ' + baht(hi) + ').';
    else move = 'No move needed – Malee is inside the band.';
  }
  const minX = Math.min(lo, cur || lo, p) * 0.9, maxX = Math.max(hi, cur || hi, p) * 1.1; const X = (v) => ((v - minX) / (maxX - minX)) * 100;
  $('cResult').innerHTML = '<div class="card-sub">To keep the index between ' + b.low + ' and ' + b.high + ' (' + esc(bandLabel(c)) + '), Malee should be priced at</div>' +
    '<div class="range">' + baht(lo) + ' – ' + baht(hi) + '</div>' +
    '<p>Current Malee price: <b>' + baht(cur) + '</b>' + (L.m ? ' (' + freshHTML(L.m) + ' ' + flags(L.m) + ')' : '') + ' → index at this competitor price: <b class="idx ' + st + '">' + fix1(idx) + '</b> <span class="status ' + st + '">' + STATUS_TEXT[st] + '</span></p>' +
    '<p>' + move + ' <span class="card-sub">(suggestion, not a fact)</span></p>' +
    '<div class="scale"><div class="band" style="left:' + X(lo) + '%;width:' + (X(hi) - X(lo)) + '%"></div>' +
    (cur != null ? '<div class="mark" style="left:' + X(cur) + '%;background:' + brandColor(MALEE) + '"></div><div class="mlabel" style="left:' + X(cur) + '%;color:' + brandColor(MALEE) + '">Malee ' + baht(cur) + '</div>' : '') +
    '<div class="mark" style="left:' + X(p) + '%;background:' + brandColor(c.comp) + '"></div></div><div style="height:22px"></div>' +
    '<div class="legend"><span><i style="background:var(--green-bg);border:1px dashed #8bc79a"></i>Malee price range that stays in band</span><span><i style="background:' + brandColor(c.comp) + '"></i>' + esc(c.comp) + ' ' + baht(p) + '</span></div>';
}

// ---------- tab: Price History ----------
function svgChart(c, from, to) {
  const ser = compSeries(c, from, to); const W = 640, H = 250, pl = 46, pr = 14, pt = 26, pb = 28; const iw = W - pl - pr, ih = H - pt - pb;
  const idxMode = S.metric === 'idx'; const b = c.band;
  const vals = []; ser.forEach((s) => { if (idxMode) { if (s.idx != null) vals.push(s.idx); } else { if (s.m) vals.push(s.m.ppm); if (s.k) vals.push(s.k.ppm); } });
  if (!vals.length) return '<div class="empty">No data in this range.</div>';
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (idxMode) { lo = Math.min(lo, b.low - 3); hi = Math.max(hi, b.high + 3); } else { const pad = (hi - lo) * 0.15 || 0.3; lo -= pad; hi += pad; }
  const n = ser.length; const x = (i) => pl + (n === 1 ? iw / 2 : (i / (n - 1)) * iw); const y = (v) => pt + ih - ((v - lo) / (hi - lo)) * ih;
  const path = (get) => { let d = '', pen = false; ser.forEach((s, i) => { const v = get(s); if (v == null) { pen = false; return; } d += (pen ? 'L' : 'M') + x(i).toFixed(1) + ',' + y(v).toFixed(1); pen = true; }); return d; };
  let g = '';
  // promo shaded columns behind lines
  const step = iw / Math.max(n - 1, 1);
  ser.forEach((s, i) => {
    if (s.k && s.k.onPromo) g += '<rect x="' + (x(i) - step / 2).toFixed(1) + '" y="' + pt + '" width="' + step.toFixed(1) + '" height="' + ih + '" fill="' + brandColor(c.comp) + '" opacity="0.10"/>';
    if (s.m && s.m.onPromo) g += '<rect x="' + (x(i) - step / 2).toFixed(1) + '" y="' + (pt - 8) + '" width="' + step.toFixed(1) + '" height="6" fill="' + brandColor(MALEE) + '" opacity="0.75"/>';
    if (s.k && s.k.onPromo) g += '<rect x="' + (x(i) - step / 2).toFixed(1) + '" y="' + (pt - 16) + '" width="' + step.toFixed(1) + '" height="6" fill="' + brandColor(c.comp) + '" opacity="0.75"/>';
  });
  if (idxMode) g += '<rect x="' + pl + '" y="' + y(b.high) + '" width="' + iw + '" height="' + (y(b.low) - y(b.high)) + '" fill="#1e8e3e" opacity="0.10"/><line x1="' + pl + '" x2="' + (pl + iw) + '" y1="' + y(100) + '" y2="' + y(100) + '" stroke="#1e8e3e" stroke-dasharray="4 4" opacity=".6"/>' +
    '<text x="' + (pl + iw - 4) + '" y="' + (y(b.high) + 12) + '" text-anchor="end" font-size="11" fill="#1e8e3e">band ' + b.low + '–' + b.high + '</text>';
  // y grid
  for (let k = 0; k <= 4; k++) { const v = lo + ((hi - lo) * k) / 4; g += '<line x1="' + pl + '" x2="' + (pl + iw) + '" y1="' + y(v) + '" y2="' + y(v) + '" stroke="#eef0f3"/><text x="' + (pl - 6) + '" y="' + (y(v) + 4) + '" text-anchor="end" font-size="11" fill="#5f6b7d">' + (idxMode ? v.toFixed(0) : '฿' + v.toFixed(1)) + '</text>'; }
  // x ticks
  const tickEvery = Math.max(1, Math.round(n / 6)); ser.forEach((s, i) => { if (i % tickEvery === 0 || i === n - 1) g += '<text x="' + x(i) + '" y="' + (H - 8) + '" text-anchor="middle" font-size="11" fill="#5f6b7d">' + nice(s.date) + '</text>'; });
  if (idxMode) g += '<path d="' + path((s) => s.idx) + '" fill="none" stroke="#1d2433" stroke-width="2.5"/>';
  else { g += '<path d="' + path((s) => s.k && s.k.ppm) + '" fill="none" stroke="' + brandColor(c.comp) + '" stroke-width="2.5"/>'; g += '<path d="' + path((s) => s.m && s.m.ppm) + '" fill="none" stroke="' + brandColor(MALEE) + '" stroke-width="2.5"/>'; }
  // real points
  ser.forEach((s, i) => { [['m', MALEE], ['k', c.comp]].forEach(([f, br]) => { const r = s[f]; if (r && r.data_type === 'REAL' && !idxMode) g += '<circle cx="' + x(i) + '" cy="' + y(r.ppm) + '" r="4.5" fill="#fff" stroke="' + brandColor(br) + '" stroke-width="2.5"/>'; }); if (idxMode && s.idx != null && ((s.m || {}).data_type === 'REAL')) g += '<circle cx="' + x(i) + '" cy="' + y(s.idx) + '" r="4.5" fill="#fff" stroke="#1d2433" stroke-width="2.5"/>'; });
  g += '<line class="hover" x1="0" x2="0" y1="' + pt + '" y2="' + (pt + ih) + '" stroke="#1d2433" stroke-dasharray="3 3" opacity="0"/>';
  g += '<rect class="hit" x="' + pl + '" y="' + (pt - 16) + '" width="' + iw + '" height="' + (ih + 16) + '" fill="transparent"/>';
  return '<svg viewBox="0 0 ' + W + ' ' + H + '" data-key="' + esc(c.key) + '" data-from="' + from + '" data-to="' + to + '" data-n="' + n + '" data-pl="' + pl + '" data-iw="' + iw + '">' + g + '</svg>';
}
function renderHistory() {
  const cs = filteredComps(); const from = dstr(dnum(D.anchor) - S.days + 1); const to = D.anchor;
  document.querySelectorAll('#metric button').forEach((bt) => bt.classList.toggle('on', bt.dataset.m === S.metric));
  $('histSub').innerHTML = (S.metric === 'idx' ? 'Index line with the green band that applies to each retailer channel and pair. ' : 'Malee (blue) vs competitor, price per 100 ml. ') + 'Coloured bars on top mark promo days; light shading = competitor promo. Circles = REAL checks. ' + nice(from) + ' – ' + nice(to) + '.';
  $('charts').classList.toggle('single', cs.length === 1);
  $('charts').innerHTML = cs.length ? cs.map((c) => '<div class="chart"><div class="chart-title"><span>' + esc(c.retailer) + ' · ' + esc(pairTitle(c)) + ' ' + (c.avail === 'both' ? bandChip(c) : '<span class="status grey">No comparison</span> ' + (!c.mSold ? 'Malee ' + nsTag('Malee', c) : '') + (!c.kSold ? ' ' + esc(c.comp) + ' ' + nsTag(c.comp, c) : '')) + '</span><span class="legend"><span><i style="background:' + brandColor(MALEE) + '"></i>Malee</span><span><i style="background:' + brandColor(c.comp) + '"></i>' + esc(c.comp) + '</span></span></div>' + svgChart(c, from, to) + '</div>').join('') : '<div class="empty">No SKU pairs match the filters.</div>';
  document.querySelectorAll('#charts svg').forEach(bindChartHover);
  // table
  const rows = []; cs.forEach((c) => compSeries(c, from, to).forEach((s) => { if (s.m || s.k || getRow(c.pair, MALEE, c.retailer, s.date) || getRow(c.pair, c.comp, c.retailer, s.date)) rows.push({ c, s }); }));
  rows.sort((a, b) => b.s.date.localeCompare(a.s.date) || a.c.retailer.localeCompare(b.c.retailer));
  $('histTable').innerHTML = '<tr><th>Date</th><th>Retailer</th><th>SKU pair</th><th class="num">Malee ฿</th><th class="num">Competitor ฿</th><th class="num">Malee /100ml</th><th class="num">Comp. /100ml</th><th class="num">Index</th><th>Band</th><th>Promos</th><th>Data</th></tr>' +
    rows.map(({ c, s }) => { const st = statusOf(s.idx, c.band); const ns = s.mNS || s.kNS; return '<tr><td>' + nice(s.date) + '</td><td>' + esc(c.retailer) + '</td><td>' + esc(pairLabel(c.pair)) + ' ' + brandPill(c.comp) + '</td><td class="num">' + (s.mNS ? nsTag('Malee', c) : baht(s.m && s.m.unit)) + '</td><td class="num">' + (s.kNS ? nsTag(c.comp, c) : baht(s.k && s.k.unit)) + '</td><td class="num">' + (s.m && s.m.ppm != null ? s.m.ppm.toFixed(2) : '–') + '</td><td class="num">' + (s.k && s.k.ppm != null ? s.k.ppm.toFixed(2) : '–') + '</td><td class="num">' + (ns ? '<span class="status grey">No comparison</span>' : '<b class="idx ' + st + '">' + fix1(s.idx) + '</b>') + '</td><td>' + (ns ? '<span class="card-sub">–</span>' : bandChip(c)) + '</td><td>' + (promoTagHTML(s.m, MALEE) + ' ' + promoTagHTML(s.k, c.comp)).trim() + '</td><td>' + flags(s.m || s.k) + '</td></tr>'; }).join('');
}
function bindChartHover(svg) {
  const c = D.comps.find((x) => x.key === svg.dataset.key); if (!c) return; const ser = compSeries(c, svg.dataset.from, svg.dataset.to);
  const n = +svg.dataset.n, pl = +svg.dataset.pl, iw = +svg.dataset.iw; const line = svg.querySelector('.hover'); const hit = svg.querySelector('.hit');
  hit.addEventListener('mousemove', (e) => {
    const pt = svg.createSVGPoint(); pt.x = e.clientX; pt.y = e.clientY; const p = pt.matrixTransform(svg.getScreenCTM().inverse());
    const i = Math.max(0, Math.min(n - 1, Math.round(((p.x - pl) / iw) * (n - 1)))); const s = ser[i]; const xx = pl + (n === 1 ? iw / 2 : (i / (n - 1)) * iw);
    line.setAttribute('x1', xx); line.setAttribute('x2', xx); line.setAttribute('opacity', '0.6');
    const row = (r, br, ns) => ns ? esc(br) + ': not sold here' : r ? '<b style="color:' + brandColor(br) + '">' + esc(br) + '</b> ' + baht(r.unit) + ' (' + r.ppm.toFixed(2) + '/100ml)' + (r.onPromo ? ' · ' + esc(r.promo_mechanic) : '') + ' · ' + r.data_type : esc(br) + ': no data';
    showTip(e, '<b>' + niceY(s.date) + '</b><br>' + row(s.m, MALEE, s.mNS) + '<br>' + row(s.k, c.comp, s.kNS) + '<br>' + (s.mNS || s.kNS ? 'No comparison' : 'Index <b>' + fix1(s.idx) + '</b> (' + STATUS_TEXT[statusOf(s.idx, c.band)] + ')'));
  });
  hit.addEventListener('mouseleave', () => { line.setAttribute('opacity', '0'); hideTip(); });
}

// ---------- tab: Data Log ----------
const LOG_DAYS = 7; // Data Log shows only the last 7 days; full history stays in the Google Sheet
const LOG_COLS = [['check_datetime', 'Checked'], ['retailer', 'Retailer'], ['pair_id', 'Pair'], ['brand', 'Brand'], ['regular_price_thb', 'Regular ฿'], ['promo_price_thb', 'Promo ฿'], ['unit_price_thb', 'Unit ฿'], ['price_per_100ml', '/100ml'], ['promo_mechanic', 'Promo'], ['promo_end_date', 'Promo ends'], ['data_type', 'Data']];
const NUMCOLS = new Set(['regular_price_thb', 'promo_price_thb', 'unit_price_thb', 'price_per_100ml']);
function logRows() {
  const cs = filteredComps(); const ok = new Set(); cs.forEach((c) => { ok.add(c.pair + '|' + MALEE + '|' + c.retailer); ok.add(c.pair + '|' + c.comp + '|' + c.retailer); });
  const from = dstr(dnum(D.anchor) - LOG_DAYS + 1); const q = S.logQuery.toLowerCase();
  const rows = D.prices.filter((p) => ok.has(p.pair_id + '|' + p.brand + '|' + p.retailer) && p.date >= from && (!q || Object.values(p).some((v) => typeof v === 'string' && v.toLowerCase().includes(q))));
  const k = S.logSort.k, dir = S.logSort.dir;
  rows.sort((a, b) => { const va = NUMCOLS.has(k) ? num(a[k]) ?? -1 : a[k] || '', vb = NUMCOLS.has(k) ? num(b[k]) ?? -1 : b[k] || ''; return (va > vb ? 1 : va < vb ? -1 : 0) * dir; });
  return rows;
}
function renderLog() {
  const rows = logRows(); const per = 25; const pages = Math.max(1, Math.ceil(rows.length / per)); if (S.logPage >= pages) S.logPage = pages - 1;
  const real = rows.filter((r) => r.data_type === 'REAL').length;
  $('logSub').innerHTML = '<b>Showing last ' + LOG_DAYS + ' days</b> (' + nice(dstr(dnum(D.anchor) - LOG_DAYS + 1)) + ' – ' + nice(D.anchor) + '): ' + rows.length + ' checks (' + real + ' REAL, ' + (rows.length - real) + ' MOCKUP). Full history is in the <a href="' + sheetUrl + '" target="_blank" rel="noopener">Google Sheet (Price_Log tab)</a>. Click a column name to sort; Download CSV saves the rows shown.';
  const arrow = (k) => S.logSort.k === k ? (S.logSort.dir > 0 ? ' ▲' : ' ▼') : '';
  $('logTable').innerHTML = '<tr>' + LOG_COLS.map(([k, l]) => '<th class="sortable' + (NUMCOLS.has(k) ? ' num' : '') + '" data-k="' + k + '">' + l + arrow(k) + '</th>').join('') + '<th>Proof</th><th>Source</th><th>Note</th></tr>' +
    rows.slice(S.logPage * per, S.logPage * per + per).map((r) => '<tr>' + LOG_COLS.map(([k]) => {
      if (k === 'check_datetime') return '<td style="white-space:nowrap">' + freshHTML(r).replace('checked ', '') + '<div class="card-sub">' + nice(r.date) + ' ' + r.check_datetime.slice(11, 16) + '</div></td>';
      if (k === 'brand') return '<td>' + brandPill(r.brand) + '</td>';
      if (k === 'data_type') return '<td><span class="tag ' + esc(r.data_type) + '">' + esc(r.data_type) + '</span>' + (r.superseded ? ' <span class="tag sup" title="A later check of this SKU at this retailer on the same day replaces this row; the dashboard ignores it.">Superseded</span>' : '') + (r.notSold ? ' <span class="tag ns">Not sold here</span>' : '') + '</td>';
      if (k === 'promo_end_date') return '<td>' + (r.promo_end_date ? nice(r.promo_end_date) : '') + '</td>';
      if (NUMCOLS.has(k)) return '<td class="num">' + (r[k] === '' ? '' : (k === 'price_per_100ml' ? (+r[k]).toFixed(2) : baht(num(r[k])))) + '</td>';
      return '<td>' + esc(r[k]) + '</td>';
    }).join('') + '<td>' + proofIcon(r) + '</td><td><a href="' + esc(r.source_url) + '" target="_blank" rel="noopener">page</a></td><td class="note-cell">' + esc(r.note) + '</td></tr>').join('');
  document.querySelectorAll('#logTable th.sortable').forEach((th) => th.onclick = () => { const k = th.dataset.k; S.logSort = { k, dir: S.logSort.k === k ? -S.logSort.dir : -1 }; renderLog(); });
  $('pager').innerHTML = '<button id="pPrev"' + (S.logPage === 0 ? ' disabled' : '') + '>‹ Prev</button><span>Page ' + (S.logPage + 1) + ' of ' + pages + '</span><button id="pNext"' + (S.logPage >= pages - 1 ? ' disabled' : '') + '>Next ›</button>';
  $('pPrev').onclick = () => { S.logPage--; renderLog(); }; $('pNext').onclick = () => { S.logPage++; renderLog(); };
}
function downloadCSV() {
  const rows = logRows(); const cols = ['check_id', 'check_datetime', 'retailer', 'pair_id', 'brand', 'sku', 'regular_price_thb', 'promo_price_thb', 'effective_price_thb', 'promo_mechanic', 'promo_end_date', 'pack_units', 'unit_price_thb', 'price_per_100ml', 'source_url', 'screenshot_url', 'data_type', 'note'];
  const q = (v) => { v = v == null ? '' : String(v); return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v; };
  const csv = '\ufeff' + [cols.join(',')].concat(rows.map((r) => cols.map((c) => q(r[c])).join(','))).join('\r\n');
  const a = document.createElement('a'); a.href = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' })); a.download = 'malee-price-log-last-' + LOG_DAYS + '-days-to-' + D.anchor + '.csv'; document.body.appendChild(a); a.click(); a.remove();
}

// ---------- tooltip ----------
function showTip(e, html) { const t = $('tip'); t.innerHTML = html; t.classList.remove('hidden'); const w = t.offsetWidth; let x = e.clientX + 14; if (x + w > innerWidth - 8) x = e.clientX - w - 14; t.style.left = x + 'px'; t.style.top = e.clientY + 14 + 'px'; }
function hideTip() { $('tip').classList.add('hidden'); }
document.addEventListener('mouseover', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(e, esc(el.dataset.tip)); });
document.addEventListener('mousemove', (e) => { const el = e.target.closest && e.target.closest('[data-tip]'); if (el) showTip(e, esc(el.dataset.tip)); });
document.addEventListener('mouseout', (e) => { if (e.target.closest && e.target.closest('[data-tip]')) hideTip(); });

// ---------- render / events ----------
function render() {
  if (!D) return;
  document.querySelectorAll('.tab').forEach((t) => t.classList.toggle('active', t.dataset.tab === S.tab));
  document.querySelectorAll('.panel').forEach((p) => p.classList.toggle('hidden', p.id !== 'tab-' + S.tab));
  document.querySelectorAll('#fRange button').forEach((b) => b.classList.toggle('on', +b.dataset.days === S.days));
  $('fRange').parentElement.style.display = (S.tab === 'log' || S.tab === 'week') ? 'none' : ''; // Data Log is fixed to 7 days; This Week is always the latest week
  ({ week: renderWeek, promo: renderPromo, history: renderHistory, log: renderLog })[S.tab]();
  try { history.replaceState(null, '', '#' + S.tab); } catch (e) { /* file:// */ }
}
document.querySelectorAll('.tab').forEach((t) => t.onclick = () => { S.tab = t.dataset.tab; render(); });
FDIMS.forEach((f) => { $(f.id).onchange = (e) => { S[f.k] = e.target.value; S.logPage = 0; buildFilters(f.k); render(); }; });
document.querySelectorAll('#fRange button').forEach((b) => b.onclick = () => { S.days = +b.dataset.days; S.logPage = 0; render(); });
document.querySelectorAll('#metric button').forEach((b) => b.onclick = () => { S.metric = b.dataset.m; render(); });
$('logSearch').oninput = (e) => { S.logQuery = e.target.value; S.logPage = 0; renderLog(); };
$('dlCsv').onclick = downloadCSV;
$('reload').onclick = load;
const h = (location.hash || '').slice(1); if (['week', 'promo', 'history', 'log'].includes(h)) S.tab = h;
window.__tracker = { S, get D() { return D; }, render, statusOf, latestCompare, suggestion, parseCSV, buildFilters, filteredComps, FDIMS };
load();
})();
