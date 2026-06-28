# workoutlog3 移行計画・実装ノート

workoutlog2（GAS + Sheets）→ workoutlog3（Supabase + PostgreSQL）移行のシミュレーション結果と、
実装時に必ず参照すべき制約・注意事項をまとめたドキュメント。

作成日: 2026-06-28

---

## 要注意ポイント 5つ（実装前に必ず確認）

### ⚠️ 1. `session_id` NOT NULL制約 vs 旧データ

`records` テーブルの `session_id` は `NOT NULL` かつ `sessions(session_id)` への FK。
しかし workoutlog2 の初期レコードには session_id が空文字列で保存されている可能性がある（GAS: `d.sessionId || ''`）。

**対策：データ移行時に必要な手順**
1. session_id が空のレコードを date + menu でグループ化
2. グループごとに合成 session_id（例: `'sid_legacy_' + date + '_' + menu`）を生成
3. sessions テーブルにも対応する行を先に INSERT してから records をインポート

インポート中は一時的に FK 制約を外すと安全：
```sql
ALTER TABLE records DISABLE TRIGGER ALL;
-- インポート
ALTER TABLE records ENABLE TRIGGER ALL;
```

---

### ⚠️ 2. `updateSession` / `deleteSession` が数値 id を使っている

`app.js` の `openSessionEditModal` → `saveSessionModal` / `deleteSessionConfirm` のフロー：

```javascript
// 現状の app.js（workoutlog2ベース）
gasPost({ action: 'updateSession', id: S.editingSession.id, ... })
// → id は Sheets の行連番（Number）

gasPost({ action: 'deleteSession', id: sess.id, sessionId: sess.sessionId })
```

Supabase の `sessions` テーブルに数値 id は存在しない（`id` は uuid）。

**修正方針：** `updateSession` / `deleteSession` を `session_id`（text）で特定する。
- `getHistory` のレスポンスで `session_id` を含める（現状の GAS は含んでいる：`sess.sessionId`）
- `S.editingSession` に `session_id` を持たせ、Supabase クエリで使う
- `deleteSession` はカスケード削除で records も消えるため、records 側の個別削除は不要

---

### ⚠️ 3. camelCase vs snake_case のフィールド名ズレ

GAS が返す exercises のキー：
```javascript
{ name, unit, defaultInterval, bodyPart, mainEquipment, subEquipment, hasSides }
```

Supabase JS クライアントが返すキー（DB の列名そのまま）：
```javascript
{ name, unit, default_interval, body_part, main_equipment, sub_equipment, has_sides }
```

`app.js` 全体で `exMaster.hasSides`、`exMaster.defaultInterval`、`ex.bodyPart` 等を参照している箇所が多数ある。

**対策：取得直後に変換するラッパーを1か所に置く**
```javascript
function toExercise(row) {
  return {
    name:            row.name,
    unit:            row.unit,
    defaultInterval: row.default_interval,
    bodyPart:        row.body_part,
    mainEquipment:   row.main_equipment,
    subEquipment:    row.sub_equipment,
    hasSides:        row.has_sides,
  };
}
// 使い方
S.exercises = data.map(toExercise);
```

---

### ⚠️ 4. `getInitialData` の複合計算（menuLastDates / recentSingle / stats）

GAS は1リクエストで6種類のデータを計算して返す。Supabase では分解が必要で、
以下の2つはそのままでは再現できない：

**menuLastDates（メニューごとの最終実施日）**
- GAS: 全 sessions を全読みして JS で GROUP BY
- Supabase: Supabase JS クライアントに GROUP BY はない
- 対策A: 全 sessions を SELECT して JS で集計（データ量が少ないうちはこれで十分）
- 対策B: PostgreSQL 関数（RPC）を作成

```javascript
// 対策A の実装例
const { data: sessions } = await supabase
  .from('sessions').select('menu, date').eq('user_id', uid);
const menuLastDates = {};
sessions.forEach(s => {
  if (!s.menu) return;
  if (!menuLastDates[s.menu] || s.date > menuLastDates[s.menu]) {
    menuLastDates[s.menu] = s.date;
  }
});
```

**stats（streak 計算）**
- GAS: 全 sessions を読んで日付 Set → streak ループ
- Supabase: 同様に JS で計算可能。ただし全 sessions 取得が必要
- 対策: `sessions` の `date` だけを SELECT して JS で streak 計算

**recentSingle（直近の単発種目 5件）**
```javascript
const { data } = await supabase
  .from('records')
  .select('exercise, date')
  .eq('user_id', uid).eq('menu', '')
  .order('date', { ascending: false })
  .limit(500);
// JS で重複除去して5件取得
```

---

### ⚠️ 5. `gasPost` がfire-and-forget → Supabase では明示的エラー処理が必要

```javascript
// workoutlog2 の gasPost
mode: 'no-cors'  // レスポンスが読めない
.catch(() => {}) // エラーも無視
```

`saveSets` / `saveSession` はこの設計のため、GAS 側でエラーが出ても気づけなかった。
Supabase JS クライアントはエラーを返すため、今まで隠れていた失敗が表面化する可能性がある。

**対策：最低限のエラー処理を追加**
```javascript
const { error } = await supabase.from('records').insert(rows);
if (error) {
  showToast('保存に失敗しました。再度お試しください。');
  console.error(error);
}
```

---

## API 対応表（全アクション）

