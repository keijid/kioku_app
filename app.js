// キオク — 間隔反復学習アプリ
// ビルド工程なし。ブラウザが直接このファイルを ES モジュールとして読み込みます。
import { h, Component, render } from "https://esm.sh/preact@10.22.0";
import htm from "https://esm.sh/htm@3.1.1";

const html = htm.bind(h);

// ---------------------------------------------------------------- 定数・ユーティリティ

const DAY = 86400000;
const ACCENTS = ["#B8452C", "#3E7C6B", "#3B4C86", "#96702A", "#6B4E7C"];
const IMPORT_MAX = 2000; // 一度に取り込める上限枚数
// 同期画面に表示する版数。sw.js の CACHE と揃えて上げること（今どのビルドが動いているかの確認用）。
const BUILD = "v23";

const C = {
  bg: "#F3EFE6",
  surface: "#FFFDF8",
  ink: "#1C2230",
  inkSoft: "#4A4540",
  muted: "#6B655A",
  faint: "#8A8478",
  ghost: "#A8A296",
  line: "#E3DCCB",
  lineSoft: "#EDE7DA",
  field: "#F8F5EE",
  accent: "#F0A868",
  accentDeep: "#C4844B",
  red: "#B8452C",
  green: "#3E7C6B",
};

// Supabase SDK の読み込み元。上から順に試し、ちゃんと動くクライアントが作れたものを使います。
// バージョンを固定しているのは、@2 のまま最新に追随させると CDN 側の変更だけで
// ある日突然ログインできなくなるためです。最後の1つだけ最新版を保険に残しています。
const SB_SOURCES = [
  "https://esm.sh/@supabase/supabase-js@2.45.4",
  "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2.45.4/+esm",
  "https://esm.sh/@supabase/supabase-js@2",
];

// 既定の保存先。ここに値を入れておくと、利用者は接続情報を貼らずメールとパスワードだけで始められます。
// publishable key はブラウザに配られる公開キーで、実際の保護は kioku_state の RLS（SQL_SETUP）が担っています。
// secret key は絶対に置かないこと。空のままなら、従来どおり画面から保存先を手入力します。
const DEFAULT_SB = {
  url: "https://iakueghsgrcxcdsqtdxt.supabase.co",
  key: "sb_publishable_1s3ilko2FhbU2MbDi4KfBg_PMalXS4f",
};

const SQL_SETUP = [
  "create table if not exists kioku_state (",
  "  user_id uuid primary key references auth.users on delete cascade,",
  "  data jsonb not null,",
  "  updated_at timestamptz not null default now()",
  ");",
  "alter table kioku_state enable row level security;",
  'drop policy if exists "own rows" on kioku_state;',
  'create policy "own rows" on kioku_state',
  "  for all using (auth.uid() = user_id) with check (auth.uid() = user_id);",
].join("\n");

function dayKey(t) {
  const d = new Date(t);
  return (
    d.getFullYear() +
    "-" +
    String(d.getMonth() + 1).padStart(2, "0") +
    "-" +
    String(d.getDate()).padStart(2, "0")
  );
}

// 出題は日単位で扱います。due はその日の 0 時に揃え、答えた時刻に左右されないようにします。
// 時刻をそのまま入れると、夜に答えたカードが翌々日の同じ時刻まで出てこなくなります。
function startOfDay(t) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// n 日後の 0 時。月またぎや夏時間の処理は Date に任せます。
function addDays(t, n) {
  const d = new Date(t);
  d.setHours(0, 0, 0, 0);
  d.setDate(d.getDate() + n);
  return d.getTime();
}

// 保存済みカードの due を日の境界へ揃えます（旧版は答えた時刻をそのまま持っていました）。
// 読み込み経路すべてに通すので、端末に残っている古いデータもここで直ります。
function alignDues(cards) {
  return (cards || []).map((c) =>
    c && typeof c.due === "number" && c.due !== startOfDay(c.due)
      ? Object.assign({}, c, { due: startOfDay(c.due) })
      : c
  );
}

// 一意なID。Date.now() だけだと同じミリ秒に複数作ったとき衝突するので連番を足します。
let uidSeq = 0;
function uid(prefix) {
  uidSeq += 1;
  return prefix + Date.now().toString(36) + uidSeq.toString(36);
}

// 配列をシャッフルした新しい配列を返す（Fisher-Yates）。学習の出題順に使います。
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const t = a[i];
    a[i] = a[j];
    a[j] = t;
  }
  return a;
}

// 読み上げの言語を決めます。ラテン文字が仮名・漢字より多ければ英語として読みます。
// 英単語と日本語の用語が同じデッキに混ざっていても、それぞれ自然に読ませるためです。
function speechLang(text) {
  const latin = (text.match(/[A-Za-z]/g) || []).length;
  const jp = (text.match(/[ぁ-んァ-ヶー一-龥]/g) || []).length;
  return latin > jp ? "en-US" : "ja-JP";
}

// ---------------------------------------------------------------- 一括取り込みのパーサ

function delimName(d) {
  if (d === "\t") return "タブ";
  if (d === ",") return "カンマ";
  if (d === ";") return "セミコロン";
  return "";
}

// 貼り付けられたテキストの区切り文字を推測する。タブ → カンマ → セミコロンの順で優先。
function guessDelim(text) {
  const lines = text.split(/\r\n|\r|\n/).filter((l) => l.trim()).slice(0, 20);
  let best = "\t";
  let bestCount = 0;
  ["\t", ",", ";"].forEach((d) => {
    let n = 0;
    lines.forEach((l) => {
      n += l.split(d).length - 1;
    });
    if (n > bestCount) {
      bestCount = n;
      best = d;
    }
  });
  return best;
}

// CSV/TSV を1レコード＝1行として分解する。"…" で囲めば区切り文字や改行を本文に含められる。
function splitRecords(text, delim) {
  const recs = [];
  let rec = [];
  let field = "";
  let inQuote = false;
  let line = 1;
  let startLine = 1;
  const pushRec = () => {
    rec.push(field);
    field = "";
    recs.push({ line: startLine, cells: rec });
    rec = [];
  };
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuote) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuote = false;
        }
      } else {
        if (ch === "\n") line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      inQuote = true;
    } else if (ch === delim) {
      rec.push(field);
      field = "";
    } else if (ch === "\r") {
      // 何もしない（CRLF の CR を捨てる）
    } else if (ch === "\n") {
      pushRec();
      line++;
      startLine = line;
    } else {
      field += ch;
    }
  }
  if (field !== "" || rec.length) pushRec();
  return recs;
}

// 表 / 裏 / 補足 の3列に振り分ける。4列目以降（Anki のタグなど）は捨てます。
function parseBulk(text, delimKey) {
  const delim = delimKey === "auto" ? guessDelim(text) : delimKey;
  const rows = [];
  const errors = [];
  if (text.trim()) {
    splitRecords(text, delim).forEach((r) => {
      const cells = r.cells.map((c) => c.trim());
      if (cells.every((c) => !c)) return; // 空行
      if (cells.length < 2) {
        errors.push({ line: r.line, text: cells[0], reason: "区切りが見つかりません" });
        return;
      }
      if (!cells[0] || !cells[1]) {
        errors.push({ line: r.line, text: cells.join(" / "), reason: "表または裏が空です" });
        return;
      }
      rows.push({ line: r.line, front: cells[0], back: cells[1], hint: cells[2] || "" });
    });
  }
  return { delim, rows, errors };
}

// 以前の版が初回起動時に入れていたサンプルデータ。保存済みの端末から取り除くために
// デッキIDと名前を残してあります（利用者が作ったデッキはIDの形が違うので巻き込みません）。
const SAMPLE_DECKS = {
  d1: "TOEIC 頻出単語",
  d2: "日本史 近現代",
  d3: "Web開発の用語",
};

// 保存済みデータからサンプルのデッキ・カードを取り除きます。取り除いた結果カードが
// 1枚も残らないときは、サンプルと一緒に作られていた学習ログと評価の累計も消します。
function stripSample(data) {
  if (!data || !data.decks) return { data, changed: false };
  const sampleIds = data.decks.filter((d) => SAMPLE_DECKS[d.id] === d.name).map((d) => d.id);
  if (!sampleIds.length) return { data, changed: false };
  const decks = data.decks.filter((d) => sampleIds.indexOf(d.id) < 0);
  const cards = (data.cards || []).filter((c) => sampleIds.indexOf(c.deckId) < 0 || !/^c\d+$/.test(c.id));
  const next = Object.assign({}, data, { decks, cards });
  if (!cards.length) {
    next.log = {};
    next.gradeTotals = { again: 0, hard: 0, good: 0, easy: 0 };
    next.todayCount = 0;
  }
  return { data: next, changed: true };
}

// ---------------------------------------------------------------- アプリ本体

class App extends Component {
  state = {
    screen: "home", // home | study | done | deck | stats | sync | import
    decks: [],
    cards: [],
    deckId: null,
    queue: [],
    showAnswer: false,
    history: [],
    tally: { again: 0, hard: 0, good: 0, easy: 0 },
    todayCount: 0,
    log: {},
    gradeTotals: { again: 0, hard: 0, good: 0, easy: 0 },
    narrow: false,
    newDeckOpen: false,
    newDeckName: "",
    quickOpen: false,
    quickDeck: "",
    qFront: "",
    qBack: "",
    formFront: "",
    formBack: "",
    formHint: "",
    formHintOpen: false, // カード追加フォームで補足欄を開いているか
    // カードのその場編集。editId が入っている行だけ入力欄に切り替わります
    editId: null,
    editFront: "",
    editBack: "",
    editHint: "",
    confirmingDelete: false,
    // デッキ名のその場編集。真のとき見出しが入力欄に切り替わります
    renamingDeck: false,
    renameName: "",
    toast: null,
    // 読み上げが使えるか（音声が1つも無い端末ではボタンを出しません）
    canSpeak: false,
    // 一括取り込み
    impFrom: "home",
    impText: "",
    impDelim: "auto",
    impDeck: "",
    impNewDeckName: "",
    impSkipDup: true,
    lastImport: null, // { ids, deckId, deckName, deckCreated }
    // 同期
    sbUrl: "",
    sbKey: "",
    syncEmail: "",
    syncPw: "",
    syncUser: null,
    syncBusy: false,
    syncError: null,
    syncAt: null,
    // 入口（ログイン画面）
    booting: false, // 保存済みセッションの復元待ち。ログイン画面のちらつき防止
    localOnly: false, // 「この端末だけで使う」を選んだ
    authMode: "in", // ログイン画面のタブ "in" | "up"
    syncAdvanced: false, // 同期画面で「別の保存先を使う」を開いているか
  };

  componentDidMount() {
    let data = null;
    try {
      data = JSON.parse(localStorage.getItem("kioku.mvp.v1") || "null");
    } catch (e) {}
    // 以前の版が入れたサンプルデータが保存されていれば、ここで取り除きます。
    const stripped = stripSample(data);
    data = stripped.data;
    // 旧版は due に答えた時刻をそのまま入れていたので、日の境界へ揃えます。
    if (data && data.cards) data.cards = alignDues(data.cards);
    this._sampleStripped = stripped.changed;
    // この端末に既に学習データがあったか。真ならログイン画面を挟まず今までどおり表示します
    // （ログインを促した結果、手元のデータが見えなくなる事故を防ぐため）。
    this._hadSavedData = !!(data && data.cards && data.cards.length);
    // 初回起動は空の状態から始めます（サンプルデータは入れません）。
    const log = (data && data.log) || {};
    this.setState({
      decks: (data && data.decks) || [],
      cards: (data && data.cards) || [],
      log: log,
      gradeTotals: (data && data.gradeTotals) || { again: 0, hard: 0, good: 0, easy: 0 },
      todayCount: log[dayKey(Date.now())] || 0,
    });
    if (this._sampleStripped) {
      this.persist({
        decks: data.decks,
        cards: data.cards,
        log: log,
        gradeTotals: data.gradeTotals || { again: 0, hard: 0, good: 0, easy: 0 },
        todayCount: log[dayKey(Date.now())] || 0,
      });
      this.toast("サンプルデータを削除しました");
    }

    // 読み上げが使えるか調べます。getVoices() は最初は空で返ることがあるので、
    // voiceschanged でもう一度確かめます（端末に音声が無ければボタンを出しません）。
    if (window.speechSynthesis) {
      this._voiceCheck = () => {
        let ok = false;
        try {
          ok = window.speechSynthesis.getVoices().length > 0;
        } catch (e) {}
        if (ok !== this.state.canSpeak) this.setState({ canSpeak: ok });
      };
      this._voiceCheck();
      window.speechSynthesis.addEventListener("voiceschanged", this._voiceCheck);
    }

    this._key = (e) => this.onKey(e);
    window.addEventListener("keydown", this._key);
    this._rz = () => {
      const n = window.innerWidth < 620;
      if (n !== this.state.narrow) this.setState({ narrow: n });
    };
    this._rz();
    window.addEventListener("resize", this._rz);

    const c = this.cfg();
    if (c) this.setState({ sbUrl: c.url, sbKey: c.key, syncAt: localStorage.getItem("kioku.sync.at") });
    // セッションが残っていれば復元が終わるまで待つ。ログイン済みの端末に
    // ログイン画面が一瞬映らないようにするためです（SDK は CDN から非同期に読み込むので）。
    const hasSession = !!localStorage.getItem("kioku.sb.auth");
    this._hadStoredSession = hasSession;
    this.setState({
      localOnly: localStorage.getItem("kioku.localonly") === "1",
      booting: !!c && hasSession,
    });
    this.initSync();
  }

  componentWillUnmount() {
    if (window.speechSynthesis && this._voiceCheck) {
      window.speechSynthesis.removeEventListener("voiceschanged", this._voiceCheck);
      window.speechSynthesis.cancel();
    }
    window.removeEventListener("keydown", this._key);
    window.removeEventListener("resize", this._rz);
    clearTimeout(this._toastT);
    clearTimeout(this._pushT);
  }

  // ---- 保存 ----

  persist(extra) {
    const s = Object.assign({}, this.state, extra || {});
    try {
      localStorage.setItem(
        "kioku.mvp.v1",
        JSON.stringify({
          decks: s.decks,
          cards: s.cards,
          todayCount: s.todayCount,
          log: s.log,
          gradeTotals: s.gradeTotals,
        })
      );
    } catch (e) {
      this.toast("端末に保存できませんでした（空き容量が足りません）");
    }
    this.queuePush();
  }

