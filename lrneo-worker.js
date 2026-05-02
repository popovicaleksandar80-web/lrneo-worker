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

// ─── Grace period: capture previous month's final data (days 1-10) ────────────

const GRACE_DAYS = parseInt(env('LRNEO_GRACE_DAYS', '10'), 10);
const CAPTURE_PREV_MONTH = env('LRNEO_CAPTURE_PREV_MONTH', 'true') !== 'false';

function isGracePeriod() {
  return new Date().getDate() <= GRACE_DAYS;
}

// Last day of the previous month — e.g. when called in May → "2026-04-30"
function prevMonthLastDay() {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), 0).toISOString().slice(0, 10);
}

// Hungarian month names shown in LR Neo date display
const HU_MONTHS = ['január','február','március','április','május','június','július','augusztus','szeptember','október','november','december'];

async function saveDebugScreenshot(page, name) {
  await page.screenshot({ path: name, fullPage: true }).catch(() => {});
}

async function visibleMonthText(page) {
  return page.evaluate((months) => {
    const values = [];
    for (const el of Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"], span, div, p'))) {
      const text = String(el.value || el.textContent || '').replace(/\s+/g, ' ').trim();
      if (!text || !/20\d\d/.test(text)) continue;
      if (months.some((m) => text.toLowerCase().includes(m))) values.push(text);
    }
    return values.slice(0, 5).join(' | ');
  }, HU_MONTHS).catch(() => '');
}

