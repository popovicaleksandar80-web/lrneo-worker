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

// ─── Fetch connected users from the app ───────────────────────────────────────

async function fetchUsersFromApp() {
  const ingestUrl = required('LR_APP_INGEST_URL');
  const token     = required('LR_APP_INGEST_TOKEN');
  const response  = await fetch(ingestUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body:    JSON.stringify({ action: 'lrneo.worker_get_users', token }),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  if (!response.ok || !data.ok) throw new Error(`worker_get_users failed: ${text.slice(0, 400)}`);
  return Array.isArray(data.users) ? data.users : [];
}

// ─── Cookie popup ─────────────────────────────────────────────────────────────

async function dismissCookiePopup(page) {
  const btn = page.locator('button:has-text("Összes süti elfogadása"), button:has-text("Accept all"), button:has-text("Elfogad")').first();
  if (await btn.count()) {
    await btn.click().catch(() => {});
    await page.waitForTimeout(1000);
  }
}

// ─── Login ────────────────────────────────────────────────────────────────────

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
  await page.waitForLoadState('networkidle', { timeout: 30000 }).catch(() => {});
}

// ─── Extract rows ─────────────────────────────────────────────────────────────

async function extractAllRows(page) {
  const result = await page.evaluate(() => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

    const allRows = [];
    for (const table of Array.from(document.querySelectorAll('table'))) {
      for (const tr of Array.from(table.querySelectorAll('tr'))) {
        const cells = Array.from(tr.children).map(cell => clean(cell.textContent));
        if (cells.some(Boolean)) allRows.push(cells);
      }
    }

    for (const row of Array.from(document.querySelectorAll('[role="row"], .ag-row, .mat-row, .datatable-row'))) {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], [role="columnheader"], .ag-cell, .mat-cell, .datatable-body-cell'))
        .map(cell => clean(cell.textContent));
      if (cells.some(Boolean)) allRows.push(cells);
    }

    if (allRows.filter(r => r.some(c => /^(HU|DE)\d{6,}$/.test(c))).length === 0) {
      const seen = new Set();
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const t = clean(el.textContent);
        if (!/^(HU|DE)\d{6,}$/.test(t)) continue;
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          if (seen.has(parent)) break;
          if (parent.children.length >= 3) {
            seen.add(parent);
            const cells = Array.from(parent.children).map(c => clean(c.textContent));
            if (cells.some(Boolean)) allRows.push(cells);
            break;
          }
          parent = parent.parentElement;
        }
      }
    }

    return {
      rows:       allRows,
      tableCount: document.querySelectorAll('table').length,
      hasHU:      /HU\d{6}/.test(document.body.textContent || ''),
    };
  });

  console.log(`  [extract] tables=${result.tableCount} hasHU=${result.hasHU} rows=${result.rows.length}`);
  return result.rows;
}

function usefulRows(rows) {
  return rows.filter(row => /HU\d{6,}|DE\d{6,}|PSZ|Összpont|Osszpont|Név|Nev/.test(row.join(' ')));
}

function partnerCount(rows) {
  return rows.filter(row => row.some(cell => /^(HU|DE)\d{6,}$/.test(clean(cell)))).length;
}

function cleanAndDedup(rows) {
  let pszCol = 0;
  const headerRow = rows.find(row => row.some(cell => cell === 'PSZ'));
  if (headerRow) {
    const idx = headerRow.findIndex(cell => cell === 'PSZ');
    if (idx >= 0) pszCol = idx;
  }
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    const sliced = pszCol > 0 ? row.slice(pszCol) : row;
    const key = sliced.join('|');
    if (!seen.has(key) && sliced.some(Boolean)) {
      seen.add(key);
      result.push(sliced);
    }
  }
  return result;
}

async function waitForAlineRows(page) {
  let best = [];
  const until = Date.now() + 90000;
  while (Date.now() < until) {
    await dismissCookiePopup(page);
    const rows = usefulRows(await extractAllRows(page));
    if (rows.length > best.length) best = rows;
    const pc = partnerCount(rows);
    console.log(`  [poll] useful=${rows.length} partners=${pc}`);
    if (best.length > 0 && rows.length === best.length) return best;
    await page.waitForTimeout(2000);
  }
  console.log(`  [poll] returning best=${best.length} rows`);
  return best;
}
    await page.waitForTimeout(2000);
  }
  throw new Error(`A-line table did not fully load. Partners found: ${partnerCount(best)}`);
}
    await page.waitForTimeout(2000);
  }
  throw new Error(`A-line table did not fully load. Partners found: ${partnerCount(best)}`);
}
    await page.waitForTimeout(2000);
  }
  throw new Error(`A-line table did not fully load. Partners found: ${partnerCount(best)}`);
}

// ─── Post snapshot ────────────────────────────────────────────────────────────

async function postSnapshot(rows, pageUrl, username) {
  const ingestUrl = required('LR_APP_INGEST_URL');
  const token     = required('LR_APP_INGEST_TOKEN');
  const response  = await fetch(ingestUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:     'lrneo.ingest_snapshot',
      token,
      username,
      date:       todayIso(),
      url:        pageUrl,
      fetched_at: new Date().toISOString(),
      rows,
    }),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  if (!response.ok || data.ok === false) {
    throw new Error(`Ingest failed: HTTP ${response.status} ${text}`);
  }
  return data;
}

// ─── Scrape one user ──────────────────────────────────────────────────────────

async function scrapeUser(headless, username, email, password) {
  console.log(`\n[user: ${username}] Starting...`);
  const browser = await chromium.launch({ headless, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'hu-HU' });
    const page    = await context.newPage();

    await page.goto('https://neo.lrworld.com/a-line', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await loginIfNeeded(page, email, password);
    await page.goto('https://neo.lrworld.com/a-line', { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 60000 }).catch(() => {});
    await page.waitForTimeout(3000);
    await dismissCookiePopup(page);

    const rawRows = await waitForAlineRows(page);
    const rows    = cleanAndDedup(rawRows);
    const result  = await postSnapshot(rows, page.url(), username);

    console.log(`[user: ${username}] ✓ rows=${rows.length} date=${result.date || todayIso()}`);
    return { ok: true, rows: rows.length };
  } finally {
    await browser.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const headless = env('LRNEO_HEADLESS', 'true') !== 'false';

  console.log('[worker] Fetching connected users...');
  const users = await fetchUsersFromApp();
  console.log(`[worker] Found ${users.length} connected user(s)`);

  if (!users.length) {
    console.log(JSON.stringify({ ok: false, error: 'no_users_connected', hint: 'Users must connect their LR Neo account in the app.' }));
    process.exit(0);
  }

  const results = [];
  for (const user of users) {
    try {
      const r = await scrapeUser(headless, user.username, user.email, user.password);
      results.push({ username: user.username, ...r });
    } catch (err) {
      const msg = err && err.message ? err.message : String(err);
      console.error(`[user: ${user.username}] ✗ ${msg}`);
      results.push({ username: user.username, ok: false, error: msg });
    }
  }

  const success = results.filter(r => r.ok).length;
  console.log(`\n[worker] Done. ${success}/${users.length} users scraped successfully.`);
  console.log(JSON.stringify({ ok: true, results }));
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
