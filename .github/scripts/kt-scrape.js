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

  // Set a real user agent
  await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36');

  // Intercept network requests to see what login sends
  const loginRequests = [];
  page.on('request', req => {
    const url = req.url();
    if (url.includes('login') || url.includes('prihlasenie') || url.includes('auth') || url.includes('user')) {
      loginRequests.push({
        url: url,
        method: req.method(),
        postData: req.postData()?.substring(0, 500),
        headers: Object.fromEntries(Object.entries(req.headers()).filter(([k]) => k !== 'user-agent' && k !== 'accept'))
      });
    }
  });

  page.on('response', async res => {
    const url = res.url();
    if (url.includes('login') || url.includes('prihlasenie') || url.includes('auth')) {
      const status = res.status();
      const location = res.headers()['location'] || '';
      console.log(`  Response: ${res.request().method()} ${url} -> ${status} ${location}`);
    }
  });

  // Step 1: Go to homepage
  console.log('Loading KT homepage...');
  await page.goto('https://www.kaloricketabulky.sk/', { waitUntil: 'networkidle2', timeout: 30000 });
  console.log('Page loaded:', page.url());

  // Step 2: Find the login button/link and click it
  console.log('\nLooking for login button...');
  const loginButtonInfo = await page.evaluate(() => {
    // Look for any element that says "Prihlásiť" or similar
    const allElements = document.querySelectorAll('a, button, span, div, md-button');
    const candidates = [];
    for (const el of allElements) {
      const text = el.textContent?.trim().toLowerCase() || '';
      const href = el.getAttribute('href') || '';
      const ngClick = el.getAttribute('ng-click') || '';
      const uiSref = el.getAttribute('ui-sref') || '';
      if (text.includes('prihlás') || text.includes('login') || text.includes('prihlás') ||
          href.includes('prihlasenie') || href.includes('login') ||
          ngClick.includes('login') || ngClick.includes('prihlasenie') || ngClick.includes('openLogin') ||
          uiSref.includes('login') || uiSref.includes('prihlasenie')) {
        candidates.push({
          tag: el.tagName,
          text: text.substring(0, 50),
          href: href,
          ngClick: ngClick,
          uiSref: uiSref,
          classes: el.className?.substring?.(0, 80) || '',
          id: el.id,
          visible: el.offsetWidth > 0 && el.offsetHeight > 0
        });
      }
    }
    return candidates;
  });
  console.log('Login buttons found:', JSON.stringify(loginButtonInfo, null, 2));

  // Click the login button
  let clicked = false;
  for (const btn of loginButtonInfo) {
    if (!btn.visible) continue;
    const selector = btn.id ? '#' + btn.id :
      btn.ngClick ? `[ng-click="${btn.ngClick}"]` :
      btn.uiSref ? `[ui-sref="${btn.uiSref}"]` :
      null;
    if (selector) {
      try {
        await page.click(selector);
        clicked = true;
        console.log('Clicked:', selector);
        break;
      } catch (e) {
        console.log('Click failed for', selector, e.message);
      }
    }
  }

  if (!clicked) {
    // Try clicking by text content
    console.log('Trying to click by text...');
    clicked = await page.evaluate(() => {
      const all = document.querySelectorAll('a, button, span, md-button');
      for (const el of all) {
        const text = el.textContent?.trim().toLowerCase() || '';
        if ((text.includes('prihlás') || text === 'prihlásenie' || text.includes('prihlásiť sa')) && el.offsetWidth > 0) {
          el.click();
          return true;
        }
      }
      return false;
    });
    console.log('Text click:', clicked);
  }

  // Wait for dialog to appear
  await new Promise(r => setTimeout(r, 2000));

  // Step 3: Find the login form inputs
  console.log('\nLooking for login form inputs...');
  const formInfo = await page.evaluate(() => {
    const inputs = document.querySelectorAll('input');
    const visible = [];
    for (const inp of inputs) {
      if (inp.offsetWidth > 0 || inp.offsetHeight > 0 || inp.type === 'hidden') {
        const ngModel = inp.getAttribute('ng-model') || '';
        visible.push({
          type: inp.type,
          name: inp.name,
          id: inp.id,
          placeholder: inp.placeholder,
          ngModel: ngModel,
          visible: inp.offsetWidth > 0 && inp.offsetHeight > 0,
          value: inp.value?.substring(0, 20)
        });
      }
    }
    // Also look for md-input-container (Angular Material)
    const mdInputs = document.querySelectorAll('md-input-container input');
    const mdInfo = [];
    for (const inp of mdInputs) {
      mdInfo.push({
        type: inp.type,
        ngModel: inp.getAttribute('ng-model') || '',
        visible: inp.offsetWidth > 0 && inp.offsetHeight > 0
      });
    }
    // Also check for login dialog
    const dialogs = document.querySelectorAll('md-dialog, .md-dialog-container, [role="dialog"]');
    return {
      allInputs: visible,
      mdInputs: mdInfo,
      dialogCount: dialogs.length,
      bodyHTML: document.body.innerHTML.substring(0, 500)
    };
  });
  console.log('Inputs:', JSON.stringify(formInfo.allInputs, null, 2));
  console.log('MD inputs:', JSON.stringify(formInfo.mdInputs, null, 2));
  console.log('Dialogs:', formInfo.dialogCount);

  // Try navigating to #/prihlasenie hash route
  if (!formInfo.mdInputs.some(i => i.ngModel.includes('loginForm'))) {
    console.log('\nTrying #/prihlasenie route...');
    await page.evaluate(() => { window.location.hash = '#/prihlasenie'; });
    await new Promise(r => setTimeout(r, 3000));

    const formInfo2 = await page.evaluate(() => {
      const inputs = document.querySelectorAll('input');
      const visible = [];
      for (const inp of inputs) {
        if (inp.offsetWidth > 0 && inp.offsetHeight > 0) {
          visible.push({
            type: inp.type,
            ngModel: inp.getAttribute('ng-model') || '',
            placeholder: inp.placeholder
          });
        }
      }
      return visible;
    });
    console.log('Inputs after hash nav:', JSON.stringify(formInfo2, null, 2));
  }

  // Step 4: Type credentials using Puppeteer (like a real user)
  console.log('\nAttempting to type credentials...');

  // Try to find and type into email field
  const emailSelectors = [
    'input[ng-model="loginForm.email"]',
    'input[type="email"]',
    'input[name="email"]',
    'input[placeholder*="mail"]',
    'input[placeholder*="Mail"]',
    'md-input-container input[type="email"]'
  ];

  let emailTyped = false;
  for (const sel of emailSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const box = await el.boundingBox();
        if (box) {
          await el.click();
          await el.type(process.env.KT_EMAIL, { delay: 50 });
          emailTyped = true;
          console.log('Typed email into:', sel);
          break;
        }
      }
    } catch (e) {}
  }

  if (!emailTyped) {
    console.log('Could not find email input to type into');
  }

  // Try to find and type into password field
  const passSelectors = [
    'input[ng-model="loginForm.password"]',
    'input[type="password"]',
    'input[name="password"]'
  ];

  let passTyped = false;
  for (const sel of passSelectors) {
    try {
      const el = await page.$(sel);
      if (el) {
        const box = await el.boundingBox();
        if (box) {
          await el.click();
          await el.type(process.env.KT_PASSWORD, { delay: 50 });
          passTyped = true;
          console.log('Typed password into:', sel);
          break;
        }
      }
    } catch (e) {}
  }

  if (!passTyped) {
    console.log('Could not find password input to type into');
  }

  // Step 5: Click submit button
  if (emailTyped && passTyped) {
    console.log('\nLooking for submit button...');
    const submitted = await page.evaluate(() => {
      // Look for submit button in dialog
      const buttons = document.querySelectorAll('button, md-button, [type="submit"]');
      for (const btn of buttons) {
        const text = btn.textContent?.trim().toLowerCase() || '';
        if ((text.includes('prihlás') || text.includes('login') || text.includes('odoslať') || text.includes('potvrdiť')) &&
            btn.offsetWidth > 0 && btn.offsetHeight > 0) {
          btn.click();
          return 'clicked: ' + text;
        }
      }
      // Try form submit
      const forms = document.querySelectorAll('form');
      for (const form of forms) {
        if (form.querySelector('input[type="password"]')) {
          form.submit();
          return 'form submitted';
        }
      }
      return 'no submit found';
    });
    console.log('Submit result:', submitted);

    // Wait for login to complete
    await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 10000 }).catch(() => {});
    await new Promise(r => setTimeout(r, 2000));
  }

  console.log('\nCurrent URL:', page.url());
  const loggedIn = await page.evaluate(() => {
    const el = document.getElementById('logged');
    return el ? el.value : 'not-found';
  });
  console.log('Logged in:', loggedIn);

  console.log('\nAll login-related requests:');
  for (const req of loginRequests) {
    console.log('  ', req.method, req.url);
    if (req.postData) console.log('    POST data:', req.postData);
  }

  // If still not logged in, try a different approach: use $http directly
  if (loggedIn !== '1') {
    console.log('\n--- Direct $http approach ---');
    const httpResult = await page.evaluate(async (email, password) => {
      if (typeof angular === 'undefined') return 'no angular';
      const el = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
      const inj = angular.element(el).injector();
      if (!inj) return 'no injector';

      const $http = inj.get('$http');

      // Try form-encoded POST to /user/login
      try {
        const resp = await $http({
          method: 'POST',
          url: '/user/login',
          data: 'email=' + encodeURIComponent(email) + '&password=' + encodeURIComponent(password),
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
        });
        return 'form-encoded: ' + resp.status + ' ' + JSON.stringify(resp.data).substring(0, 200);
      } catch (e1) {
        // Try JSON POST
        try {
          const resp2 = await $http.post('/user/login', { email: email, password: password });
          return 'json: ' + resp2.status + ' ' + JSON.stringify(resp2.data).substring(0, 200);
        } catch (e2) {
          // Try other endpoints
          const endpoints = ['/api/user/login', '/api/v1/user/login', '/api/login', '/login'];
          for (const ep of endpoints) {
            try {
              const resp3 = await $http({
                method: 'POST',
                url: ep,
                data: 'email=' + encodeURIComponent(email) + '&password=' + encodeURIComponent(password),
                headers: { 'Content-Type': 'application/x-www-form-urlencoded' }
              });
              return ep + ' form: ' + resp3.status;
            } catch (e3) {
              try {
                const resp4 = await $http.post(ep, { email, password });
                return ep + ' json: ' + resp4.status;
              } catch (e4) {}
            }
          }
          return 'all failed. e1: ' + e1.status + ' ' + JSON.stringify(e1.data).substring(0, 100) +
                 ' e2: ' + e2.status + ' ' + JSON.stringify(e2.data).substring(0, 100);
        }
      }
    }, process.env.KT_EMAIL, process.env.KT_PASSWORD);
    console.log('$http result:', httpResult);

    await page.reload({ waitUntil: 'networkidle2' });
    const loggedIn2 = await page.evaluate(() => {
      const el = document.getElementById('logged');
      return el ? el.value : 'not-found';
    });
    console.log('Logged in after $http:', loggedIn2);
  }

  // Check if logged in, navigate to diary
  const finalLoggedIn = await page.evaluate(() => {
    const el = document.getElementById('logged');
    return el ? el.value : 'not-found';
  });

  if (finalLoggedIn !== '1') {
    console.log('\nLogin failed after all attempts. Dumping page state...');
    const pageState = await page.evaluate(() => {
      return {
        title: document.title,
        url: window.location.href,
        cookies: document.cookie.substring(0, 200),
        hiddenInputs: [...document.querySelectorAll('input[type="hidden"]')].map(i => i.name + '=' + i.value?.substring(0, 30)),
        loggedValue: document.getElementById('logged')?.value
      };
    });
    console.log('Page state:', JSON.stringify(pageState, null, 2));
    await browser.close();
    process.exit(1);
  }

  // Navigate to diary
  console.log('\nLogged in! Navigating to diary...');
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
