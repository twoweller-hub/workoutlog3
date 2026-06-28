# Phase 3-A 実装詳細

ステップ 1〜4 のコア記録フロー。完了すると「記録する」主要機能が Supabase で動く。

対象ファイル: `app.js`、`index.html`（キャッシュバスター）、`sw.js`（キャッシュバスター）

---

## ステップ 1: GAS 関数削除 + _userId + API セクション全書き換え

### 1-1. 削除する行

- **行 5**: `const GAS_URL = '...'` を削除
- **行 58〜88**: `gasGet` / `gasGetWithRetry` / `gasPost` 関数ブロックを削除

### 1-2. `let _userId = null;` を追加

`let _appSetupDone = false;`（行 185）の直後に追加。

### 1-3. API セクション（行 57〜88）を以下に全置き換え

```javascript
// =====================================================================
//  API
// =====================================================================
function toExercise(r) {
  return {
    name:            r.name,
    unit:            r.unit,
    defaultInterval: r.default_interval,
    bodyPart:        r.body_part,
    mainEquipment:   r.main_equipment,
    subEquipment:    r.sub_equipment,
    hasSides:        r.has_sides,
  };
}

function toRecord(r) {
  return {
    setType:        r.set_type,
    setNum:         r.set_num,
    side:           r.side || '',
    weight:         r.weight,
    reps:           r.reps,
    targetInterval: r.target_interval,
    injurySite:     r.injury_site  || '',
    injuryLevel:    r.injury_level || '',
    injuryMemo:     r.injury_memo  || '',
    memo:           r.memo || '',
    duration:       r.duration,
    time:           r.time || '',
    date:           r.date,
    exercise:       r.exercise,
    exInstanceId:   r.ex_instance_id || '',
    sessionId:      r.session_id || '',
  };
}

function toSession(r) {
  return {
    id:           r.id,
    sessionId:    r.session_id,
    date:         r.date,
    menu:         r.menu || '',
    startTime:    r.start_time || '',
    endTime:      r.end_time   || '',
    condition:    r.condition    || '',
    satisfaction: r.satisfaction || '',
    comment:      r.comment      || '',
  };
}

const PER_PAGE = 20;

async function sbGetInitialData() {
  const uid = _userId;
  const today = todayStr();
  const todayMs = new Date(today).getTime();

  const [exRes, menuRes, menuExRes, injRes, sessRes, recRes] = await Promise.all([
    sb.from('exercises').select('*').eq('user_id', uid),
    sb.from('menus').select('id, name').eq('user_id', uid),
    sb.from('menu_exercises').select('menu_id, exercise_name, order_num').eq('user_id', uid).order('order_num'),
    sb.from('injury_sites').select('name').eq('user_id', uid),
    sb.from('sessions').select('menu, date, session_id').eq('user_id', uid),
    sb.from('records').select('exercise, date, menu').eq('user_id', uid).order('date', {ascending: false}).limit(500),
  ]);

  const exercises = (exRes.data || []).map(toExercise);

  const menuExMap = {};
  (menuExRes.data || []).forEach(me => {
    if (!menuExMap[me.menu_id]) menuExMap[me.menu_id] = [];
    menuExMap[me.menu_id].push(me.exercise_name);
  });
  const menus = (menuRes.data || []).map(m => ({
    name: m.name,
    exercises: menuExMap[m.id] || [],
  }));

  const injurySites = (injRes.data || []).map(r => r.name);

  const menuLastDates = {};
  (sessRes.data || []).forEach(s => {
    if (!s.menu) return;
    if (!menuLastDates[s.menu] || s.date > menuLastDates[s.menu]) {
      menuLastDates[s.menu] = s.date;
    }
  });
  Object.keys(menuLastDates).forEach(menu => {
    const d = menuLastDates[menu];
    menuLastDates[menu] = { date: d, daysAgo: Math.round((todayMs - new Date(d).getTime()) / 86400000) };
  });

  const seen = new Set();
  const recentSingle = [];
  for (const r of (recRes.data || [])) {
    if (r.menu !== '' || !r.exercise || seen.has(r.exercise)) continue;
    seen.add(r.exercise);
    const daysAgo = Math.round((todayMs - new Date(r.date).getTime()) / 86400000);
    recentSingle.push({ name: r.exercise, lastDate: r.date, daysAgo });
    if (recentSingle.length >= 5) break;
  }

  const stats = _calcStats(sessRes.data || [], today);

  return { exercises, menus, injurySites, menuLastDates, recentSingle, stats };
}

function _calcStats(sessions, today) {
  const todayMs = new Date(today).getTime();
  const singleDates = new Set();
  const menuDates   = new Set();
  let singleToday = 0, menuToday = 0, singleTotal = 0, menuTotal = 0;

  sessions.forEach(s => {
    const isSingle = !!s.session_id && !s.menu;
    if (isSingle) {
      singleDates.add(s.date);
      singleTotal++;
      if (s.date === today) singleToday++;
    } else {
      menuDates.add(s.date);
      menuTotal++;
      if (s.date === today) menuToday++;
    }
  });

  function calcStreak(dates) {
    let streak = 0;
    const cur = new Date(today);
    if (!dates.has(today)) cur.setDate(cur.getDate() - 1);
    for (let i = 0; i < 3650; i++) {
      const ds = cur.toISOString().slice(0, 10);
      if (!dates.has(ds)) break;
      streak++;
      cur.setDate(cur.getDate() - 1);
    }
    return streak;
  }

  return {
    singleToday, singleStreak: calcStreak(singleDates), singleTotal,
    menuToday,   menuStreak:   calcStreak(menuDates),   menuTotal,
  };
}

async function sbGetExerciseData(exerciseName) {
  const uid = _userId;
  const today = todayStr();

  const { data } = await sb.from('records')
    .select('date, set_type, set_num, side, weight, reps, memo, session_id')
    .eq('user_id', uid)
    .eq('exercise', exerciseName);

  if (!data || data.length === 0) {
    return { lastDate: null, lastSets: [], lastMemo: '', totalMainSets: 0, daysSinceLast: null };
  }

  let lastDate = null, lastSessionId = null, totalMainSets = 0;
  data.forEach(r => {
    if (r.set_type === 'メイン') totalMainSets++;
    if (!lastDate || r.date > lastDate ||
        (r.date === lastDate && r.session_id && (!lastSessionId || r.session_id > lastSessionId))) {
      lastDate = r.date;
      lastSessionId = r.session_id;
    }
  });

  const lastRecs = lastSessionId
    ? data.filter(r => r.session_id === lastSessionId)
    : data.filter(r => r.date === lastDate);

  const lastSets = lastRecs.map(r => ({
    type: r.set_type, setNum: r.set_num, side: r.side || '',
    weight: r.weight, reps: r.reps,
  }));
  const lastMemo = (lastRecs.find(r => r.memo) || {}).memo || '';
  const daysSinceLast = Math.round((new Date(today).getTime() - new Date(lastDate).getTime()) / 86400000);

  return { lastDate, lastSets, lastMemo, totalMainSets, daysSinceLast };
}
```

