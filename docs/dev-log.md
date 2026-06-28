# workoutlog3 開発ログ

---

## 2026-06-28 — 初期セットアップ

### 作業内容

workoutlog2（GAS + Googleスプレッドシート）をSupabaseに移行する新プロジェクト `workoutlog3` の初期ファイルを作成した。

**作成ファイル:**
- `CLAUDE.md` — GitHub新規リポジトリ作成手順・Supabaseテーブル設計（SQL）・開発ロードマップを含む
- `docs/dev-log.md` — 本ファイル
- `index.html` — workoutlog2からコピーし、workoutlog3用に修正（アプリ名変更・パス変更）
- `app.js` — workoutlog2からそのままコピー（Phase 3でSupabaseに置き換え予定）
- `style.css` — workoutlog2からそのままコピー
- `sw.js` — キャッシュ名・URLパスをworkoutlog3用に変更
- `manifest.webmanifest` — アプリ名・start_url・scopeをworkoutlog3用に変更
- `.gitignore` — 新規作成

**index.htmlの変更点（workoutlog2比）:**
- `link[href]` マニフェストパス: `/workoutlog2/` → `/workoutlog3/`
- サイドバーロゴ: `WORKOUT LOG2` → `WORKOUT LOG3`
- ヘッダーアプリタイトル: `WORKOUT LOG2` → `WORKOUT LOG3`
- GoogleスプレッドシートへのリンクをサイドバーNAVから削除
- SW登録パス: `/workoutlog2/sw.js` → `/workoutlog3/sw.js`
- キャッシュバスター: `style.css?v=77` → `?v=1` / `app.js?v=64` → `?v=1`

**git init 実施。**

---

## 2026-06-28 — 移行シミュレーションと計画文書作成

### 作業内容

workoutlog2（GAS + Sheets）→ workoutlog3（Supabase）の移行を詳細にシミュレートし、
実装上の要注意ポイントを洗い出して `docs/migration-plan.md` にまとめた。

**要注意ポイント（詳細は migration-plan.md 参照）:**
1. `session_id` NOT NULL制約 vs 旧データ（空文字列の補完が必要）
2. `updateSession` / `deleteSession` が数値 id → `session_id`（text）に変更必要
3. camelCase vs snake_case のフィールド名ズレ（変換関数が必要）
4. `getInitialData` の複合計算（menuLastDates / stats）は JS 側で集計
5. `gasPost` の fire-and-forget → Supabase では明示的エラー処理が必要

**CLAUDE.md の変更点:**
- セッション開始時の必須アクションに `docs/migration-plan.md` を追加
- Phase 5 完了後は「dev-log.md だけ読むように戻して」と依頼すればよい

migration-plan.md に Phase 1（Supabase セットアップ）の詳細手順を追記。
アカウント作成・プロジェクト作成・SQL実行・APIキー取得・RLS確認まで初心者向けに記載。

---

## 2026-06-28 — PWAアイコン作成

絵文字を 🏋️ から 💪 に変更したアイコンを作成。

- `make_icons.swift` を新規作成（workoutlog2版から絵文字のみ変更）
- `icon-192.png` / `icon-512.png` を生成（背景色 #d4f53c は継承）

---

---

## 2026-06-28 — Phase 1: Supabase セットアップ完了

### 作業内容

**ユーザーが Supabase ダッシュボードで実施:**
- プロジェクト `workoutlog3` 作成（リージョン: Tokyo）
- テーブル6種 + インデックス6件を SQL Editor で作成
- API キー取得（新形式 `sb_publishable_` の Publishable key）

**コード変更:**
- `index.html`: Supabase JS SDK（@2系）CDN を追加、`app.js?v=2` にキャッシュバスター更新
- `app.js`: `SUPABASE_URL` / `SUPABASE_ANON_KEY` 定数を先頭に追加（GAS_URL は Phase 3 削除予定）
- `sw.js`: キャッシュ名を `workoutlog3-v2` に更新

**Supabase プロジェクト情報:**
- URL: `https://bygocxazrbkydrqtbsrf.supabase.co`
- Publishable key: `sb_publishable_xYuWtGjhulxA4_vP00OqfA__3NedqRC`

### 次のステップ（Phase 2）

1. `index.html` にログイン画面を追加
2. Supabase Auth でサインイン/サインアップ処理を実装
3. セッション管理（自動ログイン）

---

## 2026-06-28 — Phase 2: 認証フロー実装

### 作業内容

