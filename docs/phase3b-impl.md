# Phase 3-B 実装詳細

ステップ 5〜11: 履歴・怪我・分析タブ + 記録編集。
Phase 3-A 完了後に実施。`toSession` / `toRecord` / `_userId` / `PER_PAGE` / `sbGetExerciseData` は app.js の API セクションにある前提。

対象ファイル: `app.js`、`index.html`（キャッシュバスター）、`sw.js`（キャッシュバスター）

---

## ステップ 5: `getHistory` → `sbGetHistory`

### sbGetHistory 関数を API セクションに追加

```javascript
async function sbGetHistory(offset) {
  const uid = _userId;

  const { data: sessData } = await sb.from('sessions')
    .select('*')
    .eq('user_id', uid)
    .order('date', { ascending: false })
    .order('start_time', { ascending: false });

  const allSess = (sessData || []).map(toSession);
  const paged   = allSess.slice(offset, offset + PER_PAGE);
  const hasMore = allSess.length > offset + PER_PAGE;
  if (paged.length === 0) return { sessions: [], hasMore: false };

  const dateSet = new Set(paged.map(s => s.date));
  const { data: recData } = await sb.from('records')
    .select('*')
    .eq('user_id', uid)
    .in('date', [...dateSet]);

  const recMap = {};
  (recData || []).forEach(r => {
    const sid    = r.session_id || (r.date + '|' + (r.menu || ''));
    const exInst = r.ex_instance_id || (sid + '|' + r.exercise);
    if (!recMap[sid]) recMap[sid] = {};
    if (!recMap[sid][exInst]) recMap[sid][exInst] = { name: r.exercise, exInstanceId: r.ex_instance_id || '', sets: [] };
    recMap[sid][exInst].sets.push({
      setType:     r.set_type     || '',
      setNum:      r.set_num      || 0,
      side:        r.side         || '',
      weight:      r.weight,
      reps:        r.reps,
      injurySite:  r.injury_site  || '',
      injuryLevel: r.injury_level || '',
      injuryMemo:  r.injury_memo  || '',
      memo:        r.memo         || '',
      duration:    r.duration,
    });
  });

  paged.forEach(sess => {
    const key = sess.sessionId || (sess.date + '|' + (sess.menu || ''));
    sess.exercises = Object.values(recMap[key] || {});
  });

  return { sessions: paged, hasMore };
}
```

### `loadHistoryDate()` の置き換え

```javascript
// 旧: const data = await gasGetWithRetry({ action: 'getHistory', offset: S.histDateOffset });
const data = await sbGetHistory(S.histDateOffset);
```

### `saveSessionModal()` の置き換え（gasPost の行）

```javascript
// 旧: await gasPost({ action: 'updateSession', id: S.editingSession.id, condition, satisfaction, comment });
const { error } = await sb.from('sessions')
  .update({ condition, satisfaction, comment })
  .eq('user_id', _userId)
  .eq('session_id', S.editingSession.sessionId);
if (error) { showToast('保存に失敗しました'); return; }
```

### `deleteSessionConfirm()` の置き換え（gasPost の行）

```javascript
// 旧: await gasPost({ action: 'deleteSession', id: sess.id, sessionId: sess.sessionId });
const { error } = await sb.from('sessions')
  .delete()
  .eq('user_id', _userId)
  .eq('session_id', sess.sessionId);
if (error) { showToast('削除に失敗しました'); return; }
// records は CASCADE で自動削除される
```

---

## ステップ 6: `getExercisesWithLastDate` → `sbGetExercisesWithLastDate`

### sbGetExercisesWithLastDate 関数を API セクションに追加

```javascript
async function sbGetExercisesWithLastDate() {
  const uid   = _userId;
  const today = todayStr();
  const todayMs = new Date(today).getTime();

  const { data } = await sb.from('records')
    .select('exercise, date')
    .eq('user_id', uid);

  const map = {};
  (data || []).forEach(r => {
    if (!map[r.exercise] || r.date > map[r.exercise]) map[r.exercise] = r.date;
  });

  const exercises = Object.keys(map).map(name => ({
    name,
    lastDate: map[name],
    daysAgo: Math.round((todayMs - new Date(map[name]).getTime()) / 86400000),
  }));
  exercises.sort((a, b) => a.name.localeCompare(b.name, 'ja'));
  return { exercises };
}
```

### `loadHistExList()` の置き換え

```javascript
// 旧: const data = await gasGet({ action: 'getExercisesWithLastDate' });
const data = await sbGetExercisesWithLastDate();
```

### `loadAnalysisExList()` の置き換え

```javascript
// 旧: const data = await gasGet({ action: 'getExercisesWithLastDate' });
const data = await sbGetExercisesWithLastDate();
```

---

## ステップ 7: `getExerciseHistory` → `sbGetExerciseHistory`

