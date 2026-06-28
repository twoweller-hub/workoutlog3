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

---

### Phase 1: Supabase セットアップ（詳細手順）

Supabase は初めて使うため、画面操作を含めて丁寧に記載する。

#### 1-1. アカウント作成

1. ブラウザで https://supabase.com を開く
2. 「Start your project」または「Sign Up」をクリック
3. GitHub アカウントでログインするのが最も簡単（「Continue with GitHub」を選択）
4. GitHub の認証画面が出たら許可する

#### 1-2. 新規プロジェクト作成

1. ログイン後、ダッシュボードが表示される
2. 「New project」ボタンをクリック
3. 以下を入力する：
   - **Name**（プロジェクト名）: `workoutlog3`
   - **Database Password**: 強いパスワードを設定（後で使わないが必須）。「Generate a password」ボタンで自動生成でよい
   - **Region**: `Northeast Asia (Tokyo)` を選択（日本から最も近い）
4. 「Create new project」をクリック
5. **2〜3分待つ**（データベースが起動するまでの時間）。画面に「Setting up your project...」と表示される

#### 1-3. テーブル作成（SQL 実行）

プロジェクトの準備ができたら、データベースにテーブルを作る。

1. 左のメニューから「**SQL Editor**」をクリック
2. 画面中央の入力欄に SQL を貼り付けて実行する
3. まず CLAUDE.md の「プロジェクト作成後に実行するSQL」をすべてコピーして貼り付け → 「**RUN**」ボタンをクリック
4. 「Success. No rows returned」と表示されれば成功
5. 次に以下のインデックス用 SQL を同様に実行する：

```sql
CREATE INDEX ON records(user_id, exercise);
CREATE INDEX ON records(user_id, session_id);
CREATE INDEX ON records(user_id, date);
CREATE INDEX ON sessions(user_id, date DESC);
CREATE INDEX ON sessions(user_id, session_id);
CREATE INDEX ON menu_exercises(user_id, menu_id);
```

#### 1-4. テーブルが作成されたか確認

1. 左メニューの「**Table Editor**」をクリック
2. 左側に `exercises`, `menus`, `menu_exercises`, `sessions`, `records`, `injury_sites` の6テーブルが表示されていれば OK

#### 1-5. API キーを取得する（最重要）

app.js から Supabase に接続するために必要な2つの値を取得する。

1. 左メニュー最下部の「**Project Settings**」（歯車アイコン）をクリック
2. 「**API**」をクリック
3. 以下の2つをメモ（またはコピー）しておく：
   - **Project URL**: `https://xxxxxxxxxx.supabase.co` という形式
   - **Project API keys** の中の **anon / public** のキー（長い文字列）

> ⚠️ `anon` キーはフロントエンドに埋め込むが、RLS（行レベルセキュリティ）が有効なので他人のデータは見えない。`service_role` キーは**絶対に**フロントエンドに書かない。

取得した2つの値は、のちに app.js の以下の箇所に設定する：

```javascript
const SUPABASE_URL  = 'https://xxxxxxxxxx.supabase.co';  // Project URL
const SUPABASE_ANON_KEY = 'eyJ...（長い文字列）';         // anon キー
```

#### 1-6. RLS の動作確認（任意だが推奨）

テーブルに RLS（Row Level Security）が有効になっているか確認する。

1. 「**Table Editor**」→ `exercises` テーブルをクリック
2. 右上に「RLS enabled」と表示されていれば OK
3. 全6テーブルで同様に確認する

---

### Phase 2: 認証
1. ログイン画面を index.html に追加
2. Supabase Auth でサインイン処理
3. 以降のすべての DB 操作は `auth.uid()` を前提に

---

### Phase 3: API 置き換え（app.js）

> ⚠️ 以下の「Phase 3 実装詳細」セクションを必ず読んでから実装すること。
> GAS の `gas/api.gs`（workoutlog2）を 2026-06-28 に読んで確認済みの情報が含まれている。

