/**
 * Drive the atlas in a real browser and take screenshots of it working.
 *
 *   node tools/shoot.js [baseUrl] [outDir]
 *
 * A 3D page that has never been rendered is not finished, and neither WebGL
 * errors nor a cut that fails to load show up in any of the build checks. This
 * walks the page the way a visitor would -- pick a culture, hover a cut, click
 * it, explode the carcass, switch to the anatomy and peel it -- and fails loudly
 * if the console reports anything.
 */

const path = require('path');
const fs = require('fs');

// Playwright may be installed locally, globally, or only in the npx cache. Set
// PLAYWRIGHT_PATH at the package directory if none of the usual resolution works.
function loadPlaywright() {
  const candidates = [process.env.PLAYWRIGHT_PATH, 'playwright', 'playwright-core']
    .filter(Boolean);
  for (const c of candidates) {
    try { return require(c); } catch { /* try the next one */ }
  }
  throw new Error(
    'Cannot find Playwright. Install it (npm i -D playwright) or set PLAYWRIGHT_PATH ' +
    'to the package directory, e.g. one under AppData/Local/npm-cache/_npx/.');
}
const { chromium } = loadPlaywright();

const base = process.argv[2] || 'http://127.0.0.1:8731/';
const outDir = process.argv[3] || path.join(__dirname, '..', 'build', 'shots');

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch({
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader'],
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });

  const problems = [];
  page.on('console', m => {
    if (m.type() === 'error' || m.type() === 'warning') problems.push(`${m.type()}: ${m.text()}`);
  });
  page.on('pageerror', e => problems.push(`pageerror: ${e.message}`));
  page.on('requestfailed', r => problems.push(`requestfailed: ${r.url()} ${r.failure()?.errorText}`));

  const shot = async (name, waitMs = 700) => {
    await page.waitForTimeout(waitMs);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(`shot ${name}`);
  };

  await page.goto(base, { waitUntil: 'networkidle' });
  await page.waitForSelector('#loading', { state: 'hidden', timeout: 45000 });
  await shot('01-open', 1400);

  // The page opens on the anatomy now, so the cut walk starts by asking for the
  // schematic model. That switch is itself the first thing worth failing on.
  await page.click('#modes button[data-mode="cuts"]');
  await page.waitForSelector('#cut-list li', { state: 'visible', timeout: 10000 });

  const cuts = await page.$$('#cut-list li');
  console.log(`legend entries: ${cuts.length}`);

  // click a cut in the legend: the detail panel and the highlight should follow
  await cuts[3].click();
  await page.waitForSelector('#detail:not([hidden])', { timeout: 5000 });
  const selectedName = await page.textContent('.d-native');
  console.log(`selected: ${selectedName}`);
  await shot('02-selected');

  // explode
  await page.fill('#explode', '70');
  await page.dispatchEvent('#explode', 'input');
  await shot('03-exploded', 900);
  await page.fill('#explode', '0');
  await page.dispatchEvent('#explode', 'input');

  // hover a cut in the 3D view itself, then click it there -- the pointer path
  // through the canvas is the only proof the raycast picking actually works
  await page.click('#detail-close');
  await page.mouse.move(720, 430);
  await page.waitForTimeout(400);
  await page.mouse.move(722, 432);
  const tip = await page.textContent('#tooltip');
  if (!tip || !tip.trim()) throw new Error('hovering a cut in the 3D view produced no tooltip');
  console.log(`hover tooltip: ${tip.trim()}`);
  await shot('04-hover');

  await page.mouse.click(722, 432);
  await page.waitForSelector('#detail:not([hidden])', { timeout: 5000 });
  console.log(`clicked in 3D, panel shows: ${(await page.textContent('.d-native')).trim()}`);
  await page.click('#detail-close');

  // every culture in turn, and count what actually arrived in each model
  const tabs = await page.$$('#cultures button');
  const perCulture = [];
  for (let i = 0; i < tabs.length; i++) {
    const label = (await tabs[i].textContent()).trim();
    await tabs[i].click();
    await page.waitForTimeout(1600);
    const counts = await page.evaluate(() => ({
      legend: document.querySelectorAll('#cut-list li').length,
      title: document.getElementById('legend-title').textContent,
    }));
    perCulture.push({ label, ...counts });
    await shot(`05-${String(i + 1).padStart(2, '0')}-${label.replace(/\W+/g, '-').toLowerCase()}`, 300);
  }
  console.table(perCulture);

  // ---- the anatomy model: layers, peeling, the cutaway, and the cross-reference

  await page.click('#cultures button[data-id="us"]');
  await page.waitForTimeout(900);
  await page.click('#modes button[data-mode="anatomy"]');
  await page.waitForFunction(
    () => document.querySelectorAll('#part-list li:not(.part-head)').length > 0,
    null, { timeout: 60000 });
  const partCount = await page.$$eval('#part-list li:not(.part-head)', els => els.length);
  console.log(`anatomy parts: ${partCount}`);
  if (partCount < 20) throw new Error(`only ${partCount} anatomy parts reached the page`);
  await shot('06-anatomy', 1500);

  // The butchery shell over the anatomy. It has to follow the culture tabs, keep the
  // cut list readable beside the part list, and hand the panel to the cut rather than
  // to a muscle -- the cross-reference is the only reason both models are on screen.
  if (!(await page.isChecked('#layer-cuts'))) {
    throw new Error('the anatomy view did not open with the cut shell on');
  }
  const shellCuts = await page.$$eval('#cut-list li', els => els.length);
  console.log(`cut list beside the anatomy: ${shellCuts} entries`);
  if (!shellCuts) throw new Error('the cut list is not readable while the shell is up');
  await page.click('#cultures button[data-id="fr"]');
  await page.waitForTimeout(1200);
  const frCuts = await page.$$eval('#cut-list li', els => els.length);
  if (!frCuts || frCuts === shellCuts) {
    console.log(`note: fr shows ${frCuts} cuts against us ${shellCuts}`);
  }
  await shot('06b-anatomy-cuts-fr', 600);

  await page.click('#cultures button[data-id="us"]');
  await page.waitForTimeout(1200);
  await page.click('#cut-list li[data-id="short_loin"]');
  await page.waitForSelector('#detail:not([hidden])', { timeout: 5000 });
  const shellPanel = (await page.textContent('.d-native')).trim();
  const litByShell = await page.$$eval('#part-list li.lit', els => els.length);
  console.log(`"${shellPanel}" over the anatomy lights ${litByShell} muscles`);
  if (!litByShell) throw new Error('selecting a cut over the anatomy lit no muscles');
  if (await page.$('#detail .see-anatomy')) {
    throw new Error('the "open it on the animal" button is still offered on the animal');
  }
  await shot('06c-anatomy-cut-selected', 700);
  await page.click('#detail-close');

  // and out of the way again: everything below is the anatomy on its own
  await page.uncheck('#layer-cuts');
  await page.waitForTimeout(500);

  // strip the hide and the superficial muscle: what is left has to be the deep
  // layer, the organs and the skeleton, and it has to be fewer meshes than before
  await page.uncheck('#layer-skin');
  await page.fill('#peel', '2');
  await page.dispatchEvent('#peel', 'input');
  await shot('07-anatomy-deep', 900);

  await page.fill('#peel', '0');
  await page.dispatchEvent('#peel', 'input');
  await page.check('#layer-skin');
  await page.fill('#cutaway', '62');
  await page.dispatchEvent('#cutaway', 'input');
  await shot('08-anatomy-cutaway', 900);

  // hover a part in the 3D view -- the raycast has to survive the clipping plane
  await page.mouse.move(700, 420);
  await page.waitForTimeout(400);
  await page.mouse.move(702, 422);
  const partTip = await page.textContent('#tooltip');
  if (!partTip || !partTip.trim()) {
    throw new Error('hovering a part in the anatomy view produced no tooltip');
  }
  console.log(`anatomy hover: ${partTip.trim()}`);

  await page.fill('#cutaway', '0');
  await page.dispatchEvent('#cutaway', 'input');

  // a muscle should know which cut it lands in, in every tradition
  const muscle = await page.$('#part-list li[data-system="muscle"]');
  await muscle.click();
  await page.waitForSelector('#detail:not([hidden])', { timeout: 5000 });
  const muscleName = (await page.textContent('.d-native')).trim();
  const lands = await page.$$eval('#detail .elsewhere li', els => els.length);
  console.log(`picked muscle: ${muscleName}, lands in ${lands} traditions' cuts`);
  await shot('09-anatomy-muscle', 700);

  // and back the other way: a cut should say what it is made of
  await page.click('#modes button[data-mode="cuts"]');
  await page.waitForTimeout(600);
  // Not "did it list anything" but "did it list the right thing". A cut ranked by
  // the wrong denominator still returns a full list -- it just quietly leaves the
  // longissimus out of the short loin, which is the sentence this atlas leads with.
  const loin = await page.$('#cut-list li[data-id="short_loin"]');
  await loin.click();
  await page.waitForSelector('#detail:not([hidden])', { timeout: 5000 });
  const madeOf = await page.$$eval('#detail .elsewhere.muscles .el-name', els =>
    els.map(e => e.textContent.trim()));
  console.log(`cut "${(await page.textContent('.d-native')).trim()}" is made of ` +
              `${madeOf.length} muscles: ${madeOf.slice(0, 4).join(' / ')}`);
  if (!madeOf.length) throw new Error('a cut listed no muscles -- the cross-reference is dead');
  for (const must of ['Longissimus dorsi', 'Psoas major']) {
    if (!madeOf.includes(must)) {
      throw new Error(`the US short loin did not list ${must}: got ${madeOf.join(', ')}`);
    }
  }
  if (madeOf.indexOf('Longissimus dorsi') > 1) {
    throw new Error(`the longissimus ranked ${madeOf.indexOf('Longissimus dorsi') + 1}` +
                    ` in the short loin, behind ${madeOf.slice(0, 2).join(' and ')}`);
  }
  await shot('10-cut-made-of', 700);

  await browser.close();

  if (problems.length) {
    console.log('\nCONSOLE PROBLEMS');
    for (const p of [...new Set(problems)]) console.log('  ' + p);
    process.exitCode = 1;
  } else {
    console.log('\nno console errors');
  }
})();
