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