| GAS action | Supabase での実現方法 | 難易度 |
|---|---|---|
| `getInitialData` | 5並列クエリ + JS集計 | ★★ |
| `getExerciseData` | records select + JS集計 | ★★ |
| `getExercisesWithLastDate` | records select + JS groupBy | ★★ |
| `getHistory` | sessions range + records IN | ★★★ |
| `getExerciseHistory` | records select + JS groupBy(exInstanceId) | ★★ |
| `getAnalysisData` | records select + JS集計 | ★ |
| `getInjuryHistory` | records select WHERE injury_site != '' | ★ |
| `saveSets` | records.insert(rows) | ★ |
| `saveSession` | sessions.insert(row) | ★ |
| `updateSession` | sessions.update WHERE session_id | ★ |
| `deleteSession` | sessions.delete → CASCADE自動 | ★ |
| `updateExerciseRecords` | records.delete + insert | ★★ |
| `addExercise` | exercises.insert | ★ |
| `updateExercise` | exercises.update + records.update + menu_exercises.update | ★★ |
| `deleteExercise` | exercises.delete | ★ |
| `addMenu` / `deleteMenu` | menus.insert / delete | ★ |
| `addMenuExercise` / `removeMenuExercise` | menu_exercises.insert / delete | ★ |
| `reorderMenuExercises` | menu_exercises.delete + insert | ★ |
| 怪我部位CRUD | injury_sites のCRUD | ★ |

---

## Sheets列 → PostgreSQL列 マッピング

### 記録シート（18列）→ `records`

| Sheets列インデックス | 内容 | PostgreSQL列 | 変換の注意 |
|---|---|---|---|
| r[0] | 連番 | id (uuid) | 捨てる（DB自動生成） |
| r[1] | date (Date型) | date | fmtDate() → 'YYYY-MM-DD' |
| r[2] | time (Date型) | time (text) | fmtTime(UTC) → 'HH:mm' |
| r[3] | menu | menu (text) | 空文字OK |
| r[4] | exercise | exercise (text) | そのまま |
| r[5] | set_type | set_type (text) | そのまま |
| r[6] | set_num | set_num (integer) | Number() |
| r[7] | side | side (text) | 空文字OK |
| r[8] | weight | weight (numeric) | 空文字→ NULL |
| r[9] | reps | reps (numeric) | 空文字→ NULL |
| r[10] | target_interval | target_interval (integer) | 空文字→ NULL |
| r[11] | injury_site | injury_site (text) | 空文字OK |
| r[12] | injury_level | injury_level (text) | 空文字OK |
| r[13] | injury_memo | injury_memo (text) | safeCell 不要 |
| r[14] | memo | memo (text) | safeCell 不要 |
| r[15] | session_id | session_id (text FK) | **⚠️ 要注意1 参照** |
| r[16] | ex_instance_id | ex_instance_id (text) | 空文字OK |
| r[17] | duration | duration (integer) | 空文字→ NULL |

### セッションシート（9列）→ `sessions`

| Sheets列インデックス | 内容 | PostgreSQL列 | 注意 |
|---|---|---|---|
| r[0] | 連番（数値id） | id (uuid) | 捨てる。**⚠️ 要注意2 参照** |
| r[1] | date | date | |
| r[2] | menu | menu (text) | |
| r[3] | start_time | start_time (text) | |
| r[4] | end_time | end_time (text) | |
| r[5] | condition | condition (text) | |
| r[6] | satisfaction | satisfaction (text) | |
| r[7] | comment | comment (text) | |
| r[8] | session_id | session_id (text UNIQUE) | 空文字は補完が必要 |

### 種目マスター（7列）→ `exercises`

| Sheets列 | PostgreSQL列 | 変換 |
|---|---|---|
| r[0] name | name | そのまま |
| r[1] unit | unit | デフォルト '回' |
| r[2] default_interval | default_interval | 空→90 |
| r[3] body_part | body_part | そのまま |
| r[4] main_equipment | main_equipment | そのまま |
| r[5] sub_equipment | sub_equipment | そのまま |
| r[6] 'あり'/'なし' | has_sides (boolean) | 'あり' → true |

---

## 追加すべきインデックス

CLAUDE.md のSQL定義に含まれていない。Phase 1 のテーブル作成時に追加すること。

```sql
CREATE INDEX ON records(user_id, exercise);
CREATE INDEX ON records(user_id, session_id);
CREATE INDEX ON records(user_id, date);
CREATE INDEX ON sessions(user_id, date DESC);
CREATE INDEX ON sessions(user_id, session_id);
CREATE INDEX ON menu_exercises(user_id, menu_id);
```

これを省くと `getExerciseHistory` や `getHistory` がフルスキャンになり、
GASより遅くなる可能性がある。

---

## 実装推奨手順

### Phase 1: Supabase セットアップ
1. Supabase プロジェクト作成
2. CLAUDE.md の SQL を実行（テーブル作成）
3. 上記インデックスを追加
4. RLS 動作確認

### Phase 2: 認証
1. ログイン画面を index.html に追加
2. Supabase Auth でサインイン処理
3. 以降のすべての DB 操作は `auth.uid()` を前提に

### Phase 3: API 置き換え（app.js）
1. `gasGet` / `gasPost` を削除し、Supabase クライアント初期化に差し替え
2. `toExercise()` 変換関数を追加（⚠️要注意3）
3. `getInitialData` を並列クエリに置き換え
4. `saveSets` / `saveSession` にエラー処理追加（⚠️要注意5）
5. `updateSession` / `deleteSession` を session_id ベースに修正（⚠️要注意2）
6. 残りのアクションを順次置き換え

### Phase 4: データ移行
1. Google Sheets から CSV エクスポート
2. session_id 補完スクリプト実行（⚠️要注意1）
3. Supabase へインポート（sessions → records の順）
4. データ整合性確認

### Phase 5: 本番切り替え
1. GitHub Pages へのデプロイ確認
2. PWA インストール確認
3. workoutlog2 からの切り替え
