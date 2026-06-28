# workoutlog3 — Claude向けプロジェクトコンテキスト

## ⚠️ セッション開始時の必須アクション

他の作業を始める前に、必ず `docs/dev-log.md` を Read ツールで開いて読む。

## 開発ログ

開発経緯・設計判断・バグ修正の背景は `docs/dev-log.md` に記録している。

## コミットルール

コードを修正・追加したら必ずコミットする。Push はユーザーが行うため Claude は行わない。コミットメッセージは日本語で書く。

**コミットには必ず `docs/dev-log.md` への追記を含める。** コードと同じコミットに入れること。

## プロジェクト概要

workoutlog2（GAS + Googleスプレッドシート）をSupabase（PostgreSQL）に移行した筋トレ記録PWA。
GASのコールドスタートとSheets全行スキャンによる遅延を解消し、体感5〜10倍の高速化を目指す。

- 移行元: `/Users/tsuyoshi/ドキュメント/AI_Project/workoutlog2/`
- 認証: Supabase Auth（メール＋パスワード、初回のみ入力・以降自動ログイン）
- フロントエンド: workoutlog2をベースに gasGet/gasPost を Supabase クライアント呼び出しに置き換え
- デプロイ先: GitHub Pages（GitHub ユーザー: twoweller-hub）

## ファイル構成

```
workoutlog3/
├── index.html            # PWA ルート
├── app.js                # 全フロントエンドロジック（単一ファイル）
├── style.css             # 全スタイル
├── sw.js                 # Service Worker
├── manifest.webmanifest
├── icon-192.png / icon-512.png
└── docs/
    └── dev-log.md        # 開発ログ（必ずセッション開始時に読む）
```

---

## GitHub 新規リポジトリ作成手順

ローカルで `git init` 済みの状態から、GitHubに新規リポジトリを作ってリモート接続するまでの手順。

### 1. GitHubでリポジトリを作成

1. ブラウザで https://github.com を開いてログイン
2. 右上の「**＋**」ボタンをクリック → 「**New repository**」を選択
3. 以下を入力：
   - **Repository name**: `workoutlog3`
   - **Description**: 筋トレ記録PWA（Supabase版）
   - **Public** / **Private** を選択（どちらでもよい）
   - ⚠️ 「Initialize this repository with a README」は**チェックしない**（ローカルに既にファイルがある）
4. 「**Create repository**」をクリック

### 2. ローカルとリモートを接続

GitHubがリポジトリ作成後に表示するコマンドをコピペして実行する（以下は参考）：

```bash
git remote add origin https://github.com/twoweller-hub/workoutlog3.git
git branch -M main
git push -u origin main
```

### 3. GitHub Pages の設定

1. リポジトリページの「**Settings**」タブをクリック
2. 左メニューの「**Pages**」をクリック
3. Source: 「**Deploy from a branch**」を選択
4. Branch: `main` / `/ (root)` を選択 → 「**Save**」
5. 数分後に `https://twoweller-hub.github.io/workoutlog3/` で公開される

---

## Supabase テーブル設計

workoutlog2 の Google Sheets 構成をそのまま PostgreSQL に移行。
時刻は **TEXT型（'HH:mm'）** で保存してUTC+9バグを防止。

### プロジェクト作成後に実行するSQL

