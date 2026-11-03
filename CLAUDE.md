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
firebase.json                       Firebase Hosting の公開設定（キャッシュのヘッダ）
.firebaserc                         Firebase のプロジェクトID
.github/workflows/firebase-hosting.yml  main への push で Firebase Hosting に公開
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
  こちらが入れた値が黙って別のものに置き換わります。実際に `this._sb`（当時の Supabase クライアント）が
  これで壊れ、同期のログインができなくなりました。用途がわかる長めの名前（`_sbClient` など）にし、
  使い回す前に中身を確認するようにしてください。
- **メソッド名も同じです。Preact の `Component` が持つ名前を使わないでください**
  （`setState` `forceUpdate` `render` `componentDidMount` などのライフサイクル一式）。
  実際に「アプリを最新にする」の実体が `forceUpdate()` という名前になっていて、Preact の
  `Component.prototype.forceUpdate` を上書きしていました。Preact 側から呼ばれると
  キャッシュ削除とページ再読み込みが走るため、リロードループになりかねない状態でした
  （現在は `hardReload()` に改名済み）。

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
- `kioku.sync.cfg` — Firebase の firebaseConfig（端末で保存先を上書きしたときだけ入ります）
- `kioku.sync.*` — 同期の控え（「同期」の節にまとめてあります）
- `firebase:authUser:…` — Firebase のセッション（Firebase SDK が管理）
- `kioku.localonly` — 入口で「ログインせずにこの端末だけで使う」を選んだ（`"1"`）

保存は `this.persist(next)` を呼びます。localStorage への書き込みとクラウドへの遅延プッシュを兼ねています。
**`setState` したら `persist` も呼ぶ**のを忘れないでください（画面表示だけの状態は除く）。
クラウドから取り込んだ直後だけは `persistLocal(next)`（端末に保存するだけ）を使います。
**同期はこの保存済みの内容（`savedData()`）を見て差分を出します。** `setState` だけして
`persist` を呼ばないと、その変更は同期されません。理由は「同期」の節にあります。

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

## 読み上げ（音声）

学習画面の表・裏・補足それぞれに読み上げボタンを置いています。押したときだけ鳴る手動操作で、
自動再生はしていません（iOS Safari は最初の発話にユーザー操作を要求するため、
また静かな場所で不意に鳴るのを避けるためです）。

- **音声ファイルは一切持ちません。** 端末内蔵の合成音声を Web Speech API
  （`SpeechSynthesisUtterance`）で鳴らすだけです。カードのデータ構造も同期も変わりません。
  npmパッケージも追加していません
- `speechLang()` が言語を決めます。ラテン文字が仮名・漢字より多ければ `en-US`、
  そうでなければ `ja-JP`。英単語と日本語の用語が同じデッキに混ざっていても自然に読めます
- `canSpeak` が真のときだけボタンを描きます。`getVoices()` は最初は空で返ることがあるので、
  `voiceschanged` でも確かめています。音声が無い端末ではボタン自体が出ません
- `speak()` は毎回 `cancel()` してから発話します（連打で音が重ならないように）。
  `rate()` でも `cancel()` を呼び、次のカードへ進むときに読み上げを止めます
- メソッド名は Preact の `Component` が持たないものを選んでいます（`speak` / `speakButton`）

## 学習画面の縦幅

スマホでは**答えを表示したあと、4つの評価ボタンまでスクロールなしで届くこと**を条件にしています。
ここが崩れると毎回スクロールが要るので、学習画面に要素を足すときは必ず実測してください。

- **学習中（`screen === "study"`）はヘッダーを出しません。** ロゴと統計チップで約150px使うためです
- 読み上げボタンは表・裏・補足それぞれ**テキストと同じ行**に置きます。独立した行にすると3つで約130px増えます
- 答えを表示したら `minHeight` を 0 にします（表だけのときにカードを見栄えよくするための値です）
- 補足は narrow のとき**4行までにして枠内スクロール**させます。例文が長くても評価ボタンが
  画面外へ押し出されないようにするためで、これが唯一の保証になっています

カード外枠の `overflow: hidden`（角丸のクリップ用）があるため、評価ボタンの
`position: sticky` は効きません。上の「補足を枠内スクロール」で代替しています。