1. `gasGet` / `gasPost` / `gasGetWithRetry` / `GAS_URL` 定数を削除
2. `_userId` モジュール変数を追加し、ログイン時に保存
3. 変換関数（`toExercise` / `toSession` / `toRecord`）を追加
4. `getInitialData` を並列クエリに置き換え
5. `saveSets` / `saveSession` にエラー処理追加
6. `updateSession` / `deleteSession` を session_id ベースに修正
7. 残りのアクションを順次置き換え（実装順は後述）

---

### Phase 4: データ移行
1. Google Sheets から CSV エクスポート
2. session_id 補完スクリプト実行（⚠️要注意1）
3. Supabase へインポート（sessions → records の順）
4. データ整合性確認

---

### Phase 5: 本番切り替え
1. GitHub Pages へのデプロイ確認
2. PWA インストール確認
3. workoutlog2 からの切り替え

完了後、「dev-log.md だけ読むように戻して」と Claude に依頼して CLAUDE.md を更新してもらうこと。

---

## Phase 3 実装詳細（複数セッションまたぎ用・GAS確認済み）

> 作成: 2026-06-28
> GAS ソース: `/Users/tsuyoshi/ドキュメント/AI_Project/workoutlog2/gas/api.gs` を全文確認済み。
> app.js ソース: `workoutlog3/app.js`（2455行）を全文確認済み。

---

### 設計方針

#### user_id の扱い

app.js の先頭付近に以下を追加する。

```javascript
let _userId = null;  // ログイン後にセット
```

`DOMContentLoaded` 内の `onAuthStateChange` で:

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

INSERT 時は全テーブルに `user_id: _userId` を付ける。

---

#### 変換関数（snake_case → camelCase）

DB の列名は snake_case。app.js は camelCase を期待している。以下の変換関数を `// API` セクションに追加する。

```javascript
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
    id:           r.id,          // UUID（updateSession では使わない）
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
```

---

### 各 GAS アクションの返却形式と Supabase 実装

---

#### getInitialData

**GAS の返却形式:**
```javascript
{
  exercises:     [{name, unit, defaultInterval, bodyPart, mainEquipment, subEquipment, hasSides}],
  menus:         [{name, exercises: ['種目名', ...]}],
  injurySites:   ['肩', '膝', ...],
  menuLastDates: { 'メニュー名': {date: 'YYYY-MM-DD', daysAgo: N}, ... },
  recentSingle:  [{name, lastDate, daysAgo}],   // 直近5件（単発のみ）
  stats:         {singleToday, singleStreak, singleTotal, menuToday, menuStreak, menuTotal}
}
```

**Supabase 実装（`init()` 内の gasGet を置き換え）:**

```javascript
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

  // exercises
  const exercises = (exRes.data || []).map(toExercise);

  // menus
  const menuExMap = {};
  (menuExRes.data || []).forEach(me => {
    if (!menuExMap[me.menu_id]) menuExMap[me.menu_id] = [];
    menuExMap[me.menu_id].push(me.exercise_name);
  });
  const menus = (menuRes.data || []).map(m => ({
    name: m.name,
    exercises: menuExMap[m.id] || [],
  }));

  // injurySites
  const injurySites = (injRes.data || []).map(r => r.name);

  // menuLastDates
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

  // recentSingle（単発: menu='' の records から重複除去して最新5件）
  const seen = new Set();
  const recentSingle = [];
  for (const r of (recRes.data || [])) {
    if (r.menu !== '' || !r.exercise || seen.has(r.exercise)) continue;
    seen.add(r.exercise);
    const daysAgo = Math.round((todayMs - new Date(r.date).getTime()) / 86400000);
    recentSingle.push({ name: r.exercise, lastDate: r.date, daysAgo });
    if (recentSingle.length >= 5) break;
  }

  // stats（sessions を使って streak 計算）
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
```

`init()` の置き換え:
```javascript
// 旧: const data = await gasGet({ action: 'getInitialData' });
const data = await sbGetInitialData();
```

saveSession 後のバックグラウンド再取得も同様に置き換える（`saveSession()` 関数末尾の gasGet）。

---

#### getExerciseData

**GAS の返却形式:**
```javascript
{
  lastDate: 'YYYY-MM-DD' | null,
  lastSets: [{type, setNum, side, weight, reps}],  // 最終セッションのセット
  lastMemo: '',
  totalMainSets: N,
  daysSinceLast: N | null
}
```