// Click the "previous month" arrow in LR Neo a-line view.
// From the screenshot: top-right area shows  [május 2026] [📅] [<]
// The < button is a rounded button immediately to the RIGHT of the date input.
async function clickPrevMonth(page) {
  console.log('  [prev-month] searching for previous-month button...');

  // ── Strategy 1: find the month text input/display, then get the next sibling button ──
  // LR Neo shows e.g. "május 2026" in a text field, < button is right next to it
  const monthPattern = new RegExp(HU_MONTHS.join('|'), 'i');
  const dateInputs = await page.locator('input[type="text"], input:not([type]), [class*="date"] input, [class*="period"] input').all();
  for (const inp of dateInputs) {
    const val = await inp.inputValue().catch(() => '');
    if (monthPattern.test(val)) {
      const clickedRightSibling = await inp.evaluate((input) => {
        const inputRect = input.getBoundingClientRect();
        const buttons = Array.from(document.querySelectorAll('button'))
          .map((btn) => ({ btn, r: btn.getBoundingClientRect() }))
          .filter((item) => item.r.width > 8 && item.r.height > 8)
          .filter((item) => Math.abs((item.r.top + item.r.height / 2) - (inputRect.top + inputRect.height / 2)) < 35)
          .filter((item) => item.r.left >= inputRect.right - 4 && item.r.left <= inputRect.right + 120)
          .sort((a, b) => a.r.left - b.r.left);
        if (buttons.length) {
          buttons[buttons.length - 1].btn.click();
          return true;
        }
        return false;
      }).catch(() => false);
      if (clickedRightSibling) {
        console.log(`  [prev-month] clicked rightmost button beside month input: "${val}"`);
        await page.waitForTimeout(3000);
        return true;
      }
    }
  }

  // ── Strategy 2: evaluate in browser — find button right of month text ──
  const clicked = await page.evaluate((months) => {
    // Find any element that shows the month name + year
    const allElements = Array.from(document.querySelectorAll('input, span, div, p'));
    for (const el of allElements) {
      const text = (el.value || el.textContent || '').trim();
      const hasMonth = months.some(m => text.toLowerCase().includes(m));
      const hasYear  = /20\d\d/.test(text);
      if (!hasMonth || !hasYear) continue;

      // Walk up to find a container that also has buttons
      let node = el;
      for (let i = 0; i < 6; i++) {
        node = node.parentElement;
        if (!node) break;
        const btns = Array.from(node.querySelectorAll('button'));
        if (btns.length >= 1) {
          // Get the button AFTER the month element (or last button = prev arrow on right)
          const lastBtn = btns[btns.length - 1];
          lastBtn.click();
          return true;
        }
      }
    }
    return false;
  }, HU_MONTHS);

  if (clicked) {
    console.log('  [prev-month] found via browser evaluate (month text sibling)');
    await page.waitForTimeout(3000);
    return true;
  }

  // ── Strategy 3: aria-label ──
  for (const label of ['previous', 'előző', 'elöző', 'prev', 'back', 'left', 'vissza', 'prior']) {
    const btn = page.locator(`button[aria-label*="${label}" i]`).first();
    if (await btn.count() > 0) {
      console.log(`  [prev-month] found via aria-label: ${label}`);
      await btn.click();
      await page.waitForTimeout(3000);
      return true;
    }
  }

  // ── Strategy 4: SVG path that looks like a left chevron (d="M15 18l-6-6 6-6" etc.) ──
  const svgClicked = await page.evaluate(() => {
    const svgs = Array.from(document.querySelectorAll('button svg, button i, button span[class*="icon"]'));
    for (const svg of svgs) {
      const txt = (svg.textContent || svg.getAttribute('class') || svg.getAttribute('d') || '').toLowerCase();
      if (/left|prev|back|chevron.?l|arrow.?l/.test(txt)) {
        const btn = svg.closest('button');
        if (btn) { btn.click(); return true; }
      }
      // Check SVG paths for left-pointing chevron shape
      const paths = svg.querySelectorAll('path, polyline');
      for (const p of paths) {
        const d = (p.getAttribute('d') || '').replace(/\s+/g, '');
        // Common chevron-left SVG paths
        if (/M15[,\s]18[Ll]-6/.test(d) || /M9[,\s]18[Ll]6-6/.test(d) || /M\d+\s\d+L\d+\s\d+L\d+\s\d+/.test(d)) {
          const btn = p.closest('button');
          if (btn) { btn.click(); return true; }
        }
      }
    }
    return false;
  });

  if (svgClicked) {
    console.log('  [prev-month] found via SVG path analysis');
    await page.waitForTimeout(3000);
    return true;
  }

  // ── Strategy 5: position-based fallback — rightmost button in top 120px strip ──
  // From screenshot: < button is at top-right of page
  const posClicked = await page.evaluate(() => {
    const buttons = Array.from(document.querySelectorAll('button'));
    // Filter: visible, in top 120px, in right 30% of page
    const W = window.innerWidth;
    const candidates = buttons.filter(btn => {
      const r = btn.getBoundingClientRect();
      return r.top < 120 && r.right > W * 0.65 && r.width < 60 && r.height < 60 && r.width > 10;
    });
    // Sort right-to-left, take the leftmost of the right-side buttons (that's the < one)
    candidates.sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left);
    if (candidates.length >= 2) {
      // Second from right is the < button (rightmost is the filter/settings icon)
      candidates[candidates.length - 2].click();
      return true;
    }
    if (candidates.length === 1) {
      candidates[0].click();
      return true;
    }
    return false;
  });

  if (posClicked) {
    console.log('  [prev-month] found via position-based fallback (top-right area)');
    await page.waitForTimeout(3000);
    return true;
  }

  console.log('  [prev-month] ⚠ all strategies failed — no previous-month button found');
  return false;
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
    const cellText = (cell) => {
      const parts = [
        cell.innerText,
        cell.textContent,
        cell.value,
        cell.getAttribute && cell.getAttribute('title'),
        cell.getAttribute && cell.getAttribute('aria-label'),
        cell.getAttribute && cell.getAttribute('data-value'),
      ].filter(Boolean).map(clean);
      for (const child of Array.from(cell.querySelectorAll ? cell.querySelectorAll('[title], [aria-label], input') : [])) {
        const extra = clean(child.value || child.getAttribute('title') || child.getAttribute('aria-label') || child.textContent);
        if (extra) parts.push(extra);
      }
      return Array.from(new Set(parts)).join(' ').replace(/\s+/g, ' ').trim();
    };

    const allRows = [];
    for (const table of Array.from(document.querySelectorAll('table'))) {
      for (const tr of Array.from(table.querySelectorAll('tr'))) {
        const cells = Array.from(tr.children).map(cellText);
        if (cells.some(Boolean)) allRows.push(cells);
      }
    }

    for (const row of Array.from(document.querySelectorAll('[role="row"], .ag-row, .mat-row, .datatable-row'))) {
      const cells = Array.from(row.querySelectorAll('[role="gridcell"], [role="columnheader"], .ag-cell, .mat-cell, .datatable-body-cell'))
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(cellText);
      if (cells.some(Boolean)) allRows.push(cells);
    }

    if (allRows.filter(r => r.some(c => /^(HU|DE)\d{4,}/.test(c))).length === 0) {
      const seen = new Set();
      for (const el of Array.from(document.querySelectorAll('*'))) {
        const t = cellText(el);
        if (!/^(HU|DE)\d{4,}/.test(t)) continue;
        let parent = el.parentElement;
        while (parent && parent !== document.body) {
          if (seen.has(parent)) break;
          if (parent.children.length >= 3) {
            seen.add(parent);
            const cells = Array.from(parent.children).map(cellText);
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
  return rows.filter(row => row.some(cell => /^(HU|DE)\d{4,}/.test(clean(cell)))).length;
}

function cleanAndDedup(rows) {
  let pszCol = 0;
  const headerRow = rows.find(row => row.some(cell => clean(cell) === 'PSZ'));
  if (headerRow) {
    const idx = headerRow.findIndex(cell => clean(cell) === 'PSZ');
    if (idx >= 0) pszCol = idx;
  }
  const seen = new Set();
  const result = [];
  for (const row of rows) {
    let start = -1;
    for (let i = 0; i < row.length; i++) {
      const cell = clean(row[i]);
      if (cell === 'PSZ' || /^(HU|DE)\d{4,}/.test(cell)) { start = i; break; }
    }
    const sliced = start >= 0 ? row.slice(start) : (pszCol > 0 ? row.slice(pszCol) : row);
    const key = sliced.map(clean).join('|');
    if (!seen.has(key) && sliced.some(Boolean)) {
      seen.add(key);
      result.push(sliced);
    }
  }
  console.log(`  [clean] input=${rows.length} output=${result.length} partners=${partnerCount(result)}`);
  result.slice(0, 5).forEach((row, i) => console.log(`  [clean:${i}] ${row.slice(0, 6).join(' | ')}`));
  return result;
}

function rowSignature(rows) {
  return rows.map(row => row.map(clean).join('|')).join('\n');
}

async function pageHasMonth(page, monthName) {
  return page.evaluate((month) => {
    const needle = String(month || '').toLowerCase();
    const bodyText = (document.body && document.body.textContent ? document.body.textContent : '').toLowerCase();
    if (bodyText.includes(needle)) return true;
    for (const el of Array.from(document.querySelectorAll('input, textarea, [contenteditable="true"]'))) {
      const value = String(el.value || el.textContent || '').toLowerCase();
      if (value.includes(needle)) return true;
    }
    return false;
  }, monthName).catch(() => false);
}

async function waitForAlineRows(page, opts = {}) {
  let best = [];
  let bestAllowed = [];
  let lastSig = '';
  let stableReads = 0;
  const until = Date.now() + (opts.timeoutMs || 45000);
  const avoidSignature = opts.avoidSignature || '';
  const minPartners = Number(opts.minPartners || 0);
  while (Date.now() < until) {
    await dismissCookiePopup(page);
    const rows = usefulRows(await extractAllRows(page));
    if (rows.length > best.length) best = rows;
    const pc = partnerCount(rows);
    const sig = rowSignature(rows);
    const allowed = rows.length > 0 && sig !== avoidSignature && pc >= minPartners;
    if (allowed && rows.length > bestAllowed.length) bestAllowed = rows;
    if (allowed && sig === lastSig) {
      stableReads += 1;
    } else {
      stableReads = allowed ? 1 : 0;
      lastSig = sig;
    }
    console.log(`  [poll] useful=${rows.length} partners=${pc} allowed=${allowed ? 'yes' : 'no'} stable=${stableReads}/2`);
    if (stableReads >= 2) return rows;
    await page.waitForTimeout(2000);
  }
  console.log(`  [poll] returning bestAllowed=${bestAllowed.length} best=${best.length} rows after timeout`);
  return bestAllowed.length ? bestAllowed : best;
}

// ─── Post snapshot ────────────────────────────────────────────────────────────

async function postSnapshot(rows, pageUrl, username, snapDate) {
  const ingestUrl = required('LR_APP_INGEST_URL');
  const token     = required('LR_APP_INGEST_TOKEN');
  const response  = await fetch(ingestUrl, {
    method:  'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action:     'lrneo.ingest_snapshot',
      token,
      username,
      date:       snapDate || todayIso(),
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
  console.log(`  [ingest] date=${snapDate || todayIso()} rows=${rows.length} partners=${partnerCount(rows)} response=${text.slice(0, 300)}`);
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
    await saveDebugScreenshot(page, 'debug-aline-current.png');

    // ── Scrape current month ──────────────────────────────────────────────────
    const rawRows = await waitForAlineRows(page);
    const rows    = cleanAndDedup(rawRows);
    const currentSig = rowSignature(rawRows);
    const currentPartners = partnerCount(rawRows);
    const result  = await postSnapshot(rows, page.url(), username, todayIso());
    console.log(`[user: ${username}] ✓ rows=${rows.length} date=${result.date || todayIso()}`);

    // ── Grace period: also capture previous month's final data ───────────────
    // Runs every day 1-10 of the month. LR Neo defaults to new month,
    // but previous month points may still change until ~day 10.
    // We click ← to go back one month, scrape, and overwrite snap_date=last-day-of-prev-month.
    if (CAPTURE_PREV_MONTH || isGracePeriod()) {
      const prevDate = prevMonthLastDay();
      const today    = new Date().getDate();
      console.log(`[user: ${username}] Previous-month capture (day ${today}/${GRACE_DAYS}) — capturing ${prevDate}...`);
      console.log(`  [prev-month] visible month before click: ${await visibleMonthText(page)}`);

      const moved = await clickPrevMonth(page);
      if (moved) {
        // Verify the month actually changed — page should now show previous month name
        const prevMonthIdx  = new Date().getMonth() - 1; // 0-based, may be -1 in January
        const prevMonthName = HU_MONTHS[(prevMonthIdx + 12) % 12];
        await page.waitForTimeout(1500);
        let monthChanged = false;
        for (let i = 0; i < 10; i++) {
          console.log(`  [prev-month] visible month check ${i + 1}: ${await visibleMonthText(page)}`);
          monthChanged = await pageHasMonth(page, prevMonthName);
          if (monthChanged) break;
          await page.waitForTimeout(1000);
        }
        console.log(`  [prev-month] month verification: looking for "${prevMonthName}" → ${monthChanged ? '✓ found' : '⚠ not found in page text'}`);

        await saveDebugScreenshot(page, 'debug-aline-prev.png');
        const prevRawRows = await waitForAlineRows(page, {
          avoidSignature: currentSig,
          minPartners: Math.max(1, currentPartners),
          timeoutMs: 70000,
        });
        const prevRows    = cleanAndDedup(prevRawRows);
        const prevPartners = partnerCount(prevRows);
        if (!monthChanged && prevPartners <= currentPartners) {
          await saveDebugScreenshot(page, 'debug-aline-prev-not-verified.png');
          console.log(`[user: ${username}] ⚠ Previous-month screen/rows were not verified — skipping ${prevDate} snapshot to avoid overwriting it with current-month data`);
          return { ok: true, rows: rows.length, prevSkipped: true };
        }
        await postSnapshot(prevRows, page.url(), username, prevDate);
        console.log(`[user: ${username}] ✓ prev-month rows=${prevRows.length} partners=${prevPartners} saved as ${prevDate} (overwrite)${monthChanged ? '' : ' [accepted by changed rows]'}`);
      } else {
        console.log(`[user: ${username}] ⚠ Could not navigate to previous month — skipping grace-period snapshot`);
      }
    }

    return { ok: true, rows: rows.length };
  } finally {
    await browser.close();
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  const headless = env('LRNEO_HEADLESS', 'true') !== 'false';

  // Multi-user mode: fetch all connected users from the app
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
  if (success === 0) {
    process.exit(1);
  }
}

main().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
