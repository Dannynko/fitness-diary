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

  // Intercept ALL requests to find the real login endpoint
  page.on('request', req => {
    if (req.method() === 'POST') {
      console.log(`  >> POST ${req.url()} body=${req.postData()?.substring(0, 200) || 'none'}`);
    }
  });
  page.on('response', async res => {
    if (res.request().method() === 'POST') {
      try {
        const body = await res.text();
        console.log(`  << ${res.url()} -> ${res.status()} body=${body.substring(0, 300)}`);
      } catch(e) {
        console.log(`  << ${res.url()} -> ${res.status()} (no body: ${e.message})`);
      }
    }
  });

  // APPROACH A: Homepage login flow (loginForm scope)
  console.log('=== APPROACH A: Homepage login with loginForm scope ===');
  await page.goto('https://www.kaloricketabulky.sk/', { waitUntil: 'networkidle2', timeout: 30000 });
  await page.waitForFunction(() => typeof angular !== 'undefined', { timeout: 10000 }).catch(() => {});

  const homepageResult = await page.evaluate(async (email, password, md5pass) => {
    if (typeof angular === 'undefined') return 'no angular';
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    if (!inj) return 'no injector';
    const rs = inj.get('$rootScope');

    // Find ALL scopes with any login-related data
    const loginScopes = [];
    function walk(scope, depth) {
      if (!scope || depth > 20) return;
      const keys = Object.keys(scope).filter(k => k.charAt(0) !== '$');
      const hasLogin = keys.some(k => k.toLowerCase().includes('login'));
      const hasFn = typeof scope.login === 'function';
      if (hasLogin || hasFn) {
        loginScopes.push({
          depth,
          keys: keys.filter(k => typeof scope[k] !== 'function').slice(0, 20),
          funcs: keys.filter(k => typeof scope[k] === 'function'),
          loginFn: hasFn ? scope.login.toString().substring(0, 800) : 'none',
          loginForm: scope.loginForm ? JSON.stringify(scope.loginForm) : 'none'
        });
      }
      let child = scope.$$childHead;
      while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
    }
    walk(rs, 0);

    return JSON.stringify(loginScopes);
  }, email, password, md5pass);
  console.log('\nHomepage login scopes:', homepageResult);

  // Now try to call login with the correct loginForm
  const loginCallResult = await page.evaluate(async (email, password, md5pass) => {
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    const rs = inj.get('$rootScope');

    let loginScope = null;
    function walk(scope, depth) {
      if (!scope || depth > 20 || loginScope) return;
      if (scope.loginForm && typeof scope.login === 'function') loginScope = scope;
      let child = scope.$$childHead;
      while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
    }
    walk(rs, 0);
    if (!loginScope) return 'no loginForm scope';

    // Set credentials
    loginScope.loginForm.email = email;
    loginScope.loginForm.password = password;
    loginScope.$apply();

    // Get login function source
    const fnSrc = loginScope.login.toString();

    // Call login
    try {
      const result = loginScope.login();
      if (result && typeof result.then === 'function') {
        const r = await result;
        return 'promise: ' + JSON.stringify(r).substring(0, 300) + ' | fn: ' + fnSrc.substring(0, 500);
      }
      await new Promise(r => setTimeout(r, 3000));
      return 'result: ' + (typeof result) + '=' + JSON.stringify(result).substring(0, 100) + ' | fn: ' + fnSrc.substring(0, 500);
    } catch (e) {
      return 'error: ' + e.message + ' | fn: ' + fnSrc.substring(0, 500);
    }
  }, email, password, md5pass);
  console.log('\nLogin call:', loginCallResult);

  await new Promise(r => setTimeout(r, 3000));
  await page.reload({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});

  let loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
  console.log('Logged in (A):', loggedIn);

  // APPROACH B: /login page — find the bundled JS login code
  if (loggedIn !== '1') {
    console.log('\n=== APPROACH B: Analyze bundledJs.js login code ===');
    await page.goto('https://www.kaloricketabulky.sk/login', { waitUntil: 'networkidle2', timeout: 30000 });

    // Get the login function from the /login page controller
    const loginPageFn = await page.evaluate(() => {
      if (typeof angular === 'undefined') return 'no angular';
      const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
      const inj = angular.element(el).injector();
      const rs = inj.get('$rootScope');

      const results = [];
      function walk(scope, depth) {
        if (!scope || depth > 20) return;
        if (typeof scope.login === 'function') {
          results.push({
            depth,
            loginFn: scope.login.toString().substring(0, 1000),
            userData: scope.user ? JSON.stringify(scope.user) : 'none',
            loginFormData: scope.loginForm ? JSON.stringify(scope.loginForm) : 'none'
          });
        }
        let child = scope.$$childHead;
        while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
      }
      walk(rs, 0);
      return JSON.stringify(results);
    });
    console.log('\n/login page login functions:', loginPageFn);

    // Also fetch and analyze bundledJs.js for the login endpoint
    const bundleAnalysis = await page.evaluate(async () => {
      const resp = await fetch('/wro/bundledJs.js?v=05bed406b8f7f589e69bc8ba3fa44e3b');
      const text = await resp.text();

      // Search for different URL patterns
      const patterns = ['login/create', 'user/login', 'user/signin', 'user/auth', '/login', '/auth', 'loginUser', 'authenticat'];
      const found = {};
      for (const pat of patterns) {
        let idx = text.indexOf(pat);
        if (idx !== -1) {
          found[pat] = text.substring(Math.max(0, idx - 200), idx + 200);
        }
      }

      // Also find hex_md5 or any MD5 function
      const md5idx = text.indexOf('hex_md5');
      if (md5idx !== -1) {
        found['hex_md5'] = text.substring(Math.max(0, md5idx - 100), md5idx + 200);
      }

      // Search for the string "create" near "login"
      let searchIdx = 0;
      const createNearLogin = [];
      while ((searchIdx = text.indexOf('login', searchIdx)) !== -1 && createNearLogin.length < 5) {
        const context = text.substring(Math.max(0, searchIdx - 50), searchIdx + 50);
        if (context.includes('create') || context.includes('Create')) {
          createNearLogin.push(context);
        }
        searchIdx += 5;
      }
      found['create_near_login'] = createNearLogin;

      return found;
    });
    console.log('\nBundle analysis:');
    for (const [key, val] of Object.entries(bundleAnalysis)) {
      console.log(`  ${key}:`, typeof val === 'string' ? val.substring(0, 300) : JSON.stringify(val).substring(0, 300));
    }
  }

  // APPROACH C: Try the user/login endpoint with MD5 password
  if (loggedIn !== '1') {
    console.log('\n=== APPROACH C: user/login with MD5 ===');
    await page.goto('https://www.kaloricketabulky.sk/', { waitUntil: 'networkidle2', timeout: 30000 });

    const userLoginResult = await page.evaluate(async (email, md5pass) => {
      try {
        const resp = await fetch('/user/login', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, password: md5pass }),
          credentials: 'same-origin'
        });
        const text = await resp.text();
        return '/user/login JSON: ' + resp.status + ' ' + resp.url + ' body=' + text.substring(0, 200);
      } catch (e) {
        return '/user/login error: ' + e.message;
      }
    }, email, md5pass);
    console.log(userLoginResult);

    await page.reload({ waitUntil: 'networkidle2' });
    loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
    console.log('Logged in (C):', loggedIn);
  }

  if (loggedIn !== '1') {
    console.log('\nAll approaches failed.');
    await browser.close();
    process.exit(1);
  }

  // Navigate to diary
  console.log('\nNavigating to diary...');
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
          function findVal(o, p) { for (const x of p) { for (const k in o) { if (k.charAt(0)==='$') continue; if (k.toLowerCase().includes(x)) { const v=o[k]; if (typeof v==='number') return v; if (typeof v==='string') { const n=parseFloat(v.replace(',','.')); if (!isNaN(n)) return n; } } } } for (const k in o) { if (k.charAt(0)==='$') continue; const v=o[k]; if (v&&typeof v==='object'&&!Array.isArray(v)) { const s=findVal(v,p); if (s!==0) return s; } } return 0; }
          function findStr(o, p) { for (const x of p) { for (const k in o) { if (k.charAt(0)==='$') continue; if (k.toLowerCase().includes(x)&&typeof o[k]==='string'&&o[k].length>0) return o[k]; } } for (const k in o) { if (k.charAt(0)==='$') continue; const v=o[k]; if (v&&typeof v==='object'&&!Array.isArray(v)) { const s=findStr(v,p); if (s) return s; } } return ''; }
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