**index.html:**
- ログイン画面（`#login-screen`）を `<body>` 直後に追加（メール・パスワード入力、ログイン/新規登録切り替え）
- 設定タブにログアウトボタン（`#btn-logout`）を追加
- キャッシュバスター: `style.css?v=2`、`app.js?v=3`

**style.css:**
- ログイン画面スタイル追加（`#login-screen`, `.login-box`, `.login-input` 等）

**app.js:**
- Supabase クライアント初期化: `const sb = window.supabase.createClient(...)`
- 認証関数追加: `_handleAuthSubmit`, `_toggleAuthMode`, `handleLogout`, `showLoginScreen`, `hideLoginScreen`
- `init()` にセットアップ重複防止ガード（`_appSetupDone` フラグ）追加
- `DOMContentLoaded` を認証対応に置き換え: `onAuthStateChange` で INITIAL_SESSION/SIGNED_IN/SIGNED_OUT を処理

**sw.js:** キャッシュ名を `workoutlog3-v3` に更新

### 認証フローの設計
- アプリ起動時 → `INITIAL_SESSION` イベント → セッションあり: ログイン画面を隠してアプリ起動 / なし: ログイン画面を表示
- ログイン/新規登録成功 → `SIGNED_IN` イベント → ログイン画面を隠してアプリ起動
- ログアウト → `SIGNED_OUT` イベント → ログイン画面を表示

### 次のステップ（Phase 3）

- Supabase Auth の動作確認（新規登録・ログイン・自動ログイン）
- `gasGet` / `gasPost` を Supabase クエリに置き換え（app.js の API 置き換え）

---

## 2026-06-28 — Phase 1〜2 実施時の躓きポイント（記録）

次回以降の参考のため、ユーザーが実際に詰まった箇所をまとめる。

### Phase 1 の躓き

**① SQL 実行時に ` ```sql ` ごとコピーしてエラー**
- 現象: `syntax error at or near "` ``` `"`
- 原因: CLAUDE.md のコードブロック記号（` ```sql ` / ` ``` `）まで含めてコピーした
- 対策: SQL 文だけを選択してコピーするよう明示すること

**② Supabase の API キーページが分かりにくい**
- Data API ページを開いてしまい、Project API keys が見つからなかった
- 現在の Supabase UI では Settings → **API Keys** ページに移動する必要がある
- さらに API キーの形式が旧来の `eyJ...`（JWT）から `sb_publishable_...` に変わっていた
- `sb_publishable_` キーが Supabase JS SDK v2 の anon key 相当

**③ Supabase プロジェクト作成時のオプション説明が不足していた**
- 「GitHub に接続」「自動 RLS を有効にする」「データ API を有効にする」など複数の選択肢に戸惑った
- GitHub 接続は不要（スキップ）、他はデフォルトのままで OK

### GitHub リポジトリ・Pages の躓き

**④ Public / Private の選択で迷った**
- workoutlog2 での経験から「GitHub Pages は Public でないと動かない」という記憶があったが確信が持てなかった
- 正解: 無料アカウントでは GitHub Pages は **Public リポジトリのみ** 使用可能
- anon キーを公開してもRLSがあるので問題なし

**⑤ 「Initialize this repository with a README」のチェックボックスが見つからなかった**
- 現在の GitHub UI では「Add README」というトグル（スイッチ）になっており、デフォルトで Off になっている
- チェックボックスではなくトグルなので見た目が変わっていた

**⑥ `git remote add` がサンドボックス制限でここから実行できなかった**
- Claude のサンドボックスが `.git/config` への書き込みを禁止している
- 対策: VS Code の「Publish Branch」機能を使うとリモート登録とプッシュを一括でできる

### Phase 2（認証）の躓き

**⑦ 確認メールのリンクが `localhost:3000` に飛んだ**
- 原因: Supabase の Site URL がデフォルトの `localhost:3000` のままだった
- 対策: Authentication → URL Configuration → Site URL を `https://twoweller-hub.github.io/workoutlog3/` に変更し、Redirect URLs にも同 URL を追加する
- **次回新規プロジェクト作成時は Phase 1 の手順に「Site URL の設定」を追加すること**

**⑧ メール未確認でもログインできてしまった**
- Supabase のデフォルト設定ではメール未確認でもサインインが通る場合がある
- 個人アプリなので実害なし。ログイン認証（パスワード）自体は正常に機能している

---

## 2026-06-28 — Phase 3 実装詳細を migration-plan.md に追記

### 作業内容

Phase 3（gasGet/gasPost → Supabase 置き換え）の実装が複数セッションにまたがることを想定し、
GAS ソース（`workoutlog2/gas/api.gs`）と `app.js` を全文確認した上で、
`docs/migration-plan.md` に「Phase 3 実装詳細」セクションを追記した。

