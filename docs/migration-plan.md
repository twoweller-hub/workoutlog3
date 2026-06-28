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

**対策：取得直後に変換するラッパーを1か所に置く（phase3a-impl.md の toExercise 参照）**

---

### ⚠️ 4. `getInitialData` の複合計算（menuLastDates / recentSingle / stats）

GAS は1リクエストで6種類のデータを計算して返す。Supabase では分解が必要。
- menuLastDates: 全 sessions を SELECT して JS で GROUP BY
- stats（streak）: sessions の date だけ SELECT して JS で計算
- recentSingle: records を date 降順 500 件取得して JS で重複除去

実装コードは `docs/phase3a-impl.md` の `sbGetInitialData` 参照。

---

### ⚠️ 5. `gasPost` がfire-and-forget → Supabase では明示的エラー処理が必要

```javascript
// workoutlog2 の gasPost
mode: 'no-cors'  // レスポンスが読めない
.catch(() => {}) // エラーも無視
```

`saveSets` / `saveSession` はこの設計のため、GAS 側でエラーが出ても気づけなかった。
Supabase JS クライアントはエラーを返すため、今まで隠れていた失敗が表面化する可能性がある。

**対策：最低限のエラー処理を追加（各 sb 関数内に実装済み）**

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

実装コードは分割ファイルに記載。セッション開始時は該当ファイルだけ読めばよい。

| セッション | 読むファイル | 内容 |
|---|---|---|
| Phase 3-A | `docs/phase3a-impl.md` | GAS削除・_userId・変換関数・getInitialData・saveSets・saveSession |
| Phase 3-B | `docs/phase3b-impl.md` | getHistory・getExerciseHistory・getInjuryHistory・getAnalysisData・updateExerciseRecords |
| Phase 3-C | `docs/phase3c-impl.md` | 設定系 CRUD（種目・メニュー・怪我部位） |

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

## Phase 3 チェックリスト（各セッション終了時に更新）

- [ ] 3-A-1. gasGet/gasPost 削除 + _userId + 変換関数 + sb 関数追加
- [ ] 3-A-2. getInitialData（init() + saveSession バックグラウンド再取得）
- [ ] 3-A-3. saveSets + completeEx async 化 + インターバル更新
- [ ] 3-A-4. saveSession
- [ ] 3-A-5. enterEx（getExerciseData）
- [ ] 3-A-6. onAuthStateChange に _userId 追加
- [ ] 3-B-1. getHistory + updateSession/deleteSession（session_id ベース）
- [ ] 3-B-2. getExercisesWithLastDate（loadHistExList / loadAnalysisExList）
- [ ] 3-B-3. getExerciseHistory（loadHistExDetail / loadS3Hist）
- [ ] 3-B-4. getInjuryHistory（loadInjuryHistory / loadS3Injury）
- [ ] 3-B-5. getAnalysisData
- [ ] 3-B-6. updateExerciseRecords（saveRecordModal / deleteExerciseRecordsConfirm）
- [ ] 3-C-1. 設定系 CRUD（種目）
- [ ] 3-C-2. 設定系 CRUD（メニュー）
- [ ] 3-C-3. 設定系 CRUD（怪我部位）

---

## セッション分割方針（2026-06-28 決定）

### 背景

CLAUDE.md の指示で dev-log.md と migration-plan.md を読んでから作業を開始するが、
dev-log.md + migration-plan.md の読み込みだけでコンテキストが約 44% 埋まってしまっていた
（旧 migration-plan.md が 1265 行と大きかったため）。
その状態から app.js（2455行）の広範な書き換えをすると 80% を超えてレスポンス劣化が起きる。

### 対策

Phase 3 の実装コードを 3 ファイルに分割し、migration-plan.md を軽量化した。
各セッションでは migration-plan.md 全体でなく、該当フェーズの impl ファイルだけ読む。

| ファイル | 行数（目安） |
|---|---|
| migration-plan.md（本ファイル） | ~250行 |
| phase3a-impl.md | ~200行 |
| phase3b-impl.md | ~250行 |
| phase3c-impl.md | ~130行 |

### 各セッション開始時の指示例

- 「Phase 3-A を進めて」
- 「Phase 3-B を進めて」
- 「Phase 3-C を進めて」

チェックリストの完了項目は `[x]` に更新してコミットすること。
