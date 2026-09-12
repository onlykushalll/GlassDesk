import { NextRequest, NextResponse } from "next/server";

// ============================================================
// GlassDesk — geocoding proxy. POST /api/vpc/geocode { q }
//   → OpenStreetMap Nominatim search (top 6 hits).
// Server-side proxy because Nominatim blocks CORS from
// browsers and requires a polite User-Agent; results are
// cached in-memory for 10 minutes per normalized query.
// ============================================================

type Hit = { name: string; lat: number; lon: number; kind: string };

const cache = new Map<string, { at: number; hits: Hit[] }>();
const TTL = 10 * 60 * 1000;

export async function POST(req: NextRequest) {
  try {
    const { q } = await req.json();
    if (typeof q !== "string" || q.trim().length < 2) return NextResponse.json({ hits: [] });
    const key = q.trim().toLowerCase();
    const c = cache.get(key);
    if (c && Date.now() - c.at < TTL) return NextResponse.json({ hits: c.hits });
    const url = `https://nominatim.openstreetmap.org/search?format=json&limit=6&q=${encodeURIComponent(q)}`;
    const r = await fetch(url, { headers: { "User-Agent": "GlassDesk/1.0 (shared web OS demo)", "Accept-Language": "en" } });
    if (!r.ok) return NextResponse.json({ error: "upstream " + r.status }, { status: 502 });
    const raw = (await r.json()) as { display_name: string; lat: string; lon: string; type: string }[];
    const hits: Hit[] = raw.map((h) => ({ name: h.display_name, lat: Number(h.lat), lon: Number(h.lon), kind: h.type }));
    cache.set(key, { at: Date.now(), hits });
    return NextResponse.json({ hits });
  } catch (e) {
    return NextResponse.json({ error: String((e as Error).message ?? e) }, { status: 500 });
  }
}
