const puppeteer = require('puppeteer');
const crypto = require('crypto');

const GIST_ID = 'ffe6105f3e59d233d6107f50ac5cf9ab';
const TOKEN = process.env.GH_GIST_TOKEN;
const today = new Date().toISOString().split('T')[0];

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  const email = process.env.KT_EMAIL;
  const password = process.env.KT_PASSWORD;
  const md5pass = crypto.createHash('md5').update(password).digest('hex');
  console.log('Password length:', password?.length, 'MD5:', md5pass);

  // Navigate to /login page
  console.log('Navigating to /login...');
  await page.goto('https://www.kaloricketabulky.sk/login', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof angular !== 'undefined', { timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));

  // Type email
  const emailField = await page.$('input[type="email"]');
  if (emailField && await emailField.boundingBox()) {
    await emailField.click({ clickCount: 3 });
    await emailField.type(email, { delay: 30 });
    console.log('Typed email');
  } else {
    console.log('No email field found');
  }

  // Type password
  const passField = await page.$('input[type="password"]');
  if (passField && await passField.boundingBox()) {
    await passField.click({ clickCount: 3 });
    await passField.type(password, { delay: 30 });
    console.log('Typed password');
  } else {
    console.log('No password field found');
  }

  await new Promise(r => setTimeout(r, 500));

  // Intercept the login POST response
  const loginResponsePromise = page.waitForResponse(
    res => res.url().includes('/login/create'),
    { timeout: 10000 }
  ).catch(() => null);

  // Click login button
  await page.click('button[ng-click="login()"]').catch(e => console.log('Click failed:', e.message));
  console.log('Clicked login');

  const loginRes = await loginResponsePromise;
  if (loginRes) {
    try {
      const body = await loginRes.text();
      console.log('Login response:', loginRes.status(), body.substring(0, 300));
    } catch(e) {
      console.log('Login response:', loginRes.status(), '(body read failed)');
    }
  } else {
    console.log('No /login/create response captured');
  }

  await new Promise(r => setTimeout(r, 2000));

  let loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
  console.log('Logged in:', loggedIn);

  // If not logged in, try direct POST with MD5 password
  if (loggedIn !== '1') {
    console.log('\nTrying direct POST to /login/create...');
    const directResult = await page.evaluate(async (email, md5pass) => {
      try {
        const resp = await fetch('/login/create?format=json&voucher=false', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: md5pass }),
          credentials: 'same-origin'
        });
        const data = await resp.json();
        return JSON.stringify(data);
      } catch (e) {
        return 'error: ' + e.message;
      }
    }, email, md5pass);
    console.log('Direct POST result:', directResult);

    // Check if it worked
    if (directResult.includes('"code":0') || directResult.includes('"code":1')) {
      await page.reload({ waitUntil: 'networkidle2' });
      loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
      console.log('Logged in after direct POST:', loggedIn);
    }
  }

  if (loggedIn !== '1') {
    console.log('\nLogin failed.');
    await browser.close();
    process.exit(1);
  }

  // Navigate to diary
  console.log('\nLogged in! Navigating to diary...');
  await page.goto('https://www.kaloricketabulky.sk/moj-diar', { waitUntil: 'networkidle2', timeout: 20000 });

  console.log('Waiting for diary data...');
  await page.waitForFunction(() => {
    if (typeof angular === 'undefined') return false;
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    if (!inj) return false;
    const rs = inj.get('$rootScope');
    function find(scope, depth) {
      if (!scope || depth > 20) return null;
      if (scope.diary) return scope.diary;
      let child = scope.$$childHead;
      while (child) { const r = find(child, depth + 1); if (r) return r; child = child.$$nextSibling; }
      return null;
    }
    return !!find(rs, 0);
  }, { timeout: 15000 }).catch(() => console.log('Timeout waiting for diary scope'));

  const items = await page.evaluate((isoDate) => {
    if (typeof angular === 'undefined') return { ok: false, err: 'no angular' };
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    if (!inj) return { ok: false, err: 'no injector' };
    const rs = inj.get('$rootScope');
    let diary = null;
    function find(scope, depth) {
      if (!scope || depth > 20) return;
      if (scope.diary && !diary) diary = scope.diary;
      let child = scope.$$childHead;
      while (child) { find(child, depth + 1); child = child.$$nextSibling; }
    }
    find(rs, 0);
    if (!diary) return { ok: false, err: 'no diary in scope' };
    const result = [];
    const mealNames = ['Raňajky', 'Desiata', 'Obed', 'Olovrant', 'Večera', 'Druhá večera'];
    if (diary.times && Array.isArray(diary.times)) {
      for (let t = 0; t < diary.times.length; t++) {
        const time = diary.times[t];
        const timeKeys = Object.keys(time).filter(k => k.charAt(0) !== '$');
        const mealName = time.title || time.name || time.label || mealNames[t] || 'Jedlo ' + (t + 1);
        let foodArray = null;
        for (const k of timeKeys) { if (Array.isArray(time[k]) && time[k].length > 0) { foodArray = time[k]; break; } }
        if (!foodArray) continue;
        for (const food of foodArray) {
          function findVal(o, p) { for (const x of p) for (const k in o) { if (k.charAt(0)==='$') continue; if (k.toLowerCase().includes(x)) { const v=o[k]; if (typeof v==='number') return v; if (typeof v==='string') { const n=parseFloat(v.replace(',','.')); if (!isNaN(n)) return n; } } } for (const k in o) { if (k.charAt(0)==='$') continue; const v=o[k]; if (v&&typeof v==='object'&&!Array.isArray(v)) { const s=findVal(v,p); if (s!==0) return s; } } return 0; }
          function findStr(o, p) { for (const x of p) for (const k in o) { if (k.charAt(0)==='$') continue; if (k.toLowerCase().includes(x)&&typeof o[k]==='string'&&o[k].length>0) return o[k]; } for (const k in o) { if (k.charAt(0)==='$') continue; const v=o[k]; if (v&&typeof v==='object'&&!Array.isArray(v)) { const s=findStr(v,p); if (s) return s; } } return ''; }
          result.push({
            title: String(findStr(food, ['title','name','nazov','nazev','food']) || food[Object.keys(food).filter(k=>k.charAt(0)!=='$')[0]] || ''),
            amount: findVal(food, ['amount','quantity','mnozstvo','weight','hmotnost','grams']),
            unit: findStr(food, ['unit','jednotk']) || 'g',
            energy: findVal(food, ['energy','energi','kcal','kalori','calori']),
            protein: findVal(food, ['protein','bielkov']),
            carbs: findVal(food, ['carb','sachar','uhlov','hydrat']),
            fat: findVal(food, ['fat','tuk','lipid']),
            date: isoDate, meal: mealName
          });
        }
      }
    }
    return { ok: result.length > 0, data: result, err: result.length === 0 ? 'empty' : null };
  }, today);

  await browser.close();

  if (!items.ok || !items.data || items.data.length === 0) {
    console.log('No items found:', items.err);
    process.exit(0);
  }

  console.log('Found ' + items.data.length + ' food items');

  const records = items.data.map(item => ({
    id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    date: item.date, foodName: item.title,
    amount: item.amount ? item.amount + ' ' + item.unit : '',
    protein: item.protein || 0, carbs: item.carbs || 0, fat: item.fat || 0,
    caloriesIn: item.energy || 0, caloriesOut: 0, meal: item.meal,
    source: 'kt', ktId: item.title + '_' + item.date + '_' + item.energy
  }));

  const gistResp = await fetch('https://api.github.com/gists/' + GIST_ID, {
    headers: { 'Authorization': 'token ' + TOKEN, 'Accept': 'application/vnd.github.v3+json' }
  });
  const gist = await gistResp.json();
  const data = JSON.parse(gist.files?.['fitness-data.json']?.content || '{}');
  const existing = data.records || [];
  const filtered = existing.filter(r => !(r.source === 'kt' && r.date === today));
  const merged = [...filtered, ...records];
  const seen = new Set();
  data.records = merged.filter(r => { const key = r.ktId || r.id; if (seen.has(key)) return false; seen.add(key); return true; });

  const pushResp = await fetch('https://api.github.com/gists/' + GIST_ID, {
    method: 'PATCH',
    headers: { 'Authorization': 'token ' + TOKEN, 'Accept': 'application/vnd.github.v3+json' },
    body: JSON.stringify({ files: { 'fitness-data.json': { content: JSON.stringify(data) } } })
  });

  console.log(pushResp.ok ? 'Synced ' + records.length + ' items to Gist' : 'Gist push failed: ' + pushResp.status);
  if (!pushResp.ok) process.exit(1);
})();
