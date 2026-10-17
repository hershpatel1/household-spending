// Regression tests for the household money app. Run before every push:
//   cd tests && npm install && npm test
// Each scenario loads index.html in headless Chromium with an in-memory Firebase and checks the outcome.
import { chromium } from 'playwright';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
const here = path.dirname(fileURLToPath(import.meta.url));
const mock = fs.readFileSync(path.join(here, 'firebase-mock.js'), 'utf8');
const html = fs.readFileSync(path.join(here, '..', 'index.html'), 'utf8');
const launch = process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : {};
let failures = 0;
const check = (name, ok, detail = '') => { console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + detail}`); if (!ok) failures++; };

async function scenario(name, isoTime, fn) {
  const browser = await chromium.launch(launch);
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, acceptDownloads: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await ctx.route('**/*', r => {
    const u = r.request().url();
    if (u.includes('gstatic.com/firebasejs')) return r.fulfill({ contentType: 'application/javascript', body: mock });
    if (u.startsWith('http://app.test')) return r.fulfill({ contentType: 'text/html', body: html });
    return r.abort(); // fonts etc.
  });
  page.on('dialog', d => d.accept(d.type() === 'prompt' ? 'Hersh' : undefined));
  await page.clock.install({ time: new Date(isoTime) });
  await page.goto('http://app.test/'); await page.waitForTimeout(600);
  const h = {
    page,
    store: () => page.evaluate(() => window.__store),
    fill: async (sel, v) => { await page.fill(sel, String(v)); await page.dispatchEvent(sel, 'change'); await page.waitForTimeout(100); },
    openAll: () => page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)),
    go: async v => { await page.click(`nav button[data-go=${v}]`); await page.waitForTimeout(150); },
    reloadAt: async iso => { await page.evaluate(() => localStorage.setItem('__mock', JSON.stringify(window.__store))); await page.clock.setFixedTime(new Date(iso)); await page.reload(); await page.waitForTimeout(600); },
  };
  try { await fn(h); } catch (e) { check(name + ' (ran without crashing)', false, e.message.split('\n')[0]); }
  check(name + ': no script errors', errors.length === 0, errors.join(' | '));
  await browser.close();
}

await scenario('Seed and Home', '2026-10-17T21:30:00', async ({ page, store }) => {
  const s = await store();
  check('plan, actions and opening are seeded', Object.keys(s.plan_items || {}).length > 25 && !!s.v2meta?.opening && !!s.v2meta?.seed);
  check('opening is a set-up month', s.v2meta.opening.setup === true);
  check('Home shows the set-up card', (await page.textContent('#v-home')).includes('opening balances'));
});

await scenario('Log a spend and a transfer; card repayments refused', '2026-10-20T12:00:00', async ({ page, store, go }) => {
  await go('log'); await page.fill('#fValue', '12.34'); await page.fill('#fRetailer', 'Waitrose'); await page.click('#submitBtn'); await page.waitForTimeout(100);
  await page.click('#typeSeg button[data-t=transfer]'); await page.selectOption('#fAccount', 'Hersh Debit');
  const toOpts = await page.$$eval('#fTo option', o => o.filter(x => !x.hidden).map(x => x.value));
  check('own card is not offered as a transfer destination', !toOpts.includes('Hersh Credit'));
  check('pension destination is labelled', (await page.$$eval('#fTo option', o => o.map(x => x.textContent))).includes('Hersh personal pension'));
  const tx = Object.values((await store()).transactions);
  check('spend saved', tx.some(t => t.retailer === 'Waitrose' && t.type === 'spend' && t.value === 12.34));
  await go('feed'); check('feed shows it', (await page.textContent('#feed')).includes('Waitrose'));
});

await scenario('Set-up month, pending item logged afterwards, then a full month-end that ties out', '2026-11-02T19:00:00', async ({ page, store, fill, openAll, go, reloadAt }) => {
  await go('me'); await openAll();
  await fill('[data-mebal="Joint"]', 3333.52); await fill('[data-mebal="Hersh Debit"]', 24500); await fill('[data-mebal="Hersh Credit"]', 812.40); await fill('[data-mebal="Sonali Debit"]', 7400); await fill('[data-mebal="Sonali Credit"]', 120);
  await page.click('#meSetup'); await page.waitForTimeout(400);
  // something still pending on the set-up day is logged, dated the day after
  await go('log'); await page.fill('#fDate', '2026-11-03'); await page.selectOption('#fPot', 'householdInvestment'); await page.selectOption('#fAccount', 'Joint'); await page.fill('#fValue', '243.08'); await page.fill('#fRetailer', 'Water (pending at set-up)'); await page.click('#submitBtn'); await page.waitForTimeout(150);
  let s = await store();
  check('opening balances set', s.v2meta.opening.setup === false && s.v2meta.opening.asAt === '2026-11-02');
  check('plan re-saved from the opening', String(s.v2meta.baseline?.name || '').startsWith('Plan from opening balances'));
  await reloadAt('2026-12-03T19:00:00'); await go('me'); await openAll();
  const jointText = await page.textContent('[data-fold$="-u-joint"]');
  check('pending item logged after set-up is counted in the first month-end', /Logged transactions \(1\)/.test(jointText) && jointText.includes('243.08'));
  // tick everything, enter estimate actuals and payslips, then enter balances equal to expected
  await page.click('#meTickAll'); await page.waitForTimeout(150); await openAll();
  for (const k of await page.$$eval('[data-meest]', e => e.map(x => x.dataset.meest))) { await fill(`[data-meest="${k}"]`, k.startsWith('p-h-pay') ? 6440 : 300); }
  await openAll(); await fill('[data-meps=ytd][data-who=hersh]', 83091.79); await fill('[data-meps=period][data-who=hersh]', 9583.33); await fill('[data-meps=net][data-who=hersh]', 6440);
  await openAll();
  const exp = await page.evaluate(() => ['joint', 'hersh', 'sonali'].map(k => parseFloat(document.querySelector(`[data-fold$="-u-${k}"] summary small`).innerText.replace(/[^0-9.-]/g, ''))));
  await fill('[data-mebal="Joint"]', exp[0].toFixed(2)); await fill('[data-mebal="Hersh Credit"]', 0); await fill('[data-mebal="Hersh Debit"]', exp[1].toFixed(2)); await fill('[data-mebal="Sonali Credit"]', 0); await fill('[data-mebal="Sonali Debit"]', exp[2].toFixed(2));
  const closeBtn = await page.$('#meClose');
  check('month can close once every account ties out', closeBtn && !(await closeBtn.isDisabled()));
  await page.click('#meClose'); await page.waitForTimeout(300);
  s = await store();
  check('November closed', s.month_ends['2026-11']?.status === 'closed');
});

await scenario('Set-up mid-October: the October month-end runs from that day', '2026-10-21T19:00:00', async ({ page, store, fill, openAll, go, reloadAt }) => {
  await go('me'); await openAll();
  for (const [k, v] of [['Joint', 2735.63], ['Hersh Debit', 22911.12], ['Hersh Credit', 1690.85], ['Sonali Debit', 7815.24], ['Sonali Credit', 251.82]]) await fill(`[data-mebal="${k}"]`, v);
  await page.click('#meSetup'); await page.waitForTimeout(400);
  const s = await store();
  check('set-up filed under September, no stray October draft', s.month_ends['2026-09']?.setup === true && !s.month_ends['2026-10']);
  await reloadAt('2026-11-03T19:00:00'); await go('me');
  const head = await page.textContent('#v-me');
  check('next month-end is October, from 21 Oct', head.includes('October 2026') && head.includes('21 Oct 2026'));
});

await scenario('Weekend shift and "Not gone yet" carried to next month', '2026-10-22T19:00:00', async ({ page, store, fill, openAll, go, reloadAt }) => {
  await go('me'); await openAll();
  for (const [k, v] of [['Joint', 2735.63], ['Hersh Debit', 22911.12], ['Hersh Credit', 1690.85], ['Sonali Debit', 7815.24], ['Sonali Credit', 251.82]]) await fill(`[data-mebal="${k}"]`, v);
  await page.click('#meSetup'); await page.waitForTimeout(400);
  await reloadAt('2026-11-04T19:00:00'); await go('me'); await openAll();
  await fill('#meRun', '2026-11-04'); await openAll();
  const txt = await page.textContent('#v-me');
  check('mortgage due Sun 1 Nov is expected Mon 2 Nov', /Mortgage \(Nationwide\)\s*2 Nov/.test(txt));
  const key = (await page.$$eval('[data-menotyet]', b => b.map(x => x.dataset.menotyet))).find(k => k.startsWith('p-h-spotify'));
  await page.click(`[data-menotyet="${key}"]`); await page.waitForTimeout(150);
  await page.click('#meTickAll'); await page.waitForTimeout(150); await openAll();
  for (const k of await page.$$eval('[data-meest]', e => e.map(x => x.dataset.meest))) await fill(`[data-meest="${k}"]`, 300);
  await openAll(); await fill('[data-meps=ytd][data-who=hersh]', 73508.46); await fill('[data-meps=period][data-who=hersh]', 9583.33); await fill('[data-meps=net][data-who=hersh]', 6440); await openAll();
  const exp = await page.evaluate(() => ['joint', 'hersh', 'sonali'].map(k => parseFloat(document.querySelector(`[data-fold$="-u-${k}"] summary small`).innerText.replace(/[^0-9.-]/g, ''))));
  await fill('[data-mebal="Joint"]', exp[0].toFixed(2)); await fill('[data-mebal="Hersh Credit"]', 0); await fill('[data-mebal="Hersh Debit"]', exp[1].toFixed(2)); await fill('[data-mebal="Sonali Credit"]', 0); await fill('[data-mebal="Sonali Debit"]', exp[2].toFixed(2));
  await page.click('#meClose'); await page.waitForTimeout(300);
  check('October closed with Spotify not gone yet', (await store()).month_ends['2026-10']?.status === 'closed');
  await reloadAt('2026-12-04T19:00:00'); await go('me'); await openAll();
  check('Spotify carried into the November month-end', (await page.textContent('#v-me')).includes('Spotify'));
  const hx = await page.textContent('[data-fold$="acc-Hersh Debit"]');
  check('carried item is labelled', /carried|last month/i.test(hx));
});

await scenario('Month-end defaults to the last day of the month; work back from today', '2026-10-22T19:00:00', async ({ page, store, fill, openAll, go, reloadAt }) => {
  await go('me'); await openAll();
  for (const [k, v] of [['Joint', 2735.63], ['Hersh Debit', 22911.12], ['Hersh Credit', 1690.85], ['Sonali Debit', 7815.24], ['Sonali Credit', 251.82]]) await fill(`[data-mebal="${k}"]`, v);
  await page.click('#meSetup'); await page.waitForTimeout(400);
  await go('log'); await page.fill('#fDate', '2026-11-02'); await page.selectOption('#fAccount', 'Hersh Credit'); await page.fill('#fValue', '50'); await page.fill('#fRetailer', 'November spend'); await page.click('#submitBtn'); await page.waitForTimeout(150);
  await reloadAt('2026-11-04T19:00:00'); await go('me'); await openAll();
  check('balances-as-at defaults to 31 Oct', (await page.inputValue('#meRun')) === '2026-10-31');
  check('November mortgage is not in October', !/Mortgage \(Nationwide\)\s*2 Nov/.test(await page.textContent('#v-me')));
  await fill('[data-metoday="Hersh Credit"]', 1740.85); await page.waitForTimeout(200); await openAll();
  const s = await store();
  check('card worked back to 31 Oct (today 1,740.85 owed less the 50 logged in Nov)', s.month_ends['2026-10']?.balances?.['Hersh Credit'] === -1690.85, JSON.stringify(s.month_ends['2026-10']?.balances));
});

await scenario('Review nudge on 15 March', '2027-03-15T09:00:00', async ({ page, store }) => {
  check('March review shows on Home', (await page.textContent('#v-home')).includes('Year-end review with Claude'));
  await page.click('[data-reviewdone="2027-03-15"]'); await page.waitForTimeout(200);
  check('marking it done clears it', !(await page.textContent('#v-home')).includes('Year-end review with Claude') && !!(await store()).v2meta.reviews?.['2027-03-15']);
});

await scenario('Export everything, and the 6-monthly reminder', '2026-10-18T10:00:00', async ({ page, store, go }) => {
  check('export reminder shows when never exported', (await page.textContent('#v-home')).includes('Export a backup of everything'));
  const [dl] = await Promise.all([page.waitForEvent('download'), page.click('[data-fold=home-actions] [data-export]')]);
  const file = await dl.path(); const data = JSON.parse(fs.readFileSync(file, 'utf8'));
  check('export has every collection and the forecast', ['transactions', 'plan_items', 'month_ends', 'budget_rules'].every(k => data.collections[k]) && data.forecast?.rows?.length > 40 && data.opening?.balances);
  check('timestamps are readable dates', typeof Object.values(data.collections.plan_items)[0].createdAt === 'string');
  await page.waitForTimeout(200); await go('home');
  check('reminder clears after exporting', !(await page.textContent('#v-home')).includes('Export a backup of everything'));
  check('last export recorded', !!(await store()).v2meta.exports?.lastAt);
});

await scenario('ANI: early pension payment reduces the top-up', '2026-11-03T20:00:00', async ({ page, fill, openAll, go }) => {
  await go('log'); await page.click('#typeSeg button[data-t=transfer]'); await page.fill('#fDate', '2026-11-01'); await page.selectOption('#fAccount', 'Hersh Debit'); await page.selectOption('#fTo', 'Pension'); await page.fill('#fValue', '4000'); await page.fill('#fRetailer', 'Early Vanguard payment'); await page.click('#submitBtn'); await page.waitForTimeout(150);
  // pass the set-up month first so the payslip step is the October reconciliation layout
  await go('me'); await openAll();
  await fill('[data-meps=ytd][data-who=hersh]', 73508.46); await fill('[data-meps=period][data-who=hersh]', 9583.33); await openAll();
  const t = await page.textContent('#v-me');
  check('top-up after a £4,000 early payment is £13,020.09', t.includes('£13,020.09'), t.match(/Still to pay[^£]*£[\d,.]+/)?.[0] || '');
});

await scenario('One-offs: Paid logs it, takes it off month-end, and undo works', '2026-11-03T20:00:00', async ({ page, store, go }) => {
  await go('plan'); await page.click('#planSeg button[data-ps=oneoff]'); await page.waitForTimeout(100);
  await page.fill('#ppDesc', 'Extra overpayment'); await page.selectOption('#ppKind', 'transfer'); await page.fill('#ppDate', '2026-11-20'); await page.fill('#ppAmount', '1000'); await page.selectOption('#ppTo', 'Mortgage'); await page.click('#ppForm button[type=submit]'); await page.waitForTimeout(150);
  const pay = (await page.$$eval('[data-pay]', b => b.map(x => x.dataset.pay))).find(i => i.startsWith('plan:') && !i.includes('pension'));
  await page.click(`[data-pay="${pay}"]`); await page.waitForTimeout(100); await page.click(`[data-payform="${pay}"] button:not([type=button])`); await page.waitForTimeout(150);
  let s = await store();
  const item = Object.values(s.plan_items).find(x => x.name === 'Extra overpayment');
  check('one-off marked paid and logged', item.status === 'paid' && Object.values(s.transactions).some(t => t.oneoffRef && t.toAccount === 'Mortgage'));
  await go('feed'); await page.selectOption('#flPeriod', 'all'); await page.waitForTimeout(100);
  const id = await page.evaluate(() => [...document.querySelectorAll('#feed [data-row]')].find(r => r.innerText.includes('Extra overpayment')).dataset.row);
  await page.click(`#feed [data-row="${id}"]`); await page.click(`[data-del="${id}"]`); await page.waitForTimeout(150);
  s = await store();
  check('deleting the transaction puts the one-off back', Object.values(s.plan_items).find(x => x.name === 'Extra overpayment').status === 'confirmed');
});

