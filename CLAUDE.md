# CLAUDE.md — キオク（Kioku）開発ガイド

このリポジトリで作業するときに、まずこれを読んでください。

## このアプリは何か

間隔反復（spaced repetition）による暗記カードWebアプリ。Anki風。
インストール可能なPWAで、オフラインでも動作します。日本語UI。

## 最重要ルール

- **ビルド工程はありません。** バンドラ、npm install、トランスパイル、いずれも不要。
  `app.js` を編集して push すれば、それがそのまま本番で動きます。
- **npmパッケージを追加しないでください。** 依存は `app.js` 冒頭の ESM CDN import だけです。
  `package.json` も `node_modules` も作らないでください。
- **`app.js` を編集したら必ず `sw.js` の `CACHE` 定数を上げてください**（`kioku-v5` → `kioku-v6`）。
  これを忘れると、既存ユーザーの端末が古いバージョンのままになります。
- **localStorage のキー名を変えないでください。** ユーザーの学習データが失われます。
  スキーマを変える場合は、読み込み時に旧形式からのマイグレーションを書いてください。
- UIテキストは日本語です。新しい画面や文言も日本語で書いてください。

## ファイル構成

```
index.html   HTMLシェル。フォント読み込み、CSSリセット、ホバー用CSS、SW登録。
app.js       アプリ全体（1ファイル）。Preact + htm。
sw.js        Service Worker。app.js/index.html は network-first、他は cache-first。
manifest.webmanifest
icon-*.png
.nojekyll    GitHub Pages に Jekyll 処理をさせないための空ファイル
```

`app.js` は上から順に：定数・ユーティリティ → 旧サンプルデータの除去（`stripSample`）→ `class App`（状態・学習ロジック・同期・集計）→ 各 `renderXxx()` メソッド。

## 技術スタック

- **Preact 10** + **htm**（ESM CDN から import）。JSXではなくテンプレートリテラル記法を使います。
  ```js
  html`<div style=${{ padding: 20 }} onClick=${() => this.setState({ x: 1 })}>本文</div>`
  ```
  - 属性値は `${}` で囲む。`class=${x}` ではなく静的な `class="lift"` も可。
  - 条件分岐は `${cond && html`...`}`、リストは `${arr.map(x => html`...`)}`（`key` を付ける）。
  - `onInput` を使ってください（Preactでは `onChange` は blur 相当のことがあります）。
- **スタイルはインラインの style オブジェクト**。CSSクラスは `index.html` にある
  ホバー用ユーティリティ（`.cta` `.lift` `.dark` `.soft` `.ghost` `.danger` `.grade`）のみ使います。
  新しい配色は `app.js` の `C` オブジェクト（パレット）から取ってください。勝手に色を増やさないこと。
- **レスポンシブは JS で判定**します。`state.narrow`（幅 620px 未満）が真のとき縦積みに切り替えます。
  メディアクエリは使っていません。
- **`class App` に生やすインスタンス変数は `_` 1つ始まりの短い名前を避けてください。**
  Preact は Component インスタンスに自分の内部プロパティを書き込むため、名前が衝突すると
  こちらが入れた値が黙って別のものに置き換わります。実際に `this._sb`（Supabase クライアント）が
  これで壊れ、同期のログインができなくなりました。用途がわかる長めの名前（`_sbClient` など）にし、
  使い回す前に中身を確認するようにしてください。

## 状態とデータ

すべて `class App` の `this.state`。ストア管理ライブラリはありません。

```js
deck = { id, name, sub }
card = {
  id, deckId, front, back,
  hint,      // 補足（単語なら例文、用語なら説明文）。UI上の表記は「補足」で統一しています
  ease,      // 2.5 起点、1.3〜3.2
  interval,  // 日数（0 = 学習中）
  reps,
  state,     // "new" | "learning" | "review"
  due,       // 次回出題のエポックms
}
log = { "2026-09-02": 12, ... }   // 日ごとの学習枚数
gradeTotals = { again, hard, good, easy }  // 累計（正答率の算出用）
```