**Supabase 実装:**

```javascript
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

`enterEx()` の置き換え（app.js:592）:
```javascript
// 旧: S.s3ExData = await gasGet({ action: 'getExerciseData', exercise: ex.name });
S.s3ExData = await sbGetExerciseData(ex.name);
```

---

#### getHistory

**GAS の返却形式:**
```javascript
{
  sessions: [{
    id: N,           // GAS数値ID → Supabase版では session_id を id として使う（後述）
    date, menu, startTime, endTime, condition, satisfaction, comment, sessionId,
    exercises: [{
      name, exInstanceId,
      sets: [{setType, setNum, side, weight, reps, injurySite, injuryLevel, injuryMemo, memo, duration}]
      // ※ targetInterval は getHistory の sets に含まれない
    }]
  }],
  hasMore: bool
}
```

⚠️ `updateSession` が `S.editingSession.id` を GAS に送っているが、Supabase では `session_id` を使う。
`openSessionEditModal` で `S.editingSession = { ...sess, idx }` としているため、
`sess.sessionId` は既に入っている。Supabase 版では `saveSessionModal` と `deleteSessionConfirm` を
`S.editingSession.sessionId` ベースに変更する（`id` フィールドは不要になる）。

**Supabase 実装:**

```javascript
const PER_PAGE = 20;