exerciseElapsed の計算ロジック（GAS 確認済み）:
- `time` = エントリの最初のセットの time（HH:mm）
- `lastTime` = エントリの最後のセットの time（HH:mm）
- `firstStartSec = firstRecSec - firstDuration`（firstDuration が null なら firstRecSec をそのまま使う）
- `diffSec = lastSec - firstStartSec` が正のとき `round(diffSec / 60)` を返す

### sbGetExerciseHistory 関数を API セクションに追加

```javascript
async function sbGetExerciseHistory(exerciseName, offset) {
  const uid   = _userId;
  const today = todayStr();
  const todayMs = new Date(today).getTime();

  const { data } = await sb.from('records')
    .select('*')
    .eq('user_id', uid)
    .eq('exercise', exerciseName);

  const entryMap = {};
  (data || []).forEach(r => {
    const key = r.ex_instance_id || r.date;
    const dur = r.duration;
    if (!entryMap[key]) {
      entryMap[key] = { date: r.date, time: r.time || '', sets: [], firstDuration: dur };
    }
    entryMap[key].sets.push({
      setType:        r.set_type      || '',
      setNum:         r.set_num       || 0,
      side:           r.side          || '',
      weight:         r.weight,
      reps:           r.reps,
      targetInterval: r.target_interval,
      injurySite:     r.injury_site   || '',
      injuryLevel:    r.injury_level  || '',
      injuryMemo:     r.injury_memo   || '',
      memo:           r.memo          || '',
      duration:       dur,
    });
    entryMap[key].lastTime = r.time || '';
  });

  const sorted = Object.keys(entryMap).sort((a, b) => {
    const da = entryMap[a].date + entryMap[a].time;
    const db = entryMap[b].date + entryMap[b].time;
    return db.localeCompare(da);
  });

  const paged   = sorted.slice(offset, offset + PER_PAGE);
  const hasMore = sorted.length > offset + PER_PAGE;

  const dates = paged.map((key, idx) => {
    const entry = entryMap[key];
    const prevKey = sorted[offset + idx + 1];
    let daysSincePrev = null;
    if (prevKey) {
      const thisMs = new Date(entry.date).getTime();
      const prevMs = new Date(entryMap[prevKey].date).getTime();
      daysSincePrev = Math.round((thisMs - prevMs) / 86400000);
    }
    let exerciseElapsed = null;
    if (entry.time && entry.lastTime) {
      const sp = entry.time.split(':').map(Number);
      const ep = entry.lastTime.split(':').map(Number);
      const lastSec     = ep[0] * 3600 + ep[1] * 60;
      const firstRecSec = sp[0] * 3600 + sp[1] * 60;
      const firstStartSec = entry.firstDuration != null ? firstRecSec - entry.firstDuration : firstRecSec;
      const diffSec = lastSec - firstStartSec;
      if (diffSec > 0) exerciseElapsed = Math.round(diffSec / 60);
    }
    return {
      date: entry.date, time: entry.time,
      daysAgo: Math.round((todayMs - new Date(entry.date).getTime()) / 86400000),
      daysSincePrev, exerciseElapsed,
      sets: entry.sets,
    };
  });

  return { dates, hasMore };
}
```

### `loadHistExDetail()` の置き換え

```javascript
// 旧: const data = await gasGetWithRetry({ action: 'getExerciseHistory', exercise: S.histCurrentEx, offset: S.histExOffset });
const data = await sbGetExerciseHistory(S.histCurrentEx, S.histExOffset);
```

### `loadS3Hist()` の置き換え

```javascript
// 旧: const data = await gasGetWithRetry({ action: 'getExerciseHistory', exercise: exName, offset: S.s3HistOffset });
const data = await sbGetExerciseHistory(exName, S.s3HistOffset);
```

---

## ステップ 8: `getInjuryHistory` → `sbGetInjuryHistory`

### sbGetInjuryHistory 関数を API セクションに追加

```javascript
async function sbGetInjuryHistory() {
  const { data } = await sb.from('records')
    .select('date, session_id, exercise, set_type, set_num, side, injury_site, injury_level, injury_memo')
    .eq('user_id', _userId)
    .neq('injury_site', '')
    .order('date', { ascending: false });

  const records = (data || []).map(r => ({
    date:        r.date,
    sessionId:   r.session_id   || '',
    exercise:    r.exercise,
    setType:     r.set_type     || '',
    setNum:      r.set_num      || 0,
    side:        r.side         || '',
    injurySite:  r.injury_site  || '',
    injuryLevel: r.injury_level || '',
    injuryMemo:  r.injury_memo  || '',
  }));
  return { records };
}
```

### `loadInjuryHistory()` の置き換え

```javascript
// 旧: const data = await gasGet({ action: 'getInjuryHistory' });
const data = await sbGetInjuryHistory();
```

### `loadS3Injury()` の置き換え

