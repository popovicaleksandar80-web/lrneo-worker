import { chromium } from 'playwright';

const env = (name, fallback = '') => process.env[name] || fallback;
const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

function cookieHeaderToCookies(header) {
  return String(header || '')
    .split(';')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const eq = part.indexOf('=');
      if (eq < 1) return null;
      return {
        name: part.slice(0, eq),
        value: part.slice(eq + 1),
        domain: 'neo.lrworld.com',
        path: '/',
        secure: true,
        httpOnly: false,
        sameSite: 'Lax',
      };
    })
    .filter(Boolean);
}

function required(name) {
  const value = env(name);
  if (!value) throw new Error(`Missing environment variable: ${name}`);
  return value;
}

async function appPost(action, payload = {}) {
  const response = await fetch(required('LR_APP_INGEST_URL'), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ action, token: required('LR_APP_INGEST_TOKEN'), ...payload }),
  });
  const text = await response.text();
  let data = {};
  try { data = JSON.parse(text); } catch (_) {}
  if (!response.ok || !data.ok) throw new Error(`${action} failed: ${text.slice(0, 500)}`);
  return data;
}

async function fetchUsers() {
  let users = (await appPost('lrneo.worker_get_users')).users || [];
  const only = clean(env('LRNEO_ONLY_USERNAME', '')).toLowerCase();
  if (only) users = users.filter((user) => clean(user.username).toLowerCase() === only);
  return users;
}

async function fetchPartners(username) {
  const data = await appPost('lrneo.worker_get_team_partners', { username });
  return Array.isArray(data.partners) ? data.partners : [];
}

async function reportWorkerFailure(username, error) {
  const message = clean(error && error.message ? error.message : error).slice(0, 180) || 'worker_failed';
  await appPost('lrneo.worker_report_failure', { username, context: 'team', error: message }).catch(() => {});
}

async function dismissCookiePopup(page) {
  const button = page.locator('button:has-text("Accept all"), button:has-text("Elfogad")').first();
  if (await button.count().catch(() => 0)) {
    await button.click().catch(() => {});
    await page.waitForTimeout(800);
  }
}

async function openAline(page, user) {
  await page.goto('https://neo.lrworld.com/a-line', { waitUntil: 'domcontentloaded', timeout: 60000 });
  const body = await page.locator('body').innerText({ timeout: 15000 }).catch(() => '');
  const passwordVisible = await page.locator('input[name="password"], input#password, input[type="password"]').first().isVisible().catch(() => false);
  if (passwordVisible || !/Sales Report|PSZ|Osszpont|Partner keres/i.test(body)) {
    const username = page.locator('input[name="username"], input#username, input[type="email"], input[name="email"]').first();
    const password = page.locator('input[name="password"], input#password, input[type="password"]').first();
    await username.waitFor({ state: 'visible', timeout: 30000 });
    await username.fill(user.email);
    await password.fill(user.password);
    const submit = page.locator('button[type="submit"], input[type="submit"], button:has-text("Login"), button:has-text("Prijava")').first();
    if (await submit.count().catch(() => 0)) {
      await Promise.all([
        page.waitForLoadState('domcontentloaded').catch(() => {}),
        submit.click(),
      ]);
    } else {
      await password.press('Enter');
    }
  }
  await page.goto('https://neo.lrworld.com/a-line', { waitUntil: 'domcontentloaded', timeout: 60000 });
  await page.waitForLoadState('networkidle', { timeout: 50000 }).catch(() => {});
  await page.waitForTimeout(2500);
  await dismissCookiePopup(page);
  const loginStillVisible = await page.locator('input[name="password"], input#password, input[type="password"]').first().isVisible().catch(() => false);
  if (loginStillVisible) throw new Error('lrneo_login_failed:login_form_still_visible');
}

