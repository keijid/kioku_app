// キオク：外部からカードを追加する API（Supabase Edge Function）
//
// 呼び方：
//   POST https://<project>.supabase.co/functions/v1/add-card
//   Authorization: Bearer kioku_xxxxxxxx   （アプリの同期画面で発行した個人用トークン）
//   Content-Type: application/json
//
//   1枚： { "deck": "英単語", "front": "apple", "back": "りんご", "hint": "I ate an apple." }
//   複数：{ "deck": "英単語", "cards": [ { "front": "...", "back": "...", "hint": "..." }, ... ] }
//
//   deck の代わりに deckId（アプリ内のデッキID）でも指定できます。
//   同じ名前のデッキが無ければ作ります（"createDeck": false で作らずにエラーにします）。
//   同じデッキに表が同じカードがあれば飛ばします（アプリの一括取り込みと同じ判定）。
//
// デプロイ：
//   supabase functions deploy add-card --no-verify-jwt
//   （個人用トークンは Supabase の JWT ではないので、ゲートウェイでの JWT 検証を外します。
//    検証はこの関数の中で、トークンのハッシュを kioku_api_tokens と照らし合わせて行います）
//
// 書き込む行の形はアプリの cardRow() / deckRow()（app.js）と必ず揃えてください。
// 形がずれると、端末が毎回「変わった」と判定して送り返しが止まりません。
// 依存パッケージは使わず、PostgREST を fetch で直接呼んでいます。

const SB_URL = Deno.env.get("SUPABASE_URL") ?? "";
// 書き込みは関数の中だけで使う service role key で行います。ブラウザには一切出しません。
const SB_KEY = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";

const MAX_CARDS = 500;
const MAX_TEXT = 5000;
const DAY = 86400000;

const CORS = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-kioku-token, content-type, apikey, x-client-info",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

function reply(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...CORS, "Content-Type": "application/json; charset=utf-8" },
  });
}

async function sha256(text: string): Promise<string> {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));
  return Array.from(new Uint8Array(buf))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

async function rest(path: string, init: RequestInit = {}): Promise<any> {
  const res = await fetch(SB_URL + "/rest/v1/" + path, {
    ...init,
    headers: {
      apikey: SB_KEY,
      Authorization: "Bearer " + SB_KEY,
      "Content-Type": "application/json",
      ...(init.headers || {}),
    },
  });
  const text = await res.text();
  if (!res.ok) throw new Error("データベースエラー（" + res.status + "）：" + text.slice(0, 300));
  return text ? JSON.parse(text) : null;
}

// アプリの uid() と同じ形（接頭辞＋時刻）。同じミリ秒に作っても衝突しないよう乱数を足します。
function newId(prefix: string): string {
  const r = crypto.getRandomValues(new Uint32Array(1))[0].toString(36);
  return prefix + Date.now().toString(36) + "x" + r;
}

// トークンを発行した端末の「今日の0時」。アプリの startOfDay() に合わせておくと、
// 取り込んだ端末が alignDues() で due を書き換えて送り返す、という往復が起きません。
// tzOffset は Date#getTimezoneOffset() の値（日本なら -540）。
function todayStart(tzOffset: number): number {
  const off = tzOffset * 60000;
  return Math.floor((Date.now() - off) / DAY) * DAY + off;
}

