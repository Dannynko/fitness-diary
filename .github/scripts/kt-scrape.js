const puppeteer = require('puppeteer');

const GIST_ID = 'ffe6105f3e59d233d6107f50ac5cf9ab';
const TOKEN = process.env.GH_GIST_TOKEN;
const today = new Date().toISOString().split('T')[0];

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Login: go to KT, get session cookie, then POST login with form encoding
  console.log('Loading KT homepage...');
  await page.goto('https://www.kaloricketabulky.sk/', { waitUntil: 'networkidle2', timeout: 30000 });

  // Use Angular $http with form encoding (not JSON)
  console.log('Logging in via Angular $http (form-encoded)...');
  const loginResult = await page.evaluate(async (email, password) => {
    if (typeof angular === 'undefined') return { ok: false, err: 'no angular' };
    const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
    const inj = angular.element(el).injector();
    if (!inj) return { ok: false, err: 'no injector' };
    const $http = inj.get('$http');

    // KT login endpoint expects form-encoded, not JSON
    const formData = 'email=' + encodeURIComponent(email) + '&password=' + encodeURIComponent(password) + '&_remember=1';

    const endpoints = [
      '/login',
      '/user/login',
    ];

    for (const url of endpoints) {
      try {
        const resp = await new Promise((resolve, reject) => {
          $http({
            method: 'POST',
            url: url,
            data: formData,
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
          }).then(
            r => resolve({ ok: true, status: r.status, url }),
            e => resolve({ ok: false, status: e.status, url, redirect: e.headers ? e.headers('location') : '' })
          );
        });
        if (resp.ok) return resp;
      } catch(e) {}
    }
    return { ok: false, err: 'all failed' };
  }, process.env.KT_EMAIL, process.env.KT_PASSWORD);

  console.log('Login result:', JSON.stringify(loginResult));
  await page.reload({ waitUntil: 'networkidle2', timeout: 20000 });

  const loggedIn = await page.evaluate(() => {
    const el = document.getElementById('logged');
    return el ? el.value : 'not-found';
  });
  console.log('Logged in:', loggedIn);

  if (loggedIn !== 'true' && loggedIn !== '1') {
    // Find ALL inputs including hidden ones, looking for login ng-models
    console.log('Searching for login form fields in DOM...');
    const allInputs = await page.evaluate(() => {
      return [...document.querySelectorAll('input')].map(el => ({
        type: el.type, name: el.name, id: el.id,
        ngModel: el.getAttribute('ng-model') || '',
        visible: el.offsetParent !== null,
        parent: el.parentElement?.className?.substring(0, 50) || ''
      })).filter(i => i.ngModel.match(/email|password|heslo|login|user/i) || i.type === 'password');
    });
    console.log('Login-related inputs:', JSON.stringify(allInputs, null, 2));

    // Set values via Angular scope directly
    const angularSetResult = await page.evaluate((email, password) => {
      if (typeof angular === 'undefined') return 'no angular';
      const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
      const inj = angular.element(el).injector();
      if (!inj) return 'no injector';
      const rs = inj.get('$rootScope');

      // Walk scope tree looking for email/password models
      let loginScope = null;
      function walk(scope, depth) {
        if (!scope || depth > 20) return;
        for (const k in scope) {
          if (k.charAt(0) === '$' || typeof scope[k] === 'function') continue;
          const kl = k.toLowerCase();
          if (kl === 'email' || kl === 'loginemail' || kl === 'user') {
            loginScope = scope;
          }
        }
        let child = scope.$$childHead;
        while (child) { walk(child, depth + 1); child = child.$$nextSibling; }
      }
      walk(rs, 0);

      if (loginScope) {
        // Try setting email/password on the scope
        if ('email' in loginScope) loginScope.email = email;
        if ('password' in loginScope) loginScope.password = password;
        if ('loginEmail' in loginScope) loginScope.loginEmail = email;
        if ('loginPassword' in loginScope) loginScope.loginPassword = password;
        loginScope.$apply();
        return 'set on scope: ' + Object.keys(loginScope).filter(k => k.charAt(0) !== '$' && typeof loginScope[k] !== 'function').join(', ');
      }

      // Try calling login function on rootScope
      function findLogin(scope, depth) {
        if (!scope || depth > 20) return null;
        for (const k in scope) {
          if (typeof scope[k] === 'function' && k.toLowerCase().includes('login')) {
            return { scope, fn: k };
          }
        }
        let child = scope.$$childHead;
        while (child) {
          const r = findLogin(child, depth + 1);
          if (r) return r;
          child = child.$$nextSibling;
        }
        return null;
      }

      const loginFn = findLogin(rs, 0);
      if (loginFn) {
        try {
          loginFn.scope[loginFn.fn](email, password);
          return 'called ' + loginFn.fn;
        } catch(e) {
          return 'fn error: ' + e.message;
        }
      }

      return 'no login scope/fn found';
    }, process.env.KT_EMAIL, process.env.KT_PASSWORD);
    console.log('Angular set result:', angularSetResult);

    await new Promise(r => setTimeout(r, 3000));
    await page.reload({ waitUntil: 'networkidle2' });

    const loggedIn2 = await page.evaluate(() => {
      const el = document.getElementById('logged');
      return el ? el.value : 'not-found';
    });
    console.log('Logged in after scope manipulation:', loggedIn2);
  }

  // Navigate to diary
  console.log('Navigating to diary...');
  await page.goto('https://www.kaloricketabulky.sk/moj-diar', { waitUntil: 'networkidle2', timeout: 20000 });

  // Wait for Angular to load diary data
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

  // Extract diary data
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

  // Build records
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

  // Fetch Gist
  const gistResp = await fetch('https://api.github.com/gists/' + GIST_ID, {
    headers: { 'Authorization': 'token ' + TOKEN, 'Accept': 'application/vnd.github.v3+json' }
  });
  const gist = await gistResp.json();
  const data = JSON.parse(gist.files?.['fitness-data.json']?.content || '{}');
  const existing = data.records || [];

  // Replace today's KT records
  const filtered = existing.filter(r => !(r.source === 'kt' && r.date === today));
  const merged = [...filtered, ...records];
  const seen = new Set();
  data.records = merged.filter(r => {
    const key = r.ktId || r.id || (r.date + (r.foodName || '') + (r.source || ''));
    if (seen.has(key)) return false;
    seen.add(key); return true;
  });

  // Push to Gist
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