  // 端末内蔵の合成音声で読み上げます（Web Speech API）。
  // 音声ファイルは一切持たないので、カードのデータ構造も同期も変わりません。
  // 名前は Preact の Component が持たないものを選んでいます。
  speak(text) {
    if (!text || !window.speechSynthesis) return;
    try {
      window.speechSynthesis.cancel(); // 連打したときに前の発話を止める
      const u = new SpeechSynthesisUtterance(text);
      u.lang = speechLang(text);
      u.rate = 0.95;
      window.speechSynthesis.speak(u);
    } catch (e) {}
  }

  // 読み上げボタン。音声が使えない端末では何も描きません。
  speakButton(text) {
    if (!this.state.canSpeak || !text) return null;
    return html`<button
      class="ghost"
      title="読み上げる"
      aria-label="読み上げる"
      style=${{
        display: "inline-flex",
        alignItems: "center",
        justifyContent: "center",
        width: 34,
        height: 34,
        padding: 0,
        background: "none",
        border: "1px solid " + C.line,
        borderRadius: 99,
        color: C.faint,
      }}
      onClick=${(e) => {
        e.stopPropagation();
        this.speak(text);
      }}
    >
      <svg
        width="17"
        height="17"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        stroke-width="1.8"
        stroke-linecap="round"
        stroke-linejoin="round"
      >
        <path d="M4 9.5v5h3.5L12 18V6L7.5 9.5H4z" />
        <path d="M16 9.2a4 4 0 0 1 0 5.6" />
        <path d="M18.6 6.6a7.6 7.6 0 0 1 0 10.8" />
      </svg>
    </button>`;
  }

  toast(msg) {
    clearTimeout(this._toastT);
    this.setState({ toast: msg });
    this._toastT = setTimeout(() => this.setState({ toast: null }), 2200);
  }

  // ---- 学習ロジック（SM-2 簡易版） ----

  dueCards(deckId) {
    const now = Date.now();
    return this.state.cards.filter((c) => (!deckId || c.deckId === deckId) && c.due <= now);
  }

  startStudy(deckId) {
    // 出題順はセッションごとにシャッフルします（同じ並びで覚えてしまうのを防ぐため）。
    // ただし「復習が先、新規が後」の並びは保ちます。新規を混ぜると、その日の復習が
    // 終わらないうちに新しいカードが割り込んでしまうためです。
    const due = this.dueCards(deckId);
    const q = shuffle(due.filter((c) => c.state !== "new"))
      .concat(shuffle(due.filter((c) => c.state === "new")))
      .map((c) => c.id);
    if (!q.length) {
      this.toast(this.state.cards.length ? "このデッキは今日の分が終わっています" : "まずはカードを追加してください");
      return;
    }
    this.setState({
      screen: "study",
      deckId: deckId,
      queue: q,
      showAnswer: false,
      history: [],
      tally: { again: 0, hard: 0, good: 0, easy: 0 },
      renamingDeck: false,
      confirmingDelete: false,
      editId: null,
    });
  }

  flip() {
    this.setState({ showAnswer: true });
  }

  // 評価に応じて次回出題日を決める。ここが暗記アプリの心臓部。
  // hard < good < easy が必ず成り立つように、3つの間隔をまとめて出します。
  // 倍率の丸めや ease の下限のせいで「むずかしい」と「できた」が同じ日数になるのを防ぐためです。
  intervals(card) {
    const iv = card.interval;
    if (!iv) return { hard: 1, good: 2, easy: 4 }; // 初回（新規・学習中）
    const hard = Math.max(iv + 1, Math.ceil(iv * 1.2));
    const good = Math.max(hard + 1, Math.round(iv * card.ease));
    const easyEase = Math.min(3.2, card.ease + 0.15);
    const easy = Math.max(good + 1, Math.round(iv * easyEase * 1.3));
    return { hard: hard, good: good, easy: easy };
  }

  schedule(card, grade) {
    const c = Object.assign({}, card);
    const now = Date.now();
    const iv = this.intervals(card);
    c.reps += 1;
    if (grade === "again") {
      c.ease = Math.max(1.3, c.ease - 0.2);
      c.interval = 0;
      c.state = "learning";
      c.due = now; // 同一セッション内で再出題
    } else if (grade === "hard") {
      c.ease = Math.max(1.3, c.ease - 0.15);
      c.interval = iv.hard;
      c.state = "review";
      c.due = addDays(now, c.interval);
    } else if (grade === "good") {
      c.interval = iv.good;
      c.state = "review";
      c.due = addDays(now, c.interval);
    } else {
      c.ease = Math.min(3.2, c.ease + 0.15);
      c.interval = iv.easy;
      c.state = "review";
      c.due = addDays(now, c.interval);
    }
    return c;
  }

  rate(grade) {
    const id = this.state.queue[0];
    if (!id) return;
    if (window.speechSynthesis) window.speechSynthesis.cancel(); // 次のカードへ進むので読み上げを止める
    const card = this.state.cards.find((c) => c.id === id);
    const updated = this.schedule(card, grade);
    const cards = this.state.cards.map((c) => (c.id === id ? updated : c));
    const queue = this.state.queue.slice(1);
    if (grade === "again") queue.push(id);
    const tally = Object.assign({}, this.state.tally);
    tally[grade] += 1;
    const history = this.state.history.concat([
      {
        card: card,
        queue: this.state.queue,
        tally: this.state.tally,
        gradeTotals: this.state.gradeTotals,
      },
    ]);
    const k = dayKey(Date.now());
    const log = Object.assign({}, this.state.log);
    log[k] = (log[k] || 0) + 1;
    const gradeTotals = Object.assign({}, this.state.gradeTotals);
    gradeTotals[grade] = (gradeTotals[grade] || 0) + 1;
    const next = {
      cards,
      queue,
      tally,
      history,
      log,
      gradeTotals,
      todayCount: this.state.todayCount + 1,
      showAnswer: false,
      screen: queue.length ? "study" : "done",
    };
    this.setState(next);
    this.persist(next);
  }

  undo() {
    const h2 = this.state.history.slice();
    const last = h2.pop();
    if (!last) return;
    const cards = this.state.cards.map((c) => (c.id === last.card.id ? last.card : c));
    const k = dayKey(Date.now());
    const log = Object.assign({}, this.state.log);
    log[k] = Math.max(0, (log[k] || 0) - 1);
    const next = {
      cards,
      queue: last.queue,
      tally: last.tally,
      gradeTotals: last.gradeTotals || this.state.gradeTotals,
      history: h2,
      log,
      todayCount: Math.max(0, this.state.todayCount - 1),
      showAnswer: true,
      screen: "study",
    };
    this.setState(next);
    this.persist(next);
  }

  bury() {
    const id = this.state.queue[0];
    const queue = this.state.queue.slice(1);
    const cards = this.state.cards.map((c) =>
      c.id === id ? Object.assign({}, c, { due: addDays(Date.now(), 1) }) : c
    );
    const next = { cards, queue, showAnswer: false, screen: queue.length ? "study" : "done" };
    this.setState(next);
    this.persist(next);
    this.toast("明日また出題します");
  }

  onKey(e) {
    if (this.state.screen !== "study") return;
    const tag = (e.target.tagName || "").toLowerCase();
    if (tag === "input" || tag === "textarea") return;
    if (e.key === " " || e.key === "Enter") {
      e.preventDefault();
      if (!this.state.showAnswer) this.flip();
      else this.rate("good");
      return;
    }
    if (!this.state.showAnswer) return;
    const map = { 1: "again", 2: "hard", 3: "good", 4: "easy" };
    if (map[e.key]) {
      e.preventDefault();
      this.rate(map[e.key]);
    }
  }

  intervalLabel(card, grade) {
    if (!card) return "";
    if (grade === "again") return "セッション内";
    const d = this.schedule(card, grade).interval;
    if (d < 1) return "セッション内";
    if (d === 1) return "1日後";
    if (d < 30) return d + "日後";
    return Math.round(d / 30) + "か月後";
  }

  dueLabel(card) {
    if (card.due <= Date.now()) return card.state === "new" ? "未学習" : "復習待ち";
    const d = Math.max(1, Math.round((startOfDay(card.due) - startOfDay(Date.now())) / DAY));
    return d === 1 ? "明日" : d + "日後";
  }

  // ---- クラウド同期（Supabase・任意） ----

  // 保存先。端末で設定したものがあればそれを、なければ DEFAULT_SB を使います。
  cfg() {
    try {
      const saved = JSON.parse(localStorage.getItem("kioku.sync.cfg") || "null");
      if (saved && saved.url && saved.key) return saved;
    } catch (e) {}
    return DEFAULT_SB.url && DEFAULT_SB.key ? DEFAULT_SB : null;
  }

  // 端末で保存先を上書きしているか（同期画面で「別の保存先」の表示を出し分けるのに使います）。
  hasOwnCfg() {
    try {
      const saved = JSON.parse(localStorage.getItem("kioku.sync.cfg") || "null");
      return !!(saved && saved.url && saved.key);
    } catch (e) {
      return false;
    }
  }

  // ログインできた／ローカル専用をやめたときに呼びます。
  leaveLocalOnly() {
    localStorage.removeItem("kioku.localonly");
    if (this.state.localOnly) this.setState({ localOnly: false });
  }

  // エラー文言に app.js のどの行で起きたかを添える（古い版が動いていないかの確認用）。
  errText(e) {
    const msg = String((e && e.message) || e);
    const line =
      e && e.stack
        ? String(e.stack)
            .split("\n")
            .map((l) => l.trim())
            .find((l) => l.indexOf("app.js") >= 0)
        : "";
    return line ? msg + "\n（" + BUILD + " / " + line.slice(0, 120) + "）" : msg + "\n（" + BUILD + "）";
  }

  // 同期がうまくいかないときに、どのCDNが何を返しているかを画面に出します。
  async diagnose() {
    const c = this.cfg();
    const lines = ["診断結果  ビルド " + BUILD];
    if (this._sbNote) lines.push(this._sbNote);
    if (!c || !c.url || !c.key) {
      lines.push("接続情報が未設定です");
      this.setState({ syncError: lines.join("\n") });
      return;
    }
    lines.push("接続先 " + c.url + " / キー " + c.key.slice(0, 8) + "…（" + c.key.length + "文字）");
    this.setState({ syncBusy: true, syncError: lines.join("\n") + "\n診断中…" });
    for (let i = 0; i < SB_SOURCES.length; i++) {
      const src = SB_SOURCES[i];
      const where = new URL(src).hostname + (src.indexOf("+esm") >= 0 ? "(+esm)" : "");
      try {
        const m = await import(src);
        const create = m.createClient || (m.default && m.default.createClient);
        if (typeof create !== "function") {
          lines.push(where + "：createClient なし [" + Object.keys(m).slice(0, 6).join(",") + "]");
          continue;
        }
        const cl = create(c.url, c.key, { auth: { persistSession: false } });
        lines.push(
          where +
            "：client=" +
            (cl ? typeof cl : "なし") +
            " auth=" +
            (cl && cl.auth ? typeof cl.auth : "なし") +
            " signIn=" +
            (cl && cl.auth ? typeof cl.auth.signInWithPassword : "-")
        );
      } catch (e) {
        lines.push(where + "：失敗 " + String((e && e.message) || e).slice(0, 100));
      }
      this.setState({ syncError: lines.join("\n") });
    }
    this.setState({ syncBusy: false, syncError: lines.join("\n") });
  }

  async loadSb() {
    const c = this.cfg();
    if (!c || !c.url || !c.key) throw new Error("接続情報が未設定です");
    // 使い回す前にも中身を確かめる。何かに書き換わっていたら作り直します。
    if (this._sbClient) {
      if (this._sbClient.auth && typeof this._sbClient.auth.signInWithPassword === "function") {
        return this._sbClient;
      }
      this._sbNote =
        "保持していたクライアントが別のものに変わっていました：" +
        Object.prototype.toString.call(this._sbClient) +
        " [" +
        Object.keys(this._sbClient || {}).slice(0, 8).join(",") +
        "]";
      this._sbClient = null;
    }

    const notes = [];
    for (let i = 0; i < SB_SOURCES.length; i++) {
      const src = SB_SOURCES[i];
      const where = new URL(src).hostname;
      let m = null;
      try {
        m = await import(src);
      } catch (e) {
        notes.push(where + "：読み込めませんでした");
        continue;
      }
      const create = m.createClient || (m.default && m.default.createClient);
      if (typeof create !== "function") {
        notes.push(where + "：createClient が見つかりません");
        continue;
      }
      let client = null;
      try {
        client = create(c.url, c.key, {
          auth: { persistSession: true, storageKey: "kioku.sb.auth" },
        });
      } catch (e) {
        notes.push(where + "：初期化に失敗（" + (e.message || e) + "）");
        continue;
      }
      // CDN 側のビルドが壊れていると auth を持たないクライアントが返ることがあります。
      if (!client || !client.auth || typeof client.auth.signInWithPassword !== "function") {
        notes.push(where + "：SDKの形式が想定と違います");
        continue;
      }
      this._sbClient = client;
      return client;
    }
    throw new Error("Supabase SDK を読み込めませんでした。" + notes.join(" / "));
  }

  async initSync() {
    if (!this.cfg()) {
      this.setState({ booting: false });
      return;
    }
    try {
      const sb = await this.loadSb();
      const { data } = await sb.auth.getSession();
      const user = data && data.session ? data.session.user : null;
      this.setState({ syncUser: user ? user.email : null, booting: false });
      if (user) this.leaveLocalOnly();
      if (!this._authSub) {
        this._authSub = sb.auth.onAuthStateChange((evt, session) => {
          const u = session ? session.user.email : null;
          if (u !== this.state.syncUser) {
            this.setState({ syncUser: u });
            if (u) {
              this.leaveLocalOnly();
              this.pull(true);
            }
          }
        });
      }
      if (user) this.pull(true);
    } catch (e) {
      // 復元するセッションが無いなら、まだ何もしていない人にエラーを見せる必要はありません。
      // 実際に困るのはログインを押したときで、そこで同じエラーが出ます。
      this.setState({ syncError: this._hadStoredSession ? this.errText(e) : null, booting: false });
    }
  }

