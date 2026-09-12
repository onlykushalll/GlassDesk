import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

// ============================================================
// GlassDesk — Glass AI backend (server-only: the SDK lives HERE,
// never in the client bundle). POST /api/vpc/ai
//   body: { messages: [{ role: "user" | "assistant", content }] }
//   → { reply: string }
// The client sends the shared thread's last 12 messages; we trim +
// validate server-side anyway, prepend the fixed persona, and return
// one reply. Both seats share the same thread payload, so both see
// this same answer land.
// ============================================================

const PERSONA =
  "You are Glass AI, the warm, witty built-in assistant of GlassDesk — a software-defined PC living in a browser that two people share at the same time (one shared desktop, shared windows, shared files, synced apps). Keep answers concise (under 120 words unless asked for more). Friendly, a little playful, practical. Use plain text with markdown-lite: **bold**, - lists, `code`. When asked what you can do, mention: co-browsing in Nova, Tube watch parties, synced games, Terminal, real weather, and that both seats see this very chat.";

interface InMsg {
  role: "user" | "assistant";
  content: string;
}

const MAX_HISTORY = 12;
const MAX_CHARS = 4000;

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as { messages?: unknown };
    const raw: unknown[] = Array.isArray(body?.messages) ? body.messages : [];

    // validate: keep only well-formed user/assistant turns, cap length
    const messages: InMsg[] = raw
      .filter(
        (m): m is InMsg =>
          !!m &&
          typeof m === "object" &&
          ((m as InMsg).role === "user" || (m as InMsg).role === "assistant") &&
          typeof (m as InMsg).content === "string" &&
          (m as InMsg).content.trim().length > 0,
      )
      .map((m) => ({ role: m.role, content: m.content.slice(0, MAX_CHARS) }))
      .slice(-MAX_HISTORY);

    if (messages.length === 0) {
      return NextResponse.json({ error: "messages_required" }, { status: 400 });
    }

    const zai = await ZAI.create();
    const completion = await zai.chat.completions.create({
      messages: [{ role: "assistant", content: PERSONA }, ...messages],
      thinking: { type: "disabled" },
    });
    const reply = completion.choices[0]?.message?.content;
    if (!reply?.trim()) return NextResponse.json({ error: "empty" }, { status: 502 });
    return NextResponse.json({ reply });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
