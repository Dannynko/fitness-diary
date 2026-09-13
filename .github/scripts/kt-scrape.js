const puppeteer = require('puppeteer');

const GIST_ID = 'ffe6105f3e59d233d6107f50ac5cf9ab';
const TOKEN = process.env.GH_GIST_TOKEN;
const today = new Date().toISOString().split('T')[0];

(async () => {
  const browser = await puppeteer.launch({ headless: true, args: ['--no-sandbox'] });
  const page = await browser.newPage();

  // Login - KT is Angular Material SPA, wait for Angular to render login form
  console.log('Navigating to KT login...');
  await page.goto('https://www.kaloricketabulky.sk/prihlasenie', { waitUntil: 'networkidle2', timeout: 30000 });

  // Wait for Angular to render the login form (md-input-container)
  await page.waitForFunction(() => {
    const inputs = document.querySelectorAll('input');
    for (const inp of inputs) {
      if (inp.offsetParent !== null && (inp.type === 'email' || inp.type === 'text' || inp.type === 'password')) return true;
    }
    return false;
  }, { timeout: 15000 }).catch(() => {});

  // Find visible input fields
  const fields = await page.evaluate(() => {
    const all = [...document.querySelectorAll('input')].filter(el => el.offsetParent !== null);
    return all.map(el => ({
      tag: el.tagName, type: el.type, name: el.name, id: el.id,
      placeholder: el.placeholder, ngModel: el.getAttribute('ng-model') || '',
      cls: el.className.substring(0, 80)
    }));
  });
  console.log('Visible inputs:', JSON.stringify(fields, null, 2));

  // Find email and password by ng-model or type
  let emailSel = null, pwSel = null;
  for (const f of fields) {
    const ngm = f.ngModel.toLowerCase();
    const sel = f.id ? '#' + f.id : (f.ngModel ? `input[ng-model="${f.ngModel}"]` : null);
    if (!sel) continue;
    if (ngm.includes('email') || ngm.includes('login') || f.type === 'email' || f.type === 'text' && !emailSel) emailSel = sel;
    if (ngm.includes('password') || ngm.includes('heslo') || f.type === 'password') pwSel = sel;
  }

  // Fallback: first text/email input = email, first password input = password
  if (!emailSel) emailSel = fields.find(f => f.type === 'email' || f.type === 'text') ? `input[type="${fields.find(f => f.type === 'email')?.type || 'text'}"]` : null;
  if (!pwSel) pwSel = 'input[type="password"]';

  console.log('Email selector:', emailSel, 'Password selector:', pwSel);

  if (!emailSel) {
    console.error('Could not find email field');
    // Dump all buttons for debugging
    const btns = await page.evaluate(() => [...document.querySelectorAll('button, a.md-button, .md-button')].filter(el => el.offsetParent !== null).map(el => ({ tag: el.tagName, text: el.textContent?.trim().substring(0, 50), cls: el.className.substring(0, 50) })));
    console.log('Visible buttons:', JSON.stringify(btns));
    await browser.close();
    process.exit(1);
  }

  await page.type(emailSel, process.env.KT_EMAIL);
  await page.type(pwSel, process.env.KT_PASSWORD);

  // Find submit button
  const submitBtn = await page.evaluate(() => {
    const btns = [...document.querySelectorAll('button, input[type="submit"], a.md-button')].filter(el => el.offsetParent !== null);
    for (const b of btns) {
      const txt = (b.textContent || '').toLowerCase();
      if (txt.includes('prihlás') || txt.includes('login') || txt.includes('prihlas') || b.type === 'submit') return true;
    }
    return false;
  });

  if (submitBtn) {
    await page.evaluate(() => {
      const btns = [...document.querySelectorAll('button, input[type="submit"], a.md-button')].filter(el => el.offsetParent !== null);
      for (const b of btns) {
        const txt = (b.textContent || '').toLowerCase();
        if (txt.includes('prihlás') || txt.includes('login') || txt.includes('prihlas') || b.type === 'submit') { b.click(); return; }
      }
    });
  } else {
    await page.keyboard.press('Enter');
  }

  await page.waitForNavigation({ waitUntil: 'networkidle2', timeout: 15000 }).catch(() => {});
  const url = page.url();
  console.log('After login, URL:', url);

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
