const GIST_ID = 'ffe6105f3e59d233d6107f50ac5cf9ab';
const TOKEN = [108,109,116,100,72,104,86,122,111,116,79,118,54,113,80,75,60,74,83,82,84,116,79,113,86,88,91,58,107,62,62,78,61,72,54,53,106,53,115,109].map(c=>String.fromCharCode(c-5)).join('');

function scheduleAt20() {
  const now = new Date();
  const target = new Date(now);
  target.setHours(20, 0, 0, 0);
  if (now >= target) target.setDate(target.getDate() + 1);
  chrome.alarms.create('kt-auto-sync', { when: target.getTime(), periodInMinutes: 1440 });
}

scheduleAt20();

chrome.runtime.onInstalled.addListener(() => {
  scheduleAt20();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === 'kt-auto-sync') fullSync();
});

function getLast3Days() {
  const dates = [];
  for (let i = 0; i < 3; i++) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    dates.push(d.toISOString().split('T')[0]);
  }
  return dates;
}

async function quickSync() {
  try {
    const result = await scrapeKtQuick();
    if (!result) return;
    await pushToGist(result.items, result.dates);
    chrome.storage.local.set({
      lastSync: new Date().toISOString(),
      lastSyncCount: result.items.length
    });
  } catch (e) {
    console.log('KT quick-sync error:', e.message);
  }
}

async function fullSync() {
  try {
    const result = await scrapeKtFull();
    if (!result) return;
    await pushToGist(result.items, result.dates);
    chrome.storage.local.set({
      lastSync: new Date().toISOString(),
      lastSyncCount: result.items.length
    });
  } catch (e) {
    console.log('KT full-sync error:', e.message);
  }
}

function dateFromUrl(url) {
  const m = url && url.match(/[?&]date=(\d{4}-\d{2}-\d{2})/);
  return m ? m[1] : new Date().toISOString().split('T')[0];
}

function scrapeKtQuick() {
  return new Promise((resolve) => {
    chrome.tabs.query({ url: ['*://*.kaloricketabulky.sk/*', '*://kaloricketabulky.sk/*'] }, (tabs) => {
      const authTabs = tabs.filter(t => t.url && !t.url.includes('/login') && !t.url.includes('accounts.google'));

      if (authTabs.length > 0) {
        const isoDate = dateFromUrl(authTabs[0].url);
        scrapeTab(authTabs[0].id, isoDate, (items) => {
          resolve({ items: items || [], dates: [isoDate] });
        });
      } else {
        resolve(null);
      }
    });
  });
}

function scrapeKtFull() {
  return new Promise((resolve) => {
    const dates = getLast3Days();

    chrome.tabs.create({ url: 'https://www.kaloricketabulky.sk/moj-diar', active: false }, (tab) => {
      const tabId = tab.id;
      const listener = (updatedTabId, info) => {
        if (updatedTabId === tabId && info.status === 'complete') {
          chrome.tabs.onUpdated.removeListener(listener);
          chrome.tabs.get(tabId, (t) => {
            if (t.url && (t.url.includes('/login') || t.url.includes('accounts.google'))) {
              chrome.tabs.remove(tabId);
              resolve(null);
              return;
            }
            setTimeout(() => {
              scrapeMultipleDays(tabId, dates, (items) => {
                chrome.tabs.remove(tabId);
                resolve({ items: items || [], dates });
              });
            }, 3000);
          });
        }
      };
      chrome.tabs.onUpdated.addListener(listener);
      setTimeout(() => {
        chrome.tabs.onUpdated.removeListener(listener);
        try { chrome.tabs.remove(tabId); } catch(e) {}
        resolve(null);
      }, 90000);
    });
  });
}

function itemsFingerprint(items) {
  if (!items || items.length === 0) return '';
  return items.map(i => i.t + ':' + i.e).sort().join('|');
}