async function findSearchInput(page) {
  const selectors = [
    'input[placeholder*="Partner"]',
    'input[placeholder*="Keres"]',
    'input[placeholder*="Search"]',
    'input[type="search"]',
    'input[type="text"]',
    'input:not([type])',
  ];
  for (const selector of selectors) {
    const input = page.locator(selector).first();
    if (await input.count().catch(() => 0)) {
      if (await input.isVisible().catch(() => false)) return input;
    }
  }
  throw new Error('search_input_not_found');
}

async function readPointsNearHu(page, lrId) {
  return page.evaluate((partnerId) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const exactId = clean(partnerId).toUpperCase();
    const escaped = exactId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const parsePoints = (value) => {
      const text = clean(value)
        .replace(new RegExp(escaped, 'gi'), ' ')
        .replace(/\b(HU|DE)\d+\b/gi, ' ');
      const matches = text.match(/-?\d[\d\s.,]*/g) || [];
      const values = [];
      for (const match of matches) {
        const normalized = match.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
        const number = Number(normalized);
        if (Number.isFinite(number) && number > -999999 && number < 999999) values.push(number);
      }
      return values.length ? values[values.length - 1] : null;
    };

    const nodes = [];
    for (const element of Array.from(document.querySelectorAll('tr, [role="row"], td, div, span, a, button, li'))) {
      const text = clean(element.innerText || element.textContent);
      if (!text.toUpperCase().includes(exactId)) continue;
      const row = element.closest && (element.closest('tr') || element.closest('[role="row"]'));
      if (row) nodes.push(row);
      let node = element;
      for (let depth = 0; node && depth < 6; depth += 1, node = node.parentElement) {
        const nodeText = clean(node.innerText || node.textContent);
        if (!nodeText || nodeText.length > 500 || !nodeText.toUpperCase().includes(exactId)) continue;
        const rect = node.getBoundingClientRect();
        if (rect.width >= 20 && rect.height >= 8) nodes.push(node);
      }
    }

    const candidates = [];
    for (const node of Array.from(new Set(nodes))) {
      const text = clean(node.innerText || node.textContent);
      const points = parsePoints(text);
      if (Number.isFinite(points)) candidates.push({ points, score: 1000 - text.length, text: text.slice(0, 160) });
    }
    candidates.sort((a, b) => b.score - a.score || b.points - a.points);
    return candidates.length
      ? { ok: true, total_points: candidates[0].points, debug: candidates.slice(0, 3) }
      : { ok: false, error: 'points_not_found_for_hu' };
  }, lrId);
}

async function readPointsFromHuRow(page, lrId) {
  return page.evaluate((partnerId) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const exactId = clean(partnerId).toUpperCase();
    const numberFromCell = (value) => {
      const text = clean(value)
        .replace(new RegExp(exactId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi'), ' ')
        .replace(/\b(HU|DE)\d+\b/gi, ' ')
        .replace(/\b20\d\d[-./]\d\d[-./]\d\d\b/g, ' ')
        .replace(/\b\d\d[-./]\d\d[-./]\d\d\b/g, ' ');
      const match = text.match(/-?\d[\d\s.,]*/);
      if (!match) return null;
      const normalized = match[0].replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
      const number = Number(normalized);
      return Number.isFinite(number) && number > -999999 && number < 999999 ? number : null;
    };
    const cellText = (cell) => clean(cell.innerText || cell.textContent || cell.value || '');
    const rowSelectors = 'tr, [role="row"], .ag-row, .mat-row, .datatable-row';
    const cellSelectors = 'td, th, [role="gridcell"], [role="columnheader"], .ag-cell, .mat-cell, .datatable-body-cell, div, span';
    const rows = Array.from(document.querySelectorAll(rowSelectors));

    for (const row of rows) {
      const rowText = cellText(row);
      if (!rowText.toUpperCase().includes(exactId)) continue;
      const rect = row.getBoundingClientRect();
      if (rect.width < 20 || rect.height < 8) continue;
      const cells = Array.from(row.querySelectorAll(cellSelectors))
        .filter((cell) => {
          const box = cell.getBoundingClientRect();
          return box.width > 4 && box.height > 4;
        })
        .sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left)
        .map(cellText)
        .filter(Boolean);
      const compact = [];
      for (const text of cells) {
        if (compact[compact.length - 1] !== text) compact.push(text);
      }
      const idIndex = compact.findIndex((text) => text.toUpperCase().includes(exactId));
      if (idIndex < 0) continue;
      for (let i = idIndex + 1; i < compact.length; i += 1) {
        const number = numberFromCell(compact[i]);
        if (Number.isFinite(number)) {
          return { ok: true, total_points: number, source: 'hu_row', debug: compact.slice(idIndex, idIndex + 8) };
        }
      }
    }
    return { ok: false, error: 'hu_row_points_not_found' };
  }, lrId);
}

