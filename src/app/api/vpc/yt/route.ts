import { NextRequest, NextResponse } from "next/server";
import ZAI from "z-ai-web-dev-sdk";

// ============================================================
// GlassDesk — YouTube search backend (server-only SDK).
// GET /api/vpc/yt?q=lofi        → real web search, parsed into
//                                  video cards { id, title, … }
// GET /api/vpc/yt                → curated home/trending picks
// In-memory cache 10 min — both seats usually search the same.
// ============================================================

interface YtVideo {
  id: string;
  title: string;
  snippet: string;
  channel: string;
}

const CACHE_MS = 10 * 60 * 1000;
const cache = new Map<string, { at: number; videos: YtVideo[] }>();

/** Curated, famously-stable video IDs for the Tube home page. */
const HOME: YtVideo[] = [
  { id: "jfKfPfyJRdk", title: "lofi hip hop radio 📚 beats to relax/study to", snippet: "Lofi Girl · 24/7 live stream", channel: "Lofi Girl" },
  { id: "dQw4w9WgXcQ", title: "Rick Astley - Never Gonna Give You Up", snippet: "The official video, obviously", channel: "Rick Astley" },
  { id: "9bZkp7q19f0", title: "PSY - GANGNAM STYLE(강남스타일) M/V", snippet: "A billion-view classic", channel: "officialpsy" },
  { id: "kJQP7kiw5Fk", title: "Luis Fonsi - Despacito ft. Daddy Yankee", snippet: "The most-viewed video on YouTube", channel: "Luis Fonsi" },
  { id: "JGwWNGJdvx8", title: "Ed Sheeran - Shape of You", snippet: "Official single", channel: "Ed Sheeran" },
  { id: "RgKAFK5djSk", title: "Wiz Khalifa - See You Again ft. Charlie Puth", snippet: "Furious 7 soundtrack", channel: "Wiz Khalifa" },
  { id: "OPf0YbXqDm0", title: "Mark Ronson - Uptown Funk ft. Bruno Mars", snippet: "Official video", channel: "Mark Ronson" },
  { id: "fJ9rUzIMcZQ", title: "Queen – Bohemian Rhapsody", snippet: "Official video remastered", channel: "Queen Official" },
  { id: "YE7VzlLtp-4", title: "Big Buck Bunny", snippet: "Open-movie classic, Blender Foundation", channel: "Blender" },
  { id: "1La4QzGeaaQ", title: "Timelapse: The Blue Marble", snippet: "Earth from space, compiled from NASA imagery", channel: "NASA" },
  { id: "hHW1oY26kxQ", title: "Big Data & the Renaissance of Science", snippet: "A short documentary on data-driven discovery", channel: "Athenium" },
  { id: "Zi_XLOBDo_Y", title: "Michael Jackson - Billie Jean", snippet: "The moonwalk, remastered", channel: "Michael Jackson" },
];

/** Pull an 11-char YouTube video id out of any result URL shape. */
function videoIdOf(url: string): string | null {
  try {
    const u = new URL(url);
    const host = u.hostname.replace(/^www\./, "").toLowerCase();
    if (host === "youtu.be") {
      const id = u.pathname.split("/").filter(Boolean)[0] ?? "";
      return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
    }
    if (host.endsWith("youtube.com") || host.endsWith("youtube-nocookie.com")) {
      const v = u.searchParams.get("v");
      if (v && /^[A-Za-z0-9_-]{11}$/.test(v)) return v;
      const parts = u.pathname.split("/").filter(Boolean);
      const seg = parts[0] ?? "";
      if (["shorts", "embed", "live", "v"].includes(seg)) {
        const id = parts[1] ?? "";
        return /^[A-Za-z0-9_-]{11}$/.test(id) ? id : null;
      }
    }
    return null;
  } catch {
    return null;
  }
}

function cleanTitle(raw: string): { title: string; channel: string } {
  let title = raw.trim();
  // " - YouTube" trailer
  title = title.replace(/\s*[-–—|]\s*YouTube\s*$/i, "").trim();
  // "TITLE - CHANNEL" → split on the LAST dash (channels rarely dash)
  const dash = title.lastIndexOf(" - ");
  let channel = "";
  if (dash > 0) {
    channel = title.slice(dash + 3).trim();
    title = title.slice(0, dash).trim();
  }
  return { title, channel };
}

export async function GET(req: NextRequest) {
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (!q) {
    return NextResponse.json({ videos: HOME, cached: false });
  }

  const hit = cache.get(q);
  if (hit && Date.now() - hit.at < CACHE_MS) {
    return NextResponse.json({ videos: hit.videos, cached: true });
  }

  try {
    const zai = await ZAI.create();
    const results = (await zai.functions.invoke("web_search", {
      query: `${q} site:youtube.com watch`,
      num: 14,
    })) as { url: string; name: string; snippet: string; host_name?: string }[];

    const seen = new Set<string>();
    const videos: YtVideo[] = [];
    for (const r of Array.isArray(results) ? results : []) {
      const id = videoIdOf(r.url ?? "");
      if (!id || seen.has(id)) continue;
      seen.add(id);
      const { title, channel } = cleanTitle(r.name ?? "");
      videos.push({
        id,
        title: title || "Untitled",
        snippet: (r.snippet ?? "").slice(0, 160),
        channel: channel || r.host_name || "youtube.com",
      });
      if (videos.length >= 12) break;
    }

    cache.set(q, { at: Date.now(), videos });
    return NextResponse.json({ videos, cached: false });
  } catch (err) {
    console.error("[yt-search] failed:", err);
    return NextResponse.json({ videos: [], error: "search_failed" }, { status: 502 });
  }
}