function scrapeMultipleDays(tabId, dates, callback) {
  const allItems = [];
  let i = 0;
  let todayFingerprint = null;

  function processNext() {
    if (i >= dates.length) {
      callback(allItems.length > 0 ? allItems : null);
      return;
    }
    const date = dates[i];
    i++;

    if (i === 1) {
      scrapeTab(tabId, date, (items) => {
        if (items) {
          todayFingerprint = itemsFingerprint(items);
          allItems.push(...items);
        }
        processNext();
      });
    } else {
      navigateToDate(tabId, date, () => {
        scrapeTab(tabId, date, (items) => {
          if (items) {
            const fp = itemsFingerprint(items);
            if (fp !== todayFingerprint) {
              allItems.push(...items);
            }
          }
          processNext();
        });
      });
    }
  }

  processNext();
}

function navigateToDate(tabId, isoDate, callback) {
  chrome.tabs.update(tabId, {
    url: 'https://www.kaloricketabulky.sk/moj-diar?date=' + isoDate
  }, () => {
    const listener = (id, info) => {
      if (id === tabId && info.status === 'complete') {
        chrome.tabs.onUpdated.removeListener(listener);
        setTimeout(() => {
          chrome.scripting.executeScript({
            target: { tabId },
            world: 'MAIN',
            func: changeDiaryDate,
            args: [isoDate]
          }, () => {
            setTimeout(callback, 2000);
          });
        }, 2000);
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
    setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      callback();
    }, 15000);
  });
}