**追記した内容:**
- `_userId` モジュール変数と `onAuthStateChange` での保存パターン
- `toExercise` / `toSession` / `toRecord` 変換関数（snake_case → camelCase）
- 全 GAS アクション（14種）の返却形式と Supabase 実装コード
- `exerciseElapsed` の計算ロジック（GAS から確認済み）
- `updateSession` / `deleteSession` の session_id 化方針
- メニュー CRUD での menu_id 取得パターン
- 推奨実装順序（14ステップ）とチェックリスト

**コード変更なし。次のセッションから実装開始できる状態。**

---

## 2026-06-28 — Phase 3 をセッション分割・実装ファイル分割

### 背景

dev-log.md + migration-plan.md（1265行）の読込だけでコンテキストが約 44% 埋まり、
そこから app.js（2455行）の書き換えをすると 80% を超えてレスポンス劣化が起きることが判明。

### 作業内容

**migration-plan.md の軽量化（1265行 → 348行）:**
- Phase 3 実装コード（約 900行）を 3 ファイルに分割して切り出した
- 要注意ポイント・API対応表・フェーズ手順の概要のみ migration-plan.md に残した

**新規作成ファイル:**
- `docs/phase3a-impl.md` — コア記録フロー（GAS削除・_userId・getInitialData・saveSets・saveSession）
- `docs/phase3b-impl.md` — 履歴・怪我・分析タブ（getHistory〜updateExerciseRecords）
- `docs/phase3c-impl.md` — 設定系 CRUD（種目・メニュー・怪我部位）

**CLAUDE.md 更新:**
- セッション開始時の必須読込に Phase 3 セッション別の指示を追記
- 「Phase 3-A を進めて」等の指示で該当 impl ファイルだけ読む運用に変更

**想定コンテキスト削減効果:**
- 旧: dev-log.md + migration-plan.md で約 44% → 残り 56% で作業
- 新: dev-log.md + migration-plan.md + phase3x-impl.md で約 20〜25% → 残り 75〜80% で作業

**コード変更なし。次のセッションで「Phase 3-A を進めて」と指示すれば実装開始できる。**

---

## 2026-06-28 — Phase 3-A: コア記録フロー実装（ステップ 1〜6）

### 作業内容

GAS API を Supabase に全面置き換えた。これで「記録する」主要機能が Supabase で動く。

**変更ファイル:**
- `app.js`: 以下の変更
  - `GAS_URL` 定数を削除
  - `gasGet` / `gasGetWithRetry` / `gasPost` を削除し、Supabase 実装に置き換え
  - 変換関数追加: `toExercise()` / `toRecord()` / `toSession()`（snake_case→camelCase）
  - `sbGetInitialData()` 追加（exercises/menus/menu_exercises/injury_sites/sessions/records を並列取得）
  - `_calcStats()` 追加（連続記録日数・合計回数をJS側で集計）
  - `sbGetExerciseData()` 追加（前回セットデータ取得）
  - `let _userId = null` 追加（`_appSetupDone` 直後）
  - `init()` の `gasGet({action:'getInitialData'})` → `sbGetInitialData()` に置き換え（2か所）
  - `enterEx()` の `gasGet({action:'getExerciseData'})` → `sbGetExerciseData()` に置き換え
  - `completeEx()` を async 化 + saveSets を `sb.from('records').insert(rows)` に置き換え
  - `completeEx()` のインターバル更新を `sb.from('exercises').update()` に置き換え
  - `saveSession()` の gasPost を `sb.from('sessions').insert()` に置き換え（エラー時は早期 return）
  - `onAuthStateChange` に `_userId = session.user.id` の代入を追加
- `index.html`: `app.js?v=4` に更新
- `sw.js`: `workoutlog3-v4` に更新

### 次のステップ（Phase 3-B）

「Phase 3-B を進めて」で履歴・怪我・分析タブの実装を行う。

---

## 2026-06-28 — Phase 3-B: 履歴・怪我・分析タブ実装（ステップ 5〜10）

### 作業内容

履歴・怪我・分析タブおよび記録編集モーダルの GAS API を Supabase に全面置き換えた。