```javascript
// 旧: gasGet({ action: 'getInjuryHistory' }).then(data => {
sbGetInjuryHistory().then(data => {
```

---

## ステップ 9: `getAnalysisData` → `sbGetAnalysisData`

### sbGetAnalysisData 関数を API セクションに追加

```javascript
async function sbGetAnalysisData(exerciseName) {
  const { data } = await sb.from('records')
    .select('date, weight, reps')
    .eq('user_id', _userId)
    .eq('exercise', exerciseName)
    .eq('set_type', 'メイン');

  const dateMap = {};
  (data || []).forEach(r => {
    const w   = r.weight != null ? Number(r.weight) : 0;
    const rep = r.reps   != null ? Number(r.reps)   : 0;
    if (!dateMap[r.date]) dateMap[r.date] = { maxWeight: 0, maxReps: 0, totalReps: 0, totalVolume: 0, totalSets: 0 };
    dateMap[r.date].maxWeight    = Math.max(dateMap[r.date].maxWeight, w);
    dateMap[r.date].maxReps      = Math.max(dateMap[r.date].maxReps, rep);
    dateMap[r.date].totalReps   += rep;
    dateMap[r.date].totalVolume += w * rep;
    dateMap[r.date].totalSets++;
  });

  return {
    data: Object.keys(dateMap).sort().map(date => ({
      date,
      maxWeight:   dateMap[date].maxWeight,
      maxReps:     dateMap[date].maxReps,
      totalReps:   dateMap[date].totalReps,
      totalVolume: Math.round(dateMap[date].totalVolume * 10) / 10,
      totalSets:   dateMap[date].totalSets,
    })),
  };
}
```

### `loadAnalysis()` の置き換え

```javascript
// 旧: const data = await gasGet({ action: 'getAnalysisData', exercise: name });
const data = await sbGetAnalysisData(name);
```

---

## ステップ 10: `updateExerciseRecords` → `sbUpdateExerciseRecords`

### sbUpdateExerciseRecords 関数を API セクションに追加

```javascript
async function sbUpdateExerciseRecords(d) {
  const uid = _userId;

  const { data: origData } = await sb.from('records')
    .select('set_type, set_num, side, time, target_interval, duration')
    .eq('user_id', uid)
    .eq('ex_instance_id', d.exInstanceId || '')
    .eq('exercise', d.exercise);

  const origMap = {};
  (origData || []).forEach(r => {
    const key = r.set_type + '|' + r.set_num + '|' + (r.side || '');
    if (!origMap[key]) origMap[key] = { time: r.time, targetInterval: r.target_interval, duration: r.duration };
  });

  if (d.exInstanceId) {
    await sb.from('records').delete().eq('user_id', uid).eq('ex_instance_id', d.exInstanceId);
  } else {
    await sb.from('records').delete().eq('user_id', uid)
      .eq('session_id', d.sessionId).eq('exercise', d.exercise);
  }

  if (!d.sets || d.sets.length === 0) return;

  const rows = d.sets.map(s => {
    const key  = s.type + '|' + s.setNum + '|' + (s.side || '');
    const orig = origMap[key] || {};
    return {
      user_id:         uid,
      session_id:      d.sessionId || '',
      ex_instance_id:  d.exInstanceId || '',
      date:            d.date,
      time:            orig.time || '',
      menu:            d.menu || '',
      exercise:        d.exercise,
      set_type:        s.type,
      set_num:         s.setNum,
      side:            s.side || '',
      weight:          s.weight  != null ? s.weight  : null,
      reps:            s.reps    != null ? s.reps    : null,
      target_interval: orig.targetInterval != null ? orig.targetInterval : null,
      injury_site:     s.injurySite  || '',
      injury_level:    s.injuryLevel || '',
      injury_memo:     s.injuryMemo  || '',
      memo:            s.memo        || '',
      duration:        orig.duration != null ? orig.duration : null,
    };
  });

  const { error } = await sb.from('records').insert(rows);
  if (error) { showToast('保存に失敗しました'); console.error(error); }
}
```

### `saveRecordModal()` の置き換え（gasPost の行）

```javascript
// 旧: await gasPost({ action: 'updateExerciseRecords', date, menu: menu || '', exercise: exName, sessionId, exInstanceId, sets });
await sbUpdateExerciseRecords({ date, menu: menu || '', exercise: exName, sessionId, exInstanceId, sets });
```

### `deleteExerciseRecordsConfirm()` の置き換え（gasPost の行）

```javascript
// 旧: await gasPost({ action: 'updateExerciseRecords', date, menu: menu || '', exercise: exName, sessionId, exInstanceId, sets: [] });
await sbUpdateExerciseRecords({ date, menu: menu || '', exercise: exName, sessionId, exInstanceId, sets: [] });
```

---

## キャッシュバスター更新

- `index.html`: `app.js?vN` を +1
- `sw.js`: `CACHE` 名を +1
