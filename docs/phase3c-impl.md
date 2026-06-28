# Phase 3-C 実装詳細

ステップ 12〜14: 設定系 CRUD（種目・メニュー・怪我部位）。
Phase 3-B 完了後に実施。`_userId` は app.js に定義済みの前提。

対象ファイル: `app.js`、`index.html`（キャッシュバスター）、`sw.js`（キャッシュバスター）

---

## ステップ 12: 種目 CRUD（exercises テーブル）

対象関数: `saveExModal()`（行 2038 付近）、`deleteExModal()`（行 2065 付近）

### `saveExModal()` の置き換え

```javascript
// 旧（更新時の gasPost）:
// body.action = 'updateExercise'; await gasPost(body);
const { error } = await sb.from('exercises')
  .update({ name, unit, has_sides: hasSides, body_part: bodyPart, default_interval: defaultInterval })
  .eq('user_id', _userId).eq('name', S.editingExName);
if (error) { showToast('保存に失敗しました'); return; }
if (S.editingExName !== name) {
  await sb.from('records').update({ exercise: name }).eq('user_id', _userId).eq('exercise', S.editingExName);
  await sb.from('menu_exercises').update({ exercise_name: name }).eq('user_id', _userId).eq('exercise_name', S.editingExName);
}
// ※ S.exercises[idx] のローカル更新はそのまま残す

// 旧（追加時の gasPost）:
// body.action = 'addExercise'; await gasPost(body);
const { error } = await sb.from('exercises').insert({
  user_id: _userId, name, unit, has_sides: hasSides,
  body_part: bodyPart, default_interval: defaultInterval,
  main_equipment: '', sub_equipment: '',
});
if (error) { showToast('保存に失敗しました'); return; }
// ※ S.exercises.push(...) のローカル更新はそのまま残す
```

### `deleteExModal()` の置き換え

```javascript
// 旧: await gasPost({ action: 'deleteExercise', name: S.editingExName });
const { error } = await sb.from('exercises').delete().eq('user_id', _userId).eq('name', S.editingExName);
if (error) { showToast('削除に失敗しました'); return; }
// ※ S.exercises フィルタのローカル更新はそのまま残す
```

---

## ステップ 13: メニュー CRUD（menus + menu_exercises テーブル）

⚠️ menus テーブルは id（UUID）で menu_exercises と紐づく。`name` では紐づかないため、操作前に `select('id')` で id を取得すること。

対象関数: `addMenuModal()`（行 2165 付近）、`deleteMenuConfirm()`（行 2177 付近）、`saveMenuOrder()`（行 2122 付近）、`removeMenuEx()`（行 2131 付近）、`openMenuExAdd()` 内クリックハンドラ（行 2147 付近）

### `addMenuModal()` の置き換え

```javascript
// 旧: await gasPost({ action: 'addMenu', name });
const { error } = await sb.from('menus').insert({ user_id: _userId, name });
if (error) { showToast('保存に失敗しました'); return; }
// ※ S.menus.push(...) のローカル更新はそのまま残す
```

### `deleteMenuConfirm()` の置き換え

```javascript
// 旧: await gasPost({ action: 'deleteMenu', name: S.currentMenu });
const { error } = await sb.from('menus').delete().eq('user_id', _userId).eq('name', S.currentMenu);
if (error) { showToast('削除に失敗しました'); return; }
// menu_exercises は CASCADE で自動削除される
// ※ S.menus フィルタのローカル更新はそのまま残す
```

### `saveMenuOrder()` の置き換え

```javascript
// 旧: await gasPost({ action: 'reorderMenuExercises', menu: S.currentMenu, exercises });
const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
await sb.from('menu_exercises').delete().eq('user_id', _userId).eq('menu_id', menuData.id);
await sb.from('menu_exercises').insert(exercises.map((ex, idx) => ({
  user_id: _userId, menu_id: menuData.id, exercise_name: ex, order_num: idx + 1,
})));
```

### `removeMenuEx()` の置き換え

```javascript
// 旧: await gasPost({ action: 'removeMenuExercise', menu: S.currentMenu, exercise: exName });
const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
await sb.from('menu_exercises').delete().eq('user_id', _userId).eq('menu_id', menuData.id).eq('exercise_name', exName);
// ※ menu.exercises フィルタのローカル更新はそのまま残す
```

### `openMenuExAdd()` 内クリックハンドラの置き換え

```javascript
// 旧: await gasPost({ action: 'addMenuExercise', menu: S.currentMenu, exercise: exName });
const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
const { data: existing } = await sb.from('menu_exercises').select('order_num').eq('user_id', _userId).eq('menu_id', menuData.id);
const maxOrder = existing && existing.length > 0 ? Math.max(...existing.map(e => e.order_num)) : 0;
await sb.from('menu_exercises').insert({ user_id: _userId, menu_id: menuData.id, exercise_name: exName, order_num: maxOrder + 1 });
// ※ menu.exercises.push(...) のローカル更新はそのまま残す
```

---

## ステップ 14: 怪我部位 CRUD（injury_sites テーブル）

対象関数: `saveInjuryModal()`（行 2208 付近）、`deleteInjuryModal()`（行 2225 付近）

### `saveInjuryModal()` の置き換え

```javascript
// 旧（更新）: await gasPost({ action: 'updateInjurySite', oldName: S.editingInjuryOld, newName: name });
await sb.from('injury_sites').update({ name }).eq('user_id', _userId).eq('name', S.editingInjuryOld);

// 旧（追加）: await gasPost({ action: 'addInjurySite', name });
await sb.from('injury_sites').insert({ user_id: _userId, name });
// ※ S.injurySites のローカル更新はそのまま残す
```

### `deleteInjuryModal()` の置き換え

```javascript
// 旧: await gasPost({ action: 'deleteInjurySite', name: S.editingInjuryOld });
await sb.from('injury_sites').delete().eq('user_id', _userId).eq('name', S.editingInjuryOld);
// ※ S.injurySites フィルタのローカル更新はそのまま残す
```

---

## キャッシュバスター更新

- `index.html`: `app.js?vN` を +1
- `sw.js`: `CACHE` 名を +1