**localStorage のキー**
- `kioku.mvp.v1` — decks / cards / log / gradeTotals / todayCount
- `kioku.sync.cfg` — Supabase の URL と publishable key（端末で保存先を上書きしたときだけ入ります）
- `kioku.sync.at` — 最終同期時刻（競合判定に使用）
- `kioku.sb.auth` — Supabase のセッション（Supabase SDK が管理）
- `kioku.localonly` — 入口で「ログインせずにこの端末だけで使う」を選んだ（`"1"`）

保存は `this.persist(next)` を呼びます。localStorage への書き込みとクラウドへの遅延プッシュを兼ねています。
**`setState` したら `persist` も呼ぶ**のを忘れないでください（画面表示だけの状態は除く）。

## カードの3つ目のフィールド（補足）

`hint` は表・裏に続く3つ目のテキストで、UI では **「補足」** と表記します。
単語カードなら例文、技術用語なら説明文を入れる欄です。

- 学習画面では**答えと同時に**、答えの下の帯に左寄せで表示します（`renderStudy()`）。
  改行をそのまま出すため `whiteSpace: "pre-wrap"` を付けています
- 入力は2か所。デッキ画面の「カードを追加」フォーム（`formHintOpen` で開く折りたたみ）と、
  カード一覧の行をタップして開くその場編集（`renderCardEditor()`）
- 一括取り込みの3列目がそのまま `hint` に入ります
- デッキ画面のカード一覧では、行の下に2行までに切り詰めて表示します（`renderCardRow()`）

内部名が `hint` のままなのは、保存済みデータと同期の互換性を保つためです。改名しないでください。

## カードの編集

デッキ画面のカード一覧は、行そのものがボタンです。押すと `editId` にその ID が入り、
同じ行が `renderCardEditor()` の入力欄に差し替わります（表・裏・補足＋保存／キャンセル／削除）。

`saveEdit()` は front / back / hint だけを書き換え、**学習の進み具合（`ease` `interval` `reps` `state` `due`）
には触りません**。文言を直しても復習間隔がリセットされないようにするためです。
画面を離れるときは `editId: null` を一緒に渡してください（デッキ一覧へ戻る、別デッキを開く、デッキ削除の各所）。

## 学習アルゴリズム

`schedule(card, grade)` が唯一の判定箇所です。SM-2 の簡易版：

| 評価 | ease | interval | 次回 |
| --- | --- | --- | --- |
| again（もう一度） | −0.2 | 0 にリセット | 同セッション内で再出題（キュー末尾に戻す） |
| hard（むずかしい） | −0.15 | ×1.2（初回は1日） | interval 日後 |
| good（できた） | 変化なし | ×ease（初回は1〜2日） | interval 日後 |
| easy（かんたん） | +0.15 | ×ease×1.3（初回は4日） | interval 日後 |

評価ボタンには `intervalLabel()` で計算した次回出題時期をプレビュー表示します。
`schedule()` を変えると、このプレビューと「学習の記録」の集計にも自動で反映されます。

キーボード操作：Space / Enter でめくる・「できた」、1〜4 で各評価。`onKey()` を参照。

## 同期（Supabase・任意）

未設定でもアプリは完全に動きます（端末内保存のみ）。設定した場合：

- 保存先（Project URL と publishable key）は `app.js` の `DEFAULT_SB` に持たせています。
  利用者が入力するのはメールとパスワードだけです。`DEFAULT_SB` が空のときだけ、
  同期画面の「別の保存先を使う」から手入力する従来の流れになります
