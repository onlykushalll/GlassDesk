import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

// ============================================================
// GlassDesk — speech-to-text backend for Voice Memos.
// POST /api/vpc/asr  { audio: <base64 audio blob> } → { text }
// The client converts the MediaRecorder blob to chunk-safe
// base64 (0x8000-byte btoa slices) and posts it here; the
// server-only SDK does the transcription. 15 MB hard cap.
// ============================================================

export async function POST(req: NextRequest) {
  try {
    const { audio } = await req.json();
    if (typeof audio !== "string" || !audio) {
      return NextResponse.json({ error: "audio required" }, { status: 400 });
    }
    if (audio.length > 15 * 1024 * 1024) {
      return NextResponse.json({ error: "too large" }, { status: 413 });
    }
    const zai = await ZAI.create();
    const res = await zai.audio.asr.create({ file_base64: audio });
    return NextResponse.json({ text: res.text ?? "" });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
