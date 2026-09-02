# キオク（Kioku）

間隔反復（spaced repetition）で暗記するWebアプリ。Anki風。
インストール可能なPWAで、オフラインでも動作します。

**ビルド不要** — Preact + htm を ESM CDN から読み込む素のHTML/JSです。`app.js` を編集して push すれば、それがそのまま本番になります。

## 機能

- デッキ管理（作成・削除）とカード管理（追加・削除）
- 学習セッション：表 → 答えを表示 → 4段階評価（もう一度 / むずかしい / できた / かんたん）
- SM-2 簡易版のスケジューリング。各ボタンに次回出題時期をプレビュー表示
- キーボード操作：Space / Enter でめくる・「できた」、1〜4 で評価
- ひとつ戻す（Undo）、今日はスキップ
- 学習の記録：連続学習日数、週/月の枚数、正答率、3か月ヒートマップ、定着状況、7日間の出題予測、デッキ別定着率
- 保存：端末内（localStorage）。任意で Supabase による複数端末同期
- JSON バックアップの書き出し／読み込み

## 構成

```
index.html              HTMLシェル（フォント・CSSリセット・SW登録）
app.js                  アプリ全体（Preact + htm、1ファイル）
sw.js                   Service Worker（オフラインキャッシュ）
manifest.webmanifest    PWA マニフェスト
icon-*.png              アプリアイコン
netlify.toml            Netlify 設定（publish = ルート）
CLAUDE.md               開発ガイド（設計方針・アルゴリズム・注意点）
```

## ローカルで動かす

```bash
python3 -m http.server 8000
# → http://localhost:8000
```

`file://` で開くと ES モジュールが読み込めないため、簡易サーバー経由で開いてください。

## 開発

1. `app.js` を編集
2. `sw.js` の `CACHE`（`kioku-v5` など）の番号を上げる ← **必須**。忘れると既存端末が更新されません
3. 動作確認して commit & push

詳しい設計方針・データ構造・学習アルゴリズム・やってはいけないことは [CLAUDE.md](./CLAUDE.md) にまとめてあります。

## デプロイ（Netlify）

main への push で自動デプロイされます。Build command は空、Publish directory はリポジトリルート（`netlify.toml` に設定済み）。

## 同期（任意・Supabase）

設定しない場合、学習データは端末内にのみ保存されます。複数端末で同期する場合：

1. [Supabase](https://supabase.com) で無料プロジェクトを作成
2. SQL Editor で以下を実行

```sql
create table if not exists kioku_state (
  user_id uuid primary key references auth.users on delete cascade,
  data jsonb not null,
  updated_at timestamptz not null default now()
);
alter table kioku_state enable row level security;
drop policy if exists "own rows" on kioku_state;
create policy "own rows" on kioku_state
  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);
```

3. Project Settings → API から **Project URL** と **Publishable key**（`sb_publishable_…`／旧 anon key）をコピー
   - Secret key は使用しません
4. アプリの「同期」画面に貼り付けて保存 → メールアドレスとパスワードで登録・ログイン

補足：
- Authentication → Sign In / Providers → Email の **Confirm email** を OFF にすると、確認メールなしで登録できます
- Authentication → URL Configuration の **Site URL** を公開URLにしておくと、確認メールのリンクが正しく戻ります
- データは行単位セキュリティ（RLS）で保護され、各ユーザーは自分の行のみ読み書きできます
- 競合は「後に書いた方が勝つ」方式（last-write-wins）です

## ライセンス

MIT