## カードの編集

デッキ画面のカード一覧は、行そのものがボタンです。押すと `editId` にその ID が入り、
同じ行が `renderCardEditor()` の入力欄に差し替わります（表・裏・補足＋保存／キャンセル／削除）。

`saveEdit()` は front / back / hint だけを書き換え、**学習の進み具合（`ease` `interval` `reps` `state` `due`）
には触りません**。文言を直しても復習間隔がリセットされないようにするためです。
画面を離れるときは `editId: null` を一緒に渡してください（デッキ一覧へ戻る、別デッキを開く、デッキ削除の各所）。

学習画面（`renderStudy()`）からも同じ内容を直せます。カード上部の帯にある「編集」を押すと
`editId` に出題中のカードの ID が入り、**カードの中身が表・裏・補足の入力欄に差し替わります**。
保存は同じ `saveEdit()`、キャンセルは `editId: null` です。

- **編集中は「答えを見る」も評価ボタンも下のリンク（ひとつ戻す／今日はスキップ）も出しません。**
  入力欄と並べるとスマホで縦が足りなくなるためです（390×844 で実測してスクロール無しに収めています）
- `onKey()` は `editId` が入っている間は何もしません。入力欄の外を押してからスペースを叩いても
  めくれたり評価が入ったりしないようにするためです
- 学習画面から出るときは `editId: null` を一緒に渡してください（「中断する」。`startStudy()` でも落としています）
- 削除と「反転して複製」は学習画面には置いていません。出題キュー（`queue`）に載っているカードが
  その場で消えたり増えたりするためです。どちらもデッキ画面のその場編集から行います
- 答えを見る前に「編集」を押すと裏も見えますが、自分で押したときだけなので許容しています

編集欄の下の4つのボタン（保存／キャンセル／反転して複製／削除）は **grid** に並べます。
narrow では 2 列 × 2 行、広い画面では 1 行で「削除」だけ右端です。
`flex` + `flexWrap` に戻さないでください。幅が足りないと3つ目だけが折り返し、
`marginLeft: "auto"` の「削除」が独りで次の行の右端へ飛んで散らかります。

## 表裏を反転して複製

英単語で「英→日」と「日→英」の両方を持ちたい、という用途のための機能です。
**反転カードは元カードとリンクせず、その場で実体を複製した独立したカード**になります。
親子構造にすると `cards` に階層が要り、同期・削除・重複判定の全部に波及するのに対し、
得られるのは「文言を直したら両方直る」だけなので、実体複製を選んでいます。
逆向きは難易度が別物（英→日は認識、日→英は再生）なので、進捗が独立するのはむしろ正しい挙動です。

- `reverseOf(c, deckId)` が唯一の生成箇所です。**表と裏を入れ替え、`hint`（補足）はそのまま**、
  学習の進み具合は `newCard()` 経由で新規からやり直しになります。元カードの
  `ease` / `interval` を引き継ぐと、逆向きなのに復習間隔が飛びすぎます
- **1枚単位だけです**：カードのその場編集の中の「反転して複製」（`duplicateReversed()`）。
  入力欄に見えている内容を使うので、**元カードへの編集も一緒に保存**します
- 重複判定は一括取り込みと同じく**表の一致だけ**を見ます。同じ表のカードが既にあれば飛ばすので、
  何度押しても増殖しません
- **デッキ単位の一括反転は廃止しました**（デッキ画面のボタン・確認の帯・取り消しの帯、
  `reversing` / `revDest` / `revNewName` / `lastReverse` と
  `reversePreview()` `startReverseDeck()` `runReverseDeck()` `undoReverse()` を削除）。
  デッキ画面の操作ボタンが増えすぎていたためです。戻す場合は上の1枚単位と同じ生成経路
  （`reverseOf()`）を使ってください

## デッキ名の変更

デッキ画面の見出し横「名前を変更」で `renamingDeck` が立ち、見出し（`h2`）がその場で入力欄に変わります。
保存は `saveRename()`。**`name` だけを書き換え、`id` `sub` とカードには触りません**。
`id` を保つので、カードの `deckId` も学習の進み具合もそのままです。

