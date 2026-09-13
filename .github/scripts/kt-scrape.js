const puppeteer = require('puppeteer');
const crypto = require('crypto');

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

  const email = process.env.KT_EMAIL;
  const password = process.env.KT_PASSWORD;
  const md5pass = crypto.createHash('md5').update(password).digest('hex');
  console.log('MD5 of password:', md5pass);

  // Intercept responses to capture login response body
  const responseData = {};
  page.on('response', async res => {
    const url = res.url();
    if (url.includes('/login/create') || url.includes('/user/login') || url.includes('/user/signin')) {
      try {
        const body = await res.text();
        responseData[url] = { status: res.status(), body: body.substring(0, 500) };
        console.log(`  << ${res.request().method()} ${url} -> ${res.status()}`);
        console.log(`     body: ${body.substring(0, 300)}`);
      } catch (e) {
        console.log(`  << ${url} -> ${res.status()} (no body)`);
      }
    }
  });

  // Step 1: Go to /login and interact like a real user
  console.log('Step 1: Navigate to /login...');
  await page.goto('https://www.kaloricketabulky.sk/login', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for Angular
  await page.waitForFunction(() => typeof angular !== 'undefined', { timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));

  // Type email
  const emailField = await page.$('input[type="email"]');
  if (emailField && await emailField.boundingBox()) {
    await emailField.click({ clickCount: 3 });
    await emailField.type(email, { delay: 30 });
    console.log('Typed email');
  }

  // Type password
  const passField = await page.$('input[type="password"]');
  if (passField && await passField.boundingBox()) {
    await passField.click({ clickCount: 3 });
    await passField.type(password, { delay: 30 });
    console.log('Typed password');
  }

  // Wait a bit for Angular digest
  await new Promise(r => setTimeout(r, 500));

  // Dump ALL scope data to understand the login/registration context
  const scopeInfo = await page.evaluate(() => {
    if (typeof angular === 'undefined') return 'no angular';
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    if (!inj) return 'no injector';
    const rs = inj.get('$rootScope');

    const scopes = [];
    function walk(scope, depth) {
      if (!scope || depth > 15) return;
      const keys = Object.keys(scope).filter(k => k.charAt(0) !== '$' && typeof scope[k] !== 'function');
      const funcs = Object.keys(scope).filter(k => k.charAt(0) !== '$' && typeof scope[k] === 'function');
      if (keys.length > 0 || funcs.length > 0) {
        const data = {};
        for (const k of keys) {
          try {
            const v = scope[k];
            if (v === null || v === undefined) continue;
            if (typeof v === 'object') data[k] = JSON.stringify(v).substring(0, 100);
            else data[k] = v;
          } catch(e) {}
        }
        scopes.push({ depth, keys: data, funcs: funcs });
      }
      let child = scope.$$childHead;
      while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
    }
    walk(rs, 0);
    return JSON.stringify(scopes.slice(0, 10));
  });
  console.log('\nScope data:', scopeInfo);

  // Find and click the login/submit button
  console.log('\nStep 2: Click submit...');
  const buttons = await page.evaluate(() => {
    const all = document.querySelectorAll('[ng-click], button, [type="submit"]');
    return [...all].filter(e => e.offsetWidth > 0 && e.offsetHeight > 0).map(e => ({
      tag: e.tagName,
      text: e.textContent?.trim().substring(0, 50),
      ngClick: e.getAttribute('ng-click') || '',
      type: e.getAttribute('type') || ''
    }));
  });
  console.log('Visible clickable elements:', JSON.stringify(buttons));

  // Click the actual login button (not create/register)
  const clicked = await page.evaluate(() => {
    // Look for button that does login/signin (not create/register)
    const candidates = document.querySelectorAll('[ng-click]');
    for (const el of candidates) {
      const ngClick = el.getAttribute('ng-click') || '';
      const text = el.textContent?.trim().toLowerCase() || '';
      if (el.offsetWidth > 0 && el.offsetHeight > 0 &&
          (ngClick.includes('login') || ngClick.includes('signin') || ngClick.includes('prihlás')) &&
          !ngClick.includes('create') && !ngClick.includes('register')) {
        return 'found: ' + ngClick + ' text=' + text + ' (not clicking yet)';
      }
    }
    return 'no login-specific button';
  });
  console.log('Login button search:', clicked);

  // Click the visible login() button
  await page.evaluate(() => {
    const candidates = document.querySelectorAll('[ng-click]');
    for (const el of candidates) {
      const ngClick = el.getAttribute('ng-click') || '';
      if (el.offsetWidth > 0 && el.offsetHeight > 0 && ngClick.includes('login')) {
        el.click();
        return;
      }
    }
  });

  // Wait for response
  await new Promise(r => setTimeout(r, 3000));
  await page.waitForNetworkIdle({ timeout: 5000 }).catch(() => {});

  // Check logged in
  let loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
  console.log('\nLogged in after click:', loggedIn);

  // Step 3: Try direct POST approaches with MD5 password
  if (loggedIn !== '1') {
    console.log('\n--- Direct POST with MD5 password ---');

    // The Angular app sends to /login/create - but that might be registration
    // Try /user/login with MD5 password
    const attempts = [
      { url: '/user/login', type: 'form', params: { email, password: md5pass } },
      { url: '/user/login', type: 'form', params: { email, password } },
      { url: '/user/login', type: 'json', params: { email, password: md5pass } },
      { url: '/user/login', type: 'json', params: { email, password } },
      { url: '/login/auth', type: 'json', params: { email, password: md5pass } },
      { url: '/user/signin', type: 'json', params: { email, password: md5pass } },
      { url: '/api/login', type: 'json', params: { email, password: md5pass } },
    ];

    for (const attempt of attempts) {
      const result = await page.evaluate(async (url, type, params) => {
        try {
          const opts = {
            method: 'POST',
            credentials: 'same-origin',
            redirect: 'follow'
          };
          if (type === 'form') {
            opts.headers = { 'Content-Type': 'application/x-www-form-urlencoded' };
            opts.body = Object.entries(params).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');
          } else {
            opts.headers = { 'Content-Type': 'application/json' };
            opts.body = JSON.stringify(params);
          }
          const resp = await fetch(url, opts);
          const text = await resp.text();
          return { status: resp.status, url: resp.url, redirected: resp.redirected, body: text.substring(0, 200) };
        } catch (e) {
          return { error: e.message };
        }
      }, attempt.url, attempt.type, attempt.params);

      const paramDesc = attempt.type + ' ' + Object.keys(attempt.params).join(',');
      console.log(`  ${attempt.url} [${paramDesc}]: ${result.status || result.error} -> ${result.url || ''}`);
      if (result.body && !result.url?.includes('/login')) {
        console.log(`    body: ${result.body}`);
      }

      if (result.url && !result.url.includes('/login')) {
        await page.reload({ waitUntil: 'networkidle2' });
        loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
        if (loggedIn === '1') {
          console.log('LOGIN SUCCESS!');
          break;
        }
      }
    }
  }

  // Step 4: Try the homepage login flow (registerIncludeStep=5 with loginForm)
  if (loggedIn !== '1') {
    console.log('\n--- Homepage login flow ---');
    await page.goto('https://www.kaloricketabulky.sk/', { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForFunction(() => typeof angular !== 'undefined', { timeout: 10000 }).catch(() => {});

    const homepageLogin = await page.evaluate(async (email, password, md5pass) => {
      const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
      const inj = angular.element(el).injector();
      if (!inj) return 'no injector';
      const rs = inj.get('$rootScope');
      const $http = inj.get('$http');

      // Try posting to /login/create (same as what the Angular app does from /login page)
      try {
        const resp = await $http.post('/login/create?format=json&voucher=false', {
          email: email,
          password: md5pass
        });
        return 'create: ' + resp.status + ' ' + JSON.stringify(resp.data).substring(0, 300);
      } catch (e) {
        return 'create failed: ' + e.status + ' ' + JSON.stringify(e.data).substring(0, 300);
      }
    }, email, password, md5pass);
    console.log('Homepage login:', homepageLogin);

    await page.reload({ waitUntil: 'networkidle2' });
    loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
    console.log('Logged in after homepage login:', loggedIn);
  }

  // Step 5: Try finding the REAL login endpoint by looking at /login page source
  if (loggedIn !== '1') {
    console.log('\n--- Searching for login endpoint in JS ---');
    await page.goto('https://www.kaloricketabulky.sk/login', { waitUntil: 'networkidle2', timeout: 30000 });

    const jsSearch = await page.evaluate(() => {
      // Find all scripts and search for login-related endpoints
      const scripts = document.querySelectorAll('script');
      const matches = [];
      for (const s of scripts) {
        const text = s.textContent || '';
        // Search for URLs containing login, auth, signin
        const urlMatches = text.match(/['"][^'"]*(?:login|auth|signin|prihlasenie)[^'"]*['"]/gi);
        if (urlMatches) {
          matches.push(...urlMatches.map(m => m.substring(0, 100)));
        }
      }
      // Also check external script sources
      const srcs = [...scripts].filter(s => s.src).map(s => s.src);
      return { matches: matches.slice(0, 20), scriptSrcs: srcs.filter(s => s.includes('app') || s.includes('main') || s.includes('bundle')) };
    });
    console.log('JS login URLs:', JSON.stringify(jsSearch.matches));
    console.log('App scripts:', JSON.stringify(jsSearch.scriptSrcs));

    // Try to find login function in external scripts
    if (jsSearch.scriptSrcs.length > 0) {
      for (const src of jsSearch.scriptSrcs.slice(0, 2)) {
        console.log('\nFetching:', src);
        const scriptContent = await page.evaluate(async (url) => {
          const resp = await fetch(url);
          const text = await resp.text();
          // Find login-related code
          const lines = text.split('\n');
          const loginLines = [];
          for (let i = 0; i < lines.length; i++) {
            if (lines[i].match(/login|signin|prihlás/i) && lines[i].match(/\$http|fetch|post|url|endpoint/i)) {
              loginLines.push(lines[i].trim().substring(0, 200));
            }
          }
          // Also find the login function
          const loginFnMatch = text.match(/function\s+login\s*\([^)]*\)\s*\{[^}]{0,500}\}/);
          const loginFnMatch2 = text.match(/\.login\s*=\s*function\s*\([^)]*\)\s*\{[^}]{0,500}\}/);
          const loginFnMatch3 = text.match(/login\s*:\s*function\s*\([^)]*\)\s*\{[^}]{0,500}\}/);
          return {
            loginLines: loginLines.slice(0, 10),
            loginFn: (loginFnMatch || loginFnMatch2 || loginFnMatch3 || ['not found'])[0].substring(0, 500)
          };
        }, src);
        console.log('Login lines:', JSON.stringify(scriptContent.loginLines));
        console.log('Login fn:', scriptContent.loginFn);
      }
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
