chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action !== 'fetchKtDiary') return;

  const isoDate = new Date().toISOString().split('T')[0];

  chrome.tabs.query({url: '*://*.kaloricketabulky.sk/*'}, (tabs) => {
    const authTabs = tabs.filter(t => t.url && !t.url.includes('/login') && !t.url.includes('accounts.google'));
    if (authTabs.length === 0) {
      sendResponse({success: false, error: 'Otvor kaloricketabulky.sk a prihlás sa.'});
      return;
    }

    chrome.scripting.executeScript({
      target: {tabId: authTabs[0].id},
      world: 'MAIN',
      func: (isoDate) => {
        if (typeof angular === 'undefined') {
          return {ok: false, err: 'Angular nie je dostupný'};
        }

        // Get injector - works even without debug info
        var appEl = document.querySelector('[ng-app]') || document.querySelector('.ng-scope') || document.body;
        var injector = angular.element(appEl).injector();

        if (!injector) {
          // Try other elements
          var candidates = document.querySelectorAll('[ng-app], [data-ng-app], .ng-scope');
          for (var i = 0; i < candidates.length; i++) {
            injector = angular.element(candidates[i]).injector();
            if (injector) break;
          }
        }

        if (!injector) {
          return {ok: false, err: 'Injector nedostupný', debug: 'ng-app: ' + !!document.querySelector('[ng-app]') + ', ng-scope: ' + !!document.querySelector('.ng-scope')};
        }

        // Get $rootScope from injector
        var rootScope;
        try {
          rootScope = injector.get('$rootScope');
        } catch(e) {
          return {ok: false, err: 'rootScope error: ' + e.message};
        }

        if (!rootScope) {
          return {ok: false, err: '$rootScope je null'};
        }

        // Walk the scope tree to find 'diary'
        var diary = null;
        var scopeCount = 0;
        var allKeys = [];

        function walkScope(scope, depth) {
          if (!scope || depth > 20) return;
          scopeCount++;

          if (scope.diary && !diary) {
            diary = scope.diary;
          }

          // Collect non-$ keys for debugging
          if (depth < 5) {
            for (var k in scope) {
              if (scope.hasOwnProperty(k) && k.charAt(0) !== '$' && typeof scope[k] !== 'function') {
                allKeys.push(k + ':' + typeof scope[k]);
              }
            }
          }

          var child = scope.$$childHead;
          while (child) {
            walkScope(child, depth + 1);
            child = child.$$nextSibling;
          }
        }

        walkScope(rootScope, 0);

        if (!diary) {
          return {
            ok: false,
            err: 'diary nenájdený v scope strome',
            debug: 'Scopes: ' + scopeCount + ', Keys: ' + allKeys.slice(0, 50).join(', ')
          };
        }

        // Extract food items from diary
        var items = [];
        var diaryKeys = Object.keys(diary).filter(function(k) { return k.charAt(0) !== '$'; });
        var diaryDebug = {
          keys: diaryKeys,
          energyUnit: diary.energyUnit,
          timesCount: diary.times ? diary.times.length : 0
        };

        var mealNames = ['Raňajky', 'Desiata', 'Obed', 'Olovrant', 'Večera', 'Druhá večera'];

        if (diary.times && Array.isArray(diary.times)) {
          for (var t = 0; t < diary.times.length; t++) {
            var time = diary.times[t];
            var timeKeys = Object.keys(time).filter(function(k) { return k.charAt(0) !== '$'; });
            var mealName = time.title || time.name || time.label || mealNames[t] || ('Jedlo ' + (t + 1));

            // Find the food items array
            var foodArray = null;
            for (var k = 0; k < timeKeys.length; k++) {
              if (Array.isArray(time[timeKeys[k]]) && time[timeKeys[k]].length > 0) {
                foodArray = time[timeKeys[k]];
                diaryDebug.foodArrayKey = timeKeys[k];
                break;
              }
            }

            if (!foodArray) {
              if (t === 0) {
                diaryDebug.timeKeys = timeKeys;
                diaryDebug.timeSample = {};
                for (var k = 0; k < timeKeys.length; k++) {
                  var val = time[timeKeys[k]];
                  diaryDebug.timeSample[timeKeys[k]] = val === null || val === undefined
                    ? String(val)
                    : Array.isArray(val) ? 'Array(' + val.length + ')' : typeof val === 'object' ? JSON.stringify(val).substring(0, 100) : String(val).substring(0, 50);
                }
              }
              continue;
            }

            for (var f = 0; f < foodArray.length; f++) {
              var food = foodArray[f];
              var foodKeys = Object.keys(food).filter(function(k) { return k.charAt(0) !== '$'; });

              // Dump first item completely
              if (items.length === 0) {
                diaryDebug.foodKeys = foodKeys;
                diaryDebug.foodSample = {};
                for (var k = 0; k < foodKeys.length; k++) {
                  var v = food[foodKeys[k]];
                  diaryDebug.foodSample[foodKeys[k]] = v === null || v === undefined
                    ? String(v)
                    : typeof v === 'object' ? JSON.stringify(v).substring(0, 200) : String(v).substring(0, 80);
                }
              }

              function findVal(obj, patterns) {
                // Search top-level keys
                for (var i = 0; i < patterns.length; i++) {
                  for (var k in obj) {
                    if (k.charAt(0) === '$') continue;
                    var kl = k.toLowerCase();
                    if (kl.indexOf(patterns[i]) !== -1 || kl === patterns[i]) {
                      var v = obj[k];
                      if (typeof v === 'number') return {val: v, key: k};
                      if (typeof v === 'string') { var n = parseFloat(v.replace(',', '.')); if (!isNaN(n)) return {val: n, key: k}; }
                    }
                  }
                }
                // Search one level deep in sub-objects
                for (var k in obj) {
                  if (k.charAt(0) === '$') continue;
                  var v = obj[k];
                  if (v && typeof v === 'object' && !Array.isArray(v)) {
                    var sub = findVal(v, patterns);
                    if (sub.key) return {val: sub.val, key: k + '.' + sub.key};
                  }
                }
                return {val: 0, key: null};
              }

              function findStr(obj, patterns) {
                for (var i = 0; i < patterns.length; i++) {
                  for (var k in obj) {
                    if (k.charAt(0) === '$') continue;
                    if (k.toLowerCase().indexOf(patterns[i]) !== -1 && typeof obj[k] === 'string' && obj[k].length > 0) {
                      return obj[k];
                    }
                  }
                }
                // Search sub-objects
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
              var amountR = findVal(food, ['amount', 'quantity', 'mnozstvo', 'mnozstv', 'weight', 'hmotnost', 'grams']);
              var unit = findStr(food, ['unit', 'jednotk']) || 'g';
              var energyR = findVal(food, ['energy', 'energi', 'kcal', 'kalori', 'calori']);
              var proteinR = findVal(food, ['protein', 'bielkov', 'bílkov']);
              var carbsR = findVal(food, ['carb', 'sachar', 'uhlov', 'uhloh', 'hydrat']);
              var fatR = findVal(food, ['fat', 'tuk', 'lipid']);

              if (!title) title = food[foodKeys[0]] || '';

              // Log matched keys for first item
              if (items.length === 0) {
                diaryDebug.matchedKeys = {
                  energy: energyR.key + '=' + energyR.val,
                  protein: proteinR.key + '=' + proteinR.val,
                  carbs: carbsR.key + '=' + carbsR.val,
                  fat: fatR.key + '=' + fatR.val,
                  amount: amountR.key + '=' + amountR.val
                };
                // Also dump ALL numeric values
                diaryDebug.allNumbers = {};
                for (var k = 0; k < foodKeys.length; k++) {
                  var v = food[foodKeys[k]];
                  if (typeof v === 'number') diaryDebug.allNumbers[foodKeys[k]] = v;
                }
              }

              items.push({
                t: String(title),
                a: amountR.val ? (amountR.val + ' ' + unit) : '',
                e: energyR.val,
                p: proteinR.val,
                c: carbsR.val,
                f: fatR.val,
                d: isoDate,
                m: mealName
              });
            }
          }
        }

        return {
          ok: items.length > 0,
          data: items,
          diaryDebug: diaryDebug,
          scopeCount: scopeCount,
          err: items.length === 0 ? 'Žiadne jedlá' : null
        };
      },
      args: [isoDate]
    }, (results) => {
      if (chrome.runtime.lastError) {
        sendResponse({success: false, error: chrome.runtime.lastError.message});
        return;
      }
      if (!results || !results[0] || !results[0].result) {
        sendResponse({success: false, error: 'Skript sa nespustil'});
        return;
      }

      var r = results[0].result;

      if (!r.ok || !r.data || r.data.length === 0) {
        sendResponse({
          success: false,
          error: r.err || 'Žiadne dáta',
          debug: (r.debug || '') + (r.diaryDebug ? '\n' + JSON.stringify(r.diaryDebug, null, 1) : '')
        });
        return;
      }

      sendResponse({
        success: true,
        items: r.data,
        count: r.data.length,
        debug: JSON.stringify(r.diaryDebug, null, 1),
        foodSample: r.diaryDebug ? r.diaryDebug.foodSample : null,
        matchedKeys: r.diaryDebug ? r.diaryDebug.matchedKeys : null,
        allNumbers: r.diaryDebug ? r.diaryDebug.allNumbers : null
      });
    });
  });

  return true;
});