- 空欄（空白のみ）は弾いてトーストを出し、入力欄は開いたままにします
- Enter で保存、Escape でキャンセル
- 名前が変わっていないときは保存もトーストも出さずに閉じるだけです
- `confirmingDelete` と同じく画面をまたいで残る状態ではないので、画面を離れるときは
  `renamingDeck: false` を一緒に渡してください（デッキ一覧へ戻る、別デッキを開く、学習開始、デッキ削除の各所）

## 学習アルゴリズム

出題順は `startStudy()` で毎回シャッフルします（`shuffle()` は Fisher-Yates）。
並びで覚えてしまうのを防ぐためです。**「復習が先、新規が後」の2グループ構成は保ち、
各グループの中だけをランダムに**します。新規を全体に混ぜると、その日の復習が終わらないうちに
新しいカードが割り込むためです。「もう一度」で末尾に戻す動きは従来どおりです。

`schedule(card, grade)` が唯一の判定箇所です。SM-2 の簡易版：

| 評価 | ease | interval | 次回 |
| --- | --- | --- | --- |
| again（もう一度） | −0.2 | 0 にリセット | 同セッション内で再出題（キュー末尾に戻す） |
| hard（むずかしい） | −0.15 | ×1.2（初回は1日） | interval 日後 |
| good（できた） | 変化なし | ×ease（初回は2日） | interval 日後 |
| easy（かんたん） | +0.15 | ×ease×1.3（初回は4日） | interval 日後 |

間隔は `intervals(card)` が hard / good / easy をまとめて出し、`schedule()` はそれを使います。
倍率を丸めたり ease が下限に張り付いたりすると hard と good が同じ日数になってしまうため、
`intervals()` の中で **hard < good < easy** を必ず満たすように後ろへずらしています
（例：1日のカードは 2日 / 3日 / 4日）。倍率だけを直すとこの保証が崩れるので、
変更するときは `intervals()` ごと見てください。

評価ボタンには `intervalLabel()` で計算した次回出題時期をプレビュー表示します。
`schedule()` を変えると、このプレビューと「学習の記録」の集計にも自動で反映されます。
「もう一度」だけは日数ではなくキュー末尾への差し戻しなので、表記は「セッション内」です。

**`due` は日単位です。** `addDays(now, interval)` で「n 日後の 0 時」を入れます。
`now + interval * DAY` のように時刻をそのまま足さないでください。夜に答えたカードが
翌々日の同じ時刻まで出てこなくなります（23時に「2日後」で答えると、翌々日の23時まで出ない）。

- `startOfDay()` / `addDays()` が日境界の計算箇所です。月またぎ・夏時間は `Date` に任せています
- 旧版のデータは `due` に時刻が入っているので、読み込み時に `alignDues()` で 0 時へ揃えます。
  localStorage・クラウド同期・JSONバックアップの**3経路すべて**に通してください
- 「明日/n日後」ラベル（`dueLabel()`）と7日間の出題予測は、差のミリ秒ではなく
  `startOfDay()` どうしの日差で判定します。時刻で割ると夜間に1日ずれます

Undo（`undo()`）は `history` に評価前のカード・キュー・`tally`・`gradeTotals` を丸ごと積んで
書き戻す方式です。新しい累計値を足したら、`rate()` の `history` と `undo()` の両方に足してください。
片方だけだと、押し間違えて戻しても正答率に残ります。

キーボード操作：Space / Enter でめくる・「できた」、1〜4 で各評価。`onKey()` を参照。

## 同期（Firebase・任意）

未設定でもアプリは完全に動きます（端末内保存のみ）。設定した場合：

- 保存先（firebaseConfig の `apiKey` `authDomain` `projectId` `appId`）は `app.js` の `DEFAULT_FB` に持たせています。
  利用者がするのはログインだけです。`DEFAULT_FB` が空のときだけ、同期画面の
  「別の保存先を使う」に firebaseConfig を貼る流れになります（`parseFbConfig()` が値を抜き出します）
- `cfg()` は「端末で保存した設定 → `DEFAULT_FB`」の順に返します。`kioku.sync.cfg` に Supabase 時代の
  `{url, key}` が残っていても、`apiKey` と `projectId` が揃っていないものは使いません
