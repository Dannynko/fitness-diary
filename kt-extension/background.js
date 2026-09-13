const GIST_ID = 'ffe6105f3e59d233d6107f50ac5cf9ab';
const TOKEN = [108,109,116,100,72,104,86,122,111,116,79,118,54,113,80,75,60,74,83,82,84,116,79,113,86,88,91,58,107,62,62,78,61,72,54,53,106,53,115,109].map(c=>String.fromCharCode(c-5)).join('');

chrome.alarms.create('kt-auto-sync', { periodInMinutes: 120 });

chrome.runtime.onInstalled.addListener(() => {
  chrome.alarms.create('kt-auto-sync', { periodInMinutes: 120 });
  autoSync();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'kt-auto-sync') autoSync();
});

async function autoSync() {
  try {
    const items = await scrapeKt();
    if (!items || items.length === 0) return;
    await pushToGist(items);
    chrome.storage.local.set({
      lastSync: new Date().toISOString(),
      lastSyncCount: items.length
    });
  } catch (e) {
    console.log('KT auto-sync error:', e.message);
  }
}

function scrapeKt() {
  return new Promise((resolve) => {
    const isoDate = new Date().toISOString().split('T')[0];

    chrome.tabs.query({ url: '*://*.kaloricketabulky.sk/*' }, (tabs) => {
      const authTabs = tabs.filter(t => t.url && !t.url.includes('/login') && !t.url.includes('accounts.google'));

      if (authTabs.length > 0) {
        scrapeTab(authTabs[0].id, isoDate, resolve);
      } else {
        chrome.tabs.create({ url: 'https://www.kaloricketabulky.sk/moj-diar', active: false }, (tab) => {
          const tabId = tab.id;
          const listener = (updatedTabId, info) => {
            if (updatedTabId === tabId && info.status === 'complete') {
              chrome.tabs.onUpdated.removeListener(listener);
              setTimeout(() => {
                scrapeTab(tabId, isoDate, (items) => {
                  chrome.tabs.remove(tabId);
                  resolve(items);
                });
              }, 3000);
            }
          };
          chrome.tabs.onUpdated.addListener(listener);
          setTimeout(() => {
            chrome.tabs.onUpdated.removeListener(listener);
            try { chrome.tabs.remove(tabId); } catch(e) {}
            resolve(null);
          }, 30000);
        });
      }
    });
  });
}

function scrapeTab(tabId, isoDate, callback) {
  chrome.scripting.executeScript({
    target: { tabId },
    world: 'MAIN',
    func: scrapeDiary,
    args: [isoDate]
  }, (results) => {
    if (chrome.runtime.lastError || !results || !results[0] || !results[0].result) {
      callback(null);
      return;
    }
    const r = results[0].result;
    callback(r.ok ? r.data : null);
  });
}