async function readOsszpontFromContact(page, lrId) {
  return page.evaluate((partnerId) => {
    const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();
    const normalize = (value) => clean(value).normalize('NFD').replace(/[\u0300-\u036f]/g, '').toLowerCase();
    const exactId = clean(partnerId).toUpperCase();
    const bodyText = clean(document.body && document.body.innerText);
    if (!bodyText.toUpperCase().includes(exactId)) {
      return { ok: false, error: 'detail_hu_not_visible' };
    }
    const parseNumbers = (value) => {
      const text = clean(value)
        .replace(/\b(HU|DE)\d+\b/gi, ' ')
        .replace(/\b20\d\d[-./]\d\d[-./]\d\d\b/g, ' ');
      const values = [];
      for (const match of text.match(/-?\d[\d\s.,]*/g) || []) {
        const normalized = match.replace(/\s/g, '').replace(/\.(?=\d{3}(\D|$))/g, '').replace(',', '.');
        const number = Number(normalized);
        if (Number.isFinite(number) && number > -999999 && number < 999999) values.push(number);
      }
      return values;
    };
    const hasOsszpont = (value) => /osz\s*pont|ossz\s*pont|osszpont|osszes\s*pont|total\s*points?/i.test(normalize(value));
    const candidates = [];

    for (const element of Array.from(document.querySelectorAll('td, th, div, span, strong, p, li, label'))) {
      const text = clean(element.innerText || element.textContent);
      if (!text || text.length > 250 || !hasOsszpont(text)) continue;
      const sameTextNumbers = parseNumbers(text);
      for (const number of sameTextNumbers) {
        candidates.push({ points: number, score: 300, text: text.slice(0, 160) });
      }

      const parent = element.parentElement;
      if (parent) {
        const siblings = Array.from(parent.children);
        const index = siblings.indexOf(element);
        for (let i = Math.max(0, index); i < Math.min(siblings.length, index + 4); i += 1) {
          const siblingText = clean(siblings[i].innerText || siblings[i].textContent);
          if (!siblingText || siblingText.length > 180) continue;
          for (const number of parseNumbers(siblingText)) {
            candidates.push({ points: number, score: 250 - Math.abs(i - index), text: siblingText.slice(0, 160) });
          }
        }
        const parentText = clean(parent.innerText || parent.textContent);
        if (parentText.length <= 500 && hasOsszpont(parentText)) {
          for (const number of parseNumbers(parentText)) {
            candidates.push({ points: number, score: 200, text: parentText.slice(0, 160) });
          }
        }
      }
    }

    candidates.sort((a, b) => b.score - a.score || b.points - a.points);
    return candidates.length
      ? { ok: true, total_points: candidates[0].points, source: 'osszpont_label', debug: candidates.slice(0, 5) }
      : { ok: false, error: 'osszpont_not_found' };
  }, lrId);
}