- Firebase SDK（app / auth / firestore）は `FB_SOURCES` から動的 import します。版は `FB_VER` で固定。
  **3つは必ず同じ配信元・同じ版から読み込むこと**（混ぜると別物の app を掴みます）
- SDK は起動時に（未ログインでも）読み込みます。Google ログインのポップアップは押した直後に
  開かないとブラウザに止められるので、押してから読み込むのでは間に合わないためです
- `apiKey` はブラウザに配られる公開の値です。実際の保護は Firestore のルール（`RULES_SETUP`）が担います
- ルールは `app.js` の `RULES_SETUP` にあり、アプリ内に表示されます

### 2026-11 に Supabase から移りました

それまでは Supabase（`kioku_items` テーブル）でした。移行のしかた：

- **データはクラウド間で移していません。** 各端末が `kioku.mvp.v1` に全部を持っているので、
  新しい版を開いた端末がログインすると、手元の全項目が Firebase へ送られます（＝引っ越し）
- 新しい版を初めて開いたとき `moveFromSupabase()` が1回だけ（`kioku.sync.backend`）、
  Supabase 宛ての控え（cursor / shadow / legacy / at / `kioku.sb.auth` / Supabase 形式の `kioku.sync.cfg`）を捨てます。
  **`kioku.mvp.v1`・`kioku.sync.counts`・`kioku.sync.device` は残します**
- Supabase でログインしていた端末には、ホームの帯で「もう一度ログインしてください」と出します（`kioku.sync.moved`）。
  アカウントは引き継がれないので、Google アカウントでログインし直してもらいます
- 学習枚数は `seedCounts()` で持ち込みます（下の「学習枚数と評価の累計」）
- 2台目以降の端末がログインしたときは、`applyRows()` が「控えに無い項目は相手を優先」するので、
  先に移った端末の内容と自然に合わさります

### かたち：カード1枚が1ドキュメント

同期の実体は **`users/{uid}/items/{kind:item_id}`** です（`docId()`）。
中身は `{ kind, item_id, data, deleted_at, updated_at }`。`kind` は `deck` / `card` / `log` / `grade`。
ルールで本人のみ読み書き可。

**1つの JSON に全部を入れていた頃（Supabase の `kioku_state`）に何が起きたかを、必ず読んでください。**
まるごと置き換えなので、別々のカードを触っただけで衝突し、「相手に無い」が削除なのか
未着信なのか判別できず、壊れた端末が1回上書きすると全部飛びました。実際に全部起きました。
1件1ドキュメントに分けたことで、この3つが同時に解けています。

| 仕組み | 何が解決したか |
| --- | --- |
| 1件1ドキュメント | 別々のカードを触っているかぎり、そもそも衝突しない |
| `deleted_at`（墓標） | 削除が**データ**になる。「消したのか未着信か」を推測しなくてよい |
| `updated_at` は `serverTimestamp()`、ルールで `request.time` 以外を拒否 | 端末の時計がずれても順序が壊れない |
| `updated_at` → ドキュメントID の順で続きから取得 | 変わったものだけを取る。4000枚あっても毎回は取らない |

**ドキュメントを削除しないでください。** ルールでも `allow delete: if false` にしてあります。
消すと、削除したことが誰にも伝わりません。

### 送るもの・受け取るもの

- **送る**：`pending()` が「控え（`kioku.sync.shadow`）」と今の中身を比べて差分を出します。
  控えは中身そのものではなく**短いハッシュ**です。4000枚ぶんの本体を二重に置くと
  localStorage の容量が足りません。送信は `writeBatch` で 400 件ずつです（上限 500）
- **受け取る**：`applyRows()` が唯一の入口です。`pull()`（差分取得）からも
  realtime（`onSnapshot`）からもここを通します。ドキュメントは `fbRow()` で行の形にしてから渡します
- **行の中身の形は `deckRow()` / `cardRow()` が唯一の定義**です。送信と控えで形がずれると、
  毎回「変わった」と誤判定して送り返しが止まりません。値を必ず埋めているのも同じ理由です