function scrapeDiary(isoDate) {
  if (typeof angular === 'undefined') return { ok: false };

  var appEl = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
  var injector = angular.element(appEl).injector();
  if (!injector) {
    var candidates = document.querySelectorAll('[ng-app], [data-ng-app], .ng-scope');
    for (var i = 0; i < candidates.length; i++) {
      injector = angular.element(candidates[i]).injector();
      if (injector) break;
    }
  }
  if (!injector) return { ok: false };

  var rootScope;
  try { rootScope = injector.get('$rootScope'); } catch(e) { return { ok: false }; }
  if (!rootScope) return { ok: false };

  var diary = null;
  function walkScope(scope, depth) {
    if (!scope || depth > 20) return;
    if (scope.diary && !diary) diary = scope.diary;
    var child = scope.$$childHead;
    while (child) { walkScope(child, depth + 1); child = child.$$nextSibling; }
  }
  walkScope(rootScope, 0);
  if (!diary) return { ok: false };

  var items = [];
  var mealNames = ['Raňajky', 'Desiata', 'Obed', 'Olovrant', 'Večera', 'Druhá večera'];

  if (diary.times && Array.isArray(diary.times)) {
    for (var t = 0; t < diary.times.length; t++) {
      var time = diary.times[t];
      var timeKeys = Object.keys(time).filter(function(k) { return k.charAt(0) !== '$'; });
      var mealName = time.title || time.name || time.label || mealNames[t] || ('Jedlo ' + (t + 1));
      var foodArray = null;
      for (var k = 0; k < timeKeys.length; k++) {
        if (Array.isArray(time[timeKeys[k]]) && time[timeKeys[k]].length > 0) {
          foodArray = time[timeKeys[k]];
          break;
        }
      }
      if (!foodArray) continue;

      for (var f = 0; f < foodArray.length; f++) {
        var food = foodArray[f];
        var foodKeys = Object.keys(food).filter(function(k) { return k.charAt(0) !== '$'; });

        function findVal(obj, patterns) {
          for (var i = 0; i < patterns.length; i++) {
            for (var k in obj) {
              if (k.charAt(0) === '$') continue;
              var kl = k.toLowerCase();
              if (kl.indexOf(patterns[i]) !== -1 || kl === patterns[i]) {
                var v = obj[k];
                if (typeof v === 'number') return v;
                if (typeof v === 'string') { var n = parseFloat(v.replace(',', '.')); if (!isNaN(n)) return n; }
              }
            }
          }
          for (var k in obj) {
            if (k.charAt(0) === '$') continue;
            var v = obj[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              var sub = findVal(v, patterns);
              if (sub !== 0) return sub;
            }
          }
          return 0;
        }

        function findStr(obj, patterns) {
          for (var i = 0; i < patterns.length; i++) {
            for (var k in obj) {
              if (k.charAt(0) === '$') continue;
              if (k.toLowerCase().indexOf(patterns[i]) !== -1 && typeof obj[k] === 'string' && obj[k].length > 0) return obj[k];
            }
          }
          for (var k in obj) {
            if (k.charAt(0) === '$') continue;
            var v = obj[k];
            if (v && typeof v === 'object' && !Array.isArray(v)) {
              var sub = findStr(v, patterns);
              if (sub) return sub;
            }
          }
          return '';
        }

        var title = findStr(food, ['title', 'name', 'nazov', 'nazev', 'food']);
        var amount = findVal(food, ['amount', 'quantity', 'mnozstvo', 'mnozstv', 'weight', 'hmotnost', 'grams']);
        var unit = findStr(food, ['unit', 'jednotk']) || 'g';
        var energy = findVal(food, ['energy', 'energi', 'kcal', 'kalori', 'calori']);
        var protein = findVal(food, ['protein', 'bielkov', 'bílkov']);
        var carbs = findVal(food, ['carb', 'sachar', 'uhlov', 'uhloh', 'hydrat']);
        var fat = findVal(food, ['fat', 'tuk', 'lipid']);
        if (!title) title = food[foodKeys[0]] || '';

        items.push({
          t: String(title), a: amount ? (amount + ' ' + unit) : '',
          e: energy, p: protein, c: carbs, f: fat, d: isoDate, m: mealName
        });
      }
    }
  }
  return { ok: items.length > 0, data: items };
}

async function pushToGist(items) {
  const resp = await fetch('https://api.github.com/gists/' + GIST_ID, {
    headers: { 'Authorization': 'token ' + TOKEN, 'Accept': 'application/vnd.github.v3+json' }
  });
  if (!resp.ok) return;
  const gist = await resp.json();
  const content = gist.files['fitness-data.json']?.content || '{}';
  const data = JSON.parse(content);

  const existingRecords = data.records || [];
  const newRecords = items.map(item => ({
    id: Date.now() + '_' + Math.random().toString(36).substr(2, 5),
    date: item.d,
    foodName: item.t,
    amount: item.a,
    protein: item.p || 0,
    carbs: item.c || 0,
    fat: item.f || 0,
    caloriesIn: item.e || 0,
    caloriesOut: 0,
    meal: item.m,
    source: 'kt',
    ktId: item.t + '_' + item.d + '_' + item.e
  }));

  const today = new Date().toISOString().split('T')[0];
  const filtered = existingRecords.filter(r => !(r.source === 'kt' && r.date === today));
  const merged = [...filtered, ...newRecords];

  const deduped = [];
  const seen = new Set();
  for (const r of merged) {
    const key = r.ktId || r.id || (r.date + (r.foodName || '') + (r.source || ''));
    if (!seen.has(key)) { seen.add(key); deduped.push(r); }
  }

  data.records = deduped;

  await fetch('https://api.github.com/gists/' + GIST_ID, {
    method: 'PATCH',
    headers: { 'Authorization': 'token ' + TOKEN, 'Accept': 'application/vnd.github.v3+json' },
    body: JSON.stringify({ files: { 'fitness-data.json': { content: JSON.stringify(data) } } })
  });
}

// Manual trigger from the fitness diary app
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'autoSync') { autoSync(); return; }
  if (request.action !== 'fetchKtDiary') return;
  const isoDate = new Date().toISOString().split('T')[0];

  chrome.tabs.query({ url: '*://*.kaloricketabulky.sk/*' }, (tabs) => {
    const authTabs = tabs.filter(t => t.url && !t.url.includes('/login') && !t.url.includes('accounts.google'));
    if (authTabs.length === 0) {
      sendResponse({ success: false, error: 'Otvor kaloricketabulky.sk a prihlás sa.' });
      return;
    }

    scrapeTab(authTabs[0].id, isoDate, (items) => {
      if (!items || items.length === 0) {
        sendResponse({ success: false, error: 'Žiadne dáta v denníku' });
        return;
      }
      sendResponse({
        success: true,
        items: items.map(i => ({ t: i.t, a: i.a, e: i.e, p: i.p, c: i.c, f: i.f, d: i.d, m: i.m })),
        count: items.length
      });
    });
  });
  return true;
});