  async signIn(mode) {
    const email = (this.state.syncEmail || "").trim();
    const pw = this.state.syncPw || "";
    if (!email || pw.length < 6) {
      this.toast("メールと6文字以上のパスワードを入力してください");
      return;
    }
    this.setState({ syncBusy: true, syncError: null });
    try {
      const sb = await this.loadSb();
      const res =
        mode === "up"
          ? await sb.auth.signUp({ email, password: pw })
          : await sb.auth.signInWithPassword({ email, password: pw });
      if (res.error) throw res.error;
      const data = res.data || {};
      if (!data.session) {
        this.setState({
          syncBusy: false,
          syncPw: "",
          syncError:
            "登録は受け付けられましたが、まだログインできていません。" +
            email +
            " に届いた確認メールのリンクを開いたうえで「ログイン」を押してください。（確認メールを不要にするには Supabase の Authentication → Sign In / Providers → Email で Confirm email を OFF にします）",
        });
        return;
      }
      this.leaveLocalOnly();
      this.setState({
        syncUser: data.session.user.email,
        syncPw: "",
        syncBusy: false,
        syncError: null,
        screen: this.state.screen === "login" ? "home" : this.state.screen,
      });
      this.toast("ログインしました");
      this.pull(true);
    } catch (e) {
      this.setState({ syncBusy: false, syncError: this.errText(e) });
    }
  }

  async signOut() {
    try {
      const sb = await this.loadSb();
      await sb.auth.signOut();
    } catch (e) {}
    // 手元の学習データは消しません。入口のログイン画面に戻すだけです。
    this.setState({ syncUser: null, syncAt: null, localOnly: false, syncPw: "", syncError: null, screen: "login" });
    localStorage.removeItem("kioku.localonly");
    this.toast("ログアウトしました");
  }

  payload() {
    const s = this.state;
    return { decks: s.decks, cards: s.cards, log: s.log, gradeTotals: s.gradeTotals, todayCount: s.todayCount };
  }

  async push() {
    if (!this.state.syncUser) return;
    this.setState({ syncBusy: true, syncError: null });
    try {
      const sb = await this.loadSb();
      const { data: u } = await sb.auth.getUser();
      const at = new Date().toISOString();
      const { error } = await sb
        .from("kioku_state")
        .upsert({ user_id: u.user.id, data: this.payload(), updated_at: at });
      if (error) throw error;
      localStorage.setItem("kioku.sync.at", at);
      this.setState({ syncBusy: false, syncAt: at });
    } catch (e) {
      this.setState({ syncBusy: false, syncError: this.errText(e) });
    }
  }

  // 競合は updated_at が新しい方を採用（last-write-wins）
  async pull(silent) {
    if (!this.state.syncUser) return;
    this.setState({ syncBusy: true, syncError: null });
    try {
      const sb = await this.loadSb();
      const { data: u } = await sb.auth.getUser();
      const { data, error } = await sb
        .from("kioku_state")
        .select("data, updated_at")
        .eq("user_id", u.user.id)
        .maybeSingle();
      if (error) throw error;
      if (!data) {
        this.setState({ syncBusy: false });
        await this.push();
        return;
      }
      const localAt = localStorage.getItem("kioku.sync.at");
      const remoteNewer = !localAt || new Date(data.updated_at) > new Date(localAt);
      if (remoteNewer && data.data) {
        // クラウド側に古い版のサンプルデータが残っていることがあるので、ここでも取り除きます。
        const d = stripSample(data.data).data;
        const next = {
          decks: d.decks || [],
          cards: alignDues(d.cards),
          log: d.log || {},
          gradeTotals: d.gradeTotals || { again: 0, hard: 0, good: 0, easy: 0 },
          todayCount: (d.log && d.log[dayKey(Date.now())]) || 0,
        };
        this.setState(Object.assign({}, next, { syncBusy: false, syncAt: data.updated_at }));
        localStorage.setItem("kioku.sync.at", data.updated_at);
        this.persist(next);
        if (!silent) this.toast("クラウドから復元しました");
      } else {
        this.setState({ syncBusy: false });
        await this.push();
        if (!silent) this.toast("この端末のデータをアップロードしました");
      }
    } catch (e) {
      this.setState({ syncBusy: false, syncError: this.errText(e) });
    }
  }

  queuePush() {
    if (!this.state.syncUser) return;
    clearTimeout(this._pushT);
    this._pushT = setTimeout(() => this.push(), 2500);
  }

  saveCfg() {
    const url = (this.state.sbUrl || "").trim();
    const key = (this.state.sbKey || "").trim();
    let origin = "";
    try {
      origin = new URL(url).origin;
    } catch (e) {}
    if (!origin) {
      this.toast("URLは https:// から始まる Project URL を入力してください");
      return;
    }
    if (/supabase\.com$/.test(new URL(origin).hostname)) {
      this.setState({
        syncError:
          "これはダッシュボードのURLです。Project Settings → Data API にある Project URL（https://〇〇〇.supabase.co）を貼ってください。",
      });
      return;
    }
    if (key.length < 20) {
      this.toast("キーが短すぎます。Publishable key 全体を貼り付けてください");
      return;
    }
    if (/^sb_secret_/.test(key)) {
      this.toast("Secret key は使えません。Publishable key を貼ってください");
      return;
    }
    localStorage.setItem("kioku.sync.cfg", JSON.stringify({ url: origin, key }));
    this._sbClient = null;
    this.setState({ sbUrl: origin, syncError: null });
    this.toast("接続情報を保存しました");
    this.initSync();
  }

  // 端末で上書きした保存先を捨てます。DEFAULT_SB があればそちらに戻ります。
  clearCfg() {
    localStorage.removeItem("kioku.sync.cfg");
    localStorage.removeItem("kioku.sync.at");
    this._sbClient = null;
    const back = DEFAULT_SB.url && DEFAULT_SB.key;
    this.setState({
      syncUser: null,
      syncAt: null,
      sbUrl: back ? DEFAULT_SB.url : "",
      sbKey: back ? DEFAULT_SB.key : "",
      syncError: null,
    });
    this.toast(back ? "既定の保存先に戻しました" : "接続を解除しました");
    if (back) this.initSync();
  }

  // 端末に古い版が残ったときの逃げ道。キャッシュとService Workerを捨てて読み直します。
  // 名前を forceUpdate にしないこと。Preact の Component が同名のAPIを持っていて、
  // 上書きすると Preact 側から呼ばれたときにページ再読み込みが走ってしまいます。
  async hardReload() {
    this.toast("最新版を取得しています…");
    try {
      if (window.caches) {
        const keys = await caches.keys();
        await Promise.all(keys.map((k) => caches.delete(k)));
      }
      if (navigator.serviceWorker) {
        const regs = await navigator.serviceWorker.getRegistrations();
        await Promise.all(regs.map((r) => r.unregister()));
      }
    } catch (e) {}
    location.replace(location.pathname + "?u=" + Date.now());
  }

