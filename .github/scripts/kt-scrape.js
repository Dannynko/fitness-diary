const puppeteer = require('puppeteer');

const GIST_ID = 'ffe6105f3e59d233d6107f50ac5cf9ab';
const TOKEN = process.env.GH_GIST_TOKEN;
const today = new Date().toISOString().split('T')[0];

(async () => {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-blink-features=AutomationControlled'],
    defaultViewport: { width: 1280, height: 800 }
  });
  const page = await browser.newPage();
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Log all POST requests to understand login flow
  page.on('request', req => {
    if (req.method() === 'POST') {
      console.log(`  >> POST ${req.url()} body=${req.postData()?.substring(0, 200) || 'none'}`);
    }
  });
  page.on('response', async res => {
    if (res.url().includes('login') || res.url().includes('user')) {
      console.log(`  << ${res.request().method()} ${res.url()} -> ${res.status()} loc=${res.headers()['location'] || ''}`);
    }
  });

  // Navigate to /login page directly
  console.log('Step 1: Navigate to /login...');
  await page.goto('https://www.kaloricketabulky.sk/login', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('URL:', page.url());

  // Wait for Angular
  await page.waitForFunction(() => typeof angular !== 'undefined', { timeout: 10000 }).catch(() => {});

  // Show the login form by setting registerIncludeStep = 5
  console.log('\nStep 2: Show login form (registerIncludeStep = 5)...');
  const showResult = await page.evaluate(() => {
    if (typeof angular === 'undefined') return 'no angular';
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    if (!inj) return 'no injector';
    const rs = inj.get('$rootScope');

    let targetScope = null;
    function walk(scope, depth) {
      if (!scope || depth > 20 || targetScope) return;
      if ('registerIncludeStep' in scope || scope.loginForm) targetScope = scope;
      let child = scope.$$childHead;
      while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
    }
    walk(rs, 0);
    if (!targetScope) return 'no scope with registerIncludeStep';

    targetScope.registerIncludeStep = 5;
    targetScope.$apply();
    return 'set to 5, loginForm=' + JSON.stringify(targetScope.loginForm || 'undefined');
  });
  console.log('Show result:', showResult);

  // Wait for form to render
  await new Promise(r => setTimeout(r, 1000));

  // Check what inputs are now visible
  const visibleInputs = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    return [...inputs].filter(i => i.offsetWidth > 0 && i.offsetHeight > 0).map(i => ({
      type: i.type, name: i.name, ngModel: i.getAttribute('ng-model') || '', placeholder: i.placeholder
    }));
  });
  console.log('Visible inputs:', JSON.stringify(visibleInputs));

  // Try to type into email field
  let emailTyped = false;
  for (const sel of ['input[ng-model="loginForm.email"]', 'input[type="email"]:not([name="gSearch"])']) {
    try {
      const el = await page.$(sel);
      if (el && await el.boundingBox()) {
        await el.click({ clickCount: 3 });
        await el.type(process.env.KT_EMAIL, { delay: 30 });
        emailTyped = true;
        console.log('Typed email into:', sel);
        break;
      }
    } catch (e) { console.log('Email selector failed:', sel, e.message); }
  }

  // Try password field
  let passTyped = false;
  for (const sel of ['input[ng-model="loginForm.password"]', 'input[type="password"]']) {
    try {
      const el = await page.$(sel);
      if (el && await el.boundingBox()) {
        await el.click({ clickCount: 3 });
        await el.type(process.env.KT_PASSWORD, { delay: 30 });
        passTyped = true;
        console.log('Typed password into:', sel);
        break;
      }
    } catch (e) { console.log('Password selector failed:', sel, e.message); }
  }

  // If couldn't type, try setting through Angular scope
  if (!emailTyped || !passTyped) {
    console.log('\nFallback: Set credentials via Angular scope...');
    const setResult = await page.evaluate((email, password) => {
      const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
      const inj = angular.element(el).injector();
      const rs = inj.get('$rootScope');
      let loginScope = null;
      function walk(scope, depth) {
        if (!scope || depth > 20 || loginScope) return;
        if (scope.loginForm) loginScope = scope;
        let child = scope.$$childHead;
        while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
      }
      walk(rs, 0);
      if (!loginScope) return 'no login scope';

      loginScope.loginForm.email = email;
      loginScope.loginForm.password = password;
      loginScope.$apply();
      return 'set via scope, loginForm=' + JSON.stringify(loginScope.loginForm);
    }, process.env.KT_EMAIL, process.env.KT_PASSWORD);
    console.log('Scope set result:', setResult);
  }

  // Click the login button
  console.log('\nStep 3: Click login button...');

  // First try clicking the visible ng-click="login()" button
  const loginClicked = await page.evaluate(() => {
    const buttons = document.querySelectorAll('[ng-click="login()"]');
    for (const btn of buttons) {
      if (btn.offsetWidth > 0 && btn.offsetHeight > 0) {
        btn.click();
        return 'clicked visible button';
      }
    }
    // If none visible, click the first one anyway
    if (buttons.length > 0) {
      buttons[0].click();
      return 'clicked hidden button';
    }
    return 'no login button found';
  });
  console.log('Login click:', loginClicked);

  // Also try calling login() on scope
  console.log('\nStep 4: Call login() via scope...');
  const loginCallResult = await page.evaluate(async () => {
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    const rs = inj.get('$rootScope');
    let loginScope = null;
    function walk(scope, depth) {
      if (!scope || depth > 20 || loginScope) return;
      if (typeof scope.login === 'function' && scope.loginForm) loginScope = scope;
      let child = scope.$$childHead;
      while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
    }
    walk(rs, 0);
    if (!loginScope) return 'no login scope with login()';

    // Check what login function does
    const fnSource = loginScope.login.toString().substring(0, 500);

    // Verify credentials are set
    const form = loginScope.loginForm;

    // Call it
    try {
      const result = loginScope.login();
      // Wait for any promises
      if (result && typeof result.then === 'function') {
        const r = await result;
        return 'promise resolved: ' + JSON.stringify(r).substring(0, 200) + ' | fn: ' + fnSource;
      }
      await new Promise(r => setTimeout(r, 3000));
      return 'called (no promise): ' + (typeof result) + ' logged=' + (document.getElementById('logged')?.value) + ' | fn: ' + fnSource;
    } catch (e) {
      return 'error: ' + e.message + ' | fn: ' + fnSource;
    }
  });
  console.log('Login call result:', loginCallResult);

  // Wait and check
  await new Promise(r => setTimeout(r, 3000));
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 }).catch(() => {});

  let loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
  console.log('\nLogged in:', loggedIn);

  // If still not logged in, try approach 2: direct form POST with Puppeteer request interception
  if (loggedIn !== '1') {
    console.log('\n--- Approach 2: Direct POST with cookies ---');

    // Get current cookies
    const cookies = await page.cookies();
    const jsessionid = cookies.find(c => c.name === 'JSESSIONID');
    console.log('JSESSIONID:', jsessionid?.value?.substring(0, 20));

    // Try POST /user/login with different parameter names
    const paramSets = [
      { email: process.env.KT_EMAIL, password: process.env.KT_PASSWORD },
      { username: process.env.KT_EMAIL, password: process.env.KT_PASSWORD },
      { j_username: process.env.KT_EMAIL, j_password: process.env.KT_PASSWORD },
      { email: process.env.KT_EMAIL, password: process.env.KT_PASSWORD, _remember: '1' },
    ];

    const endpoints = ['/user/login', '/j_spring_security_check', '/login'];

    for (const ep of endpoints) {
      for (const params of paramSets) {
        const body = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
        const paramNames = Object.keys(params).join(',');

        try {
          const result = await page.evaluate(async (endpoint, postBody) => {
            const resp = await fetch(endpoint, {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: postBody,
              redirect: 'follow',
              credentials: 'same-origin'
            });
            return {
              status: resp.status,
              url: resp.url,
              ok: resp.ok,
              redirected: resp.redirected
            };
          }, ep, body);

          console.log(`  ${ep} [${paramNames}]: ${result.status} -> ${result.url} redirected=${result.redirected}`);

          // Check if login succeeded
          if (!result.url.includes('/login')) {
            // Might have worked! Reload and check
            await page.reload({ waitUntil: 'networkidle2' });
            loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
            if (loggedIn === '1') {
              console.log('LOGIN SUCCESS with', ep, paramNames);
              break;
            }
          }
        } catch (e) {
          console.log(`  ${ep} [${paramNames}]: error ${e.message}`);
        }
      }
      if (loggedIn === '1') break;
    }
  }

  if (loggedIn !== '1') {
    console.log('\nAll login attempts failed.');
    await browser.close();
    process.exit(1);
  }

  // Navigate to diary
  console.log('\nLogged in! Navigating to diary...');
  await page.goto('https://www.kaloricketabulky.sk/moj-diar', { waitUntil: 'networkidle2', timeout: 20000 });

  console.log('Waiting for Angular diary data...');
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
        for (const k of timeKeys) {
          if (Array.isArray(time[k]) && time[k].length > 0) { foodArray = time[k]; break; }
        }
        if (!foodArray) continue;

        for (const food of foodArray) {
          function findVal(obj, patterns) {
            for (const p of patterns) {
              for (const k in obj) {
                if (k.charAt(0) === '$') continue;
                if (k.toLowerCase().includes(p)) {
                  const v = obj[k];
                  if (typeof v === 'number') return v;
                  if (typeof v === 'string') { const n = parseFloat(v.replace(',', '.')); if (!isNaN(n)) return n; }
                }
              }
            }
            for (const k in obj) {
              if (k.charAt(0) === '$') continue;
              const v = obj[k];
              if (v && typeof v === 'object' && !Array.isArray(v)) {
                const sub = findVal(v, patterns);
                if (sub !== 0) return sub;
              }
            }
            return 0;
          }
          function findStr(obj, patterns) {
            for (const p of patterns) {
              for (const k in obj) {
                if (k.charAt(0) === '$') continue;
                if (k.toLowerCase().includes(p) && typeof obj[k] === 'string' && obj[k].length > 0) return obj[k];
              }
            }
            for (const k in obj) {
              if (k.charAt(0) === '$') continue;
              const v = obj[k];
              if (v && typeof v === 'object' && !Array.isArray(v)) {
                const sub = findStr(v, patterns);
                if (sub) return sub;
              }
            }
            return '';
          }

          const title = findStr(food, ['title', 'name', 'nazov', 'nazev', 'food']);
          const amount = findVal(food, ['amount', 'quantity', 'mnozstvo', 'weight', 'hmotnost', 'grams']);
          const unit = findStr(food, ['unit', 'jednotk']) || 'g';
          const energy = findVal(food, ['energy', 'energi', 'kcal', 'kalori', 'calori']);
          const protein = findVal(food, ['protein', 'bielkov']);
          const carbs = findVal(food, ['carb', 'sachar', 'uhlov', 'hydrat']);
          const fat = findVal(food, ['fat', 'tuk', 'lipid']);

          result.push({
            title: String(title || food[Object.keys(food).filter(k => k.charAt(0) !== '$')[0]] || ''),
            amount: amount ? amount + ' ' + unit : '',
            energy, protein, carbs, fat,
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
    date: item.date,
    foodName: item.title,
    amount: item.amount,
    protein: item.protein || 0,
    carbs: item.carbs || 0,
    fat: item.fat || 0,
    caloriesIn: item.energy || 0,
    caloriesOut: 0,
    meal: item.meal,
    source: 'kt',
    ktId: item.title + '_' + item.date + '_' + item.energy
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
  data.records = merged.filter(r => {
    const key = r.ktId || r.id || (r.date + (r.foodName || '') + (r.source || ''));
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  const pushResp = await fetch('https://api.github.com/gists/' + GIST_ID, {
    method: 'PATCH',
    headers: { 'Authorization': 'token ' + TOKEN, 'Accept': 'application/vnd.github.v3+json' },
    body: JSON.stringify({ files: { 'fitness-data.json': { content: JSON.stringify(data) } } })
  });

  if (pushResp.ok) {
    console.log('Synced ' + records.length + ' items to Gist');
  } else {
    console.error('Gist push failed:', pushResp.status);
    process.exit(1);
  }
})();
