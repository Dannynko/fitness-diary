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

  // Debug: print credential lengths (not values) to check for issues
  console.log('Email length:', email?.length, 'Password length:', password?.length);
  console.log('Email starts with:', email?.substring(0, 3), 'ends with:', email?.substring(email.length - 4));

  // Step 1: Fetch bundledJs.js to find the exact login function implementation
  console.log('\nStep 1: Analyzing KT login function...');
  await page.goto('https://www.kaloricketabulky.sk/login', { waitUntil: 'networkidle2', timeout: 30000 });

  const loginFnAnalysis = await page.evaluate(async () => {
    // Fetch the bundled JS
    const resp = await fetch('/wro/bundledJs.js?v=05bed406b8f7f589e69bc8ba3fa44e3b');
    const text = await resp.text();

    // Search for login function that posts to /login/create
    const results = [];

    // Find the section around "login/create"
    const createIdx = text.indexOf('login/create');
    if (createIdx !== -1) {
      results.push('login/create context: ' + text.substring(Math.max(0, createIdx - 300), createIdx + 200));
    }

    // Find password hashing
    const md5Patterns = ['md5', 'MD5', 'hex_md5', 'CryptoJS', 'digest', 'hashCode', 'sha1', 'sha256'];
    for (const pat of md5Patterns) {
      let idx = 0;
      while ((idx = text.indexOf(pat, idx)) !== -1 && results.length < 20) {
        const context = text.substring(Math.max(0, idx - 100), idx + 100);
        if (context.includes('password') || context.includes('pass') || context.includes('heslo')) {
          results.push(pat + ' near password: ' + context);
        }
        idx += pat.length;
      }
    }

    // Find "login" function definition
    const loginFnPatterns = [
      /\.login\s*=\s*function\s*\([^)]*\)\s*\{[^}]{0,1000}\}/g,
      /function\s+login\s*\([^)]*\)\s*\{[^}]{0,1000}\}/g,
      /login\s*:\s*function\s*\([^)]*\)\s*\{[^}]{0,1000}\}/g,
    ];
    for (const pat of loginFnPatterns) {
      let match;
      while ((match = pat.exec(text)) !== null && results.length < 30) {
        const fn = match[0];
        if (fn.includes('$http') || fn.includes('create') || fn.includes('password') || fn.includes('email')) {
          results.push('login fn: ' + fn.substring(0, 500));
        }
      }
    }

    // Also look for the scope's login function by searching for "loginForm" or "user.password"
    const userPassIdx = text.indexOf('.password');
    const nearPasswords = [];
    let searchIdx = 0;
    while ((searchIdx = text.indexOf('.password', searchIdx)) !== -1 && nearPasswords.length < 10) {
      const context = text.substring(Math.max(0, searchIdx - 200), searchIdx + 200);
      if (context.includes('md5') || context.includes('MD5') || context.includes('hex') || context.includes('hash') || context.includes('login') || context.includes('create')) {
        nearPasswords.push(context.substring(0, 300));
      }
      searchIdx += 10;
    }
    results.push('password contexts: ' + JSON.stringify(nearPasswords));

    return results;
  });

  for (const line of loginFnAnalysis) {
    console.log(line.substring(0, 500));
  }

  // Step 2: Check if the password field gets transformed before sending
  console.log('\n\nStep 2: Type credentials and intercept the actual POST...');

  // Intercept the POST to see exact payload
  let capturedBody = null;
  page.on('request', req => {
    if (req.url().includes('/login/create') && req.method() === 'POST') {
      capturedBody = req.postData();
      console.log('CAPTURED POST body:', capturedBody?.substring(0, 300));
    }
  });

  page.on('response', async res => {
    if (res.url().includes('/login/create')) {
      try {
        const body = await res.text();
        console.log('CAPTURED response:', body.substring(0, 300));
      } catch(e) {}
    }
  });

  // Type credentials
  await page.waitForFunction(() => typeof angular !== 'undefined', { timeout: 10000 }).catch(() => {});
  await new Promise(r => setTimeout(r, 1000));

  const emailField = await page.$('input[type="email"]');
  if (emailField && await emailField.boundingBox()) {
    await emailField.click({ clickCount: 3 });
    await emailField.type(email, { delay: 30 });
    console.log('Typed email');
  }

  const passField = await page.$('input[type="password"]');
  if (passField && await passField.boundingBox()) {
    await passField.click({ clickCount: 3 });
    await passField.type(password, { delay: 30 });
    console.log('Typed password');
  }

  await new Promise(r => setTimeout(r, 500));

  // Click login button
  await page.click('button[ng-click="login()"]');
  console.log('Clicked login button');

  // Wait for response
  await new Promise(r => setTimeout(r, 3000));

  let loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
  console.log('\nLogged in:', loggedIn);

  // Step 3: If the password hash doesn't match, try different hashing approaches
  if (loggedIn !== '1') {
    console.log('\n--- Trying different password formats ---');

    const hashVariants = [
      { name: 'md5(pass)', hash: crypto.createHash('md5').update(password).digest('hex') },
      { name: 'md5(pass.lower)', hash: crypto.createHash('md5').update(password.toLowerCase()).digest('hex') },
      { name: 'sha1(pass)', hash: crypto.createHash('sha1').update(password).digest('hex') },
      { name: 'sha256(pass)', hash: crypto.createHash('sha256').update(password).digest('hex') },
      { name: 'plain', hash: password },
      { name: 'md5(email+pass)', hash: crypto.createHash('md5').update(email + password).digest('hex') },
    ];

    for (const variant of hashVariants) {
      const result = await page.evaluate(async (email, passHash, variantName) => {
        try {
          const resp = await fetch('/login/create?format=json&voucher=false', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ email, password: passHash }),
            credentials: 'same-origin'
          });
          const data = await resp.json();
          return variantName + ': code=' + data.code + ' msg=' + (data.message || 'none');
        } catch (e) {
          return variantName + ': error ' + e.message;
        }
      }, email, variant.hash, variant.name);
      console.log('  ' + result);

      if (result.includes('code=0') || result.includes('code=1') || result.includes('code=2')) {
        // Success!
        await page.reload({ waitUntil: 'networkidle2' });
        loggedIn = await page.evaluate(() => document.getElementById('logged')?.value || 'not-found');
        if (loggedIn === '1') {
          console.log('LOGIN SUCCESS with ' + variant.name);
          break;
        }
      }
    }
  }

  if (loggedIn !== '1') {
    console.log('\nLogin failed. All attempts returned "incorrect password or email".');
    console.log('Please verify GitHub Secrets KT_EMAIL and KT_PASSWORD are correct.');
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
