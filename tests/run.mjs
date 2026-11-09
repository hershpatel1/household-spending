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

await scenario('Log a spend and a transfer', '2026-10-20T12:00:00', async ({ page, store, go }) => {
  await go('log'); await page.fill('#fValue', '12.34'); await page.fill('#fRetailer', 'Waitrose'); await page.click('#submitBtn'); await page.waitForTimeout(100);
  await page.click('#typeSeg button[data-t=transfer]'); await page.selectOption('#fAccount', 'Hersh Debit');
  const toOpts = await page.$$eval('#fTo option', o => o.filter(x => !x.hidden).map(x => x.value));
  check('own card is offered as a transfer destination (card repayment), but not the account itself', toOpts.includes('Hersh Credit') && !toOpts.includes('Hersh Debit'));
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

await scenario('Planned budget spends show as planned against the right year', '2026-10-18T10:00:00', async ({ page, go }) => {
  await go('plan'); await page.click('#planSeg button[data-ps=oneoff]'); await page.waitForTimeout(100);
  await page.fill('#ppDesc', 'Summer holiday deposit'); await page.selectOption('#ppKind', 'budget'); await page.fill('#ppDate', '2027-05-01'); await page.fill('#ppAmount', '2000'); await page.selectOption('#ppPot', 'holidays'); await page.click('#ppForm button[type=submit]'); await page.waitForTimeout(150);
  await page.click('#planSeg button[data-ps=budgets]'); await page.waitForTimeout(100);
  check('next year shows £2,000 planned, £3,000 left', (await page.textContent('#planBody')).includes('£2,000 planned, £3,000 left'));
  await go('home'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.waitForTimeout(100);
  await go('plan'); await page.click('#planSeg button[data-ps=budgets]'); await page.waitForTimeout(100);
  await page.click('#yearPill button[data-by="2027-04"]'); await page.waitForTimeout(100);
  const y = await page.textContent('#planBody');
  check('year switcher shows 2027/28 with the deposit planned', y.includes('Annual budgets · 2027/28') && y.includes('£2,000.00 planned'));
  await page.click('#yearPill button[data-by="2029-04"]'); await page.waitForTimeout(100);
  const y2 = await page.textContent('#planBody');
  check('a later year shows carried-forward budgets', y2.includes('Annual budgets · 2029/30') && y2.includes('£650 a month') && y2.includes('£7,800 for the year'));
  await go('home'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.waitForTimeout(100);
  check('Home notes what is already planned for next year', (await page.textContent('#v-home')).includes('Already planned for 2027/28: Holidays £2,000 of £5,000'));
});

await scenario('Budget cards open Transactions with the right filters; one-offs carry a category', '2026-10-18T10:00:00', async ({ page, go, store }) => {
  await go('log'); await page.selectOption('#fPot', 'riyaan'); await page.fill('#fValue', '20'); await page.fill('#fRetailer', 'Nappies'); await page.click('#submitBtn'); await page.waitForTimeout(100);
  await go('log'); await page.selectOption('#fPot', 'holidays'); await page.fill('#fValue', '300'); await page.fill('#fRetailer', 'Flights'); await page.click('#submitBtn'); await page.waitForTimeout(100);
  await go('plan'); await page.click('#planSeg button[data-ps=oneoff]'); await page.waitForTimeout(100);
  check('category field shows for a budget spend', await page.isVisible('#ppCat'));
  await page.selectOption('#ppKind', 'out'); await page.waitForTimeout(50); check('category hidden for a payment out', !(await page.isVisible('#ppCat')));
  await page.selectOption('#ppKind', 'budget');
  await page.fill('#ppDesc', 'Hotel balance'); await page.fill('#ppDate', '2027-02-01'); await page.fill('#ppAmount', '500'); await page.selectOption('#ppPot', 'holidays'); await page.selectOption('#ppCat', 'Travel & Parking'); await page.click('#ppForm button[type=submit]'); await page.waitForTimeout(150);
  const pp = Object.values((await store()).planned_payments).find(x => x.description === 'Hotel balance');
  check('planned spend saves its category', pp && pp.category === 'Travel & Parking');
  await go('home'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.waitForTimeout(100);
  await page.locator('#v-home [data-drill*="riyaan%22"]').first().click({ timeout: 4000 }); await page.waitForTimeout(150);
  let feed = await page.textContent('#v-feed');
  check('Riyaan card opens Transactions filtered to Riyaan this month', (await page.inputValue('#flPot')) === 'riyaan' && (await page.inputValue('#flPeriod')) === 'this' && (await page.inputValue('#flType')) === 'spend' && feed.includes('Nappies') && !feed.includes('Flights'));
  await go('home'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.waitForTimeout(100);
  await page.click('#v-home [data-drill*="holidays%22"]'); await page.waitForTimeout(150);
  feed = await page.textContent('#v-feed');
  check('Holidays card opens the year to date, and notes what is planned', (await page.inputValue('#flPeriod')) === 'fy' && feed.includes('Flights') && feed.includes('Plus £500.00 planned, not yet paid: Hotel balance'));
  await go('plan'); await page.click('#planSeg button[data-ps=budgets]'); await page.waitForTimeout(100); await page.click('#yearPill button[data-by="2027-04"]'); await page.waitForTimeout(100);
  await page.click('#planBody [data-drill*="holidays%22"]'); await page.waitForTimeout(150);
  check('a future year opens a custom range for that year', (await page.inputValue('#flPeriod')) === 'custom' && (await page.inputValue('#flFrom')) === '2027-04-01' && (await page.inputValue('#flToDate')) === '2028-03-31');
  await go('plan'); await page.click('#planSeg button[data-ps=oneoff]'); await page.waitForTimeout(100);
  const ppId = Object.entries((await store()).planned_payments).find(([, x]) => x.description === 'Hotel balance')[0]; const pay = 'pp:' + ppId;
  await page.click(`[data-pay="${pay}"]`); await page.waitForTimeout(100);
  check('Paid sheet pre-selects the saved category', (await page.inputValue(`[data-payform="${pay}"] select[name=category]`)) === 'Travel & Parking');
  await page.click(`[data-payform="${pay}"] button:not([type=button])`); await page.waitForTimeout(150);
  const t = Object.values((await store()).transactions).find(x => x.retailer === 'Hotel balance');
  check('paid one-off logs with its category', t && t.category === 'Travel & Parking' && t.pot === 'holidays');
});

await scenario('Changing a regular payment date: no duplicates, visible, undoable, self-healing', '2026-10-18T10:00:00', async ({ page, go, store }) => {
  const car = () => Object.values(page._s.plan_items).filter(x => (x.series || '') === 'p-s-car' || x.name === 'Car finance');
  const openCar = async () => { await go('plan'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.click('[data-plan="p-s-car"]'); await page.waitForTimeout(100); };
  for (let i = 0; i < 3; i++) {
    await openCar(); await page.click('[data-plan="p-s-car"] [data-pm=change]'); await page.waitForTimeout(100);
    await page.fill('[data-pform=change] input[name=day]', '1'); await page.click('[data-pform=change] button[type=submit]'); await page.waitForTimeout(200);
  }
  page._s = await store(); let v = car();
  check('three saves leave exactly two versions', v.length === 2, JSON.stringify(v.map(x => [x.start, x.end, x.day])));
  const nov = v.find(x => x.start === '2026-11');
  check('November version keeps the Oct 2028 end and the 1st', nov && nov.end === '2028-10' && nov.day === 1);
  await openCar(); const row = await page.textContent('[data-plan="p-s-car"]');
  check('list shows the upcoming change', row.includes('Changes from Nov') && row.includes('on the 1st'));
  await page.click('[data-plan="p-s-car"] [data-pm=unchange]'); await page.waitForTimeout(200);
  page._s = await store(); v = car();
  check('undo removes the change and restores the end date', v.length === 1 && v[0].end === '2028-10' && v[0].day === 15);
  // fix a mistake in every month
  await openCar(); await page.click('[data-plan="p-s-car"] [data-pm=change]'); await page.waitForTimeout(100);
  await page.fill('[data-pform=change] input[name=day]', '23'); await page.check('[data-pform=change] input[name=fix]'); await page.click('[data-pform=change] button[type=submit]'); await page.waitForTimeout(200);
  page._s = await store(); v = car();
  check('fix a mistake updates in place', v.length === 1 && v[0].day === 23);
  // self-heal duplicates already saved
  await page.evaluate(() => { const s = window.__store.plan_items; const b = s['p-s-car']; s['dupA'] = { ...b, start: '2026-11', end: '2028-10', day: 1, createdAt: { seconds: 100 } }; s['dupB'] = { ...b, start: '2026-11', end: '', day: 1, createdAt: { seconds: 200 } }; s['dupC'] = { ...b, start: '2026-11', end: '', day: 1, createdAt: { seconds: 300 } }; });
  await page.evaluate(() => localStorage.setItem('__mock', JSON.stringify(window.__store))); await page.reload(); await page.waitForTimeout(900);
  page._s = await store(); v = car();
  check('duplicates healed on load, keeping the original end date', v.filter(x => x.start === '2026-11').length === 1 && v.find(x => x.start === '2026-11').end === '2028-10', JSON.stringify(v.map(x => [x.start, x.end])));
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

await scenario('Yearly payment: move the month of the year via Change and Replace', '2026-10-18T10:00:00', async ({ page, go, store }) => {
  const openIt = async id => { await go('plan'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.click(`[data-plan="${id}"]`); await page.waitForTimeout(100); };
  const ins = () => Object.values(page._s.plan_items).filter(x => (x.series || x.id) === 'p-carins');
  await openIt('p-carins'); await page.click('[data-plan="p-carins"] [data-pm=change]'); await page.waitForTimeout(100);
  check('month box shows on a yearly item, pre-filled with 11', (await page.inputValue('[data-pform=change] input[name=months]')) === '11');
  await page.fill('[data-pform=change] input[name=months]', '10'); await page.fill('[data-pform=change] input[name=from]', '2026-10');
  await page.fill('[data-pform=change] input[name=day]', '28');
  await page.click('[data-pform=change] button[type=submit]'); await page.waitForTimeout(200);
  page._s = await store(); let v = ins();
  check('one version, now paid in October on the 28th', v.length === 1 && JSON.stringify(v[0].months) === '[10]' && v[0].day === 28, JSON.stringify(v.map(x => [x.start, x.end, x.months, x.day])));
  await openIt('p-carins'); await page.click('[data-plan="p-carins"] [data-pm=change]'); await page.waitForTimeout(100);
  await page.fill('[data-pform=change] input[name=months]', '13'); await page.click('[data-pform=change] button[type=submit]'); await page.waitForTimeout(200);
  page._s = await store(); v = ins();
  check('an invalid month is refused and nothing changes', v.length === 1 && JSON.stringify(v[0].months) === '[10]');
  await openIt('p-h-life'); await page.click('[data-plan="p-h-life"] [data-pm=change]'); await page.waitForTimeout(100);
  check('no month box on a monthly item', (await page.locator('[data-pform=change] input[name=months]').count()) === 0);
});

await scenario('Stale local plan document: heal does not loop or flicker', '2026-10-28T22:00:00', async ({ page, go, store }) => {
  page._s = await store(); const car = page._s.plan_items['p-s-car'];
  await page.addInitScript(c => { window.__strict = true; window.__ghosts = { plan_items: { 'p-ghost': { ...c, createdAt: { seconds: 1 } } } }; }, car);
  await page.reload(); await page.waitForTimeout(1500);
  const log = await page.evaluate(() => Object.keys(localStorage).filter(k => /err/i.test(k)).map(k => localStorage.getItem(k)).join(''));
  const n = (log.match(/healPlan/g) || []).length;
  check('heal fails at most twice, not in a loop', n >= 1 && n <= 2, 'healPlan log entries: ' + n);
  await go('plan'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  const rows = await page.locator('[data-plan="p-s-car"]').count();
  check('the real item still shows once and the stale copy is hidden', rows === 1 && (await page.locator('[data-plan="p-ghost"]').count()) === 0, 'rows ' + rows);
});

await scenario('Ledger: running total adds up for each account', '2026-10-20T10:00:00', async ({ page, go }) => {
  await go('feed'); await page.click('[data-fs=ledger]'); await page.waitForTimeout(200);
  for (const u of ['Joint', 'Hersh Debit', 'Hersh Credit', 'Sonali Debit', 'Sonali Credit']) {
    await page.click(`[data-lu="${u}"]`); await page.waitForTimeout(100);
    const rows = await page.$$eval('#ledger .lrow', els => els.map(e => [+e.dataset.v, +e.dataset.run, e.hasAttribute('data-open')]));
    let ok = rows.length >= 1 && rows[0][2], run = rows[0] ? rows[0][1] : 0;
    for (const [v, r] of rows.slice(1)) { run = Math.round((run + v) * 100) / 100; if (Math.abs(run - r) > 0.005) ok = false; }
    check(`${u}: opening row first and every running total = previous + amount`, ok, JSON.stringify(rows.slice(0, 4)));
  }
  await page.click('[data-fs=feed]'); await page.waitForTimeout(100);
  check('Feed view returns and the ledger hides', (await page.locator('#ledger').isHidden()) && (await page.locator('#feed').isVisible()));
});

await scenario('Home: tick a regular payment as you go, Month-end shows it ticked and override still works', '2026-10-31T12:00:00', async ({ page, go, store }) => {
  await go('home'); await page.waitForTimeout(200);
  const n = await page.locator('[data-hometick]').count();
  check('Home lists payments that have gone and can be ticked', n >= 1, 'tick buttons: ' + n);
  const key = await page.locator('[data-hometick]').first().getAttribute('data-hometick');
  await page.locator('[data-hometick]').first().click(); await page.waitForTimeout(300);
  const s = await store(); const ticked = Object.values(s.month_ends || {}).flatMap(m => Object.entries(m.items || {})).find(([k]) => k === key);
  check('the tick is saved against the month-end item', !!ticked && ticked[1].status === 'ticked');
  check('the ticked payment no longer has a Tick button', (await page.locator(`[data-hometick="${key}"]`).count()) === 0);
  await page.evaluate(() => { const m = JSON.parse(localStorage.getItem('__mock')); m.v2meta.opening.setup = false; localStorage.setItem('__mock', JSON.stringify(m)); }); await page.reload(); await page.waitForTimeout(800);
  await go('me'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.waitForTimeout(300);
  check('Month-end shows it ticked, and Override is still offered', (await page.locator(`[data-metick="${key}"].on`).count()) === 1 && (await page.locator(`[data-meovr="${key}"]`).count()) === 1);
});

await scenario('Home: estimates take an actual; Commuting is calculated from Commuting transactions', '2026-10-31T12:00:00', async ({ page, go, store }) => {
  await go('home'); await page.waitForTimeout(200);
  const inp = page.locator('[data-homeact]').first(); const n = await page.locator('[data-homeact]').count();
  check('estimates in the list have an Actual box', n >= 1, 'boxes: ' + n);
  const key = await inp.getAttribute('data-homeact'); await inp.fill('123.45'); await inp.dispatchEvent('change'); await page.waitForTimeout(300);
  const s = await store(); const it = Object.values(s.month_ends || {}).flatMap(m => Object.entries(m.items || {})).find(([k]) => k === key);
  check('the actual is saved as the month-end actual', !!it && it[1].status === 'actual' && it[1].amount === 123.45, JSON.stringify(it));
  await go('log'); check('Commuting is a budget you can log against', (await page.locator('#fPot option[value=commuting]').count()) === 1);
  await page.evaluate(() => { const m = JSON.parse(localStorage.getItem('__mock')); m.v2meta.opening.setup = false; m.transactions['t-rail'] = { date: '2026-10-29', monthKey: '2026-10', direction: 'out', value: 111.11, pot: 'commuting', category: 'Travel', account: 'Hersh Debit', paidBy: 'Hersh', retailer: 'Rail' }; localStorage.setItem('__mock', JSON.stringify(m)); });
  await page.reload(); await page.waitForTimeout(800); await go('me'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.waitForTimeout(300);
  const me = await page.locator('#v-me').innerText();
  check('Month-end Commuting is calculated from Commuting transactions (111.11), with no actual box', /Calculated from your logged Commuting/.test(me) && /111\.11/.test(me) && (await page.locator('[data-meest*="p-h-rail"]').count()) === 0);
});

await scenario('Card repayment: a transfer from a current account to the same person\'s card can be logged and nets out', '2026-10-28T10:00:00', async ({ page, go, store }) => {
  await go('log'); await page.click('#typeSeg button[data-t=transfer]'); await page.selectOption('#fAccount', 'Hersh Debit'); check('Hersh Credit is a visible choice in To account', (await page.$$eval('#fTo option', o => o.filter(x => !x.hidden).map(x => x.value))).includes('Hersh Credit')); await page.selectOption('#fTo', 'Hersh Credit');
  await page.fill('#fValue', '500'); await page.fill('#fRetailer', 'Card repayment'); await page.click('#submitBtn'); await page.waitForTimeout(300);
  const s = await store(); const tx = Object.values(s.transactions).find(t => t.retailer === 'Card repayment');
  check('the repayment is saved as a transfer from Hersh Debit to Hersh Credit', !!tx && tx.type === 'transfer' && tx.account === 'Hersh Debit' && tx.toAccount === 'Hersh Credit' && tx.value === 500, JSON.stringify(tx));
  await go('feed'); await page.click('[data-fs=ledger]'); await page.click('[data-lu="Hersh Debit"]'); await page.waitForTimeout(150);
  const d = await page.$$eval('#ledger .lrow', els => els.map(e => +e.dataset.v)); await page.click('[data-lu="Hersh Credit"]'); await page.waitForTimeout(150);
  const c = await page.$$eval('#ledger .lrow', els => els.map(e => +e.dataset.v));
  check('it shows as -500 on the current account ledger and +500 on the card ledger', d.includes(-500) && c.includes(500), JSON.stringify([d, c]));
});

await scenario('Spare cash, Commuting rename, End on a line not yet started, Payslip log, balances from ledger', '2026-10-31T12:00:00', async ({ page, go, store }) => {
  await go('home'); await page.waitForTimeout(200);
  const hi = await page.locator('.card.pot', { hasText: 'Household Investment' }).first().innerText();
  check('Household Investment card shows spare cash and no longer the Joint balance line', /Spare cash/.test(hi) && !/Joint was/.test(hi), hi.replace(/\n/g, ' | ').slice(0, 200));
  // Rail -> Commuting for existing data (seed v5)
  await page.evaluate(() => { const m = JSON.parse(localStorage.getItem('__mock')); m.v2meta.seed = { version: 4 }; m.plan_items['p-h-rail'] = { ...(m.plan_items['p-h-rail'] || {}), name: 'Rail', account: 'Hersh Debit', amount: 327, start: '2026-10', end: '', freq: 'monthly', kind: 'out', basis: 'estimate', day: 'lwd', months: [], status: 'confirmed', series: 'p-h-rail' }; localStorage.setItem('__mock', JSON.stringify(m)); });
  await page.reload(); await page.waitForTimeout(1200);
  let s = await store(); check('existing Rail line is renamed Commuting and the seed moves to v5', s.plan_items['p-h-rail'].name === 'Commuting' && s.v2meta.seed.version === 5, JSON.stringify([s.plan_items['p-h-rail'].name, s.v2meta.seed]));
  // End on a line that has not started cancels it
  await go('plan'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true));
  const shown = await page.$$eval('[data-plan]', els => els.map(e => e.dataset.plan));
  const fut = Object.entries(s.plan_items).find(([id, p]) => shown.includes(id) && p.freq === 'monthly' && p.start > '2026-12' && !p.end);
  if (fut) {
    await page.click(`[data-plan="${fut[0]}"]`); await page.click(`[data-plan="${fut[0]}"] [data-pm=end]`); await page.waitForTimeout(100);
    await page.fill('[data-pform=end] input[name=last]', '2026-11'); await page.click('[data-pform=end] button[type=submit]'); await page.waitForTimeout(250);
    s = await store(); check('ending a line before it starts removes it instead of leaving end before start', !s.plan_items[fut[0]], fut[0]);
  } else check('(no not-yet-started monthly line in the test data)', true);
  // Payslip as a log type
  await go('log'); await page.click('#typeSeg button[data-t=payslip]'); await page.selectOption('#fAccount', 'Hersh Debit');
  await page.fill('#fDate', '2026-10-30'); await page.fill('#fValue', '6440'); await page.fill('#fPsYtd', '70000'); await page.fill('#fPsPer', '8000'); await page.click('#submitBtn'); await page.waitForTimeout(300);
  s = await store(); const ps = (s.month_ends['2026-10'] || {}).payslip;
  check('a payslip is saved for month-end and creates no transaction', !!ps && ps.ytd === 70000 && ps.period === 8000 && ps.net === 6440 && !Object.values(s.transactions).some(t => t.value === 6440), JSON.stringify(ps));
  // balances from the ledger
  await page.evaluate(() => { const m = JSON.parse(localStorage.getItem('__mock')); m.v2meta.opening.setup = false; localStorage.setItem('__mock', JSON.stringify(m)); });
  await page.reload(); await page.waitForTimeout(800); await go('me'); await page.evaluate(() => document.querySelectorAll('details').forEach(d => d.open = true)); await page.waitForTimeout(300);
  await page.click('#meFillLedger'); await page.waitForTimeout(400);
  s = await store(); const bal = (s.month_ends['2026-10'] || {}).balances || {};
  check('Fill from ledger saves a balance for every account', ['Joint', 'Hersh Debit', 'Hersh Credit', 'Sonali Debit', 'Sonali Credit'].every(a => typeof bal[a] === 'number'), JSON.stringify(bal));
});

console.log(failures ? `\n${failures} check(s) failed` : '\nAll checks passed');
process.exit(failures ? 1 : 0);