### 踏むと壊れるところ

- **取り込みの位置（cursor）は時刻だけでなく「時刻｜ドキュメントID」です（`posOf()` / `splitPos()`）。**
  `writeBatch` でまとめて書いた項目は**全部同じ `updated_at`** になります。時刻だけで
  「これより後」を取ると、1000件の区切りが同じ時刻の途中に来たとき、残りを取りこぼします。
  `orderBy("updated_at")` → `orderBy(documentId())` と `startAfter(時刻, ID)` で、ちょうど続きから取ります。
  ID が空のときは `startAfter(時刻)` だけにすること（空の ID は Firestore が受け付けません）
- **取得は `getDocsFromServer()` を使ってください。** `getDocs()` は端末内キャッシュから
  返すことがあり、古い内容のまま「取り込めた」ことになります
- **Firestore の端末内キャッシュ（persistentLocalCache）は使いません。** 手元の正は
  `kioku.mvp.v1` で、置き場所を二つにすると食い違います
- **比較は `canon()` を使ってください。素の `JSON.stringify` はだめです。**
  クラウドから戻ってきた中身はキーの順が並べ替わっていることがあり、中身が同じでも
  「変わった」ことになって、送り返しが延々と続きます
- **同期が見る「いまの手元の内容」は `savedData()`（localStorage）です。`this.state` ではありません。**
  Preact の `setState` は次の描画まで `this.state` を書き換えないので、取り込んだ直後に
  state を見ると空のままです。そこで差分を取ると全項目が「消された」ことになり、
  **墓標を送ってクラウドを空にします。**実際にそうなりました。
  `persist` / `persistLocal` は同期的に書くので、localStorage は常に最新です
- **`setState` の直後に `pull` / `push` を呼ばないでください。** 同じ理由で、
  ログイン状態は `setSyncUser()` が入れる `this._syncUserEmail` を見ます
- **送信中に触っていた項目を、相手の内容で潰さないでください。** `applyRows()` は
  未送信（dirty）の項目を飛ばします。カードだけは学習の進み具合を `pickCard()` で
  進んでいる方に寄せます
- **ただし、この端末から一度も送っていない項目（控えに無い）は相手を優先します。**
  ログインし直した直後や保存先を移した直後は控えが空なので、手元の全項目が「未送信」に見えます。
  そこで手元を優先すると、他の端末で消したものを送り返して生き返らせます（カードの進み具合だけは `pickCard()`）
- realtime では、自分が書いた直後のサーバ未着の版（`hasPendingWrites`）を飛ばします。`updated_at` がまだ無いためです

### 学習枚数と評価の累計

**端末ごとに1ドキュメント**持ち（`log:<端末ID>` / `grade:<端末ID>`）、表示は全部の合計にします。
足し算なので、同じ日に2台で学習しても正しく合算されます。

「この端末のぶん」は **合計 −（他の端末＋legacy）** で出せるので（`myCounts()`）、
学習のたびにカウンタを別途触る必要がありません。`rate()` は今までどおりです。

- 受け取ったときの合計は、**この端末のぶんだけ受け取る前の値（`mineNow`）で計算します**（`applyRows()`）。
  受け取った行は「最後に送った値」なので、まだ送っていない直前の学習が入っておらず、
  他の端末の行が届いた瞬間に今日の枚数が消えていました
- **内訳（`kioku.sync.counts`）はログアウトでも捨てません。** 手元の合計は全端末の合計なので、
  内訳が無いと「この端末のぶん」が合計そのものになり、再ログインで二重に数えます
- `seedCounts()` はユーザーごとに1回（`kioku.sync.seeded`）、自分のぶんを必ず送り、
  他の端末と legacy のぶんはクラウドに無いときだけ送ります。`push()` は控えと変わったときしか
  送らないので、移ってきた直後の自分のぶんはこれが無いと一度も送られません

`log:legacy` / `grade:legacy` は Supabase の `kioku_state` 時代の履歴を1つにまとめたものです。
端末ごとに持たせると、どの端末も同じ履歴を「自分のぶん」と主張して二重に数えます。

### 即時反映（realtime）

