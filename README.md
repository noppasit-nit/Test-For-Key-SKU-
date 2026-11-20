# Malee Price & Promo Tracker (mockup)

A small website that shows how Malee's prices and promotions compare with competitors at Thai retailers.
History before 20 Nov 2026 is **MOCKUP**; the 20 Nov 2026 prices are real public retailer prices.

## How it reads the Google Sheet live
- Every time someone opens or reloads the page, it downloads the latest data straight from the Google Sheet
  "For AI Testing/Spy project" (tabs `SKU_Pairs`, `Price_Log`, `Promo_Log`, `Settings`).
- It uses Google's CSV link for each tab:
  `https://docs.google.com/spreadsheets/d/<SHEET_ID>/gviz/tq?tqx=out:csv&headers=1&sheet=<TabName>`
- Nothing needs to be rebuilt or republished. Add a row to the Sheet, reload the page, and it appears.
  (Google may cache for a minute or two.)
- This works only while the Sheet can be viewed by anyone with the link (or is published to the web).
  If the Sheet is made private, the page shows "Couldn't load data from Google Sheet".
- The Sheet ID is set once at the top of `assets/app.js` (`SHEET_ID`).

## What's on each tab
1. **This Week** – alerts: full cards only for pairs out of band (red) or near a band edge (amber), plus a compact
   list of in-band pairs that changed this week (competitor promo started/ended or index moved 1+ point), each with a
   suggested move; then what changed in the last 7 days; then a collapsed "Show all pairs today (N)" table with every pair.
2. **Promo Pattern** – how often the competitor runs promos, how deep and how long, a calculator for the Malee
   price that keeps the index in band, and a promo timeline per retailer.
3. **Price History** – one simple chart per retailer and SKU pair (Malee vs competitor), price per 100 ml or index.
4. **Data Log** – the last 7 days of price checks only (to keep it uncluttered), searchable and sortable, with source links and a CSV download of the rows shown. Full history stays in the Google Sheet. REAL rows without a screenshot are flagged "No proof captured".

Price index = Malee price per 100 ml ÷ competitor price per 100 ml × 100 (competitor = 100).
Bands differ by **retailer channel** and **SKU pair**:
- `Retailers` tab maps each retailer to a channel (Big C, Tops, Makro, Lotus's = Super/Hyper; 7-Eleven = CVS, no data yet).
- `Bands` tab holds channel, pair_id (or ALL), band_low, band_high, near_margin. Current values are MOCKUP, to be set by Marketing:
  Super/Hyper P1 coconut 95–107, Super/Hyper P2 apple 95–105, CVS ALL 95–110.
- Lookup order: channel + pair → channel + ALL → global default in `Settings` (band_low / band_high, 95–105).
- Every card, row, chart and timeline shows the band it used, e.g. "Band 95–107 · Super/Hyper". A Channel filter is in the filter bar.

## Freshness, proof and recommendations
- **Freshness:** every price shows when it was checked ("checked today 15:37", "checked 19 Nov", Bangkok time).
  If the latest check for a retailer × pair is older than `stale_after_days` in Settings (7), a grey **Stale** tag appears.
- **Proof status** for each price (legend at the top of the page):
  📷 Screenshot (screenshot_url filled in, click to open) · ○ No proof yet (REAL price, no screenshot) ·
  ? Unverified (note contains [Unverified]) · M Mockup (data_type MOCKUP).
- **Recommended action:** each alert card starts with one bold line (e.g. "Match Tipco's −10% at Big C until 3 Dec"),
  worked out from the band, promo end dates and the counter-move maths. It is a suggestion, not a fact.
  Promo tags show a countdown ("ends in 13 days") when the end date is known.

## Publishing (GitHub Pages)
Push the contents of this folder to the repo root (index.html at the top level, `assets/` beside it, `.nojekyll`).
All paths are relative, so it works at `https://<user>.github.io/<repo>/`. In the repo: Settings → Pages →
Deploy from branch → main / (root). Free GitHub Pages sites are public, so keep only mockup/public data here.

## How to add SKUs, competitors or retailers (just add rows)
- **New SKU pair or competitor:** add one row per retailer in `SKU_Pairs` (pair_id, category, Malee SKU,
  competitor brand and SKU, sizes, retailer, product URLs). One Malee SKU can have several competitors:
  use a new row with the same Malee SKU and a different `competitor_brand` (a new pair_id is clearest).
- **New retailer:** add a row in `Retailers` (retailer, channel), add `SKU_Pairs` rows with the new retailer name, then add its checks to `Price_Log`.
- **New prices:** add rows to `Price_Log` (one per brand per retailer per check). `brand` must be `Malee` for
  Malee rows and must match `competitor_brand` in `SKU_Pairs` for competitor rows.
- **New promos:** add rows to `Promo_Log` (leave `end_date` blank if unknown; it shows as "ongoing").
- Filters, colours and charts update automatically. Malee is blue, Cocomax teal, Tipco orange; new brands get
  the next colour from a fixed palette.
- Don't rename the header row (it is protected with a warning) – the site finds columns by these names.

## Switching to private later (Looker Studio)
This site is public if hosted on free GitHub Pages, and it needs the Sheet to be link-viewable. Before real,
sensitive data goes in:
1. In Google Sheets, set General access back to **Restricted** and share only with named people.
2. Build the dashboard in **Looker Studio** (free): connect it to the same Sheet, recreate the 4 views
   (alerts table with conditional colours, promo timeline, price history chart, data log table).
3. Share the Looker Studio report only with named emails, with "Viewer's credentials" so each person needs
   their own Sheet access. Both the data and the dashboard are then private.
4. Take this GitHub site down (or leave it on mockup-only data).

## Files
- `index.html` – the page
- `assets/app.js` – loads the Sheet (SKU_Pairs, Price_Log, Promo_Log, Settings, Bands, Retailers), does the calculations and draws everything (no external libraries)
- `assets/styles.css` – the look
- `.nojekyll` – tells GitHub Pages to serve the files as-is
