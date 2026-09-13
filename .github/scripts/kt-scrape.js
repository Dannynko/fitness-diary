const puppeteer = require('puppeteer');

const GIST_ID = 'ffe6105f3e59d233d6107f50ac5cf9ab';
const TOKEN = process.env.GH_GIST_TOKEN;
const today = new Date().toISOString().split('T')[0];

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Intercept network to discover login API
  const apiCalls = [];
  page.on('response', resp => {
    const u = resp.url();
    if (u.includes('kaloricketabulky') && !u.includes('.css') && !u.includes('.js') && !u.includes('.png') && !u.includes('.jpg')) {
      apiCalls.push({ url: u, status: resp.status() });
    }
  });

  // Go to KT main page first, let Angular load
  console.log('Loading KT...');
  await page.goto('https://www.kaloricketabulky.sk/', { waitUntil: 'networkidle2', timeout: 30000 });

  // Use Angular's own login service
  console.log('Attempting Angular login...');
  const loginResult = await page.evaluate(async (email, password) => {
    try {
      if (typeof angular === 'undefined') return { ok: false, err: 'no angular' };
      const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
      const inj = angular.element(el).injector();
      if (!inj) return { ok: false, err: 'no injector' };

      // Try to find AuthService or UserService
      const serviceNames = ['AuthService', 'UserService', 'loginService', 'authService', 'userService', 'auth', 'Auth'];
      let authSvc = null;
      for (const name of serviceNames) {
        try { authSvc = inj.get(name); if (authSvc) break; } catch(e) {}
      }

      // List all registered services for debugging
      const registeredServices = [];
      try {
        const providerInjector = inj.get('$injector');
        // Angular doesn't expose service list easily, try known patterns
        const commonNames = ['$http', 'AuthService', 'UserService', 'loginService', 'authService', 'sessionService', 'AccountService', 'userService'];
        for (const n of commonNames) {
          try { if (inj.get(n)) registeredServices.push(n); } catch(e) {}
        }
      } catch(e) {}

      // Use $http directly to try login endpoints
      const $http = inj.get('$http');
      const endpoints = [
        { url: '/login', data: { email, password } },
        { url: '/api/login', data: { email, password } },
        { url: '/api/v1/login', data: { email, password } },
        { url: '/api/v1/user/login', data: { email, password } },
        { url: '/user/login', data: { email, password } },
        { url: '/auth/login', data: { email, password } },
      ];

      for (const ep of endpoints) {
        try {
          const resp = await new Promise((resolve, reject) => {
            $http.post(ep.url, ep.data).then(
              r => resolve({ ok: true, status: r.status, data: JSON.stringify(r.data).substring(0, 300), url: ep.url }),
              e => resolve({ ok: false, status: e.status, data: JSON.stringify(e.data).substring(0, 300), url: ep.url })
            );
          });
          if (resp.ok) return { ...resp, services: registeredServices };
          registeredServices.push(ep.url + ':' + resp.status);
        } catch(e) {}
      }

      return { ok: false, err: 'all endpoints failed', services: registeredServices };
    } catch(e) {
      return { ok: false, err: e.message };
    }
  }, process.env.KT_EMAIL, process.env.KT_PASSWORD);

  console.log('Login result:', JSON.stringify(loginResult));

  // Log API calls we intercepted
  console.log('API calls:', JSON.stringify(apiCalls.slice(-20)));

  if (loginResult.ok) {
    await page.reload({ waitUntil: 'networkidle2' });
  }

  const loggedIn = await page.evaluate(() => {
    const el = document.getElementById('logged');
    return el ? el.value : 'not-found';
  });
  console.log('Logged in:', loggedIn);

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