async function sbGetHistory(offset) {
  const uid = _userId;

  // sessions を降順取得
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

  // session_id → exercises マップ
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

`loadHistoryDate()` の置き換え（app.js:1169）:
```javascript
// 旧: const data = await gasGetWithRetry({ action: 'getHistory', offset: S.histDateOffset });
const data = await sbGetHistory(S.histDateOffset);
```

`saveSessionModal()` の変更（app.js:1707）:
```javascript
// 旧: await gasPost({ action: 'updateSession', id: S.editingSession.id, ... });
const { error } = await sb.from('sessions')
  .update({ condition, satisfaction, comment })
  .eq('user_id', _userId)
  .eq('session_id', S.editingSession.sessionId);
if (error) { showToast('保存に失敗しました'); return; }
```

`deleteSessionConfirm()` の変更（app.js:1725）:
```javascript
// 旧: await gasPost({ action: 'deleteSession', id: sess.id, sessionId: sess.sessionId });
const { error } = await sb.from('sessions')
  .delete()
  .eq('user_id', _userId)
  .eq('session_id', sess.sessionId);
// records は CASCADE で自動削除される
if (error) { showToast('削除に失敗しました'); return; }
```

---

#### getExercisesWithLastDate

**GAS の返却形式:**
```javascript
{ exercises: [{name, lastDate, daysAgo}] }  // 名前の日本語ソート順
```

**Supabase 実装:**

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

`loadHistExList()` と `loadAnalysisExList()` の両方で使う（app.js:1310, 1901）:
```javascript
// 旧: const data = await gasGet({ action: 'getExercisesWithLastDate' });
const data = await sbGetExercisesWithLastDate();
```

---

#### getExerciseHistory

**GAS の返却形式:**
```javascript
{
  dates: [{
    date, time,           // time は最初のセットの 'HH:mm'
    daysAgo,
    daysSincePrev,        // 1つ前のエントリとの日数差（null の場合あり）
    exerciseElapsed,      // 種目の所要時間（分）、計算できない場合は null
    sets: [{setType, setNum, side, weight, reps, targetInterval, injurySite, injuryLevel, injuryMemo, memo, duration}]
  }],
  hasMore: bool
}
```

**exerciseElapsed の計算ロジック（GASから確認済み）:**
- `time` = そのエントリの最初のセットの `time`（HH:mm）
- `lastTime` = そのエントリの最後のセットの `time`（HH:mm）
- `firstDuration` = 最初のセットの `duration`（秒）
- `firstStartSec = firstRecSec - firstDuration`（firstDuration が null の場合は firstRecSec をそのまま使う）
- `diffSec = lastSec - firstStartSec`
- `exerciseElapsed = round(diffSec / 60)` ← diffSec > 0 の場合のみ、そうでなければ null

**Supabase 実装:**

```javascript
async function sbGetExerciseHistory(exerciseName, offset) {
  const PER_PAGE = 20;
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

`loadHistExDetail()` と `loadS3Hist()` の両方で使う（app.js:1366, 1462）:
```javascript
// 旧: const data = await gasGetWithRetry({ action: 'getExerciseHistory', exercise: ..., offset: ... });
const data = await sbGetExerciseHistory(exerciseName, offset);
```

---

#### getInjuryHistory

**GAS の返却形式:**
```javascript
{
  records: [{date, sessionId, exercise, setType, setNum, side, injurySite, injuryLevel, injuryMemo}]
}
// 日付降順ソート済み
```

**Supabase 実装:**

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

`loadInjuryHistory()` と `loadS3Injury()` の両方で使う（app.js:1751, 1770）:
```javascript
// 旧: const data = await gasGet({ action: 'getInjuryHistory' });
const data = await sbGetInjuryHistory();
```

---

#### getAnalysisData

**GAS の返却形式:**
```javascript
{ data: [{date, maxWeight, maxReps, totalReps, totalVolume, totalSets}] }
// 日付昇順
```

**Supabase 実装:**

```javascript
async function sbGetAnalysisData(exerciseName) {
  const { data } = await sb.from('records')
    .select('date, weight, reps')
    .eq('user_id', _userId)
    .eq('exercise', exerciseName)
    .eq('set_type', 'メイン');

  const dateMap = {};
  (data || []).forEach(r => {
    const w = r.weight != null ? Number(r.weight) : 0;
    const rep = r.reps  != null ? Number(r.reps)  : 0;
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

`loadAnalysis()` の置き換え（app.js:1932）:
```javascript
// 旧: const data = await gasGet({ action: 'getAnalysisData', exercise: name });
const data = await sbGetAnalysisData(name);
```

---

#### saveSets

**app.js の呼び出し箇所（completeEx 内、app.js:1008）:**
```javascript
gasPost({ action: 'saveSets', date: today, menu: menuStorage(S.session.menu),
          exercise: ex.name, sessionId: S.session.sessionId,
          exInstanceId: ex.exInstanceId || '', sets });
```

各 set の構造: `{type, setNum, side, weight, reps, targetInterval, time, duration, injurySite, injuryLevel, injuryMemo, memo}`

**Supabase 実装（completeEx 内の gasPost を置き換え）:**

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

合わせて、インターバル変更時の `updateExercise` gasPost（app.js:1012）も Supabase に変更:
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

`completeEx` を `async function` に変更する必要がある（現在は同期関数）。

---

#### saveSession

**app.js の呼び出し箇所（saveSession 関数内、app.js:1083）:**
```javascript
await gasPost({ action: 'saveSession', date, menu, startTime, endTime,
                condition, satisfaction, comment, sessionId });
```

**Supabase 実装（gasPost を置き換え）:**

```javascript
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

#### updateExerciseRecords

**app.js の呼び出し箇所（saveRecordModal / deleteExerciseRecordsConfirm、app.js:1661, 1678）:**
```javascript
await gasPost({ action: 'updateExerciseRecords', date, menu, exercise, sessionId, exInstanceId, sets });
```

⚠️ GAS はセット順序（time, targetInterval, duration）を引き継ぐが、Supabase 版では元データが DB にあるので取得して引き継ぐ必要がある。ただし **現実的には 0 で問題ない**（編集モーダルは weight/reps しか変えられない）ため、元データを取得し直して `time` と `target_interval` と `duration` を保持する方針で実装する。

```javascript
async function sbUpdateExerciseRecords(d) {
  const uid = _userId;

  // 既存レコードを取得して time/target_interval/duration を引き継ぐ
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

  // 削除
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

---

#### 設定系 CRUD

**種目（exercises テーブル）:**

```javascript
// addExercise（saveExModal 内）
const { error } = await sb.from('exercises').insert({
  user_id: _userId, name, unit, has_sides: hasSides,
  body_part: bodyPart, default_interval: defaultInterval,
  main_equipment: '', sub_equipment: '',
});

// updateExercise（saveExModal 内）
const { error } = await sb.from('exercises')
  .update({ name, unit, has_sides: hasSides, body_part: bodyPart, default_interval: defaultInterval })
  .eq('user_id', _userId).eq('name', S.editingExName);
// 名前変更時は records と menu_exercises も更新
if (S.editingExName !== name) {
  await sb.from('records').update({ exercise: name }).eq('user_id', _userId).eq('exercise', S.editingExName);
  await sb.from('menu_exercises').update({ exercise_name: name }).eq('user_id', _userId).eq('exercise_name', S.editingExName);
}

// deleteExercise（deleteExModal 内）
const { error } = await sb.from('exercises').delete().eq('user_id', _userId).eq('name', S.editingExName);
```

**メニュー（menus + menu_exercises テーブル）:**

menus テーブルには `id`（UUID）がある。フロントは `name` でしか扱わないので、操作前に `id` を取得する必要がある。

```javascript
// addMenu（addMenuModal 内）
const { error } = await sb.from('menus').insert({ user_id: _userId, name });

// deleteMenu（deleteMenuConfirm 内）
// menus を削除すると menu_exercises も CASCADE される（要確認: CLAUDE.md の SQL に ON DELETE CASCADE があるか？）
// ⚠️ CLAUDE.md の SQL を確認: menu_exercises に ON DELETE CASCADE はある。menus 削除で連鎖削除される。
const { error } = await sb.from('menus').delete().eq('user_id', _userId).eq('name', S.currentMenu);

// addMenuExercise（openMenuExAdd 内）
// menu の id を取得してから insert
const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
const { data: existing } = await sb.from('menu_exercises').select('order_num').eq('user_id', _userId).eq('menu_id', menuData.id);
const maxOrder = existing.length > 0 ? Math.max(...existing.map(e => e.order_num)) : 0;
await sb.from('menu_exercises').insert({ user_id: _userId, menu_id: menuData.id, exercise_name: exName, order_num: maxOrder + 1 });

// removeMenuExercise（removeMenuEx 内）
const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
await sb.from('menu_exercises').delete().eq('user_id', _userId).eq('menu_id', menuData.id).eq('exercise_name', exName);

// reorderMenuExercises（saveMenuOrder 内）
const { data: menuData } = await sb.from('menus').select('id').eq('user_id', _userId).eq('name', S.currentMenu).single();
await sb.from('menu_exercises').delete().eq('user_id', _userId).eq('menu_id', menuData.id);
await sb.from('menu_exercises').insert(exercises.map((ex, idx) => ({
  user_id: _userId, menu_id: menuData.id, exercise_name: ex, order_num: idx + 1,
})));
```

**怪我部位（injury_sites テーブル）:**

```javascript
// addInjurySite
await sb.from('injury_sites').insert({ user_id: _userId, name });

// updateInjurySite
await sb.from('injury_sites').update({ name }).eq('user_id', _userId).eq('name', S.editingInjuryOld);

// deleteInjurySite
await sb.from('injury_sites').delete().eq('user_id', _userId).eq('name', S.editingInjuryOld);
```

---

### 実装順序（推奨）

以下の順で進めると、動作確認しながら進められる。

1. **`gasGet` / `gasPost` / `gasGetWithRetry` / `GAS_URL` の削除** + `_userId` 変数追加 + 変換関数追加
2. **`getInitialData` → `sbGetInitialData`**（アプリ起動が確認できる）
3. **`saveSets` → Supabase INSERT**（記録ができるようになる） ＋ `completeEx` を async 化
4. **`saveSession` → Supabase INSERT**（セッション保存ができる）
5. **`getHistory` → `sbGetHistory`** ＋ `updateSession` / `deleteSession` の session_id 化
6. **`getExerciseData` → `sbGetExerciseData`**（前回データが表示される）
7. **`getExercisesWithLastDate` → `sbGetExercisesWithLastDate`**（履歴・分析の種目リスト）
8. **`getExerciseHistory` → `sbGetExerciseHistory`**（種目別履歴）
9. **`getInjuryHistory` → `sbGetInjuryHistory`**（怪我タブ）
10. **`getAnalysisData` → `sbGetAnalysisData`**（分析タブ）
11. **`updateExerciseRecords` → `sbUpdateExerciseRecords`**（記録編集）
12. **設定系 CRUD**（種目・メニュー・怪我部位）

---

### チェックリスト（各セッション終了時に更新）

- [ ] 1. gasGet/gasPost 削除 + _userId + 変換関数
- [ ] 2. getInitialData
- [ ] 3. saveSets + completeEx async 化
- [ ] 4. saveSession
- [ ] 5. getHistory + updateSession/deleteSession
- [ ] 6. getExerciseData
- [ ] 7. getExercisesWithLastDate
- [ ] 8. getExerciseHistory
- [ ] 9. getInjuryHistory
- [ ] 10. getAnalysisData
- [ ] 11. updateExerciseRecords
- [ ] 12. 設定系 CRUD（種目）
- [ ] 13. 設定系 CRUD（メニュー）
- [ ] 14. 設定系 CRUD（怪我部位）

---

## セッション分割方針（2026-06-28 決定）

### 背景

CLAUDE.md の指示で dev-log.md と migration-plan.md を読んでから作業を開始するが、
この2ファイルを読むだけでコンテキストが約 44% 埋まってしまう（migration-plan.md が 1265 行と大きいため）。
その状態から app.js（2455行）の広範な書き換えをすると、1セッションでコンテキストが枯渇するリスクがある。
そのため Phase 3 を以下の3セッションに分割して進める。

### Phase 3-A：コア記録フロー（ステップ 1〜4）

**「記録する」主要機能が動くようになることがゴール。**

- ステップ 1: `GAS_URL` 削除、`gasGet` / `gasPost` / `gasGetWithRetry` 削除、`_userId` 追加、変換関数（`toExercise` / `toSession` / `toRecord`）追加、全 `sb〜` 関数を API セクションに追加
- ステップ 2: `init()` の `gasGet` → `sbGetInitialData()`、バックグラウンド再取得も置き換え
- ステップ 3: `completeEx()` を `async` 化、saveSets → Supabase INSERT、インターバル更新 → Supabase UPDATE
- ステップ 4: `saveSession()` の `gasPost` → Supabase INSERT + エラー処理
- `onAuthStateChange` に `_userId = session.user.id` を追加
- `enterEx()` の `gasGet` → `sbGetExerciseData()`
- キャッシュバスター更新（index.html / sw.js）＋コミット

### Phase 3-B：履歴・怪我・分析タブ（ステップ 5〜11）

- ステップ 5: `loadHistoryDate()` → `sbGetHistory()`、`saveSessionModal()` / `deleteSessionConfirm()` を session_id ベースに変更
- ステップ 6: （enterEx() は Phase 3-A で対応済み）
- ステップ 7: `loadHistExList()` / `loadAnalysisExList()` → `sbGetExercisesWithLastDate()`
- ステップ 8: `loadHistExDetail()` / `loadS3Hist()` → `sbGetExerciseHistory()`
- ステップ 9: `loadInjuryHistory()` / `loadS3Injury()` → `sbGetInjuryHistory()`
- ステップ 10: `loadAnalysis()` → `sbGetAnalysisData()`
- ステップ 11: `saveRecordModal()` / `deleteExerciseRecordsConfirm()` → `sbUpdateExerciseRecords()`
- キャッシュバスター更新＋コミット

### Phase 3-C：設定 CRUD（ステップ 12〜14）

- ステップ 12: `saveExModal()` / `deleteExModal()` → exercises テーブル CRUD
- ステップ 13: `addMenuModal()` / `deleteMenuConfirm()` / `saveMenuOrder()` / `removeMenuEx()` / `openMenuExAdd()` → menus + menu_exercises CRUD
- ステップ 14: `saveInjuryModal()` / `deleteInjuryModal()` → injury_sites CRUD
- キャッシュバスター更新＋コミット

### 次のセッションへの引き継ぎ

各セッション開始時の指示例：
- 「Phase 3-A を進めて」
- 「Phase 3-B を進めて」
- 「Phase 3-C を進めて」

チェックリストの完了項目は `[x]` に更新してコミットすること。