- `cfg()` は「端末で保存した設定 → `DEFAULT_SB`」の順に返します。localStorage の形式は変えていません
- Supabase JS SDK は同期を初めて使うときに動的 import します（初期表示を軽くするため）
- テーブルは `kioku_state`（`user_id` 主キー、`data` jsonb、`updated_at`）の1行だけ。RLSで本人のみ読み書き可
- 認証はメール＋パスワード
- 競合解決は **last-write-wins**（`updated_at` が新しい方を採用）。マージはしません
- 学習のたびに 2.5 秒のデバウンスで自動プッシュ（`queuePush()`）
- キーは **publishable key**（`sb_publishable_…`／旧 anon key）。secret key は絶対に使わないこと
- セットアップSQLは `app.js` の `SQL_SETUP` にあり、アプリ内に表示されます

## 入口（ログイン画面）

デッキやカードを見る前に `renderLogin()` を挟みます。判定は `render()` の先頭にまとめてあります。

- 出す条件：`cfg()` があり、未ログインで、`localOnly` でなく、この端末に学習データが無いとき
  （`screen` を明示的に `"login"` にしたときも出ます）
- **この端末に既に学習データがある人（`this._hadSavedData`）は素通し**します。
  ログインを促した結果、手元のデータが見えなくなる事故を防ぐためです
- 「ログインせずにこの端末だけで使う」を押すと `kioku.localonly` が立ち、以後は素通しになります。
  ホームの上部に出る1行バナーからいつでもログイン画面に戻れます
- `kioku.sb.auth` が残っている端末は `booting` を立てて、セッション復元が終わるまで「読み込み中…」を出します。
  これをしないと、ログイン済みの端末でログイン画面が一瞬ちらつきます
- ログアウトしても手元の学習データ（`kioku.mvp.v1`）は消しません。入口に戻すだけです

## デプロイ

main への push で **GitHub Pages** が自動デプロイ（Settings → Pages、Source は
「Deploy from a branch」＝ `main` / `/ (root)`）。ビルド工程は無しのままです。
公開URLは `https://keijid.github.io/kioku_app/` で、サブパス配信になります。

`index.html`・`manifest.webmanifest`・`sw.js` の参照はすべて `./` の相対パスです。
**絶対パス（`/app.js` など）に書き換えないでください。** サブパス配信で壊れます。

GitHub Pages は `Cache-Control` ヘッダを設定できません（Netlify の `netlify.toml` で
やっていた `no-cache` 指定は移行できないため廃止しました）。代わりに `sw.js` の
network-first 側で `fetch(url, { cache: 'reload' })` を使い、HTTPキャッシュを迂回して
更新を拾っています。ここを素の `fetch(e.request)` に戻さないでください。

**変更を出すときのチェックリスト**
1. `app.js`（必要なら `index.html`）を編集
2. `sw.js` の `CACHE` と `app.js` の `BUILD` を揃えて上げる ← 忘れやすい
   （`BUILD` は同期画面の下に「ビルド v10」と出ます。端末で古い版が動いていないかの確認に使います）
3. ローカル確認：`python3 -m http.server 8000` → `http://localhost:8000`
   （`file://` では ES モジュールが読めません）
4. commit & push

端末に古い版が残っているか怪しいときは、同期画面の「アプリを最新にする」で
キャッシュと Service Worker を捨てて読み直せます。隣の「接続を診断」は、
同期がうまくいかないときに各CDNが何を返しているかを画面に出します。

## 現状の制約（既知・意図的）

- 画像・音声カードなし（テキストのみ）
- Cloze（穴埋め）なし
- 1日の新規カード上限・学習上限なし
- デッキの入れ替え・階層なし
- Anki パッケージ（.apkg）のインポートなし（CSV / TSV の一括取り込みは `renderImport()` で対応）
- 学習ログは日ごとの枚数のみ（カード単位の履歴は保持していません）

## やらないこと

- ビルドツールの導入（Vite、webpack など）
- CSS フレームワークやコンポーネントライブラリの導入
- `app.js` の分割（1ファイルで完結させる方針。読みやすさが問題になったら相談してください）
- `C` パレット外の色の追加
- 絵文字の使用（デザイン方針として使っていません）