```sql
-- =====================
-- 種目マスター
-- =====================
CREATE TABLE exercises (
  id               uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid REFERENCES auth.users NOT NULL,
  name             text NOT NULL,
  unit             text NOT NULL DEFAULT '回',       -- '回' | '秒'
  default_interval integer NOT NULL DEFAULT 90,
  body_part        text NOT NULL DEFAULT '',
  main_equipment   text NOT NULL DEFAULT '',
  sub_equipment    text NOT NULL DEFAULT '',
  has_sides        boolean NOT NULL DEFAULT false,
  created_at       timestamptz DEFAULT now(),
  UNIQUE(user_id, name)
);
ALTER TABLE exercises ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON exercises FOR ALL USING (user_id = auth.uid());

-- =====================
-- メニューマスター
-- =====================
CREATE TABLE menus (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES auth.users NOT NULL,
  name       text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, name)
);
ALTER TABLE menus ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON menus FOR ALL USING (user_id = auth.uid());

-- =====================
-- メニュー内種目（順番付き）
-- =====================
CREATE TABLE menu_exercises (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid REFERENCES auth.users NOT NULL,
  menu_id       uuid REFERENCES menus(id) ON DELETE CASCADE NOT NULL,
  exercise_name text NOT NULL,
  order_num     integer NOT NULL DEFAULT 0,
  created_at    timestamptz DEFAULT now()
);
ALTER TABLE menu_exercises ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON menu_exercises FOR ALL USING (user_id = auth.uid());

-- =====================
-- 怪我部位マスター
-- =====================
CREATE TABLE injury_sites (
  id         uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id    uuid REFERENCES auth.users NOT NULL,
  name       text NOT NULL,
  created_at timestamptz DEFAULT now(),
  UNIQUE(user_id, name)
);
ALTER TABLE injury_sites ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON injury_sites FOR ALL USING (user_id = auth.uid());

-- =====================
-- セッション
-- =====================
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid REFERENCES auth.users NOT NULL,
  session_id   text UNIQUE NOT NULL,          -- フロントで生成: 'sid_' + Date.now()
  date         date NOT NULL,
  menu         text NOT NULL DEFAULT '',      -- 単発記録は空文字
  start_time   text NOT NULL DEFAULT '',      -- 'HH:mm' TEXT型
  end_time     text NOT NULL DEFAULT '',      -- 'HH:mm' TEXT型
  condition    text NOT NULL DEFAULT '',      -- '好調'|'普通'|'不調'
  satisfaction text NOT NULL DEFAULT '',      -- 'よくできた'|'まあまあ'|'いまいち'
  comment      text NOT NULL DEFAULT '',
  created_at   timestamptz DEFAULT now()
);
ALTER TABLE sessions ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON sessions FOR ALL USING (user_id = auth.uid());

-- =====================
-- 記録（セット単位）
-- =====================
CREATE TABLE records (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         uuid REFERENCES auth.users NOT NULL,
  session_id      text REFERENCES sessions(session_id) ON DELETE CASCADE NOT NULL,
  ex_instance_id  text NOT NULL DEFAULT '',   -- 'exinst_' + Date.now() + '_' + idx
  date            date NOT NULL,
  time            text NOT NULL DEFAULT '',   -- 'HH:mm' TEXT型
  menu            text NOT NULL DEFAULT '',
  exercise        text NOT NULL,
  set_type        text NOT NULL,              -- 'ウォームアップ'|'メイン'
  set_num         integer NOT NULL,
  side            text NOT NULL DEFAULT '',   -- ''|'右'|'左'
  weight          numeric,
  reps            numeric,
  target_interval integer,
  injury_site     text NOT NULL DEFAULT '',
  injury_level    text NOT NULL DEFAULT '',
  injury_memo     text NOT NULL DEFAULT '',
  memo            text NOT NULL DEFAULT '',
  duration        integer,                    -- セット所要時間（秒）
  created_at      timestamptz DEFAULT now()
);
ALTER TABLE records ENABLE ROW LEVEL SECURITY;
CREATE POLICY "own" ON records FOR ALL USING (user_id = auth.uid());
```

### workoutlog2 シート → workoutlog3 テーブル 対応表

| Sheets | PostgreSQL |
|--------|-----------|
| 記録シート | `records` |
| セッションシート | `sessions` |
| 種目マスター | `exercises` |
| メニューシート | `menus` + `menu_exercises` |
| 怪我部位マスター | `injury_sites` |

---

## 開発ロードマップ

### Phase 0: 初期セットアップ（完了）
- [x] ファイル作成（index.html, app.js, style.css, sw.js, manifest.webmanifest）
- [x] git init

### Phase 1: Supabase プロジェクト設定
- [ ] Supabase で新規プロジェクト作成
- [ ] 上記 SQL を実行してテーブル作成
- [ ] RLS の動作確認
- [ ] Supabase JS SDK のCDN追加（index.html）
- [ ] `SUPABASE_URL` と `SUPABASE_ANON_KEY` を app.js に設定

### Phase 2: 認証フロー実装
- [ ] ログイン画面（メール＋パスワード）を index.html に追加
- [ ] Supabase Auth でサインイン/サインアップ処理
- [ ] セッション管理（自動ログイン）

### Phase 3: API置き換え（gasGet/gasPost → Supabase）
- [ ] `getInitialData` 相当: exercises, menus, injury_sites, stats を並列取得
- [ ] `saveSets` → records テーブルに INSERT
- [ ] `saveSession` → sessions テーブルに INSERT
- [ ] `getHistory` → sessions + records を JOIN してページネーション
- [ ] `getExerciseData` → 前回セットデータ取得
- [ ] `getExerciseHistory` → 種目別履歴
- [ ] `getAnalysisData` → 種目別集計
- [ ] 設定系（種目/メニュー/怪我部位のCRUD）

### Phase 4: データ移行
- [ ] workoutlog2 の Google Sheets から CSV エクスポート
- [ ] Supabase のインポート機能でインポート
- [ ] データ整合性確認

### Phase 5: 本番切り替え
- [ ] GitHub Pages へのデプロイ確認
- [ ] PWA インストール確認（iOS Safari / Android Chrome）
- [ ] workoutlog2 から切り替え（新しいスプレッドシートへの記録停止）

---

## UI / デザイントークン（workoutlog2から継承）

| 変数 | 値 | 用途 |
|------|-----|------|
| bg | `#111318` | アプリ背景 |
| surface | `#1c1f2a` | カード・モーダル背景 |
| accent | `#d4f53c` | ボタン・ハイライト |
| text-sub | `#b0b8c8` | サブテキスト |

## Service Worker

- キャッシュ名: `workoutlog3-v1`（バージョンを変えるとキャッシュが強制クリアされる）
- HTML/CSS/JS → **network-first**（取得失敗時のみキャッシュから返す）
- 画像・マニフェスト → **cache-first**
- Supabase（`supabase.co`）→ **キャッシュしない**

## キャッシュバスター

`style.css` または `app.js` を変更したコミットには必ずキャッシュバスターの更新を含める：
- `style.css` 変更時 → `index.html` の `style.css?vN` を +1、`sw.js` の `CACHE` 名を +1
- `app.js` 変更時 → `index.html` の `app.js?vN` を +1、`sw.js` の `CACHE` 名を +1