  exportJson() {
    const blob = new Blob([JSON.stringify(this.payload(), null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "kioku-backup-" + dayKey(Date.now()) + ".json";
    a.click();
    this.toast("バックアップを書き出しました");
  }

  importJson(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => {
      try {
        const d = JSON.parse(r.result);
        const next = {
          decks: d.decks || [],
          cards: alignDues(d.cards),
          log: d.log || {},
          gradeTotals: d.gradeTotals || { again: 0, hard: 0, good: 0, easy: 0 },
          todayCount: (d.log && d.log[dayKey(Date.now())]) || 0,
        };
        this.setState(next);
        this.persist(next);
        this.toast("バックアップを読み込みました");
      } catch (err) {
        this.toast("ファイルを読み込めませんでした");
      }
    };
    r.readAsText(f);
  }

  // ---- 集計（学習の記録画面で使う） ----

  stats() {
    const s = this.state;
    const now = Date.now();
    const log = s.log || {};
    const cards = s.cards;

    let streak = 0;
    for (let i = 0; i < 400; i++) {
      const v = log[dayKey(now - i * DAY)] || 0;
      if (v > 0) streak++;
      else if (i > 0) break;
    }

    const heatColor = (v) =>
      v === 0 ? "#E7E0D2" : v < 8 ? "#DCE9E1" : v < 16 ? "#A9CDBD" : v < 26 ? "#6BA893" : "#3E7C6B";
    const heatCells = [];
    const days = 91;
    const start = now - (days - 1) * DAY;
    const startDow = new Date(start).getDay();
    for (let i = 0; i < startDow; i++) heatCells.push({ key: "pad" + i, color: "transparent", label: "", today: false });
    for (let i = 0; i < days; i++) {
      const k = dayKey(start + i * DAY);
      const v = log[k] || 0;
      heatCells.push({ key: k, color: heatColor(v), label: k + "：" + v + "枚", today: k === dayKey(now) });
    }
    const heatLegend = [0, 5, 12, 20, 30].map((v) => ({ key: "l" + v, color: heatColor(v) }));

    let weekTotal = 0;
    let monthTotal = 0;
    for (let i = 0; i < 30; i++) {
      const v = log[dayKey(now - i * DAY)] || 0;
      monthTotal += v;
      if (i < 7) weekTotal += v;
    }

    const gt = s.gradeTotals || {};
    const gAll = (gt.again || 0) + (gt.hard || 0) + (gt.good || 0) + (gt.easy || 0);
    const retention = gAll ? Math.round(((gAll - (gt.again || 0)) / gAll) * 100) : 0;

    const m = { fresh: 0, learning: 0, young: 0, mature: 0 };
    cards.forEach((c) => {
      if (c.state === "new") m.fresh++;
      else if (c.interval < 1) m.learning++;
      else if (c.interval < 21) m.young++;
      else m.mature++;
    });
    const maturity = [
      ["未学習", m.fresh, "#D8D1C1"],
      ["学習中", m.learning, "#EBC98A"],
      ["定着中", m.young, "#A9CDBD"],
      ["定着済み", m.mature, "#3E7C6B"],
    ].map((x) => ({
      name: x[0],
      count: x[1],
      color: x[2],
      pct: cards.length ? Math.round((x[1] / cards.length) * 100) + "%" : "0%",
      width: cards.length ? (x[1] / cards.length) * 100 + "%" : "0%",
    }));

    const fc = [];
    const today = startOfDay(now);
    for (let i = 0; i < 7; i++) {
      const n = cards.filter((c) => {
        const d = Math.round((startOfDay(c.due) - today) / DAY);
        return i === 0 ? d <= 0 : d === i;
      }).length;
      fc.push({ i, n, label: i === 0 ? "今日" : i === 1 ? "明日" : "+" + i + "日" });
    }
    const fcMax = Math.max.apply(null, fc.map((f) => f.n).concat([1]));
    const forecast = fc.map((f) => ({
      key: "f" + f.i,
      label: f.label,
      n: f.n,
      height: Math.max(4, Math.round((f.n / fcMax) * 92)),
      color: f.i === 0 ? C.accent : "#C9D9D1",
    }));

    const deckProgress = s.decks.map((d, i) => {
      const cs = cards.filter((c) => c.deckId === d.id);
      const mature = cs.filter((c) => c.interval >= 21).length;
      const pct = cs.length ? Math.round((mature / cs.length) * 100) : 0;
      return { key: d.id, name: d.name, total: cs.length, mature, pct: pct + "%", color: ACCENTS[i % ACCENTS.length] };
    });

    return {
      streak,
      heatCells,
      heatLegend,
      weekTotal,
      weekAvg: Math.round(weekTotal / 7),
      monthTotal,
      retention,
      maturity,
      maturityTotal: cards.length,
      forecast,
      deckProgress,
    };
  }

  // ---------------------------------------------------------------- 描画

  render() {
    const s = this.state;
    const n = s.narrow;
    const st = this.stats();
    const box = { background: C.surface, border: "1px solid " + C.line, borderRadius: 18, padding: 20 };
    const field = {
      border: "1px solid " + C.line,
      background: C.field,
      borderRadius: 10,
      padding: "12px 14px",
      fontSize: 14,
      outline: "none",
      // input / textarea は既定の最小幅を持つため、flex や grid の中で縮まずに
      // 隣のボタンを枠外へ押し出す。0 にして必ず親幅に収める。
      minWidth: 0,
    };
    const primary = {
      background: C.ink,
      color: C.bg,
      border: "none",
      borderRadius: 10,
      padding: "12px 22px",
      fontSize: 14,
      fontWeight: 700,
    };
    const secondary = {
      background: C.bg,
      border: "1px solid " + C.line,
      color: C.inkSoft,
      borderRadius: 10,
      padding: "12px 18px",
      fontSize: 13,
    };
    const backLink = {
      background: "none",
      border: "none",
      color: C.faint,
      fontSize: 13,
      padding: "6px 0",
      marginBottom: 10,
    };
    const h2Style = { margin: 0, fontSize: n ? 22 : 28, fontWeight: 700 };

    const toast =
      s.toast &&
      html`<div
        style=${{
          position: "fixed",
          left: "50%",
          bottom: "calc(28px + env(safe-area-inset-bottom))",
          transform: "translateX(-50%)",
          background: C.ink,
          color: C.bg,
          padding: "12px 22px",
          borderRadius: 999,
          fontSize: 13,
          boxShadow: "0 10px 30px rgba(28,34,48,.25)",
          animation: "kk-rise .2s ease both",
          zIndex: 50,
        }}
      >
        ${s.toast}
      </div>`;

    // 入口の出し分け。保存先が決まっていて未ログインなら、デッキ一覧の手前にログイン画面を挟みます。
    // ただし、この端末に既に学習データがある人と「この端末だけで使う」を選んだ人は素通しします
    // （明示的に screen を "login" にしたときは、そのときだけ出します）。
    const gate = !!this.cfg() && !s.syncUser;
    const showLogin = gate && !s.booting && (s.screen === "login" || (!s.localOnly && !this._hadSavedData));
    if (gate && s.booting) {
      return html`
        <div style=${{ minHeight: "100vh", background: C.bg, display: "grid", placeItems: "center" }}>
          <div style=${{ fontSize: 13, color: C.faint }}>読み込み中…</div>
        </div>
      `;
    }
    if (showLogin) {
      return html`
        <div style=${{ minHeight: "100vh", background: C.bg, padding: "0 20px 60px" }}>
          ${this.renderLogin(box, field, primary, secondary)} ${toast}
        </div>
      `;
    }

    return html`
      <div style=${{ minHeight: "100vh", background: C.bg, padding: "0 20px 80px" }}>
        ${this.renderHeader(st)}
        ${(s.screen === "home" || s.screen === "login") && this.renderHome(st, box, field, primary)}
        ${s.screen === "study" && this.renderStudy()}
        ${s.screen === "done" && this.renderDone()}
        ${s.screen === "deck" && this.renderDeck(box, field, primary, backLink, h2Style)}
        ${s.screen === "import" && this.renderImport(box, field, primary, secondary, backLink, h2Style)}
        ${s.screen === "stats" && this.renderStats(st, box, backLink, h2Style)}
        ${s.screen === "sync" && this.renderSync(box, field, primary, secondary, backLink, h2Style)}
        ${toast}
      </div>
    `;
  }

  renderHeader(st) {
    const s = this.state;
    const n = s.narrow;
    const pill = {
      display: "flex",
      alignItems: "baseline",
      gap: 5,
      background: C.surface,
      border: "1px solid " + C.line,
      borderRadius: 999,
      padding: n ? "6px 12px" : "8px 16px",
      whiteSpace: "nowrap",
      flexShrink: 0,
    };
    const navBtn = {
      background: "none",
      border: "1px solid " + C.line,
      color: C.muted,
      borderRadius: 999,
      padding: n ? "6px 13px" : "8px 15px",
      fontSize: 13,
      whiteSpace: "nowrap",
    };
    return html`
      <header
        style=${{
          maxWidth: 900,
          margin: "0 auto",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: n ? "18px 0 14px" : "26px 0 18px",
          flexWrap: "wrap",
        }}
      >
        <div
          style=${{ display: "flex", alignItems: "center", gap: 12, cursor: "pointer", flexShrink: 0 }}
          onClick=${() => this.setState({ screen: "home", showAnswer: false, confirmingDelete: false, renamingDeck: false, editId: null })}
        >
          <div
            style=${{
              width: 34,
              height: 34,
              borderRadius: 10,
              background: C.ink,
              color: C.bg,
              display: "grid",
              placeItems: "center",
              fontFamily: "'Zen Old Mincho', serif",
              fontSize: 19,
              fontWeight: 700,
            }}
          >
            記
          </div>
          <div>
            <div style=${{ fontSize: 17, fontWeight: 700, letterSpacing: ".04em" }}>キオク</div>
            <div style=${{ fontSize: 11, color: C.faint, letterSpacing: ".14em" }}>SPACED REPETITION</div>
          </div>
        </div>
        <div style=${{ display: "flex", alignItems: "center", gap: 8, flexShrink: 0, flexWrap: "wrap" }}>
          <button class="ghost" style=${navBtn} onClick=${() => this.setState({ screen: "stats" })}>記録</button>
          <button class="ghost" style=${navBtn} onClick=${() => this.setState({ screen: "sync", syncError: null })}>
            同期
          </button>
          <div style=${{ width: 1, height: 20, background: C.line }}></div>
          <div style=${pill} onClick=${() => this.setState({ screen: "stats" })}>
            <span style=${{ fontSize: 12, color: C.faint }}>連続</span>
            <span style=${{ fontSize: 15, fontWeight: 700 }}>${st.streak}</span>
            <span style=${{ fontSize: 12, color: C.faint }}>日</span>
          </div>
          <div style=${pill}>
            <span style=${{ fontSize: 12, color: C.faint }}>今日</span>
            <span style=${{ fontSize: 15, fontWeight: 700 }}>${this.state.todayCount}</span>
            <span style=${{ fontSize: 12, color: C.faint }}>枚</span>
          </div>
        </div>
      </header>
    `;
  }

  renderHome(st, box, field, primary) {
    const s = this.state;
    const n = s.narrow;
    const now = Date.now();
    const totalDue = this.dueCards(null).length;

    const decks = s.decks.map((d, i) => {
      const cs = s.cards.filter((c) => c.deckId === d.id);
      const dueCount = cs.filter((c) => c.due <= now && c.state !== "new").length;
      const newCount = cs.filter((c) => c.due <= now && c.state === "new").length;
      const mature = cs.filter((c) => c.interval >= 2).length;
      return {
        d,
        cs,
        dueCount,
        newCount,
        empty: dueCount + newCount === 0,
        barWidth: cs.length ? Math.round((mature / cs.length) * 100) + "%" : "0%",
        color: ACCENTS[i % ACCENTS.length],
      };
    });

    return html`
      <main style=${{ maxWidth: 900, margin: "0 auto", animation: "kk-rise .3s ease both" }}>
        ${!s.syncUser &&
        !!this.cfg() &&
        html`<div
          style=${{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 12,
            flexWrap: "wrap",
            background: C.surface,
            border: "1px solid " + C.line,
            borderRadius: 14,
            padding: "11px 16px",
            marginBottom: 16,
          }}
        >
          <div style=${{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            いまはこの端末の中だけに保存されています。ログインすると他の端末と同じ状態になります。
          </div>
          <button
            class="soft"
            style=${{
              background: C.bg,
              border: "1px solid " + C.line,
              color: C.inkSoft,
              borderRadius: 999,
              padding: "8px 16px",
              fontSize: 12,
              flexShrink: 0,
            }}
            onClick=${() => this.setState({ screen: "login", syncError: null })}
          >
            ログイン
          </button>
        </div>`}
        <section
          style=${{
            background: C.ink,
            borderRadius: 22,
            padding: n ? "26px 22px" : "34px 36px",
            color: C.bg,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 24,
            flexWrap: "wrap",
          }}
        >
          <div style=${{ maxWidth: 460 }}>
            <div style=${{ fontSize: 12, letterSpacing: ".18em", color: C.ghost }}>TODAY</div>
            <h1 style=${{ margin: "8px 0 10px", fontSize: n ? 25 : 34, lineHeight: 1.3, fontWeight: 700, textWrap: "pretty" }}>
              復習が待っているカードが<br />
              <span style=${{ fontFamily: "'Zen Old Mincho', serif", fontSize: n ? 34 : 44, color: C.accent }}>
                ${totalDue}
              </span>
              枚あります
            </h1>
            <p style=${{ margin: 0, fontSize: 14, lineHeight: 1.7, color: "#BDB7AB" }}>
              1日10分で十分。忘れかけたタイミングで出題されるので、少ない回数で長く覚えられます。
            </p>
          </div>
          <button
            class="cta"
            style=${{
              background: C.accent,
              color: C.ink,
              border: "none",
              borderRadius: 14,
              padding: n ? "16px 22px" : "18px 30px",
              fontSize: n ? 15 : 17,
              fontWeight: 700,
              boxShadow: "0 8px 0 " + C.accentDeep,
              width: n ? "100%" : "auto",
            }}
            onClick=${() => this.startStudy(null)}
          >
            今日の学習をはじめる →
          </button>
        </section>

        <div
          style=${{
            display: "flex",
            alignItems: n ? "flex-start" : "baseline",
            flexDirection: n ? "column" : "row",
            justifyContent: "space-between",
            gap: n ? 10 : 16,
            margin: "34px 0 14px",
          }}
        >
          <h2 style=${{ margin: 0, fontSize: 18, fontWeight: 700, flexShrink: 0, whiteSpace: "nowrap" }}>デッキ</h2>
          <div style=${{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              class="dark"
              style=${{
                background: C.ink,
                border: "1px solid " + C.ink,
                color: C.bg,
                borderRadius: 999,
                padding: "8px 16px",
                fontSize: 13,
                fontWeight: 700,
              }}
              onClick=${() =>
                this.setState({
                  quickOpen: !s.quickOpen,
                  newDeckOpen: false,
                  quickDeck: s.quickDeck || (s.decks[0] && s.decks[0].id) || "",
                })}
            >
              ＋ カードを追加
            </button>
            <button
              class="ghost"
              style=${{
                background: "none",
                border: "1px dashed #C0B8A5",
                color: C.muted,
                borderRadius: 999,
                padding: "7px 16px",
                fontSize: 13,
              }}
              onClick=${() => this.setState({ newDeckOpen: !s.newDeckOpen })}
            >
              ＋ デッキを追加
            </button>
            <button
              class="ghost"
              style=${{
                background: "none",
                border: "1px dashed #C0B8A5",
                color: C.muted,
                borderRadius: 999,
                padding: "7px 16px",
                fontSize: 13,
              }}
              onClick=${() => this.openImport(null, "home")}
            >
              一括で取り込む
            </button>
          </div>
        </div>

        ${s.quickOpen &&
        html`<div
          style=${{
            background: C.surface,
            border: "1px solid " + C.line,
            borderRadius: 16,
            padding: 18,
            marginBottom: 14,
            animation: "kk-rise .2s ease both",
          }}
        >
          <div style=${{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style=${{ fontSize: 13, fontWeight: 700 }}>カードを追加</div>
            <select
              value=${s.quickDeck || (s.decks[0] && s.decks[0].id) || ""}
              onChange=${(e) => this.setState({ quickDeck: e.target.value })}
              style=${{
                border: "1px solid " + C.line,
                background: C.field,
                borderRadius: 8,
                padding: "7px 10px",
                fontSize: 13,
                color: C.ink,
                outline: "none",
              }}
            >
              ${s.decks.map((d) => html`<option key=${d.id} value=${d.id}>${d.name}</option>`)}
            </select>
            <button
              style=${{ marginLeft: "auto", background: "none", border: "none", color: C.ghost, fontSize: 13 }}
              onClick=${() => this.setState({ quickOpen: false })}
            >
              閉じる
            </button>
          </div>
          <div style=${{ display: "grid", gridTemplateColumns: n ? "1fr" : "1fr 1fr auto", gap: 10, alignItems: "start" }}>
            <textarea
              rows="2"
              placeholder="表：問題・単語"
              value=${s.qFront}
              onInput=${(e) => this.setState({ qFront: e.target.value })}
              style=${Object.assign({}, field, { resize: "vertical" })}
            ></textarea>
            <textarea
              rows="2"
              placeholder="裏：答え・意味"
              value=${s.qBack}
              onInput=${(e) => this.setState({ qBack: e.target.value })}
              style=${Object.assign({}, field, { resize: "vertical" })}
            ></textarea>
            <button
              style=${Object.assign({}, primary, { height: "100%", flexShrink: 0, whiteSpace: "nowrap" })}
              onClick=${() => this.quickAdd()}
            >
              追加
            </button>
          </div>
          <div style=${{ fontSize: 11, color: C.ghost, marginTop: 8 }}>続けて入力すれば何枚でも追加できます。</div>
        </div>`}

        ${s.newDeckOpen &&
        html`<div
          style=${{
            background: C.surface,
            border: "1px solid " + C.line,
            borderRadius: 16,
            padding: 16,
            marginBottom: 14,
            display: "flex",
            gap: 10,
          }}
        >
          <input
            placeholder="デッキ名（例：フランス語 基礎1000）"
            value=${s.newDeckName}
            onInput=${(e) => this.setState({ newDeckName: e.target.value })}
            style=${Object.assign({}, field, { flex: 1 })}
          />
          <button style=${Object.assign({}, primary, { flexShrink: 0, whiteSpace: "nowrap" })} onClick=${() => this.createDeck()}>
            作成
          </button>
        </div>`}

        ${!s.decks.length &&
        html`<div
          style=${{
            background: C.surface,
            border: "1px dashed " + C.line,
            borderRadius: 18,
            padding: n ? "26px 20px" : "34px 30px",
            textAlign: "center",
          }}
        >
          <div style=${{ fontSize: 16, fontWeight: 700, marginBottom: 8 }}>まだデッキがありません</div>
          <p style=${{ margin: "0 0 16px", fontSize: 13, lineHeight: 1.8, color: C.muted }}>
            「デッキを追加」で覚えたいことのまとまりを作り、カードを入れていきます。<br />
            手元の単語帳やスプレッドシートがあれば「一括で取り込む」から貼り付けられます。
          </p>
          <div style=${{ display: "flex", gap: 8, justifyContent: "center", flexWrap: "wrap" }}>
            <button style=${primary} onClick=${() => this.setState({ newDeckOpen: true, quickOpen: false })}>
              デッキを作る
            </button>
            <button
              class="soft"
              style=${{
                background: C.bg,
                border: "1px solid " + C.line,
                color: C.inkSoft,
                borderRadius: 10,
                padding: "11px 18px",
                fontSize: 13,
              }}
              onClick=${() => this.openImport(null, "home")}
            >
              一括で取り込む
            </button>
          </div>
        </div>`}

        <div style=${{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(272px, 1fr))", gap: 16 }}>
          ${decks.map(
            (x) => html`
              <div
                key=${x.d.id}
                class="lift"
                style=${{
                  background: C.surface,
                  border: "1px solid " + C.line,
                  borderRadius: 18,
                  padding: 20,
                  display: "flex",
                  flexDirection: "column",
                  gap: 14,
                }}
              >
                <div style=${{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", gap: 10 }}>
                  <div>
                    <div style=${{ fontSize: 16, fontWeight: 700, lineHeight: 1.4 }}>${x.d.name}</div>
                    <div style=${{ fontSize: 12, color: C.faint, marginTop: 3 }}>${x.d.sub}</div>
                  </div>
                  <div
                    style=${{
                      width: 30,
                      height: 30,
                      borderRadius: 9,
                      display: "grid",
                      placeItems: "center",
                      fontSize: 13,
                      fontWeight: 700,
                      fontFamily: "'Zen Old Mincho', serif",
                      background: C.bg,
                      color: C.muted,
                    }}
                  >
                    ${x.d.name.slice(0, 1)}
                  </div>
                </div>

                <div style=${{ height: 6, background: C.lineSoft, borderRadius: 99, overflow: "hidden" }}>
                  <div style=${{ height: "100%", width: x.barWidth, background: x.color, borderRadius: 99, transition: "width .4s ease" }}></div>
                </div>

                <div style=${{ display: "flex", gap: 14, fontSize: 12, color: C.muted }}>
                  <span>復習 <strong style=${{ fontSize: 14, color: C.red }}>${x.dueCount}</strong></span>
                  <span>新規 <strong style=${{ fontSize: 14, color: C.green }}>${x.newCount}</strong></span>
                  <span style=${{ marginLeft: "auto", color: C.ghost }}>${x.cs.length} 枚</span>
                </div>

                <div style=${{ display: "flex", gap: 8, marginTop: 2 }}>
                  <button
                    disabled=${x.empty}
                    onClick=${() => this.startStudy(x.d.id)}
                    style=${{
                      flex: 1,
                      border: "none",
                      borderRadius: 10,
                      padding: "11px 14px",
                      fontSize: 13,
                      fontWeight: 700,
                      background: x.empty ? C.lineSoft : C.ink,
                      color: x.empty ? C.ghost : C.bg,
                      cursor: x.empty ? "default" : "pointer",
                    }}
                  >
                    ${x.empty ? "完了 ✓" : "学習する（" + (x.dueCount + x.newCount) + "）"}
                  </button>
                  <button
                    class="soft"
                    onClick=${() => this.setState({ screen: "deck", deckId: x.d.id, confirmingDelete: false, renamingDeck: false, editId: null })}
                    style=${{
                      background: C.bg,
                      border: "1px solid " + C.line,
                      color: C.inkSoft,
                      borderRadius: 10,
                      padding: "11px 14px",
                      fontSize: 13,
                    }}
                  >
                    カード
                  </button>
                </div>
              </div>
            `
          )}
        </div>
      </main>
    `;
  }

  createDeck() {
    const name = (this.state.newDeckName || "").trim();
    if (!name) {
      this.toast("デッキ名を入力してください");
      return;
    }
    const decks = this.state.decks.concat([{ id: uid("d"), name, sub: "自作デッキ" }]);
    this.setState({ decks, newDeckName: "", newDeckOpen: false });
    this.persist({ decks });
    this.toast("デッキを作成しました");
  }

  // hint は「補足」（単語なら例文、用語なら説明文）。答えを見たあとに一緒に表示します。
  newCard(deckId, front, back, hint) {
    return {
      id: uid("c"),
      deckId,
      front,
      back,
      hint: (hint || "").trim(),
      ease: 2.5,
      interval: 0,
      reps: 0,
      state: "new",
      due: Date.now(),
    };
  }

  quickAdd() {
    const s = this.state;
    const f = (s.qFront || "").trim();
    const b = (s.qBack || "").trim();
    const did = s.quickDeck || (s.decks[0] && s.decks[0].id);
    if (!did) {
      this.toast("先にデッキを作成してください");
      return;
    }
    if (!f || !b) {
      this.toast("表と裏の両方を入力してください");
      return;
    }
    const cards = s.cards.concat([this.newCard(did, f, b)]);
    this.setState({ cards, qFront: "", qBack: "" });
    this.persist({ cards });
    const dn = s.decks.find((d) => d.id === did);
    this.toast("「" + (dn ? dn.name : "") + "」に追加しました");
  }

  // ---- 一括取り込み ----

  openImport(deckId, from) {
    const s = this.state;
    const did = deckId || s.impDeck || (s.decks[0] && s.decks[0].id) || "__new";
    this.setState({ screen: "import", impFrom: from || "home", impDeck: did, lastImport: null });
  }

  // 貼り付けテキストを解析して、取り込む行・重複・エラーを数える。描画のたびに呼びます。
  importPreview() {
    const s = this.state;
    const parsed = parseBulk(s.impText, s.impDelim);
    const existing = new Set(s.cards.filter((c) => c.deckId === s.impDeck).map((c) => c.front.trim()));
    const seen = new Set();
    const keep = [];
    let dup = 0;
    parsed.rows.forEach((r) => {
      if (existing.has(r.front) || seen.has(r.front)) {
        dup++;
        if (s.impSkipDup) return;
      }
      seen.add(r.front);
      keep.push(r);
    });
    return { delim: parsed.delim, rows: parsed.rows, errors: parsed.errors, keep, dup };
  }

  importFile(e) {
    const f = e.target.files && e.target.files[0];
    if (!f) return;
    const r = new FileReader();
    r.onload = () => this.setState({ impText: String(r.result || "") });
    r.onerror = () => this.toast("ファイルを読み込めませんでした");
    r.readAsText(f);
    e.target.value = "";
  }

  runImport() {
    const s = this.state;
    const p = this.importPreview();
    let decks = s.decks;
    let deckId = s.impDeck;
    let deckName = "";
    let deckCreated = false;

    if (deckId === "__new") {
      deckName = (s.impNewDeckName || "").trim();
      if (!deckName) {
        this.toast("デッキ名を入力してください");
        return;
      }
      deckId = uid("d");
      deckCreated = true;
    } else {
      const d = s.decks.find((x) => x.id === deckId);
      if (!d) {
        this.toast("取り込み先のデッキを選んでください");
        return;
      }
      deckName = d.name;
    }
    if (!p.keep.length) {
      this.toast("取り込めるカードがありません");
      return;
    }
    if (deckCreated) decks = decks.concat([{ id: deckId, name: deckName, sub: "取り込んだデッキ" }]);

    const added = p.keep.slice(0, IMPORT_MAX).map((r) => this.newCard(deckId, r.front, r.back, r.hint));
    const cards = s.cards.concat(added);
    const next = {
      decks,
      cards,
      impText: "",
      impNewDeckName: "",
      impDeck: deckId,
      lastImport: { ids: added.map((c) => c.id), deckId, deckName, deckCreated },
    };
    this.setState(next);
    this.persist(next);
    this.toast(added.length + "枚を取り込みました");
  }

  undoImport() {
    const s = this.state;
    const li = s.lastImport;
    if (!li) return;
    const ids = new Set(li.ids);
    const cards = s.cards.filter((c) => !ids.has(c.id));
    const decks = li.deckCreated ? s.decks.filter((d) => d.id !== li.deckId) : s.decks;
    const next = { decks, cards, lastImport: null };
    if (li.deckCreated) {
      next.impDeck = (decks[0] && decks[0].id) || "__new";
      if (s.deckId === li.deckId) next.deckId = null;
    }
    this.setState(next);
    this.persist(next);
    this.toast("取り込みを取り消しました");
  }

  renderStudy() {
    const s = this.state;
    const n = s.narrow;
    const card = s.cards.find((c) => c.id === s.queue[0]);
    const deck = s.decks.find((d) => d.id === s.deckId);
    const done = s.history.length;
    const pct = Math.round((done / Math.max(done + s.queue.length, 1)) * 100);
    const stateLabels = { new: "新しいカード", learning: "学習中", review: "復習" };

    const grades = [
      ["again", "もう一度", "1", "#FBEDE9", "#EFCFC5", C.red, "#A87A6C", "#C4A79C"],
      ["hard", "むずかしい", "2", "#FBF4E7", "#EBDCBE", "#96702A", "#A08A5E", "#C0AE87"],
      ["good", "できた", "3", "#ECF3EF", "#C9DDD3", "#2F6B59", "#6A8B7F", "#9BB4AA"],
      ["easy", "かんたん", "4", "#ECEFF7", "#CBD3E6", "#3B4C86", "#6F7CA3", "#A3ACC6"],
    ];

    return html`
      <main style=${{ maxWidth: 760, margin: "0 auto" }}>
        <div style=${{ display: "flex", alignItems: "center", gap: 14, marginBottom: 18 }}>
          <button
            style=${{ background: "none", border: "none", color: C.faint, fontSize: 13, padding: "6px 0" }}
            onClick=${() => this.setState({ screen: "home", showAnswer: false })}
          >
            ← 中断する
          </button>
          <div style=${{ flex: 1, height: 8, background: "#E7E0D2", borderRadius: 99, overflow: "hidden" }}>
            <div style=${{ height: "100%", width: pct + "%", background: C.accent, borderRadius: 99, transition: "width .3s ease" }}></div>
          </div>
          <div style=${{ fontSize: 13, color: C.muted, fontVariantNumeric: "tabular-nums" }}>残り ${s.queue.length} 枚</div>
        </div>

        <div
          key=${s.queue[0] || "none"}
          style=${{
            background: C.surface,
            border: "1px solid " + C.line,
            borderRadius: 24,
            boxShadow: "0 14px 40px rgba(28,34,48,.07)",
            overflow: "hidden",
            animation: "kk-pop .22s ease both",
          }}
        >
          <div
            style=${{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 22px",
              borderBottom: "1px solid " + C.lineSoft,
              fontSize: 12,
              color: C.faint,
            }}
          >
            <span>${deck ? deck.name : "すべてのデッキ"}</span>
            <span style=${{ background: C.bg, borderRadius: 99, padding: "4px 12px", color: C.muted }}>
              ${card ? stateLabels[card.state] || "復習" : ""}
            </span>
          </div>

          <div
            style=${{
              minHeight: n ? 160 : 210,
              display: "grid",
              placeItems: "center",
              padding: n ? "30px 20px" : "46px 32px",
              textAlign: "center",
            }}
          >
            <div>
              <div style=${{ fontSize: n ? 24 : 32, fontWeight: 700, lineHeight: 1.45, textWrap: "pretty" }}>
                ${card ? card.front : ""}
              </div>
              ${card &&
              this.state.canSpeak &&
              html`<div style=${{ marginTop: 14 }}>${this.speakButton(card.front)}</div>`}
              ${s.showAnswer &&
              html`<div
                style=${{
                  marginTop: 26,
                  paddingTop: 26,
                  borderTop: "1px dashed #DDD5C4",
                  animation: "kk-rise .2s ease both",
                }}
              >
                <div style=${{ fontSize: n ? 19 : 24, lineHeight: 1.6, color: "#2E3648", textWrap: "pretty" }}>
                  ${card ? card.back : ""}
                </div>
                ${card &&
                this.state.canSpeak &&
                html`<div style=${{ marginTop: 12 }}>${this.speakButton(card.back)}</div>`}
                ${card &&
                card.hint &&
                html`<div
                  style=${{
                    marginTop: 18,
                    padding: n ? "12px 14px" : "14px 18px",
                    background: C.bg,
                    borderRadius: 12,
                    fontSize: n ? 14 : 15,
                    lineHeight: 1.8,
                    color: C.muted,
                    textAlign: "left",
                    whiteSpace: "pre-wrap",
                    textWrap: "pretty",
                  }}
                >
                  <div>${card.hint}</div>
                  ${this.state.canSpeak &&
                  html`<div style=${{ marginTop: 10 }}>${this.speakButton(card.hint)}</div>`}
                </div>`}
              </div>`}
            </div>
          </div>

          ${!s.showAnswer &&
          html`<div
            style=${{
              padding: "20px 22px 26px",
              borderTop: "1px solid " + C.lineSoft,
              display: "grid",
              gap: 10,
              justifyItems: "center",
            }}
          >
            <button
              class="dark"
              style=${{
                width: "100%",
                background: C.ink,
                color: C.bg,
                border: "none",
                borderRadius: 14,
                padding: 18,
                fontSize: 16,
                fontWeight: 700,
              }}
              onClick=${() => this.flip()}
            >
              答えを見る
            </button>
            <div style=${{ fontSize: 12, color: C.ghost }}>スペースキーでもめくれます</div>
          </div>`}

          ${s.showAnswer &&
          html`<div style=${{ padding: "18px 22px 24px", borderTop: "1px solid " + C.lineSoft }}>
            <div style=${{ fontSize: 12, color: C.faint, textAlign: "center", marginBottom: 12 }}>
              どのくらい思い出せましたか？
            </div>
            <div style=${{ display: "grid", gridTemplateColumns: n ? "1fr 1fr" : "repeat(4, 1fr)", gap: 10 }}>
              ${grades.map(
                (g) => html`
                  <button
                    key=${g[0]}
                    class="grade"
                    onClick=${() => this.rate(g[0])}
                    style=${{
                      background: g[3],
                      border: "1px solid " + g[4],
                      borderRadius: 14,
                      padding: "14px 8px",
                      display: "grid",
                      gap: 3,
                      justifyItems: "center",
                    }}
                  >
                    <span style=${{ fontSize: 15, fontWeight: 700, color: g[5] }}>${g[1]}</span>
                    <span style=${{ fontSize: 11, color: g[6] }}>${this.intervalLabel(card, g[0])}</span>
                    <span style=${{ fontSize: 10, color: g[7] }}>${g[2]}</span>
                  </button>
                `
              )}
            </div>
          </div>`}
        </div>

        <div style=${{ display: "flex", justifyContent: "center", gap: 18, marginTop: 18, fontSize: 13 }}>
          <button
            disabled=${!s.history.length}
            onClick=${() => this.undo()}
            style=${{
              background: "none",
              border: "none",
              padding: 6,
              color: s.history.length ? C.muted : "#C9C2B4",
              cursor: s.history.length ? "pointer" : "default",
            }}
          >
            ↺ ひとつ戻す
          </button>
          <button style=${{ background: "none", border: "none", color: C.faint, padding: 6 }} onClick=${() => this.bury()}>
            今日はスキップ
          </button>
        </div>
      </main>
    `;
  }

  renderDone() {
    const t = this.state.tally;
    const done = this.state.history.length;
    const cells = [
      [t.again, "もう一度", "#FBEDE9", C.red, "#A87A6C"],
      [t.hard, "むずかしい", "#FBF4E7", "#96702A", "#A08A5E"],
      [t.good, "できた", "#ECF3EF", "#2F6B59", "#6A8B7F"],
      [t.easy, "かんたん", "#ECEFF7", "#3B4C86", "#6F7CA3"],
    ];
    return html`
      <main style=${{ maxWidth: 620, margin: "40px auto 0", textAlign: "center", animation: "kk-pop .3s ease both" }}>
        <div style=${{ background: C.surface, border: "1px solid " + C.line, borderRadius: 24, padding: "46px 34px" }}>
          <div style=${{ fontFamily: "'Zen Old Mincho', serif", fontSize: 46, color: C.green }}>完</div>
          <h2 style=${{ margin: "10px 0 6px", fontSize: 26 }}>今日のぶんは終わりました</h2>
          <p style=${{ margin: "0 0 26px", fontSize: 14, color: C.muted, lineHeight: 1.7 }}>
            ${done} 枚を復習しました。
            ${t.again ? "「もう一度」だったカードは明日また出題されます。" : "順調です。この調子で続けましょう。"}
          </p>
          <div style=${{ display: "grid", gridTemplateColumns: "repeat(4, 1fr)", gap: 10, marginBottom: 28 }}>
            ${cells.map(
              (c) => html`
                <div key=${c[1]} style=${{ background: c[2], borderRadius: 14, padding: "14px 6px" }}>
                  <div style=${{ fontSize: 22, fontWeight: 700, color: c[3] }}>${c[0]}</div>
                  <div style=${{ fontSize: 11, color: c[4] }}>${c[1]}</div>
                </div>
              `
            )}
          </div>
          <button
            class="dark"
            style=${{
              background: C.ink,
              color: C.bg,
              border: "none",
              borderRadius: 14,
              padding: "15px 30px",
              fontSize: 15,
              fontWeight: 700,
            }}
            onClick=${() => this.setState({ screen: "home" })}
          >
            デッキ一覧へ戻る
          </button>
        </div>
      </main>
    `;
  }

  renderDeck(box, field, primary, backLink, h2Style) {
    const s = this.state;
    const n = s.narrow;
    const deck = s.decks.find((d) => d.id === s.deckId);
    const cards = s.cards.filter((c) => c.deckId === s.deckId);

    return html`
      <main style=${{ maxWidth: 900, margin: "0 auto", animation: "kk-rise .3s ease both" }}>
        <button style=${backLink} onClick=${() => this.setState({ screen: "home", confirmingDelete: false, renamingDeck: false, editId: null })}>
          ← デッキ一覧
        </button>
        <div
          style=${{
            display: "flex",
            alignItems: "flex-end",
            justifyContent: "space-between",
            gap: 20,
            flexWrap: "wrap",
            marginBottom: 22,
          }}
        >
          <div style=${{ minWidth: 0, flex: "1 1 260px" }}>
            ${s.renamingDeck
              ? html`<div style=${{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
                  <input
                    placeholder="デッキ名"
                    value=${s.renameName}
                    onInput=${(e) => this.setState({ renameName: e.target.value })}
                    onKeyDown=${(e) => {
                      if (e.key === "Enter") this.saveRename();
                      if (e.key === "Escape") this.setState({ renamingDeck: false });
                    }}
                    style=${Object.assign({}, field, {
                      fontSize: 18,
                      fontWeight: 700,
                      flex: n ? "1 1 100%" : "1 1 200px",
                      minWidth: 0,
                    })}
                  />
                  <button style=${Object.assign({}, primary, { flexShrink: 0 })} onClick=${() => this.saveRename()}>
                    保存
                  </button>
                  <button
                    class="soft"
                    style=${{
                      background: C.bg,
                      border: "1px solid " + C.line,
                      color: C.inkSoft,
                      borderRadius: 10,
                      padding: "12px 18px",
                      fontSize: 13,
                      flexShrink: 0,
                    }}
                    onClick=${() => this.setState({ renamingDeck: false })}
                  >
                    キャンセル
                  </button>
                </div>`
              : html`<h2 style=${h2Style}>${deck ? deck.name : ""}</h2>`}
            <div style=${{ fontSize: 13, color: C.faint, marginTop: 4 }}>
              ${cards.length} 枚 ・ ${deck ? deck.sub : ""}
            </div>
          </div>
          <div style=${{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            ${!s.confirmingDelete &&
            !s.renamingDeck &&
            html`<button
              class="ghost"
              style=${{
                background: "none",
                border: "1px solid " + C.line,
                color: C.inkSoft,
                borderRadius: 12,
                padding: "13px 16px",
                fontSize: 13,
              }}
              onClick=${() => this.startRename()}
            >
              名前を変更
            </button>`}
            ${!s.confirmingDelete &&
            html`<button
              class="danger"
              style=${{
                background: "none",
                border: "1px solid " + C.line,
                color: C.faint,
                borderRadius: 12,
                padding: "13px 16px",
                fontSize: 13,
              }}
              onClick=${() => this.setState({ confirmingDelete: true, renamingDeck: false })}
            >
              デッキを削除
            </button>`}
            <button
              style=${{
                background: C.accent,
                color: C.ink,
                border: "none",
                borderRadius: 12,
                padding: "13px 22px",
                fontSize: 14,
                fontWeight: 700,
              }}
              onClick=${() => this.startStudy(s.deckId)}
            >
              このデッキを学習
            </button>
          </div>
        </div>

        ${s.confirmingDelete &&
        html`<div
          style=${{
            background: "#FBEDE9",
            border: "1px solid #EFCFC5",
            borderRadius: 16,
            padding: "16px 18px",
            marginBottom: 18,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
            animation: "kk-rise .2s ease both",
          }}
        >
          <div style=${{ fontSize: 13, color: "#8E3320", lineHeight: 1.6 }}>
            このデッキと <strong>${cards.length}</strong> 枚のカードを削除します。学習履歴も消え、元に戻せません。
          </div>
          <div style=${{ display: "flex", gap: 8 }}>
            <button
              style=${{
                background: C.surface,
                border: "1px solid " + C.line,
                color: C.inkSoft,
                borderRadius: 10,
                padding: "11px 18px",
                fontSize: 13,
              }}
              onClick=${() => this.setState({ confirmingDelete: false })}
            >
              キャンセル
            </button>
            <button
              style=${{
                background: C.red,
                border: "none",
                color: "#FFF6F2",
                borderRadius: 10,
                padding: "11px 18px",
                fontSize: 13,
                fontWeight: 700,
              }}
              onClick=${() => this.deleteDeck()}
            >
              削除する
            </button>
          </div>
        </div>`}

        <div style=${Object.assign({}, box, { padding: 18, marginBottom: 20 })}>
          <div style=${{ display: "flex", alignItems: "center", gap: 10, marginBottom: 12 }}>
            <div style=${{ fontSize: 13, fontWeight: 700 }}>カードを追加</div>
            <button
              class="ghost"
              style=${{
                marginLeft: "auto",
                background: "none",
                border: "1px dashed #C0B8A5",
                color: C.muted,
                borderRadius: 999,
                padding: "6px 14px",
                fontSize: 12,
              }}
              onClick=${() => this.openImport(s.deckId, "deck")}
            >
              一括で取り込む
            </button>
          </div>
          <div style=${{ display: "grid", gridTemplateColumns: n ? "1fr" : "1fr 1fr auto", gap: 10, alignItems: "start" }}>
            <textarea
              rows="2"
              placeholder="表：問題・単語"
              value=${s.formFront}
              onInput=${(e) => this.setState({ formFront: e.target.value })}
              style=${Object.assign({}, field, { resize: "vertical" })}
            ></textarea>
            <textarea
              rows="2"
              placeholder="裏：答え・意味"
              value=${s.formBack}
              onInput=${(e) => this.setState({ formBack: e.target.value })}
              style=${Object.assign({}, field, { resize: "vertical" })}
            ></textarea>
            <button style=${Object.assign({}, primary, { height: "100%" })} onClick=${() => this.addCard()}>追加</button>
          </div>
          ${s.formHintOpen
            ? html`<textarea
                rows="3"
                placeholder="補足：例文・説明（省略可）"
                value=${s.formHint}
                onInput=${(e) => this.setState({ formHint: e.target.value })}
                style=${Object.assign({}, field, { width: "100%", resize: "vertical", marginTop: 10, lineHeight: 1.7 })}
              ></textarea>`
            : html`<button
                class="ghost"
                style=${{
                  marginTop: 10,
                  background: "none",
                  border: "none",
                  color: C.faint,
                  fontSize: 12,
                  padding: "4px 0",
                }}
                onClick=${() => this.setState({ formHintOpen: true })}
              >
                ＋ 補足（例文・説明）を追加
              </button>`}
        </div>

        <div style=${{ display: "grid", gap: 8 }}>
          ${cards.map((c) =>
            c.id === s.editId ? this.renderCardEditor(c, field, primary) : this.renderCardRow(c)
          )}
        </div>
      </main>
    `;
  }

  // デッキ画面のカード1行（通常表示）。行そのものを押すと編集に切り替わります。
  renderCardRow(c) {
    const n = this.state.narrow;
    const at = (col, row) => ({ gridColumn: col, gridRow: row });
    // 縦積みのときは 表 / 裏 / 補足 / 次回 の順。補足が無い行で空の段ができないよう詰めます。
    const dueRow = n ? (c.hint ? "4" : "3") : "1";
    return html`
      <div
        key=${c.id}
        class="soft"
        onClick=${() => this.startEdit(c)}
        style=${{
          background: C.surface,
          border: "1px solid " + C.line,
          borderRadius: 12,
          padding: "14px 16px",
          display: "grid",
          gridTemplateColumns: n ? "1fr 34px" : "1fr 1fr 96px 34px",
          gap: 10,
          alignItems: "center",
          cursor: "pointer",
        }}
      >
        <div style=${Object.assign({ fontSize: 14, fontWeight: 500 }, at("1", "1"))}>${c.front}</div>
        <div style=${Object.assign({ fontSize: n ? 13 : 14, color: C.muted }, n ? at("1 / -1", "2") : at("2", "1"))}>
          ${c.back}
        </div>
        <div
          style=${Object.assign(
            { fontSize: 11, color: C.faint },
            n ? at("1 / -1", dueRow) : Object.assign({ textAlign: "right" }, at("3", "1"))
          )}
        >
          ${this.dueLabel(c)}
        </div>
        <button
          class="danger"
          onClick=${(e) => {
            e.stopPropagation();
            this.deleteCard(c.id);
          }}
          style=${Object.assign(
            {
              background: "none",
              border: "1px solid " + C.line,
              borderRadius: 8,
              color: C.ghost,
              padding: "6px 0",
              fontSize: 13,
            },
            n ? at("2", "1") : at("4", "1")
          )}
        >
          ✕
        </button>
        ${c.hint &&
        html`<div
          style=${Object.assign(
            {
              fontSize: 12,
              color: C.faint,
              lineHeight: 1.7,
              whiteSpace: "pre-wrap",
              display: "-webkit-box",
              WebkitBoxOrient: "vertical",
              WebkitLineClamp: "2",
              overflow: "hidden",
            },
            at("1 / -1", n ? "3" : "2")
          )}
        >
          ${c.hint}
        </div>`}
      </div>
    `;
  }

  // 同じ行を入力欄に差し替えたもの。表・裏・補足をその場で直せます。
  renderCardEditor(c, field, primary) {
    const s = this.state;
    const n = s.narrow;
    const area = Object.assign({}, field, { resize: "vertical", lineHeight: 1.7 });
    return html`
      <div
        key=${c.id}
        style=${{
          background: C.surface,
          border: "1px solid " + C.accentDeep,
          borderRadius: 12,
          padding: 16,
          display: "grid",
          gap: 10,
          animation: "kk-rise .18s ease both",
        }}
      >
        <div style=${{ fontSize: 12, color: C.faint }}>カードを編集</div>
        <div style=${{ display: "grid", gridTemplateColumns: n ? "1fr" : "1fr 1fr", gap: 10 }}>
          <textarea
            rows="2"
            placeholder="表：問題・単語"
            value=${s.editFront}
            onInput=${(e) => this.setState({ editFront: e.target.value })}
            style=${area}
          ></textarea>
          <textarea
            rows="2"
            placeholder="裏：答え・意味"
            value=${s.editBack}
            onInput=${(e) => this.setState({ editBack: e.target.value })}
            style=${area}
          ></textarea>
        </div>
        <textarea
          rows="3"
          placeholder="補足：例文・説明（省略可）"
          value=${s.editHint}
          onInput=${(e) => this.setState({ editHint: e.target.value })}
          style=${area}
        ></textarea>
        <div style=${{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          <button style=${primary} onClick=${() => this.saveEdit()}>保存</button>
          <button
            class="soft"
            style=${{
              background: C.bg,
              border: "1px solid " + C.line,
              color: C.inkSoft,
              borderRadius: 10,
              padding: "12px 18px",
              fontSize: 13,
            }}
            onClick=${() => this.setState({ editId: null })}
          >
            キャンセル
          </button>
          <button
            class="danger"
            style=${{
              marginLeft: "auto",
              background: "none",
              border: "1px solid " + C.line,
              color: C.faint,
              borderRadius: 10,
              padding: "12px 16px",
              fontSize: 13,
            }}
            onClick=${() => this.deleteCard(c.id)}
          >
            削除
          </button>
        </div>
      </div>
    `;
  }

  startEdit(c) {
    this.setState({ editId: c.id, editFront: c.front, editBack: c.back, editHint: c.hint || "" });
  }

  // 編集内容を書き戻します。学習の進み具合（ease / interval / due など）はそのままです。
  saveEdit() {
    const s = this.state;
    const front = (s.editFront || "").trim();
    const back = (s.editBack || "").trim();
    if (!front || !back) {
      this.toast("表と裏の両方を入力してください");
      return;
    }
    const cards = s.cards.map((x) =>
      x.id === s.editId ? Object.assign({}, x, { front, back, hint: (s.editHint || "").trim() }) : x
    );
    this.setState({ cards, editId: null });
    this.persist({ cards });
    this.toast("カードを更新しました");
  }

  addCard() {
    const s = this.state;
    if (!s.formFront.trim() || !s.formBack.trim()) {
      this.toast("表と裏の両方を入力してください");
      return;
    }
    const cards = s.cards.concat([
      this.newCard(s.deckId, s.formFront.trim(), s.formBack.trim(), s.formHint),
    ]);
    this.setState({ cards, formFront: "", formBack: "", formHint: "" });
    this.persist({ cards });
    this.toast("カードを追加しました");
  }

  deleteCard(id) {
    const s = this.state;
    const cards = s.cards.filter((x) => x.id !== id);
    this.setState({ cards, editId: s.editId === id ? null : s.editId });
    this.persist({ cards });
    this.toast("カードを削除しました");
  }

  startRename() {
    const s = this.state;
    const deck = s.decks.find((d) => d.id === s.deckId);
    if (!deck) return;
    this.setState({ renamingDeck: true, renameName: deck.name, confirmingDelete: false });
  }

  // デッキ名だけを書き換えます。カードと学習の進み具合には触れません。
  saveRename() {
    const s = this.state;
    const name = (s.renameName || "").trim();
    if (!name) {
      this.toast("デッキ名を入力してください");
      return;
    }
    const deck = s.decks.find((d) => d.id === s.deckId);
    if (!deck) {
      this.setState({ renamingDeck: false });
      return;
    }
    if (name === deck.name) {
      this.setState({ renamingDeck: false });
      return;
    }
    const decks = s.decks.map((d) => (d.id === s.deckId ? Object.assign({}, d, { name }) : d));
    this.setState({ decks, renamingDeck: false });
    this.persist({ decks });
    this.toast("デッキ名を変更しました");
  }

  deleteDeck() {
    const s = this.state;
    const decks = s.decks.filter((d) => d.id !== s.deckId);
    const cards = s.cards.filter((c) => c.deckId !== s.deckId);
    this.setState({ decks, cards, confirmingDelete: false, renamingDeck: false, screen: "home", deckId: null, editId: null });
    this.persist({ decks, cards });
    this.toast("デッキを削除しました");
  }

  renderImport(box, field, primary, secondary, backLink, h2Style) {
    const s = this.state;
    const n = s.narrow;
    const p = this.importPreview();
    const li = s.lastImport;
    const isNew = s.impDeck === "__new";
    const take = Math.min(p.keep.length, IMPORT_MAX);
    const over = p.keep.length > IMPORT_MAX;

    const label = { fontSize: 12, color: C.faint, marginBottom: 7 };
    const sel = Object.assign({}, field, { width: "100%", color: C.ink, boxSizing: "border-box" });
    const cols = n ? "1fr 1fr" : "1fr 1fr 150px";
    const cell = { fontSize: 13, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" };

    return html`
      <main style=${{ maxWidth: 900, margin: "0 auto", animation: "kk-rise .3s ease both" }}>
        <button
          style=${backLink}
          onClick=${() => this.setState({ screen: s.impFrom === "deck" && s.deckId ? "deck" : "home" })}
        >
          ${s.impFrom === "deck" && s.deckId ? "← デッキ" : "← デッキ一覧"}
        </button>
        <h2 style=${h2Style}>カードを一括取り込み</h2>
        <p style=${{ fontSize: 13, color: C.muted, lineHeight: 1.9, margin: "8px 0 22px" }}>
          1行に1枚。<strong>表</strong> ・ <strong>裏</strong> ・ <strong>補足（省略可）</strong> の順に、カンマかタブで区切って貼り付けてください。
          スプレッドシートからそのままコピーできます。区切り文字を含む文は <code>"…"</code> で囲みます。
        </p>

        ${li &&
        html`<div
          style=${{
            background: C.surface,
            border: "1px solid " + C.line,
            borderLeft: "3px solid " + C.green,
            borderRadius: 14,
            padding: "15px 18px",
            marginBottom: 16,
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            gap: 14,
            flexWrap: "wrap",
            animation: "kk-rise .2s ease both",
          }}
        >
          <div style=${{ fontSize: 13, color: C.inkSoft, lineHeight: 1.6 }}>
            「${li.deckName}」に <strong>${li.ids.length}</strong> 枚を取り込みました。
          </div>
          <div style=${{ display: "flex", gap: 8 }}>
            <button
              class="soft"
              style=${Object.assign({}, secondary, { padding: "10px 16px" })}
              onClick=${() => this.undoImport()}
            >
              取り消す
            </button>
            <button
              style=${Object.assign({}, primary, { padding: "10px 18px" })}
              onClick=${() => this.setState({ screen: "deck", deckId: li.deckId, confirmingDelete: false, renamingDeck: false, editId: null })}
            >
              デッキを見る
            </button>
          </div>
        </div>`}

        <div style=${Object.assign({}, box, { marginBottom: 16 })}>
          <div style=${{ display: "grid", gridTemplateColumns: n ? "1fr" : "1fr 1fr", gap: 16 }}>
            <div>
              <div style=${label}>取り込み先のデッキ</div>
              <select style=${sel} value=${s.impDeck} onChange=${(e) => this.setState({ impDeck: e.target.value })}>
                ${s.decks.map((d) => html`<option key=${d.id} value=${d.id}>${d.name}</option>`)}
                <option value="__new">＋ 新しいデッキを作る</option>
              </select>
              ${isNew &&
              html`<input
                placeholder="デッキ名（例：英検準1級 単語）"
                value=${s.impNewDeckName}
                onInput=${(e) => this.setState({ impNewDeckName: e.target.value })}
                style=${Object.assign({}, sel, { marginTop: 8 })}
              />`}
            </div>
            <div>
              <div style=${label}>区切り文字</div>
              <select style=${sel} value=${s.impDelim} onChange=${(e) => this.setState({ impDelim: e.target.value })}>
                <option value="auto">
                  自動判定${s.impText.trim() ? "（" + delimName(p.delim) + "）" : ""}
                </option>
                <option value=${"\t"}>タブ</option>
                <option value=",">カンマ</option>
                <option value=";">セミコロン</option>
              </select>
            </div>
          </div>

          <textarea
            rows=${n ? 8 : 10}
            placeholder=${"acute,鋭い,an acute pain\ngrasp,理解する"}
            value=${s.impText}
            onInput=${(e) => this.setState({ impText: e.target.value })}
            style=${Object.assign({}, field, {
              width: "100%",
              marginTop: 16,
              resize: "vertical",
              lineHeight: 1.7,
              boxSizing: "border-box",
            })}
          ></textarea>

          <div style=${{ display: "flex", alignItems: "center", gap: 10, marginTop: 12, flexWrap: "wrap" }}>
            <label class="soft" style=${Object.assign({}, secondary, { cursor: "pointer" })}>
              ファイルから読み込む
              <input
                type="file"
                accept=".csv,.tsv,.txt,text/plain,text/csv"
                onChange=${(e) => this.importFile(e)}
                style=${{ display: "none" }}
              />
            </label>
            ${!!s.impText &&
            html`<button class="soft" style=${secondary} onClick=${() => this.setState({ impText: "" })}>クリア</button>`}
            <label style=${{ display: "flex", alignItems: "center", gap: 7, fontSize: 13, color: C.muted, marginLeft: "auto" }}>
              <input
                type="checkbox"
                checked=${s.impSkipDup}
                onChange=${(e) => this.setState({ impSkipDup: e.target.checked })}
              />
              同じ表のカードは取り込まない
            </label>
          </div>
        </div>

        ${!!s.impText.trim() &&
        html`<div style=${Object.assign({}, box, { marginBottom: 16 })}>
          <div style=${{ display: "flex", alignItems: "baseline", gap: 14, flexWrap: "wrap", marginBottom: 14 }}>
            <div style=${{ fontSize: 13, fontWeight: 700 }}>取り込む ${p.keep.length} 枚</div>
            <div style=${{ fontSize: 12, color: C.faint }}>
              重複 ${p.dup} 件 ・ エラー ${p.errors.length} 件
            </div>
          </div>

          ${over &&
          html`<div style=${{ fontSize: 12, color: C.red, lineHeight: 1.7, marginBottom: 12 }}>
            一度に取り込めるのは ${IMPORT_MAX} 枚までです。先頭 ${IMPORT_MAX} 枚だけを取り込みます。
          </div>`}

          ${!!p.keep.length &&
          html`<div style=${{ border: "1px solid " + C.lineSoft, borderRadius: 12, overflow: "hidden" }}>
            <div
              style=${{
                display: "grid",
                gridTemplateColumns: cols,
                gap: 12,
                padding: "9px 14px",
                background: C.field,
                fontSize: 11,
                color: C.faint,
              }}
            >
              <div>表</div>
              <div>裏</div>
              ${!n && html`<div>補足</div>`}
            </div>
            ${p.keep.slice(0, 20).map(
              (r) => html`
                <div
                  key=${r.line}
                  style=${{
                    display: "grid",
                    gridTemplateColumns: cols,
                    gap: 12,
                    padding: "10px 14px",
                    borderTop: "1px solid " + C.lineSoft,
                  }}
                >
                  <div style=${Object.assign({}, cell, { fontWeight: 500 })}>${r.front}</div>
                  <div style=${Object.assign({}, cell, { color: C.muted })}>${r.back}</div>
                  ${!n && html`<div style=${Object.assign({}, cell, { color: C.ghost, fontSize: 12 })}>${r.hint}</div>`}
                </div>
              `
            )}
            ${p.keep.length > 20 &&
            html`<div
              style=${{
                padding: "9px 14px",
                borderTop: "1px solid " + C.lineSoft,
                fontSize: 12,
                color: C.ghost,
              }}
            >
              ほか ${p.keep.length - 20} 枚
            </div>`}
          </div>`}

          ${!!p.errors.length &&
          html`<div style=${{ marginTop: 14 }}>
            <div style=${{ fontSize: 12, color: C.red, marginBottom: 8 }}>
              次の行は取り込めません。区切り文字を確認してください。
            </div>
            <div style=${{ display: "grid", gap: 5 }}>
              ${p.errors.slice(0, 10).map(
                (er) => html`
                  <div key=${er.line} style=${{ fontSize: 12, color: C.faint, lineHeight: 1.6 }}>
                    ${er.line} 行目：${er.reason}
                    <span style=${{ color: C.ghost }}> ${(er.text || "").slice(0, 40)}</span>
                  </div>
                `
              )}
              ${p.errors.length > 10 &&
              html`<div style=${{ fontSize: 12, color: C.ghost }}>ほか ${p.errors.length - 10} 行</div>`}
            </div>
          </div>`}
        </div>`}

        <div style=${{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
          <button
            style=${Object.assign({}, primary, take ? {} : { opacity: 0.4 })}
            disabled=${!take}
            onClick=${() => this.runImport()}
          >
            ${take ? take + "枚を取り込む" : "取り込む"}
          </button>
        </div>
      </main>
    `;
  }

  renderStats(st, box, backLink, h2Style) {
    const stat = (label, value, unit, extra) => html`
      <div style=${Object.assign({}, box, { borderRadius: 16, padding: "18px 20px" })}>
        <div style=${{ fontSize: 11, color: C.faint, letterSpacing: ".1em" }}>${label}</div>
        <div style=${{ fontSize: 30, fontWeight: 700, lineHeight: 1.2 }}>
          ${value}${unit && html`<span style=${{ fontSize: 14, color: C.faint, fontWeight: 400 }}> ${unit}</span>`}
        </div>
        ${extra}
      </div>
    `;

    return html`
      <main style=${{ maxWidth: 900, margin: "0 auto", animation: "kk-rise .3s ease both" }}>
        <button style=${backLink} onClick=${() => this.setState({ screen: "home" })}>← デッキ一覧</button>
        <h2 style=${h2Style}>学習の記録</h2>
        <div style=${{ fontSize: 13, color: C.faint, margin: "4px 0 22px" }}>
          続けた日数と定着の状況をひと目で確認できます。
        </div>

        <div style=${{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(150px, 1fr))", gap: 12, marginBottom: 18 }}>
          ${stat("連続学習", st.streak, "日")}
          ${stat(
            "今週の枚数",
            st.weekTotal,
            "枚",
            html`<div style=${{ fontSize: 11, color: C.ghost, marginTop: 2 }}>1日平均 ${st.weekAvg} 枚</div>`
          )}
          ${stat("30日間", st.monthTotal, "枚")}
          <div style=${Object.assign({}, box, { borderRadius: 16, padding: "18px 20px" })}>
            <div style=${{ fontSize: 11, color: C.faint, letterSpacing: ".1em" }}>正答率</div>
            <div style=${{ fontSize: 30, fontWeight: 700, lineHeight: 1.2, color: "#2F6B59" }}>${st.retention}%</div>
            <div style=${{ height: 5, background: C.lineSoft, borderRadius: 99, overflow: "hidden", marginTop: 8 }}>
              <div style=${{ height: "100%", width: st.retention + "%", background: C.green, borderRadius: 99, transition: "width .4s ease" }}></div>
            </div>
          </div>
        </div>

        <div style=${Object.assign({}, box, { marginBottom: 18 })}>
          <div style=${{ display: "flex", alignItems: "baseline", justifyContent: "space-between", gap: 12, marginBottom: 14 }}>
            <div style=${{ fontSize: 14, fontWeight: 700 }}>この3か月の学習</div>
            <div style=${{ display: "flex", alignItems: "center", gap: 6, fontSize: 11, color: C.ghost }}>
              <span>少</span>
              ${st.heatLegend.map(
                (l) => html`<div key=${l.key} style=${{ width: 11, height: 11, borderRadius: 3, background: l.color }}></div>`
              )}
              <span>多</span>
            </div>
          </div>
          <div
            style=${{
              display: "grid",
              gridTemplateRows: "repeat(7, 14px)",
              gridAutoFlow: "column",
              gridAutoColumns: "14px",
              gap: 4,
              justifyContent: "start",
              overflowX: "auto",
            }}
          >
            ${st.heatCells.map(
              (c) => html`<div
                key=${c.key}
                title=${c.label}
                style=${{
                  width: 14,
                  height: 14,
                  borderRadius: 3,
                  background: c.color,
                  outline: c.today ? "1.5px solid " + C.ink : "none",
                  outlineOffset: 1,
                }}
              ></div>`
            )}
          </div>
        </div>

        <div style=${{ display: "grid", gridTemplateColumns: "repeat(auto-fit, minmax(300px, 1fr))", gap: 18, marginBottom: 18 }}>
          <div style=${box}>
            <div style=${{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>カードの定着状況</div>
            <div style=${{ fontSize: 11, color: C.ghost, marginBottom: 14 }}>全 ${st.maturityTotal} 枚</div>
            <div style=${{ display: "flex", height: 12, borderRadius: 99, overflow: "hidden", background: C.lineSoft, marginBottom: 16 }}>
              ${st.maturity.map(
                (m) => html`<div key=${m.name} style=${{ width: m.width, background: m.color, transition: "width .4s ease" }}></div>`
              )}
            </div>
            <div style=${{ display: "grid", gap: 9 }}>
              ${st.maturity.map(
                (m) => html`
                  <div key=${m.name} style=${{ display: "flex", alignItems: "center", gap: 9, fontSize: 13 }}>
                    <div style=${{ width: 9, height: 9, borderRadius: 99, background: m.color, flexShrink: 0 }}></div>
                    <span style=${{ color: C.inkSoft }}>${m.name}</span>
                    <span style=${{ marginLeft: "auto", fontWeight: 700 }}>${m.count}</span>
                    <span style=${{ color: C.ghost, fontSize: 11, width: 38, textAlign: "right" }}>${m.pct}</span>
                  </div>
                `
              )}
            </div>
          </div>

          <div style=${box}>
            <div style=${{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>これから出題される枚数</div>
            <div style=${{ fontSize: 11, color: C.ghost, marginBottom: 16 }}>今日からの7日間</div>
            <div style=${{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, alignItems: "end", height: 120 }}>
              ${st.forecast.map(
                (f) => html`
                  <div
                    key=${f.key}
                    style=${{
                      display: "flex",
                      flexDirection: "column",
                      justifyContent: "flex-end",
                      alignItems: "center",
                      gap: 6,
                      height: "100%",
                    }}
                  >
                    <div style=${{ fontSize: 11, color: C.muted, fontWeight: 700 }}>${f.n}</div>
                    <div style=${{ width: "100%", height: f.height, background: f.color, borderRadius: "5px 5px 0 0", transition: "height .4s ease" }}></div>
                  </div>
                `
              )}
            </div>
            <div style=${{ display: "grid", gridTemplateColumns: "repeat(7, 1fr)", gap: 8, marginTop: 8 }}>
              ${st.forecast.map(
                (f) => html`<div key=${f.key} style=${{ fontSize: 10, color: C.ghost, textAlign: "center" }}>${f.label}</div>`
              )}
            </div>
          </div>
        </div>

        <div style=${box}>
          <div style=${{ fontSize: 14, fontWeight: 700, marginBottom: 16 }}>デッキ別の定着率</div>
          <div style=${{ display: "grid", gap: 14 }}>
            ${st.deckProgress.map(
              (d) => html`
                <div key=${d.key}>
                  <div style=${{ display: "flex", alignItems: "baseline", gap: 10, fontSize: 13, marginBottom: 6 }}>
                    <span style=${{ fontWeight: 500 }}>${d.name}</span>
                    <span style=${{ marginLeft: "auto", color: C.faint, fontSize: 11 }}>${d.mature} / ${d.total} 枚</span>
                    <span style=${{ fontWeight: 700, width: 44, textAlign: "right" }}>${d.pct}</span>
                  </div>
                  <div style=${{ height: 8, background: C.lineSoft, borderRadius: 99, overflow: "hidden" }}>
                    <div style=${{ height: "100%", width: d.pct, background: d.color, borderRadius: 99, transition: "width .4s ease" }}></div>
                  </div>
                </div>
              `
            )}
          </div>
        </div>
      </main>
    `;
  }

  // 入口。デッキやカードを見る前に、ここでログインします。
  // 保存先（URLとキー）は DEFAULT_SB に持たせているので、ここで聞くのはメールとパスワードだけです。
  renderLogin(box, field, primary, secondary) {
    const s = this.state;
    const up = s.authMode === "up";
    const tab = (on) => ({
      flex: 1,
      background: on ? C.surface : "none",
      border: "1px solid " + (on ? C.line : "transparent"),
      color: on ? C.ink : C.faint,
      borderRadius: 999,
      padding: "9px 0",
      fontSize: 13,
      fontWeight: on ? 700 : 400,
    });
    // 手元に学習データがある人と、いちどローカル専用を選んだ人は、ログインせずに戻れます。
    const canGoBack = !!this._hadSavedData || s.localOnly;
    const submit = () => this.signIn(s.authMode);
    const onEnter = (e) => {
      if (e.key === "Enter") submit();
    };

    return html`
      <main
        style=${{
          maxWidth: 420,
          margin: "0 auto",
          paddingTop: s.narrow ? 48 : 88,
          animation: "kk-rise .3s ease both",
        }}
      >
        <div style=${{ display: "grid", justifyItems: "center", gap: 12, marginBottom: 30 }}>
          <div
            style=${{
              width: 52,
              height: 52,
              borderRadius: 16,
              background: C.ink,
              color: C.bg,
              display: "grid",
              placeItems: "center",
              fontFamily: "'Zen Old Mincho', serif",
              fontSize: 27,
              fontWeight: 700,
            }}
          >
            記
          </div>
          <div style=${{ textAlign: "center" }}>
            <div style=${{ fontSize: 21, fontWeight: 700, letterSpacing: ".04em" }}>キオク</div>
            <div style=${{ fontSize: 11, color: C.faint, letterSpacing: ".14em", marginTop: 3 }}>SPACED REPETITION</div>
          </div>
        </div>

        <div style=${box}>
          <div
            style=${{
              display: "flex",
              gap: 4,
              background: C.field,
              border: "1px solid " + C.lineSoft,
              borderRadius: 999,
              padding: 4,
              marginBottom: 18,
            }}
          >
            <button
              class="ghost"
              style=${tab(!up)}
              onClick=${() => this.setState({ authMode: "in", syncError: null })}
            >
              ログイン
            </button>
            <button
              class="ghost"
              style=${tab(up)}
              onClick=${() => this.setState({ authMode: "up", syncError: null })}
            >
              新規登録
            </button>
          </div>

          <div style=${{ display: "grid", gap: 10 }}>
            <input
              type="email"
              autocomplete="email"
              placeholder="メールアドレス"
              value=${s.syncEmail}
              onInput=${(e) => this.setState({ syncEmail: e.target.value })}
              onKeyDown=${onEnter}
              style=${Object.assign({}, field, { fontSize: 14 })}
            />
            <input
              type="password"
              autocomplete=${up ? "new-password" : "current-password"}
              placeholder="パスワード（6文字以上）"
              value=${s.syncPw}
              onInput=${(e) => this.setState({ syncPw: e.target.value })}
              onKeyDown=${onEnter}
              style=${Object.assign({}, field, { fontSize: 14 })}
            />
            <button
              class="cta"
              disabled=${s.syncBusy}
              style=${Object.assign({}, primary, { width: "100%", marginTop: 4 })}
              onClick=${submit}
            >
              ${s.syncBusy ? "通信中…" : up ? "登録してはじめる" : "ログイン"}
            </button>
          </div>

          <div style=${{ fontSize: 12, color: C.faint, lineHeight: 1.8, marginTop: 14 }}>
            ${up
              ? "登録すると、学習履歴とカードが複数の端末で同じ状態になります。"
              : "はじめての方は「新規登録」を選んでください。"}
          </div>
        </div>

        ${s.syncError &&
        html`<div
          style=${{
            background: "#FBEDE9",
            border: "1px solid #EFCFC5",
            color: "#8E3320",
            borderRadius: 14,
            padding: "14px 16px",
            fontSize: 13,
            lineHeight: 1.6,
            marginTop: 16,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          ${s.syncError}
        </div>`}

        <div style=${{ textAlign: "center", marginTop: 22 }}>
          ${canGoBack
            ? html`<button
                class="ghost"
                style=${{ background: "none", border: "none", color: C.faint, fontSize: 13, padding: "8px 12px" }}
                onClick=${() => this.setState({ screen: "home", syncError: null, syncPw: "" })}
              >
                ← デッキ一覧に戻る
              </button>`
            : html`<button
                  class="ghost"
                  style=${{ background: "none", border: "none", color: C.faint, fontSize: 13, padding: "8px 12px" }}
                  onClick=${() => {
                    localStorage.setItem("kioku.localonly", "1");
                    this.setState({ localOnly: true, screen: "home", syncError: null, syncPw: "" });
                  }}
                >
                  ログインせずにこの端末だけで使う
                </button>
                <div style=${{ fontSize: 11, color: C.ghost, lineHeight: 1.7, marginTop: 4 }}>
                  この端末の中だけに保存されます。あとから「同期」画面でログインできます。
                </div>`}
        </div>

        <div style=${{ textAlign: "center", fontSize: 11, color: C.ghost, marginTop: 26 }}>ビルド ${BUILD}</div>
      </main>
    `;
  }

  renderSync(box, field, primary, secondary, backLink, h2Style) {
    const s = this.state;
    const cfg = this.cfg();
    const own = this.hasOwnCfg(); // 端末で保存先を上書きしているか
    const advOpen = s.syncAdvanced || !cfg; // 保存先が決まっていないときは開いた状態で出す
    const status = s.syncBusy
      ? "同期中…"
      : s.syncAt
      ? "最終同期 " +
        new Date(s.syncAt).toLocaleString("ja-JP", { month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit" })
      : "まだ同期していません";

    return html`
      <main style=${{ maxWidth: 720, margin: "0 auto", animation: "kk-rise .3s ease both" }}>
        <button style=${backLink} onClick=${() => this.setState({ screen: "home" })}>← デッキ一覧</button>
        <div style=${{ display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" }}>
          <h2 style=${h2Style}>同期とバックアップ</h2>
          <span
            style=${{
              display: "inline-flex",
              alignItems: "center",
              gap: 6,
              fontSize: 11,
              borderRadius: 999,
              padding: "5px 12px",
              background: s.syncUser ? "#ECF3EF" : C.bg,
              color: s.syncUser ? "#2F6B59" : C.faint,
            }}
          >
            ${s.syncUser ? "同期オン" : cfg ? "未ログイン" : "この端末のみ"}
          </span>
        </div>
        <div style=${{ fontSize: 13, color: C.faint, margin: "6px 0 22px", lineHeight: 1.7 }}>
          ログインすると、学習履歴とカードが複数の端末で同じ状態になります。ログインしない場合はこの端末の中だけに保存されます。
        </div>

        ${s.syncError &&
        html`<div
          style=${{
            background: "#FBEDE9",
            border: "1px solid #EFCFC5",
            color: "#8E3320",
            borderRadius: 14,
            padding: "14px 16px",
            fontSize: 13,
            lineHeight: 1.6,
            marginBottom: 16,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
          }}
        >
          ${s.syncError}
        </div>`}

        ${!!cfg &&
        html`<button
          class="ghost"
          style=${{
            background: "none",
            border: "none",
            color: C.faint,
            fontSize: 12,
            padding: "6px 0",
            marginBottom: 12,
          }}
          onClick=${() => this.setState({ syncAdvanced: !s.syncAdvanced })}
        >
          ${(s.syncAdvanced ? "▾ " : "▸ ") + "別の保存先を使う（自分の Supabase プロジェクト）"}
        </button>`}

        ${advOpen &&
        html`<div style=${Object.assign({}, box, { marginBottom: 16 })}>
          <div style=${{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>保存先を用意する</div>
          <div style=${{ fontSize: 13, color: C.muted, lineHeight: 1.8, marginBottom: 14 }}>
            <a href="https://supabase.com" target="_blank" rel="noreferrer">Supabase</a>
            で無料プロジェクトを作り、SQL Editor に下のSQLを貼って実行します。次に Project Settings → API から
            <strong>Project URL</strong> と <strong>Publishable key</strong>（sb_publishable_… / 旧 anon key）をコピーしてください。Secret
            key は使いません。
          </div>
          <div
            style=${{
              background: C.ink,
              color: "#D6DCE8",
              borderRadius: 12,
              padding: 16,
              fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
              fontSize: 11.5,
              lineHeight: 1.75,
              whiteSpace: "pre-wrap",
              overflowX: "auto",
            }}
          >
            ${SQL_SETUP}
          </div>
          <button
            class="soft"
            style=${{
              marginTop: 10,
              background: C.bg,
              border: "1px solid " + C.line,
              color: C.inkSoft,
              borderRadius: 10,
              padding: "9px 16px",
              fontSize: 12,
            }}
            onClick=${() => {
              if (navigator.clipboard)
                navigator.clipboard.writeText(SQL_SETUP).then(() => this.toast("SQLをコピーしました"), () => {});
            }}
          >
            SQLをコピー
          </button>
        </div>`}

        ${advOpen &&
        html`<div style=${Object.assign({}, box, { marginBottom: 16 })}>
          <div style=${{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>接続情報</div>
          <div style=${{ display: "grid", gap: 10 }}>
            <input
              placeholder="https://xxxxx.supabase.co"
              value=${s.sbUrl}
              onInput=${(e) => this.setState({ sbUrl: e.target.value })}
              style=${Object.assign({}, field, { fontSize: 13 })}
            />
            <input
              placeholder="publishable key（sb_publishable_... / 旧 anon key）"
              value=${s.sbKey}
              onInput=${(e) => this.setState({ sbKey: e.target.value })}
              style=${Object.assign({}, field, { fontSize: 13 })}
            />
            <div style=${{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button style=${primary} onClick=${() => this.saveCfg()}>保存して接続</button>
              ${own &&
              html`<button class="danger" style=${Object.assign({}, secondary, { background: "none", color: C.faint })} onClick=${() => this.clearCfg()}>
                ${DEFAULT_SB.url && DEFAULT_SB.key ? "既定の保存先に戻す" : "接続を解除"}
              </button>`}
            </div>
          </div>
        </div>`}

        ${cfg &&
        html`<div style=${Object.assign({}, box, { marginBottom: 16 })}>
          <div style=${{ fontSize: 14, fontWeight: 700, marginBottom: 12 }}>アカウント</div>
          ${!s.syncUser
            ? html`<div style=${{ display: "grid", gap: 10 }}>
                <input
                  type="email"
                  placeholder="メールアドレス"
                  value=${s.syncEmail}
                  onInput=${(e) => this.setState({ syncEmail: e.target.value })}
                  style=${Object.assign({}, field, { fontSize: 13 })}
                />
                <input
                  type="password"
                  placeholder="パスワード（6文字以上）"
                  value=${s.syncPw}
                  onInput=${(e) => this.setState({ syncPw: e.target.value })}
                  style=${Object.assign({}, field, { fontSize: 13 })}
                />
                <div style=${{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button disabled=${s.syncBusy} style=${primary} onClick=${() => this.signIn("in")}>ログイン</button>
                  <button class="soft" disabled=${s.syncBusy} style=${secondary} onClick=${() => this.signIn("up")}>
                    新規登録
                  </button>
                </div>
                ${s.syncBusy && html`<div style=${{ fontSize: 12, color: C.faint }}>通信中…</div>`}
              </div>`
            : html`<div style=${{ display: "grid", gap: 14 }}>
                <div style=${{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12, flexWrap: "wrap" }}>
                  <div>
                    <div style=${{ fontSize: 14, fontWeight: 500 }}>${s.syncUser}</div>
                    <div style=${{ fontSize: 12, color: C.faint, marginTop: 2 }}>${status}</div>
                  </div>
                  <button
                    class="ghost"
                    style=${{
                      background: "none",
                      border: "1px solid " + C.line,
                      color: C.faint,
                      borderRadius: 10,
                      padding: "10px 16px",
                      fontSize: 12,
                    }}
                    onClick=${() => this.signOut()}
                  >
                    ログアウト
                  </button>
                </div>
                <div style=${{ fontSize: 12, color: C.muted, lineHeight: 1.7, background: C.field, borderRadius: 12, padding: "12px 14px" }}>
                  学習するたび自動でアップロードされます。別の端末では、同じアカウントでログインすれば最新の状態が取り込まれます。
                </div>
                <div style=${{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button style=${primary} onClick=${() => this.pull(false)}>今すぐ同期</button>
                  <button class="soft" style=${secondary} onClick=${() => this.push()}>この端末の内容で上書き</button>
                </div>
              </div>`}
        </div>`}

        <div style=${box}>
          <div style=${{ fontSize: 14, fontWeight: 700, marginBottom: 6 }}>ファイルでバックアップ</div>
          <div style=${{ fontSize: 13, color: C.muted, lineHeight: 1.7, marginBottom: 14 }}>
            同期を使わない場合の保険。JSONファイルに書き出し、別の端末で読み込めば移行できます。
          </div>
          <div style=${{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <button class="soft" style=${secondary} onClick=${() => this.exportJson()}>書き出す</button>
            <label class="soft" style=${Object.assign({}, secondary, { cursor: "pointer" })}>
              読み込む
              <input type="file" accept="application/json" onChange=${(e) => this.importJson(e)} style=${{ display: "none" }} />
            </label>
          </div>
        </div>

        <div
          style=${{
            display: "flex",
            alignItems: "center",
            gap: 12,
            flexWrap: "wrap",
            marginTop: 22,
            paddingTop: 18,
            borderTop: "1px solid " + C.lineSoft,
          }}
        >
          <div style=${{ fontSize: 12, color: C.ghost }}>ビルド ${BUILD}</div>
          <button
            class="soft"
            style=${Object.assign({}, secondary, { marginLeft: "auto", padding: "10px 16px", fontSize: 12 })}
            disabled=${s.syncBusy}
            onClick=${() => this.diagnose()}
          >
            接続を診断
          </button>
          <button
            class="soft"
            style=${Object.assign({}, secondary, { padding: "10px 16px", fontSize: 12 })}
            onClick=${() => this.hardReload()}
          >
            アプリを最新にする
          </button>
        </div>
      </main>
    `;
  }
}

render(html`<${App} />`, document.getElementById("app"));