async function readPartner(page, partner) {
  const lrId = clean(partner.lr_partner_id).toUpperCase();
  if (!lrId) return { ...partner, ok: false, error: 'missing_lr_partner_id' };

  await page.goto('https://neo.lrworld.com/a-line', { waitUntil: 'domcontentloaded', timeout: 60000 }).catch(() => {});
  await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});
  await dismissCookiePopup(page);

  const input = await findSearchInput(page);
  await input.click({ timeout: 10000 }).catch(() => {});
  await input.fill('');
  await input.fill(lrId);
  await page.waitForTimeout(2200);
  await page.screenshot({ path: `debug-team-${lrId}-search.png`, fullPage: true }).catch(() => {});

  const result = page.getByText(lrId, { exact: false }).last();
  if (await result.count().catch(() => 0)) {
    await Promise.all([
      page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {}),
      result.click({ timeout: 12000 }).catch(() => {}),
    ]);
    await page.waitForTimeout(2200);
    await page.screenshot({ path: `debug-team-${lrId}-detail.png`, fullPage: true }).catch(() => {});
  }

  let points = await readPointsFromHuRow(page, lrId);
  if (!points.ok) points = await readOsszpontFromContact(page, lrId);
  if (!points.ok) points = await readPointsNearHu(page, lrId);

  if (!points.ok || !Number.isFinite(Number(points.total_points))) {
    return { ...partner, ok: false, error: points.error || 'points_not_found' };
  }
  return { ...partner, ok: true, total_points: points.total_points };
}

async function runUser(user) {
  const partners = await fetchPartners(user.username);
  console.log(`[team:${user.username}] partners=${partners.length}`);
  if (!partners.length) return { ok: true, checked: 0, found: 0, saved: 0 };

  const browser = await chromium.launch({
    headless: env('LRNEO_HEADLESS', 'true') !== 'false',
    args: ['--no-sandbox', '--disable-dev-shm-usage'],
  });
  const results = [];
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, locale: 'hu-HU' });
    const sessionCookies = cookieHeaderToCookies(user.cookies || '');
    if (sessionCookies.length) await context.addCookies(sessionCookies);
    const page = await context.newPage();
    await openAline(page, user);
    for (const partner of partners) {
      const lrId = clean(partner.lr_partner_id).toUpperCase();
      try {
        const result = await readPartner(page, partner);
        console.log(`[team:${user.username}] ${lrId} -> ${result.ok ? `${result.total_points} P` : result.error}`);
        results.push(result);
      } catch (error) {
        results.push({ ...partner, ok: false, error: error && error.message ? error.message : String(error) });
      }
    }
  } finally {
    await browser.close();
  }

  const successful = results.filter((result) => result.ok && Number.isFinite(Number(result.total_points)));
  const uniqueValues = new Set(successful.map((result) => Number(result.total_points)));
  if (successful.length >= 3 && uniqueValues.size === 1) {
    throw new Error(`suspicious_same_team_points: ${successful.length} partners all read as ${Array.from(uniqueValues)[0]} P`);
  }
  const saved = await appPost('lrneo.ingest_team_points', { username: user.username, results: successful });
  if (partners.length > 0 && Number(saved.saved || 0) === 0) {
    throw new Error(`team_points_saved_zero: checked=${partners.length} found=${successful.length}`);
  }
  return { ok: true, checked: partners.length, found: successful.length, saved: saved.saved || 0, results };
}

async function main() {
  const users = await fetchUsers();
  if (!users.length) {
    console.warn('[team] no_users_connected');
    console.log(JSON.stringify({ ok: true, warning: 'no_users_connected', results: [] }));
    return;
  }
  const results = [];
  for (const user of users) {
    try {
      results.push({ username: user.username, ...(await runUser(user)) });
    } catch (error) {
      const message = error && error.message ? error.message : String(error);
      console.error(`[team:${user.username}] ${message}`);
      results.push({ username: user.username, ok: false, error: message });
      await reportWorkerFailure(user.username, message);
    }
  }
  const savedTotal = results.reduce((sum, result) => sum + Number(result.saved || 0), 0);
  if (savedTotal <= 0) {
    console.warn('[team] finished_without_saved_points');
  }
  console.log(JSON.stringify({ ok: true, saved: savedTotal, results }));
  if (results.some((result) => !result.ok)) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error && error.stack ? error.stack : error);
  process.exit(1);
});