`subscribeRealtime()` が `onSnapshot` で `updated_at > cursor` の変更を購読し、`applyRows()` に流します。
**cursor は進めません**（届いた行より古い未取得の行を取りこぼすため。取りこぼし防止は `pull()` の役目）。
学習中は反映しません。接続できなくても60秒ごとの見直しで追いつくので、**失敗しても黙って続行します**。

### 同期がいつ走るか

| きっかけ | すること |
| --- | --- |
| ログイン・起動時のセッション復元 | 差分取得＋購読開始 |
| 相手の端末が書いたとき（realtime） | その項目だけ反映 |
| 学習・編集のたび | 2.5秒後に差分送信（`queuePush()`） |
| 画面を離れる／戻る、回線が戻る | 送信、戻るときは取得も |
| 60秒ごと | 送るものがあれば送信、無ければ取得。ログインを掴めていなければ `initSync()` をやり直す |

**どれも外さないでください。** 特に `visibilitychange` は必須です（スマホは学習の直後に
アプリを切り替えるのが普通で、2.5秒待っている間に iOS がタブを凍結します）。
60秒ごとの見直しも、端末を前面に置いたままだと `visibilitychange` が起きないため必要です。

### Service Worker に同期の通信を触らせないこと

**`sw.js` の fetch ハンドラは、同一オリジンと `CDN` に挙げた配信元だけを扱います。**
Firebase の API（`*.googleapis.com`）はどちらでもないので、素通しでネットワークに任せます。
`www.gstatic.com` は版を固定した SDK の配信元なので `CDN` に入れています。
**同じオリジンでも `/__/` で始まるパスは触りません。** Firebase Hosting がログインの受け渡しに使う
予約パス（`/__/auth/handler` など）で、キャッシュから返すと Google ログインが壊れます。

一度これを外して**すべての GET をキャッシュ優先**にしていたことがあり（Supabase 時代）、取り込み（GET）が
キャッシュに載った古い応答を返し続けました。問い合わせURLは毎回同じなので、一度載ると
永久に古いままです。しかも**書き込みは POST なので通り、読み取りだけが止まる**ため、
「PCで作ったデッキがスマホにいつまでも出てこない」という、アプリ側をいくら直しても
直らない形になりました。さらに悪いことに、**書き込み前の安全確認（GET）まで古い値を返す**ので、
その端末は競合に気づかずクラウドを丸ごと上書きしていました。

`CDN` に足してよいのは**内容が変わらないもの**だけです（SDK、フォント）。API を足さないこと。

### Firestore の準備がまだのとき

データベースが無い・ルールが既定（ロックモード）のままだと `permission-denied` / `not-found` が返ります。
`needsSetup()` がそれを見て、同期画面にルールを出し、「それまで端末内にだけ保存されます」と伝えます（`syncFail()`）。
**この経路を消さないでください。** 黙って失敗すると、利用者は同期が壊れたと思います。

### ログイン

- **ログイン方法は Google だけです。** メール＋パスワードは v38 でやめました（入力欄・新規登録タブ・`signIn()` を削除）。
  新規の人も「Google でログイン」を押すだけで、アカウントは初回に自動で作られます
- Google：開いている場所で方式を変えます（`onOwnHosting()`）
  - **Firebase Hosting（`<projectId>.web.app` / `.firebaseapp.com`）**：`signInWithRedirect`。
    `loadFb()` が `authDomain` をいま開いているドメインに差し替えるので、ログイン処理（`/__/auth/handler`）が
    アプリと同じドメインに載り、iPhone のホーム画面アプリでも完了します。戻ってきたことは
    sessionStorage の `kioku.redirecting` で知り、`initSync()` が `getRedirectResult()` で結果（失敗理由も）を受け取ります
  - **それ以外（手元の localhost など）**：`signInWithPopup`。別ドメインのリダイレクトは
    最近のブラウザで動きません。SDK を先に読み込んでおき、await を挟まずにポップアップを開きます
- エラーは `authErrText()` が `code` を日本語にします
- セッションは `browserLocalPersistence`（localStorage の `firebase:authUser:…`）に置きます。
  起動時に `hasFbSession()` で同期的に「ログイン済みか」を判定し、`booting` を立てるためです