function text(v: unknown): string {
  return typeof v === "string" ? v.trim().slice(0, MAX_TEXT) : "";
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "POST") return reply(405, { error: "POST で呼んでください" });
  if (!SB_URL || !SB_KEY) return reply(500, { error: "関数の環境変数（SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY）がありません" });

  try {
    // ---- 認証：個人用トークン
    const auth = req.headers.get("x-kioku-token") || (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
    const token = auth.trim();
    if (!/^kioku_[A-Za-z0-9_-]{20,}$/.test(token)) {
      return reply(401, { error: "トークンがありません。Authorization: Bearer kioku_… を付けてください" });
    }
    const hash = await sha256(token);
    const found = await rest(
      "kioku_api_tokens?select=user_id,tz_offset&token_hash=eq." + hash + "&limit=1",
    );
    if (!found || !found.length) return reply(401, { error: "トークンが無効です（取り消されたか、打ち間違いです）" });
    const userId: string = found[0].user_id;
    const tzOffset = typeof found[0].tz_offset === "number" ? found[0].tz_offset : -540;
    // 使った記録。失敗しても追加そのものは続けます。
    rest("kioku_api_tokens?token_hash=eq." + hash, {
      method: "PATCH",
      headers: { Prefer: "return=minimal" },
      body: JSON.stringify({ last_used_at: new Date().toISOString() }),
    }).catch(() => {});

    // ---- 入力
    let body: any;
    try {
      body = await req.json();
    } catch {
      return reply(400, { error: "本文が JSON ではありません" });
    }
    if (!body || typeof body !== "object") return reply(400, { error: "本文が空です" });
    const rawCards: any[] = Array.isArray(body.cards) ? body.cards : [body];
    if (!rawCards.length) return reply(400, { error: "cards が空です" });
    if (rawCards.length > MAX_CARDS) return reply(400, { error: "1回に追加できるのは " + MAX_CARDS + " 枚までです" });

    const items = rawCards.map((c) => ({ front: text(c && c.front), back: text(c && c.back), hint: text(c && c.hint) }));
    const bad = items.findIndex((c) => !c.front || !c.back);
    if (bad >= 0) return reply(400, { error: (bad + 1) + " 枚目：front（表）と back（裏）は必須です" });

    // ---- デッキを決める
    const decks: { item_id: string; data: { name?: string } }[] = await rest(
      "kioku_items?select=item_id,data&user_id=eq." + userId + "&kind=eq.deck&deleted_at=is.null&order=updated_at.asc",
    );
    const deckIdIn = text(body.deckId);
    const deckName = text(body.deck);
    let deck: { id: string; name: string; created: boolean } | null = null;
    if (deckIdIn) {
      const d = decks.find((x) => x.item_id === deckIdIn);
      if (!d) return reply(404, { error: "deckId のデッキが見つかりません" });
      deck = { id: d.item_id, name: (d.data && d.data.name) || "", created: false };
    } else if (deckName) {
      const d = decks.find((x) => ((x.data && x.data.name) || "").trim() === deckName);
      if (d) deck = { id: d.item_id, name: deckName, created: false };
      else if (body.createDeck === false) return reply(404, { error: "デッキ「" + deckName + "」が見つかりません" });
      else deck = { id: newId("d"), name: deckName, created: true };
    } else {
      return reply(400, { error: "deck（デッキ名）か deckId を指定してください" });
    }

    // ---- 重複（同じデッキで表が同じ）を飛ばす
    const existing = new Set<string>();
    if (!deck.created) {
      for (let offset = 0; offset < 100000; offset += 1000) {
        const page: { front: string | null }[] = await rest(
          "kioku_items?select=front:data->>front&user_id=eq." + userId +
            "&kind=eq.card&deleted_at=is.null&data->>deckId=eq." + encodeURIComponent(deck.id) +
            "&order=item_id.asc&limit=1000&offset=" + offset,
        );
        page.forEach((r) => existing.add((r.front || "").trim()));
        if (page.length < 1000) break;
      }
    }
    const due = todayStart(tzOffset);
    const rows: any[] = [];
    const skipped: string[] = [];
    items.forEach((c) => {
      if (existing.has(c.front)) {
        skipped.push(c.front);
        return;
      }
      existing.add(c.front);
      rows.push({
        user_id: userId,
        kind: "card",
        item_id: newId("c"),
        deleted_at: null,
        // app.js の cardRow() と同じ形・同じ既定値（newCard() の新規カード）
        data: {
          deckId: deck!.id,
          front: c.front,
          back: c.back,
          hint: c.hint,
          ease: 2.5,
          interval: 0,
          reps: 0,
          state: "new",
          due,
        },
      });
    });

    // ---- 書き込み（デッキが先。カードだけ先に届くと、端末に持ち主のいないカードができます）
    if (deck.created && rows.length) {
      await rest("kioku_items", {
        method: "POST",
        headers: { Prefer: "return=minimal" },
        // app.js の deckRow() と同じ形
        body: JSON.stringify([
          { user_id: userId, kind: "deck", item_id: deck.id, deleted_at: null, data: { name: deck.name, sub: "外部から追加" } },
        ]),
      });
    }
    if (rows.length) {
      await rest("kioku_items", { method: "POST", headers: { Prefer: "return=minimal" }, body: JSON.stringify(rows) });
    }

    return reply(200, {
      added: rows.length,
      skipped,
      deck: { id: deck.id, name: deck.name, created: deck.created && rows.length > 0 },
    });
  } catch (e) {
    const msg = String((e as Error)?.message || e);
    if (/kioku_api_tokens/.test(msg) && /(PGRST205|does not exist|schema cache)/.test(msg)) {
      return reply(500, { error: "kioku_api_tokens テーブルがありません。アプリの同期画面にあるSQLを実行してください" });
    }
    return reply(500, { error: msg });
  }
});