**変更ファイル:**
- `app.js`: 以下の変更
  - API セクションに 6 関数を追加:
    - `sbGetHistory()` — セッション一覧 + 対象日付の records を取得してページネーション
    - `sbGetExercisesWithLastDate()` — 全 records から種目ごとの最終実施日を集計
    - `sbGetExerciseHistory()` — 種目別履歴（ex_instance_id 単位でグループ化・exerciseElapsed 計算）
    - `sbGetInjuryHistory()` — injury_site != '' の records を降順取得
    - `sbGetAnalysisData()` — メインセットの日付別集計（最高重量・レップ・ボリュームなど）
    - `sbUpdateExerciseRecords()` — 既存 records の時刻を保持した上で削除 → 再 INSERT
  - 置き換え箇所（gasGet/gasPost → sb 関数）:
    - `loadHistoryDate()` → `sbGetHistory()`
    - `saveSessionModal()` → `sb.from('sessions').update()` / エラー時 return
    - `deleteSessionConfirm()` → records を先に削除（CASCADE 無効のため手動）→ sessions 削除
    - `loadHistExList()` → `sbGetExercisesWithLastDate()`
    - `loadHistExDetail()` → `sbGetExerciseHistory()`
    - `loadS3Hist()` → `sbGetExerciseHistory()`
    - `loadInjuryHistory()` → `sbGetInjuryHistory()`
    - `loadS3Injury()` → `sbGetInjuryHistory()`
    - `loadAnalysisExList()` → `sbGetExercisesWithLastDate()`
    - `loadAnalysis()` → `sbGetAnalysisData()`
    - `saveRecordModal()` → `sbUpdateExerciseRecords()`
    - `deleteExerciseRecordsConfirm()` → `sbUpdateExerciseRecords()`
- `index.html`: `app.js?v=5` に更新
- `sw.js`: `workoutlog3-v5` に更新

**deleteSession の注意点:**
records.session_id の FK 制約は Phase 3-A 前に削除済みのため CASCADE が効かない。
records を先に DELETE → sessions を DELETE の順で実装。

### 次のステップ（Phase 3-C）

「Phase 3-C を進めて」で設定系 CRUD（種目・メニュー・怪我部位）の実装を行う。

---

## 2026-06-28 — Phase 3-C: 設定系 CRUD 実装（ステップ 12〜14）

### 作業内容

設定タブの全 CRUD 操作の GAS API を Supabase に置き換えた。これで `gasPost` の呼び出しがコードから完全になくなった。

**変更ファイル:**
- `app.js`: 以下の変更
  - `saveExModal()` — exercises テーブルへの update/insert に置き換え。名前変更時は records・menu_exercises も update
  - `deleteExModal()` — exercises テーブルへの delete に置き換え
  - `saveMenuOrder()` — menu_id を select で取得 → menu_exercises を delete + insert（全件洗い替え）
  - `removeMenuEx()` — menu_id を select で取得 → menu_exercises から対象行を delete
  - `openMenuExAdd()` 内クリックハンドラ — menu_id を select で取得 → 最大 order_num を取得 → menu_exercises に insert
  - `addMenuModal()` — menus テーブルへの insert に置き換え
  - `deleteMenuConfirm()` — menus テーブルへの delete に置き換え（menu_exercises は CASCADE で自動削除）
  - `saveInjuryModal()` — injury_sites テーブルへの update/insert に置き換え
  - `deleteInjuryModal()` — injury_sites テーブルへの delete に置き換え
- `index.html`: `app.js?v=6` に更新
- `sw.js`: `workoutlog3-v6` に更新

### Phase 3 完了

Phase 3-A〜C が完了し、GAS API (gasGet/gasPost) をすべて Supabase クライアントに置き換えた。
次は Phase 4（データ移行）または動作確認。

---

## 2026-06-28 — バグ修正: 怪我記録削除後に怪我タブが即時反映されない

### 原因

記録を削除・編集する `saveRecordModal` / `deleteExerciseRecordsConfirm` で
`S.histDateItems = []` はリセットしていたが `S.injuryRecords` をリセットしていなかった。
そのため怪我タブが古いキャッシュを使い続け、リロードするまで反映されなかった。

### 修正

両関数に `S.injuryRecords = null` を追加。
次に怪我タブを開いたとき `loadInjuryHistory()` が再取得する。

---

## 2026-06-28 — バグ修正: 怪我を登録した後に同種目を再記録すると怪我履歴が即時表示されない

### 原因

`completeEx()` が records を INSERT した後も `S.injuryRecords` をリセットしなかった。
次の `enterEx()` → `loadS3Injury()` 呼び出し時に `S.injuryRecords !== null` だった場合、
古いキャッシュをそのまま描画し、直前の怪我記録が表示されなかった。

### 修正

`completeEx()` の records INSERT 完了直後に `S.injuryRecords = null` を追加。
次に `loadS3Injury()` が呼ばれたとき必ず Supabase から再取得するようになった。