await scenario('Closed months are locked', '2026-12-05T12:00:00', async ({ page, store, go }) => {
  await page.evaluate(() => { const s = window.__store; s.month_ends = { '2026-11': { status: 'closed', runDate: '2026-12-03', balances: s.v2meta.opening.balances, isas: {}, pensions: {} } }; s.transactions.lockme = { date: '2026-11-15', monthKey: '2026-11', direction: 'out', value: 9, pot: 'dayToDay', category: 'Other', account: 'Joint', paidBy: 'Hersh', retailer: 'Locked test', type: 'spend' }; localStorage.setItem('__mock', JSON.stringify(s)); });
  await page.reload(); await page.waitForTimeout(600);
  await go('log'); await page.fill('#fDate', '2026-11-20'); await page.fill('#fValue', '5'); await page.fill('#fRetailer', 'Back-dated'); await page.click('#submitBtn'); await page.waitForTimeout(150);
  const s = await store();
  check('a back-dated spend into a closed month is refused', !Object.values(s.transactions).some(t => t.retailer === 'Back-dated'));
  await go('feed'); await page.selectOption('#flPeriod', 'all'); await page.waitForTimeout(100);
  await page.click('#feed [data-row="lockme"]');
  check('a closed transaction shows no Edit or Delete', !(await page.$('[data-edit="lockme"]')));
});