---

## ステップ 2: `init()` の置き換え（行 263）

```javascript
// 旧: const data = await gasGet({ action: 'getInitialData' });
const data = await sbGetInitialData();
```

`saveSession()` 末尾のバックグラウンド再取得（行 1107 付近）も置き換え：

```javascript
// 旧: gasGet({ action: 'getInitialData' }).then(data => {
sbGetInitialData().then(data => {
```

---

## ステップ 3: `enterEx()` の置き換え（行 592 付近）

```javascript
// 旧: S.s3ExData = await gasGet({ action: 'getExerciseData', exercise: ex.name });
S.s3ExData = await sbGetExerciseData(ex.name);
```

---

## ステップ 4: `completeEx()` async 化 + saveSets 置き換え（行 962、1007 付近）

**関数定義を async 化：**

```javascript
// 旧: function completeEx() {
async function completeEx() {
```

**saveSets の gasPost を置き換え（行 1007 付近の gasPost 呼び出し）：**

```javascript
if (sets.length > 0) {
  const rows = sets.map(s => ({
    user_id:         _userId,
    session_id:      S.session.sessionId,
    ex_instance_id:  ex.exInstanceId || '',
    date:            today,
    time:            s.time || '',
    menu:            menuStorage(S.session.menu),
    exercise:        ex.name,
    set_type:        s.type,
    set_num:         s.setNum,
    side:            s.side || '',
    weight:          s.weight  != null ? s.weight  : null,
    reps:            s.reps    != null ? s.reps    : null,
    target_interval: s.targetInterval != null ? s.targetInterval : null,
    injury_site:     s.injurySite  || '',
    injury_level:    s.injuryLevel || '',
    injury_memo:     s.injuryMemo  || '',
    memo:            s.memo        || '',
    duration:        s.duration    != null ? s.duration : null,
  }));
  const { error } = await sb.from('records').insert(rows);
  if (error) { showToast('記録の保存に失敗しました'); console.error(error); }
}
```

**インターバル更新の gasPost を置き換え（行 1011 付近）：**

```javascript
if (exMaster && targetInterval !== exMaster.defaultInterval) {
  exMaster.defaultInterval = targetInterval;
  const { error } = await sb.from('exercises')
    .update({ default_interval: targetInterval })
    .eq('user_id', _userId)
    .eq('name', exMaster.name);
  if (error) console.error('インターバル更新失敗', error);
}
```

---

## ステップ 5: `saveSession()` の置き換え（行 1083 付近）

```javascript
// 旧の gasPost 呼び出しブロックを以下に置き換え：
const { error } = await sb.from('sessions').insert({
  user_id:      _userId,
  session_id:   S.session.sessionId,
  date:         todayStr(),
  menu:         menuStorage(S.session.menu),
  start_time:   S.session.startTime,
  end_time:     endTime,
  condition:    cond,
  satisfaction: satis,
  comment:      comment,
});
if (error) {
  showToast('保存に失敗しました');
  btn.textContent = '保存して終了';
  btn.disabled = false;
  return;
}
```

---

## ステップ 6: `onAuthStateChange` に `_userId` を追加（行 2444 付近）

```javascript
sb.auth.onAuthStateChange((event, session) => {
  if (event === 'INITIAL_SESSION') {
    if (session) { _userId = session.user.id; hideLoginScreen(); init(); }
  } else if (event === 'SIGNED_IN') {
    _userId = session.user.id; hideLoginScreen(); init();
  } else if (event === 'SIGNED_OUT') {
    _userId = null; _appSetupDone = false; showLoginScreen();
  }
});
```

---

## キャッシュバスター更新

- `index.html`: `app.js?vN` を +1
- `sw.js`: `CACHE` 名を +1（例: `workoutlog3-v3` → `workoutlog3-v4`）
