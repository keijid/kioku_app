# キオク（Kioku）

間隔反復（spaced repetition）で暗記するWebアプリ。Anki風。
インストール可能なPWAで、オフラインでも動作します。

**ビルド不要** — Preact + htm を ESM CDN から読み込む素のHTML/JSです。`app.js` を編集して push すれば、それがそのまま本番になります。

## 機能

- デッキ管理（作成・削除）とカード管理（追加・編集・削除）
- カードは 表 / 裏 / 補足（単語なら例文、用語なら説明文）の3つ
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
firebase.json           Firebase Hosting の公開設定
.firebaserc             Firebase のプロジェクトID
.github/workflows/      main への push で Firebase Hosting に公開
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

## デプロイ（Firebase Hosting）

main への push で GitHub Actions が Firebase Hosting に公開します。ビルド工程はありません。

公開URL: `https://kioku-b32ba.web.app/`

リポジトリの Secrets に `FIREBASE_SERVICE_ACCOUNT`（サービスアカウント鍵 JSON）が必要です。
サービスアカウントには「Firebase Hosting 管理者」「Service Usage ユーザー」「API キー閲覧者」のロールを付けます。

## 同期（任意・Firebase）

設定しない場合、学習データは端末内にのみ保存されます。既定の保存先（Firebase プロジェクト `kioku-b32ba`）は
`app.js` の `DEFAULT_FB` に入っており、ログインするだけで複数端末で同期できます（Google またはメールアドレス）。

自分の Firebase プロジェクトを使う場合は、アプリの「同期」画面 →「別の保存先を使う」の手順に従い、
Firestore のルールを貼ってから firebaseConfig を貼り付けます。設計の詳細は [CLAUDE.md](./CLAUDE.md) の「同期」の節にあります。

## ライセンス

MIT
