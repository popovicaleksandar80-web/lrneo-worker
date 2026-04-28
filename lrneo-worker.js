import { chromium } from 'playwright';

const env = (name, fallback = '') => process.env[name] || fallback;

function required(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

function clean(value) {
  return String(value || '').replace(/\s+/g, ' ').trim();
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

async function loginIfNeeded(page, email, password) {
  const text = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  if (/PSZ|Összpont|Osszpont|Partner keresés|Partner kereses/.test(text)) return;

  const user = page.locator('input[name="username"], input#username, input[type="email"], input[name="email"]').first();
  const pass = page.locator('input[name="password"], input#password, input[type="password"]').first();
  await user.waitFor({ state: 'visible', timeout: 30000 });
  await user.fill(email);
  await pass.fill(password);

  const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Bejelentkezés"), button:has-text("Prijava")').first();
  if (await submit.count()) {
    await Promise.all([
      page.waitForLoadState('domcontentloaded').catch(() => {}),
      submit.click(),
    ]);
  } else {
    await pass.press('Enter');
  }
}

async function extractVisibleRows(page) {
  return page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const visible = (el) => {
      if (!el) return false;
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0 && rect.height > 0;
    };
    const inViewport = (el) => {
      const rect = el.getBoundingClientRect();
      return rect.bottom >= 0 && rect.top <= window.innerHeight + 2;
    };

    const tableRows = [];
    for (const table of Array.from(document.querySelectorAll('table')).filter(visible)) {
      const rows = Array.from(table.querySelectorAll('tr'))
        .filter((tr) => visible(tr) && inViewport(tr))
        .map((tr) => Array.from(tr.children).filter(visible).map((cell) => clean(cell.innerText || cell.textContent)))
        .filter((row) => row.some(Boolean));
      const text = rows.flat().join(' ');
      if (rows.length && /PSZ|Összpont|Osszpont|Név|Nev/.test(text)) tableRows.push(rows);
    }
    if (tableRows.length) return tableRows.sort((a, b) => b.length - a.length)[0];

    const gridRows = Array.from(document.querySelectorAll('[role="row"], .ag-row, .ui-grid-row, .mat-row, .mat-header-row, .datatable-row'))
      .filter((row) => visible(row) && inViewport(row))
      .map((row) => {
        const cells = Array.from(row.querySelectorAll('[role="gridcell"], [role="columnheader"], .ag-cell, .ui-grid-cell, .mat-cell, .mat-header-cell, .datatable-body-cell'))
          .filter(visible)
          .map((cell) => clean(cell.innerText || cell.textContent));
        return cells.length ? cells : [clean(row.innerText || row.textContent)];
      })
      .filter((row) => row.some(Boolean));
    return gridRows;
  });
}

function usefulRows(rows) {
  return rows.filter((row) => {
    const text = row.join(' ');
    return /HU\d{6,}|DE\d{6,}|PSZ|Összpont|Osszpont|Név|Nev/.test(text);
  });
}

function partnerCount(rows) {
  return rows.filter((row) => /^(HU|DE)\d{6,}/.test(clean(row[0]))).length;
}

async function waitForAlineRows(page) {
  let best = [];
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    const rows = usefulRows(await extractVisibleRows(page));
    if (rows.length > best.length) best = rows;
    const text = rows.flat().join(' ');
    if (/PSZ/.test(text) && /Összpont|Osszpont/.test(text) && partnerCount(rows) >= 8) return rows;
    await page.waitForTimeout(1500);
  }
  throw new Error(`Neo A-line table did not fully load. Visible partner rows: ${partnerCount(best)}. Rows: ${JSON.stringify(best).slice(0, 1200)}`);
}

async function postSnapshot(rows, pageUrl) {
  const ingestUrl = required('LR_APP_INGEST_URL');
  const token = required('LR_APP_INGEST_TOKEN');
  const username = required('LR_APP_USERNAME');
  const response = await fetch(ingestUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'lrneo.ingest_snapshot',
      token,
      username,
      date: todayIso(),
      url: pageUrl,
      fetched_at: new Date().toISOString(),
      rows,
    }),
  });
  const text = await response.text();
  let data = {};
  try { data = text ? JSON.parse(text) : {}; } catch (err) {}
  if (!response.ok || data.ok === false) {
    throw new Error(`Ingest failed: HTTP ${response.status} ${text}`);
  }
  return data;
}

async function main() {
  const email = required('LRNEO_EMAIL');
  const password = required('LRNEO_PASSWORD');
  const headless = env('LRNEO_HEADLESS', 'true') !== 'false';

  const browser = await chromium.launch({ headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({
      viewport: { width: 1500, height: 620 },
      locale: 'hu-HU',
    });
    const page = await context.newPage();
    await page.goto('https://neo.lrworld.com/a-line', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await loginIfNeeded(page, email, password);
    await page.goto('https://neo.lrworld.com/a-line', { waitUntil: 'domcontentloaded', timeout: 90000 });
    await page.waitForLoadState('networkidle', { timeout: 90000 }).catch(() => {});
    const rows = await waitForAlineRows(page);
    const result = await postSnapshot(rows, page.url());
    console.log(JSON.stringify({ ok: true, uploaded: result, rows: rows.length }, null, 2));
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