- iOS のホーム画面に追加したアプリではポップアップが完了しないことがあるため、ポップアップ方式のときだけ注記を出しています

Firebase 側で必要な設定（コードの外）：Firestore Database を作成してルールを貼る。
Authentication → Sign-in method で「Google」を有効にする（「メール / パスワード」は不要）。
`<projectId>.web.app` と `.firebaseapp.com` は Authentication の承認済みドメインに最初から入っています。
**Google Cloud コンソールの OAuth クライアント（Web client (auto created by Google Service)）の
「承認済みのリダイレクト URI」に `https://<projectId>.web.app/__/auth/handler` を足す必要があります。**
最初から入っているのは firebaseapp.com の方だけで、足さないと web.app で `redirect_uri_mismatch` になります。

### 手元での確認（エミュレータ）

`window.KIOKU_EMULATOR` を立てると、`loadFb()` が Auth（127.0.0.1:9099）と Firestore（127.0.0.1:8080）の
エミュレータへ繋ぎます。firebase-tools はリポジトリに入れず、一時フォルダで動かしてください
（`firebase emulators:start --project demo-kioku --only auth,firestore`、ルールは `RULES_SETUP` を書き出したもの）。

### localStorage のキー（同期用）

- `kioku.sync.device` — この端末の名札（学習枚数の集計に使用）
- `kioku.sync.cursor` — どこまで取り込んだか（`posOf()` の形）
- `kioku.sync.shadow` — 送信済みの控え（項目ごとの短いハッシュ）
- `kioku.sync.counts` — 受け取った学習枚数・評価の内訳（ログアウトでも残す）
- `kioku.sync.seeded` — `seedCounts()` を済ませたユーザー
- `kioku.sync.at` — 最終同期時刻（表示用）
- `kioku.sync.backend` — `"firebase"`。Supabase からの移行を済ませた印
- `kioku.sync.moved` — Supabase でログインしていた端末。ホームで再ログインを促す
- `firebase:authUser:…` — Firebase のセッション（SDK が管理）

ログアウトと接続解除では `forgetSyncState()` で控え（at / cursor / shadow / seeded など）を捨てます。
**学習データ（`kioku.mvp.v1`）と内訳（`kioku.sync.counts`）には触りません。**

## API でカードを追加

AI（Claude Code など、プログラムを実行できるもの）からカードを送るための口です。
**サーバーは持ちません**（Cloud Functions は Blaze プランが要るため）。Firestore の REST API に直接書かせます。

| 置き場所 | 中身 | ルール |
| --- | --- | --- |
| `users/{uid}/apiTokens/{トークン}` | `{ created_at }` | 本人だけ読み書き |
| `users/{uid}/inbox/{自動ID}` | `{ token, deck?, cards?[], front?, back?, hint? }` | **ログイン不要で作成可**。ただし `token` が本人の `apiTokens` にあるときだけ。キーは上の6つだけ、`cards` は200件まで。読み・削除は本人だけ |

- 同期画面の「API でカードを追加」でトークンを発行します（`issueApiToken()`。24バイトの乱数を base64url にしたもの、1本だけ）。
  「AI に渡す説明をコピー」（`apiGuide()`）が送り先の URL・トークン・本文の例・curl をまとめて出します
- アプリは `subscribeInbox()`（開いている間）と `pull()`（開いたとき・60秒ごと）で inbox を見て、
  `importInbox()` がカードにしてから inbox のドキュメントを**消します**。inbox は同期の項目（items）ではないので消してよく、
  取り込んだカードは `persist` で普通に同期されます
- 外から来た中身なので、`importInbox()` は文字列以外を捨て、`API_TEXT_MAX`（2000字）で切り、表か裏が空のものを飛ばします。
  重複は一括取り込みと同じく「同じデッキに同じ表があるか」で判定します
- デッキは名前で探し、無ければ作ります。名前を省くと `API_DECK`（「API で追加」）。新しく作るデッキの ID は名前のハッシュ、
  カードの ID は `capi<inboxのID>_<番号>` なので、**2台が同時に取り込んでも同じデッキ・同じカードになります**（二重にならない）
