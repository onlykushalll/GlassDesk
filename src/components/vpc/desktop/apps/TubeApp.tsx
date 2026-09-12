"use client";

// ============================================================
// GlassDesk — Tube: the shared YouTube client (watch party).
//
// page / q / videoId / results / history ride in win.payload —
// searching or picking a video moves BOTH seats to the same
// screen, and the player is the same embed on both sides.
// The curated home feed is cached module-side (10 min TTL);
// results are synced through the payload so the co-seat lands
// on the same grid without refetching.
// ============================================================

import { useCallback, useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  ArrowLeft,
  Copy,
  Flame,
  History,
  House,
  ListVideo,
  Maximize2,
  Minimize2,
  Play,
  Search,
  SearchX,
  Users,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import type { WindowState } from "@/lib/vpc/types";
import { ytThumb } from "@/lib/vpc/youtube";

// ---------------- payload contract ----------------

interface YtVideo {
  id: string; // 11-char YouTube id
  title: string;
  snippet: string;
  channel: string;
}
interface YtHistoryItem {
  id: string;
  title: string;
  at: number;
}
interface TubePayload {
  page?: "home" | "results" | "watch";
  q?: string;
  videoId?: string | null;
  results?: YtVideo[];
  history?: YtHistoryItem[];
}

const RESULTS_CAP = 12;
const HISTORY_CAP = 24;
const TITLE_CAP = 70;
const HOME_TTL_MS = 10 * 60 * 1000;
const SPRING = { type: "spring", stiffness: 420, damping: 32 } as const;

// module-scope curated-feed cache (identical for both seats)
let homeFeed: YtVideo[] | null = null;
let homeFeedAt = 0;

function readTube(winId: string): TubePayload {
  const st = useGlassDesk.getState().state;
  const w = st?.windows.find((x) => x.id === winId);
  return (w?.payload ?? {}) as TubePayload;
}

const TILE_GRADIENTS = [
  "from-teal-300 to-emerald-400",
  "from-amber-300 to-orange-400",
  "from-rose-300 to-red-400",
  "from-emerald-300 to-teal-500",
];
function tileFor(id: string): string {
  let h = 0;
  for (const c of id) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return TILE_GRADIENTS[h % TILE_GRADIENTS.length];
}

// ============================================================
// main component
// ============================================================

export default function TubeApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const payload = win.payload as Partial<TubePayload>;

  // defensive reads — old windows lack every field
  const page: "home" | "results" | "watch" =
    payload.page === "results" || payload.page === "watch" ? payload.page : "home";
  const q = typeof payload.q === "string" ? payload.q : "";
  const videoId =
    typeof payload.videoId === "string" && /^[a-zA-Z0-9_-]{11}$/.test(payload.videoId) ? payload.videoId : null;
  const results = (Array.isArray(payload.results) ? payload.results : []).slice(0, RESULTS_CAP);
  const history = Array.isArray(payload.history)
    ? payload.history.filter((h): h is YtHistoryItem => !!h && typeof h.id === "string" && typeof h.title === "string")
    : [];

  const [loading, setLoading] = useState(false);
  const [searchError, setSearchError] = useState(false);
  const [theater, setTheater] = useState(false);
  const [draft, setDraft] = useState("");
  const [draftDirty, setDraftDirty] = useState(false);
  const shownQ = draftDirty ? draft : q;

  const patch = useCallback(
    (p: Record<string, unknown>) => dispatch({ t: "app:patch", id: win.id, patch: p }),
    [dispatch, win.id],
  );

  const runSearch = useCallback(
    async (query: string) => {
      const clean = query.trim();
      if (!clean) return;
      setDraftDirty(false);
      setLoading(true);
      setSearchError(false);
      try {
        const res = await fetch(`/api/vpc/yt?q=${encodeURIComponent(clean)}`);
        if (!res.ok) throw new Error("bad status");
        const j = (await res.json()) as { videos?: YtVideo[] };
        const videos = (Array.isArray(j.videos) ? j.videos : []).slice(0, RESULTS_CAP);
        patch({ page: "results", q: clean, results: videos });
      } catch {
        setSearchError(true);
        pushToast({ title: "Search failed", body: "Tube couldn't reach the search service", kind: "danger" });
      } finally {
        setLoading(false);
      }
    },
    [patch],
  );

  const watch = useCallback(
    (id: string) => {
      setTheater(false);
      patch({ page: "watch", videoId: id });
    },
    [patch],
  );

  const goHome = useCallback(() => {
    setTheater(false);
    patch({ page: "home" });
  }, [patch]);

  const copyLink = useCallback(async (id: string) => {
    const url = `https://www.youtube.com/watch?v=${id}`;
    try {
      await navigator.clipboard.writeText(url);
      pushToast({ title: "Link copied", body: url, kind: "success" });
    } catch {
      pushToast({ title: "Copy failed", body: "Clipboard is unavailable here", kind: "warn" });
    }
  }, []);

  const saveToHistory = useCallback(
    (id: string, title: string) => {
      const prev = Array.isArray(readTube(win.id).history)
        ? (readTube(win.id).history as YtHistoryItem[])
        : [];
      patch({
        history: [{ id, title: title.slice(0, TITLE_CAP), at: Date.now() }, ...prev.filter((h) => h.id !== id)].slice(
          0,
          HISTORY_CAP,
        ),
      });
      pushToast({ title: "Saved to watch history", body: title.slice(0, TITLE_CAP), kind: "success" });
    },
    [patch, win.id],
  );

  // curated home feed — fetched once per 10 min, module-cached
  const [homeLoading, setHomeLoading] = useState(homeFeed === null);
  const [homeError, setHomeError] = useState(false);
  useEffect(() => {
    if (page !== "home") return;
    if (homeFeed && Date.now() - homeFeedAt < HOME_TTL_MS) return;
    let alive = true;
    setHomeLoading(true);
    setHomeError(false);
    fetch("/api/vpc/yt")
      .then(async (r) => {
        if (!r.ok) throw new Error("bad status");
        return (await r.json()) as { videos?: YtVideo[] };
      })
      .then((j) => {
        if (!alive) return;
        homeFeed = (Array.isArray(j.videos) ? j.videos : []).slice(0, RESULTS_CAP);
        homeFeedAt = Date.now();
        setHomeLoading(false);
      })
      .catch(() => {
        if (!alive) return;
        setHomeError(true);
        setHomeLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [page, homeLoading]);

  // ---------------- home ----------------
  if (page === "home") {
    return (
      <HomeView
        history={history}
        feed={homeFeed ?? []}
        feedLoading={homeLoading}
        feedError={homeError}
        onWatch={watch}
        onSearch={runSearch}
        onRetry={() => {
          // clear the module cache + flip loading — the feed effect
          // (dep on homeLoading) refetches on its own
          homeFeed = null;
          homeFeedAt = 0;
          setHomeError(false);
          setHomeLoading(true);
        }}
      />
    );
  }

  // ---------------- results / watch ----------------
  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <header className="flex shrink-0 items-center gap-2 border-b border-white/60 bg-white/40 px-3 py-2">
        {page === "watch" && (
          <Button
            variant="ghost"
            size="icon"
            className="h-8 w-8 shrink-0 rounded-lg"
            onClick={() => patch({ page: "results" })}
            aria-label="Back to results"
            title="Back to results"
          >
            <ArrowLeft className="h-4 w-4" />
          </Button>
        )}
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-lg"
          onClick={goHome}
          aria-label="Tube home"
          title="Home"
        >
          <House className="h-4 w-4" />
        </Button>
        <button
          type="button"
          onClick={goHome}
          className="flex shrink-0 items-center gap-1 rounded-lg px-1.5 py-1 text-sm font-extrabold tracking-tight focus-visible:ring-2 focus-visible:ring-rose-300/70"
          aria-label="Tube home"
        >
          <span className="bg-gradient-to-r from-rose-500 to-red-500 bg-clip-text text-transparent">Tube</span>
          <Play className="h-3.5 w-3.5 fill-rose-500 text-rose-500" aria-hidden />
        </button>
        <form
          className="flex min-w-0 flex-1 justify-center"
          onSubmit={(e) => {
            e.preventDefault();
            void runSearch(shownQ);
          }}
        >
          <div className="relative flex w-full max-w-md items-center">
            <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-stone-400" aria-hidden />
            <Input
              value={shownQ}
              onChange={(e) => {
                setDraft(e.target.value);
                setDraftDirty(true);
              }}
              onFocus={(e) => {
                setDraft(q);
                setDraftDirty(true);
                e.target.select();
              }}
              onBlur={() => setDraftDirty(false)}
              placeholder="Search YouTube…"
              aria-label="Search YouTube"
              spellCheck={false}
              className="h-8 rounded-full pl-9 pr-3 text-xs focus-visible:ring-rose-300/60"
            />
          </div>
        </form>
        <span
          className="hidden shrink-0 items-center gap-1 rounded-full bg-white/60 px-2.5 py-1 text-[10px] font-medium text-stone-500 sm:flex"
          title="Searches and playback are synced to both seats"
        >
          <Users className="h-3 w-3 text-emerald-500" aria-hidden /> synced
        </span>
      </header>

      <div className={page === "watch" && theater ? "flex min-h-0 flex-1 flex-col overflow-hidden" : "gd-scroll min-h-0 flex-1 overflow-y-auto"}>
        {page === "results" ? (
          <ResultsView loading={loading} error={searchError} q={q} results={results} onWatch={watch} onRetry={() => void runSearch(q)} />
        ) : (
          <WatchView
            videoId={videoId}
            results={results}
            theater={theater}
            setTheater={setTheater}
            onCopy={copyLink}
            onSave={saveToHistory}
            onWatch={watch}
            onHome={goHome}
          />
        )}
      </div>
    </div>
  );
}

// ============================================================
// views
// ============================================================

function HomeView({
  history,
  feed,
  feedLoading,
  feedError,
  onWatch,
  onSearch,
  onRetry,
}: {
  history: YtHistoryItem[];
  feed: YtVideo[];
  feedLoading: boolean;
  feedError: boolean;
  onWatch: (id: string) => void;
  onSearch: (q: string) => void;
  onRetry: () => void;
}) {
  const [q, setQ] = useState("");
  return (
    <div className="gd-scroll h-full overflow-y-auto">
      <div className="mx-auto max-w-4xl px-4 pb-10 pt-10">
        {/* hero */}
        <motion.div
          initial={{ opacity: 0, y: 16 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          className="flex flex-col items-center gap-3 text-center"
        >
          <h1 className="flex items-center gap-2.5 text-4xl font-extrabold tracking-tight">
            <span className="bg-gradient-to-r from-rose-500 to-red-500 bg-clip-text text-transparent">Tube</span>
            <span
              className="grid h-10 w-10 place-items-center rounded-2xl bg-gradient-to-br from-rose-500 to-red-500 shadow-lg shadow-rose-200"
              aria-hidden
            >
              <Play className="h-5 w-5 fill-white text-white" />
            </span>
          </h1>
          <p className="text-xs text-stone-400">the shared player — search once, watch together on both seats</p>
          <form
            onSubmit={(e) => {
              e.preventDefault();
              onSearch(q);
            }}
            className="glass-strong mt-3 flex w-full max-w-xl items-center gap-2 rounded-full p-1.5 pl-4 shadow-lg"
          >
            <Search className="h-4 w-4 shrink-0 text-stone-400" aria-hidden />
            <Input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder='Search YouTube — try "lofi study beats"'
              aria-label="Search YouTube"
              className="h-8 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
            />
            <Button
              type="submit"
              className="h-8 shrink-0 rounded-full bg-gradient-to-r from-rose-500 to-red-500 px-4 text-xs hover:from-rose-600 hover:to-red-600"
              aria-label="Search"
            >
              <span className="hidden sm:inline">Search</span>
              <Search className="h-3.5 w-3.5 sm:hidden" aria-hidden />
            </Button>
          </form>
        </motion.div>

        {/* recently watched */}
        {history.length > 0 && (
          <section className="mt-9" aria-label="Recently watched">
            <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-stone-600">
              <History className="h-3.5 w-3.5 text-stone-400" aria-hidden /> Recently watched
            </h2>
            <div className="gd-scroll mt-2.5 flex gap-3 overflow-x-auto pb-2">
              {history.map((h) => (
                <button
                  key={`${h.id}-${h.at}`}
                  type="button"
                  onClick={() => onWatch(h.id)}
                  className="group w-44 shrink-0 text-left"
                  aria-label={`Rewatch ${h.title}`}
                >
                  <div className="relative aspect-video overflow-hidden rounded-lg shadow-sm">
                    <Thumb id={h.id} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.04]" />
                    <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
                      <Play className="h-8 w-8 fill-white text-white drop-shadow" aria-hidden />
                    </span>
                  </div>
                  <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-snug text-stone-700">{h.title}</p>
                </button>
              ))}
            </div>
          </section>
        )}

        {/* curated grid */}
        <section className="mt-9" aria-label="Trending now">
          <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-stone-600">
            <Flame className="h-3.5 w-3.5 text-amber-400" aria-hidden /> Trending now
          </h2>
          <div className="mt-3">
            {feedLoading ? (
              <CardSkeletonGrid />
            ) : feedError ? (
              <FeedError onRetry={onRetry} />
            ) : feed.length === 0 ? (
              <EmptyState />
            ) : (
              <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
                {feed.map((v, i) => (
                  <VideoCard key={v.id} v={v} i={i} onWatch={onWatch} />
                ))}
              </div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function ResultsView({
  loading,
  error,
  q,
  results,
  onWatch,
  onRetry,
}: {
  loading: boolean;
  error: boolean;
  q: string;
  results: YtVideo[];
  onWatch: (id: string) => void;
  onRetry: () => void;
}) {
  return (
    <div className="mx-auto max-w-4xl space-y-4 p-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2 px-1">
        <h1 className="text-sm font-semibold text-stone-700">
          Results for <span className="text-rose-600">“{q}”</span>
        </h1>
        <span className="text-[11px] text-stone-400">{results.length} videos · synced with your co-seat</span>
      </div>

      {error ? (
        <FeedError onRetry={onRetry} />
      ) : loading ? (
        <CardSkeletonGrid />
      ) : results.length === 0 ? (
        <EmptyState />
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4"
        >
          {results.map((v, i) => (
            <VideoCard key={v.id} v={v} i={i} onWatch={onWatch} />
          ))}
        </motion.div>
      )}
    </div>
  );
}

function WatchView({
  videoId,
  results,
  theater,
  setTheater,
  onCopy,
  onSave,
  onWatch,
  onHome,
}: {
  videoId: string | null;
  results: YtVideo[];
  theater: boolean;
  setTheater: (v: boolean) => void;
  onCopy: (id: string) => void;
  onSave: (id: string, title: string) => void;
  onWatch: (id: string) => void;
  onHome: () => void;
}) {
  const current = results.find((v) => v.id === videoId);
  const upNext = results.filter((v) => v.id !== videoId);
  const title = current?.title ?? "YouTube video";

  if (!videoId) {
    return (
      <div className="grid h-full place-items-center p-6">
        <div className="glass rounded-2xl p-8 text-center">
          <Play className="mx-auto h-8 w-8 text-stone-300" aria-hidden />
          <h2 className="mt-3 text-sm font-semibold text-stone-700">Nothing playing</h2>
          <p className="mt-1 text-xs text-stone-400">Pick a video — both seats watch the same one.</p>
          <Button variant="outline" size="sm" className="mt-4 rounded-full" onClick={onHome}>
            <House className="h-3.5 w-3.5" /> Back home
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className={theater ? "flex h-full min-h-0 flex-col" : "space-y-4 p-4"}>
      {/* player — springs between aspect-video and full height */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 420, damping: 34 }}
        className={`relative w-full overflow-hidden bg-stone-900 shadow-lg ${
          theater ? "min-h-0 flex-1 rounded-none sm:rounded-xl" : "aspect-video rounded-xl"
        }`}
      >
        <iframe
          key={videoId}
          className="absolute inset-0 h-full w-full"
          src={`https://www.youtube-nocookie.com/embed/${videoId}?autoplay=1&rel=0`}
          title={title}
          allow="autoplay; encrypted-media; picture-in-picture; fullscreen"
          allowFullScreen
        />
      </motion.div>

      {theater ? (
        /* slim theater bar */
        <div className="flex shrink-0 items-center gap-2 border-t border-white/50 bg-white/70 px-3 py-1.5">
          <Button
            variant="ghost"
            size="sm"
            onClick={() => setTheater(false)}
            aria-pressed={false}
            aria-label="Exit theater mode"
            title="Exit theater"
          >
            <Minimize2 className="h-3.5 w-3.5" /> Exit theater
          </Button>
          <p className="min-w-0 flex-1 truncate text-xs text-stone-600">{title}</p>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onCopy(videoId)}
            aria-label="Copy video link"
            title="Copy link"
          >
            <Copy className="h-3.5 w-3.5" />
          </Button>
        </div>
      ) : (
        <motion.div initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={SPRING} className="space-y-4">
          {/* title + actions */}
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="min-w-0 flex-1">
              <h1 className="text-sm font-semibold leading-snug text-stone-800">{title}</h1>
              <p className="mt-0.5 text-xs text-stone-500">{current?.channel ?? "youtube.com"}</p>
            </div>
            <div className="flex shrink-0 flex-wrap items-center gap-2">
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => setTheater(true)}
                aria-pressed={false}
                aria-label="Expand player to theater mode"
                title="Expand player"
              >
                <Maximize2 className="h-3.5 w-3.5" /> Theater
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => onCopy(videoId)}
                aria-label="Copy video link"
                title="Copy link"
              >
                <Copy className="h-3.5 w-3.5" /> Copy link
              </Button>
              <Button
                variant="outline"
                size="sm"
                className="rounded-full"
                onClick={() => onSave(videoId, title)}
                aria-label="Add to watch history"
                title="Add to watch history"
              >
                <ListVideo className="h-3.5 w-3.5" /> Add to history
              </Button>
            </div>
          </div>

          {/* up next */}
          {upNext.length > 0 ? (
            <section aria-label="Up next">
              <h2 className="flex items-center gap-1.5 px-1 text-xs font-semibold text-stone-600">
                <ListVideo className="h-3.5 w-3.5 text-stone-400" aria-hidden /> Up next
              </h2>
              <div className="gd-scroll mt-2.5 flex gap-3 overflow-x-auto pb-2">
                {upNext.map((v) => (
                  <button
                    key={v.id}
                    type="button"
                    onClick={() => onWatch(v.id)}
                    className="group w-44 shrink-0 text-left"
                    aria-label={`Watch ${v.title}`}
                  >
                    <div className="relative aspect-video overflow-hidden rounded-lg shadow-sm">
                      <Thumb id={v.id} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.04]" />
                      <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
                        <Play className="h-8 w-8 fill-white text-white drop-shadow" aria-hidden />
                      </span>
                    </div>
                    <p className="mt-1.5 line-clamp-2 text-[11px] font-medium leading-snug text-stone-700">{v.title}</p>
                    <p className="truncate text-[10px] text-stone-400">{v.channel}</p>
                  </button>
                ))}
              </div>
            </section>
          ) : (
            <p className="px-1 text-[11px] text-stone-400">Nothing queued — search for more to line them up.</p>
          )}
        </motion.div>
      )}
    </div>
  );
}

// ============================================================
// shared bits
// ============================================================

function Thumb({ id, alt, className }: { id: string; alt: string; className?: string }) {
  const [broken, setBroken] = useState(false);
  if (broken) {
    return (
      <div className={`grid place-items-center bg-gradient-to-br ${tileFor(id)} ${className ?? ""}`} aria-hidden>
        <Play className="h-7 w-7 fill-white/70 text-white/70 drop-shadow" />
      </div>
    );
  }
  return (
    <img
      src={ytThumb(id)}
      alt={alt}
      loading="lazy"
      draggable={false}
      onError={() => setBroken(true)}
      className={className}
    />
  );
}

function VideoCard({ v, i, onWatch }: { v: YtVideo; i: number; onWatch: (id: string) => void }) {
  return (
    <motion.button
      type="button"
      layout
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ ...SPRING, delay: Math.min(i * 0.04, 0.4) }}
      whileHover={{ y: -4 }}
      whileTap={{ scale: 0.97 }}
      onClick={() => onWatch(v.id)}
      aria-label={`Watch ${v.title}`}
      className="group text-left focus-visible:ring-2 focus-visible:ring-rose-300/70 focus-visible:ring-offset-2 focus-visible:outline-none"
    >
      <div className="relative aspect-video overflow-hidden rounded-xl shadow-sm">
        <Thumb id={v.id} alt="" className="h-full w-full object-cover transition group-hover:scale-[1.05]" />
        <span className="absolute inset-0 grid place-items-center bg-black/0 opacity-0 transition group-hover:bg-black/30 group-hover:opacity-100">
          <span className="grid h-11 w-11 place-items-center rounded-full bg-rose-500/95 shadow-lg" aria-hidden>
            <Play className="h-5 w-5 fill-white text-white" />
          </span>
        </span>
      </div>
      <h3 className="mt-2 line-clamp-2 text-xs font-medium leading-snug text-stone-700">{v.title}</h3>
      <p className="mt-0.5 truncate text-[11px] text-stone-400">{v.channel}</p>
    </motion.button>
  );
}

function CardSkeletonGrid({ n = 8 }: { n?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4" aria-hidden>
      {Array.from({ length: n }, (_, i) => (
        <div key={i} className="space-y-2">
          <Skeleton className="aspect-video w-full rounded-xl bg-white/70" />
          <Skeleton className="h-3 w-4/5 rounded bg-white/70" />
          <Skeleton className="h-2.5 w-2/5 rounded bg-white/70" />
        </div>
      ))}
    </div>
  );
}

function EmptyState() {
  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={SPRING}
      className="glass rounded-2xl p-10 text-center"
    >
      <SearchX className="mx-auto h-9 w-9 text-stone-300" aria-hidden />
      <h2 className="mt-3 text-sm font-semibold text-stone-700">No videos found</h2>
      <p className="mt-1 text-xs text-stone-400">try another search</p>
    </motion.div>
  );
}

function FeedError({ onRetry }: { onRetry: () => void }) {
  return (
    <div className="flex items-center gap-3 rounded-2xl border border-rose-200 bg-rose-50/80 p-4">
      <SearchX className="h-5 w-5 shrink-0 text-rose-400" aria-hidden />
      <p className="min-w-0 flex-1 text-xs text-rose-700">Tube couldn&apos;t reach the search service.</p>
      <Button variant="outline" size="sm" className="rounded-full border-rose-200 text-rose-600 hover:bg-rose-100" onClick={onRetry}>
        Retry
      </Button>
    </div>
  );
}