await scenario('Forecast and saved plan', '2026-10-17T22:30:00', async ({ page, store, go }) => {
  await go('plan'); await page.click('#planSeg button[data-ps=forecast]'); await page.waitForTimeout(300);
  const s = await store();
  check('plan saved once all data loaded', (s.v2meta.baseline?.v || 0) >= 2);
  await page.click('#planSeg button[data-ps=oneoff]'); await page.waitForTimeout(100);
  await page.fill('#ppDesc', 'Move Vida cash ISA to S&S'); await page.selectOption('#ppKind', 'transfer'); await page.fill('#ppDate', '2027-06-15'); await page.fill('#ppAmount', '30000'); await page.selectOption('#ppAccount', 'Hersh Cash ISA'); await page.selectOption('#ppTo', 'Hersh S&S ISA'); await page.click('#ppForm button[type=submit]'); await page.waitForTimeout(200);
  const r = Object.fromEntries((await page.evaluate(() => liveForecastForTest())).map(x => [x.mk, x]));
  check('a one-off ISA transfer moves money from cash to S&S in the forecast', r['2027-06'].isas['Hersh Cash ISA'] < r['2027-05'].isas['Hersh Cash ISA'] - 29000 && r['2027-06'].isas['Hersh S&S ISA'] > r['2027-05'].isas['Hersh S&S ISA'] + 29000);
  await page.click('#planSeg button[data-ps=forecast]'); await page.waitForTimeout(200);
  check('July 2030 summary shows', (await page.textContent('#planBody')).includes('July 2030'));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