- 学習中（`screen === "study"`）は取り込みません（出題キューを崩さないため）
- `RULES_SETUP` を変えたので、**Firestore のルールを貼り直すまでトークンの発行は `permission-denied` になります**
  （`syncFail()` がルールを出して案内します）。取り込み側の失敗は黙って無視し、カードの同期は止めません
- claude.ai の普通のチャットは POST できないので、この API は呼べません。そこから使うには MCP サーバー（＝サーバーが要る）が必要です

## 入口（ログイン画面）

デッキやカードを見る前に `renderLogin()` を挟みます。判定は `render()` の先頭にまとめてあります。

- 出す条件：`cfg()` があり、未ログインで、`localOnly` でなく、この端末に学習データが無いとき
  （`screen` を明示的に `"login"` にしたときも出ます）
- **この端末に既に学習データがある人（`this._hadSavedData`）は素通し**します。
  ログインを促した結果、手元のデータが見えなくなる事故を防ぐためです
- 「ログインせずにこの端末だけで使う」を押すと `kioku.localonly` が立ち、以後は素通しになります。
  ホームの上部に出る1行バナーからいつでもログイン画面に戻れます
- Firebase のセッション（`hasFbSession()`）が残っている端末は `booting` を立てて、セッション復元が終わるまで「読み込み中…」を出します。
  これをしないと、ログイン済みの端末でログイン画面が一瞬ちらつきます
- ログアウトしても手元の学習データ（`kioku.mvp.v1`）は消しません。入口に戻すだけです

## デプロイ

**Firebase Hosting**（`https://kioku-b32ba.web.app/`）に公開します。ビルド工程は無しのままです。
2026-11 に GitHub Pages（`keijid.github.io/kioku_app/`）から移りました。旧サイトは使っていません。

- main への push で `.github/workflows/firebase-hosting.yml` がリポジトリのファイルをそのまま上げます。
  公開しないファイルは `firebase.json` の `ignore` に書きます（CLAUDE.md・README・ドットファイル）
- 必要なもの：リポジトリの Secrets の `FIREBASE_SERVICE_ACCOUNT`（Firebase Hosting 管理者権限の
  サービスアカウント鍵 JSON）と、`.firebaserc` のプロジェクトID。Secret が無いあいだは何もせずに終わります。
  サービスアカウントのロールは「Firebase Hosting 管理者」「Service Usage ユーザー」「API キー閲覧者」。
  Hosting 管理者だけだと、公開前の確認（serviceusage.services.get）で 403 になります
- キャッシュは `firebase.json` の `headers` で指定します。`index.html` / `*.js` / `manifest.webmanifest` / `sw.js` は
  `no-cache`（毎回更新を確かめる）、アイコンは1日です。**`sw.js` を長くキャッシュさせないでください。**
  Service Worker の更新が届かなくなり、古い版から抜けられなくなります

`index.html`・`manifest.webmanifest`・`sw.js` の参照は `./` の相対パスにしてあります（旧サイトがサブパス配信だった名残。
ルート配信でもそのまま動くので、このままにしています）。

`sw.js` の network-first 側は `fetch(url, { cache: 'reload' })` で HTTP キャッシュを迂回して更新を拾います。
ここを素の `fetch(e.request)` に戻さないでください。

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

- 画像・音声**ファイル**を添付するカードはなし（テキストのみ。読み上げは端末の合成音声で行います）
- Cloze（穴埋め）なし
- 1日の新規カード上限・学習上限なし
- デッキの入れ替え・階層なし
- Anki パッケージ（.apkg）のインポートなし（CSV / TSV の一括取り込みは `renderImport()` で対応）
- 学習ログは日ごとの枚数のみ（カード単位の履歴は保持していません）

## やらないこと

- ビルドツールの導入（Vite、webpack など）
- CSS フレームワークやコンポーネントライブラリの導入
- `app.js` の分割（1ファイルで完結させる方針。読みやすさが問題になったら相談してください）
- `C` パレット外の色の追加（例外は Google ログインボタンのロゴ `GOOGLE_G` だけ。ガイドラインで公式の4色が決まっています）
- 絵文字の使用（デザイン方針として使っていません）