function changeDiaryDate(isoDate) {
  if (typeof angular === 'undefined') return false;
  var appEl = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
  var injector = angular.element(appEl).injector();
  if (!injector) return false;

  var rootScope;
  try { rootScope = injector.get('$rootScope'); } catch(e) { return false; }

  var diaryScope = null;
  function walkScope(scope, depth) {
    if (!scope || depth > 20) return;
    if (scope.diary && !diaryScope) diaryScope = scope;
    var child = scope.$$childHead;
    while (child) { walkScope(child, depth + 1); child = child.$$nextSibling; }
  }
  walkScope(rootScope, 0);
  if (!diaryScope) return false;

  var target = new Date(isoDate + 'T12:00:00');
  var diary = diaryScope.diary;
  var dateProps = ['date', 'actualDate', 'currentDate', 'selectedDate', 'diaryDate', 'datum'];
  for (var i = 0; i < dateProps.length; i++) {
    if (diary.hasOwnProperty(dateProps[i])) {
      if (diary[dateProps[i]] instanceof Date) diary[dateProps[i]] = target;
      else diary[dateProps[i]] = isoDate;
    }
  }

  var methods = ['loadDiary','getDiary','load','refresh','changePeriod','setDate',
                 'goToDate','fetchDiary','loadDay','getDay','changeDate'];
  for (var i = 0; i < methods.length; i++) {
    if (typeof diaryScope[methods[i]] === 'function') try { diaryScope[methods[i]](target); } catch(e) {}
    if (typeof diary[methods[i]] === 'function') try { diary[methods[i]](target); } catch(e) {}
  }

  try { if (!diaryScope.$$phase && !rootScope.$$phase) diaryScope.$apply(); } catch(e) {}
  return true;
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

  function dateToLocal(d) {
    var y = d.getFullYear();
    var m = ('0' + (d.getMonth()+1)).slice(-2);
    var dd = ('0' + d.getDate()).slice(-2);
    return y + '-' + m + '-' + dd;
  }
  var dateProps = ['date', 'actualDate', 'currentDate', 'selectedDate', 'diaryDate', 'datum'];
  var foundDate = false;
  for (var dp = 0; dp < dateProps.length; dp++) {
    if (diary.hasOwnProperty(dateProps[dp])) {
      var dv = diary[dateProps[dp]];
      if (dv instanceof Date && !isNaN(dv)) {
        isoDate = dateToLocal(dv);
        foundDate = true;
        break;
      } else if (typeof dv === 'string' && /^\d{4}-\d{2}-\d{2}/.test(dv)) {
        isoDate = dv.substring(0, 10);
        foundDate = true;
        break;
      }
    }
  }
  if (!foundDate) {
    var dateEl = document.querySelector('.diary-date, .date-picker, [class*="date"] input, .diary h2, .diary h3');
    if (dateEl) {
      var txt = dateEl.value || dateEl.textContent || '';
      var dm = txt.match(/(\d{1,2})\.\s*(\d{1,2})\.\s*(\d{4})/);
      if (dm) isoDate = dm[3] + '-' + ('0'+dm[2]).slice(-2) + '-' + ('0'+dm[1]).slice(-2);
    }
  }

  var items = [];
  var mealNames = ['Raňajky', 'Desiata', 'Obed', 'Olovrant', 'Večera', 'Druhá večera'];

  if (diary.times && Array.isArray(diary.times)) {
    for (var t = 0; t < diary.times.length; t++) {
      var time = diary.times[t];
      var timeKeys = Object.keys(time).filter(function(k) { return k.charAt(0) !== '$'; });
      var mealName = time.title || time.name || time.label || mealNames[t] || ('Jedlo ' + (t + 1));
      var foodArray = null;
      if (time.foodstuff && Array.isArray(time.foodstuff) && time.foodstuff.length > 0) {
        foodArray = time.foodstuff;
      } else {
        for (var k = 0; k < timeKeys.length; k++) {
          if (Array.isArray(time[timeKeys[k]]) && time[timeKeys[k]].length > 0) {
            foodArray = time[timeKeys[k]];
            break;
          }
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

        var title = food.title || food.name || findStr(food, ['title', 'name', 'nazov', 'nazev', 'food']);
        var unitStr = food.unit || findStr(food, ['unit', 'jednotk']) || '';
        var energy = findVal(food, ['energy', 'energi', 'kcal', 'kalori', 'calori']);
        var protein = findVal(food, ['protein', 'bielkov', 'bílkov']);
        var carbs = findVal(food, ['carb', 'sachar', 'uhlov', 'uhloh', 'hydrat']);
        var fat = findVal(food, ['fat', 'tuk', 'lipid']);
        if (!title) title = food[foodKeys[0]] || '';

        items.push({
          t: String(title), a: unitStr,
          e: energy, p: protein, c: carbs, f: fat, d: isoDate, m: mealName,
          idx: t + '_' + f
        });
      }
    }
  }
  var deduped = [];
  var seen = {};
  for (var j = 0; j < items.length; j++) {
    var key = items[j].t + '|' + items[j].m;
    if (seen[key] !== undefined) {
      if (items[j].e > deduped[seen[key]].e) {
        deduped[seen[key]] = items[j];
      }
    } else {
      seen[key] = deduped.length;
      deduped.push(items[j]);
    }
  }
  return { ok: deduped.length > 0, data: deduped };
}

async function pushToGist(items, syncDates) {
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
    ktId: item.t + '_' + item.d + '_' + item.e + '_' + item.m + '_' + (item.idx || 0)
  }));

  const datesToClear = new Set(syncDates || items.map(i => i.d));
  const filtered = existingRecords.filter(r => !(r.source === 'kt' && datesToClear.has(r.date)));
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

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'autoSync') { quickSync(); return; }
  if (request.action !== 'fetchKtDiary') return;

  chrome.tabs.query({ url: ['*://*.kaloricketabulky.sk/*', '*://kaloricketabulky.sk/*'] }, (tabs) => {
    const authTabs = tabs.filter(t => t.url && !t.url.includes('/login') && !t.url.includes('accounts.google'));
    if (authTabs.length === 0) {
      sendResponse({ success: false, error: 'Otvor kaloricketabulky.sk a prihlás sa.' });
      return;
    }

    const isoDate = dateFromUrl(authTabs[0].url);
    scrapeTab(authTabs[0].id, isoDate, async (items) => {
      const resultItems = items || [];
      try {
        await pushToGist(resultItems, [isoDate]);
      } catch(e) { console.log('pushToGist err', e); }
      sendResponse({
        success: true,
        items: resultItems.map(i => ({ t: i.t, a: i.a, e: i.e, p: i.p, c: i.c, f: i.f, d: i.d, m: i.m })),
        count: resultItems.length,
        syncDate: isoDate
      });
    });
  });
  return true;
});
