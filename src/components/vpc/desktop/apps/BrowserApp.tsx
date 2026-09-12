"use client";

// ============================================================
// GlassDesk — Nova 2.0, the shared tabbed browser.
//
// tabs / activeTab / bookmarks / history ride in win.payload
// (synced → both seats co-browse the SAME tab). Per-tab back /
// forward stacks are local (each seat's own gesture trail).
//
// nova:// pages: newtab · search (Wikipedia) · history ·
// bookmarks. Only iframe-friendly hosts (Wikipedia, OSM,
// Archive.org, wttr.in, example.com, Wikimedia Commons) get
// real frames — everyone else gets Chrome's honest
// "refused to connect" card. YouTube links hand off to the
// shared Tube app instead of a dead frame.
//
// Frame slots mount per-tab and stay alive (visibility swap,
// never unmount) so tab switches keep page state.
// ============================================================

import { useCallback, useEffect, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Archive,
  BookOpen,
  Bookmark,
  ChevronLeft,
  ChevronRight,
  CloudSun,
  Compass,
  Copy,
  Globe,
  History,
  House,
  Map,
  Play,
  Plus,
  RotateCw,
  Search,
  Star,
  Trash2,
  X,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { uid, type WindowState } from "@/lib/vpc/types";
import { parseYouTubeId } from "@/lib/vpc/youtube";
import { openApp } from "@/components/vpc/desktop/Dock";

// ---------------- payload contract ----------------

interface NovaTab {
  id: string;
  url: string; // full https url or nova://newtab|search|history|bookmarks
  title: string;
}
interface NovaBookmark {
  title: string;
  url: string;
  yt?: boolean;
}
interface NovaHistoryItem {
  title: string;
  url: string;
  at: number;
}
interface NovaPayload {
  tabs?: NovaTab[];
  activeTab?: string;
  bookmarks?: NovaBookmark[];
  history?: NovaHistoryItem[];
}

const TAB_CAP = 6;
const BOOKMARK_CAP = 20;
const HISTORY_CAP = 40;
const TITLE_CAP = 60;
const NEW_TAB = "nova://newtab";
const SEARCH_PREFIX = "nova://search";

const SPRING = { type: "spring", stiffness: 440, damping: 32 } as const;

const SEED_TAB: NovaTab = { id: "nova-tab-1", url: NEW_TAB, title: "New Tab" };

const DEFAULT_BOOKMARKS: NovaBookmark[] = [
  { title: "Wikipedia", url: "https://en.wikipedia.org" },
  { title: "OpenStreetMap", url: "https://www.openstreetmap.org" },
  { title: "Archive.org", url: "https://archive.org" },
  { title: "wttr.in", url: "https://wttr.in" },
  { title: "YouTube", url: "https://youtube.com", yt: true },
];

// ---------------- helpers ----------------

function readNova(winId: string): NovaPayload {
  const st = useGlassDesk.getState().state;
  const w = st?.windows.find((x) => x.id === winId);
  return (w?.payload ?? {}) as NovaPayload;
}

function tabsOf(p: NovaPayload): NovaTab[] {
  if (!Array.isArray(p.tabs)) return [];
  return p.tabs.filter(
    (t): t is NovaTab => !!t && typeof t.id === "string" && typeof t.url === "string" && typeof t.title === "string",
  );
}
function bookmarksOf(p: NovaPayload): NovaBookmark[] {
  if (!Array.isArray(p.bookmarks)) return [];
  return p.bookmarks.filter((b): b is NovaBookmark => !!b && typeof b.title === "string" && typeof b.url === "string");
}
function historyOf(p: NovaPayload): NovaHistoryItem[] {
  if (!Array.isArray(p.history)) return [];
  return p.history.filter(
    (h): h is NovaHistoryItem => !!h && typeof h.title === "string" && typeof h.url === "string" && typeof h.at === "number",
  );
}

function hostOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return "";
  }
}

/** Only these hosts are allowed inside a Nova frame. */
function isEmbeddable(url: string): boolean {
  const h = hostOf(url);
  if (!h) return false;
  if (h === "en.wikipedia.org" || h.endsWith(".wikipedia.org")) return true;
  if (h === "commons.wikimedia.org") return true;
  if (h === "openstreetmap.org" || h.endsWith(".openstreetmap.org")) return true;
  if (h === "archive.org" || h.endsWith(".archive.org")) return true;
  if (h === "wttr.in") return true;
  if (h === "example.com" || h.endsWith(".example.com")) return true;
  return false;
}

/** OSM only allows its /export/embed.html viewer in a frame. */
function embedUrlOf(url: string): string {
  const h = hostOf(url);
  if ((h === "openstreetmap.org" || h.endsWith(".openstreetmap.org")) && !url.includes("/export/embed.html")) {
    return "https://www.openstreetmap.org/export/embed.html?bbox=-180.0%2C-60.0%2C180.0%2C75.0&layer=mapnik";
  }
  return url;
}

function titleFor(url: string): string {
  if (url === NEW_TAB) return "New Tab";
  if (url.startsWith(SEARCH_PREFIX)) return "Nova Search";
  if (url === "nova://history") return "History";
  if (url === "nova://bookmarks") return "Bookmarks";
  const h = hostOf(url);
  if (h) return h.replace(/^www\./, "").slice(0, TITLE_CAP);
  return url.slice(0, TITLE_CAP);
}

function Favicon({ url, className }: { url: string; className?: string }) {
  const cls = className ?? "h-3.5 w-3.5 shrink-0 text-stone-400";
  if (url === NEW_TAB) return <Compass className={cls} aria-hidden />;
  if (url.startsWith(SEARCH_PREFIX)) return <Search className={cls} aria-hidden />;
  if (url === "nova://history") return <History className={cls} aria-hidden />;
  if (url === "nova://bookmarks") return <Star className={cls} aria-hidden />;
  const h = hostOf(url);
  if (h.includes("youtu")) return <Play className={cls} aria-hidden />;
  if (h.endsWith("wikipedia.org") || h.endsWith("wikimedia.org")) return <BookOpen className={cls} aria-hidden />;
  if (h.endsWith("openstreetmap.org")) return <Map className={cls} aria-hidden />;
  if (h.endsWith("archive.org")) return <Archive className={cls} aria-hidden />;
  if (h === "wttr.in") return <CloudSun className={cls} aria-hidden />;
  return <Globe className={cls} aria-hidden />;
}

/** Pastel avatar gradient per bookmark host. */
const SITE_GRADIENTS: [string, RegExp][] = [
  ["from-teal-300 to-emerald-400", /wikipedia\.org|wikimedia\.org$/],
  ["from-emerald-300 to-teal-500", /openstreetmap\.org$/],
  ["from-amber-300 to-orange-400", /archive\.org$/],
  ["from-amber-300 to-rose-400", /wttr\.in$/],
  ["from-rose-400 to-red-500", /youtu/],
];
function gradFor(url: string): string {
  const h = hostOf(url);
  for (const [g, re] of SITE_GRADIENTS) if (re.test(h)) return g;
  return "from-stone-300 to-stone-400";
}

function timeAgo(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 45) return "just now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h} hr ago`;
  const d = Math.floor(h / 24);
  return `${d} d ago`;
}

function isFrameSlot(url: string): boolean {
  return /^https?:\/\//i.test(url) || url.startsWith(SEARCH_PREFIX);
}

async function copyText(text: string): Promise<void> {
  try {
    await navigator.clipboard.writeText(text);
    pushToast({ title: "Link copied", body: text.slice(0, 80), kind: "success" });
  } catch {
    pushToast({ title: "Copy failed", body: "Clipboard is unavailable here", kind: "warn" });
  }
}

// ============================================================
// main component
// ============================================================

export default function BrowserApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const payload = win.payload as Partial<NovaPayload>;

  // defensive reads — old windows lack every field
  const rawTabs = tabsOf(payload);
  const tabs = rawTabs.length > 0 ? rawTabs : [SEED_TAB];
  const bookmarks = bookmarksOf(payload).length > 0 || Array.isArray(payload.bookmarks) ? bookmarksOf(payload) : DEFAULT_BOOKMARKS;
  const history = historyOf(payload);
  const activeId =
    typeof payload.activeTab === "string" && tabs.some((t) => t.id === payload.activeTab)
      ? payload.activeTab
      : tabs[0].id;
  const activeTab = tabs.find((t) => t.id === activeId) ?? tabs[0];
  const activeUrl = activeTab.url;

  // one-time migration of old payloads into the 2.0 shape (mount-once)
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (rawTabs.length === 0) {
      dispatch({
        t: "app:patch",
        id: win.id,
        patch: { tabs: [SEED_TAB], activeTab: SEED_TAB.id, bookmarks: DEFAULT_BOOKMARKS, history: [] },
      });
    }
  }, [dispatch, win.id, rawTabs.length]);

  // per-tab local back/forward trail (never synced)
  const [nav, setNav] = useState<Record<string, { back: string[]; fwd: string[] }>>({});
  const stacks = nav[activeId] ?? { back: [], fwd: [] };

  // address bar draft
  const [draft, setDraft] = useState("");
  const [dirty, setDirty] = useState(false);
  const shownAddr = dirty ? draft : activeUrl === NEW_TAB ? "" : activeUrl;

  // reload nonce per tab (toolbar reload only re-arms the active frame)
  const [tabNonce, setTabNonce] = useState<Record<string, number>>({});
  const activeNonce = tabNonce[activeId] ?? 0;

  // frame-load bookkeeping: a key (tabId|url|nonce) is marked loaded when
  // its iframe fires onLoad — or after a 3s safety valve for stuck frames.
  // `frameLoading` is DERIVED from the map, never set from an effect body.
  const [loadedKeys, setLoadedKeys] = useState<Record<string, boolean>>({});
  const activeKey = `${activeId}|${activeUrl}|${activeNonce}`;
  const frameLoading = isFrameSlot(activeUrl) && !loadedKeys[activeKey];

  const patch = useCallback(
    (p: Record<string, unknown>) => dispatch({ t: "app:patch", id: win.id, patch: p }),
    [dispatch, win.id],
  );

  const markLoaded = useCallback((key: string) => {
    setLoadedKeys((m) => (m[key] ? m : { ...m, [key]: true }));
  }, []);

  const activate = (id: string) => {
    if (id !== activeId) patch({ activeTab: id });
  };

  /** Navigate a tab. record=true pushes the per-tab back stack + shared history. */
  const navigate = useCallback(
    (tabId: string, rawUrl: string, record = true) => {
      let url = rawUrl;
      const h = hostOf(url);
      if (h === "wikipedia.org") {
        url = url.replace(/^https?:\/\/wikipedia\.org/i, "https://en.wikipedia.org");
      }
      const live = readNova(win.id);
      const liveTabs = tabsOf(live).length > 0 ? tabsOf(live) : [SEED_TAB];
      const idx = liveTabs.findIndex((t) => t.id === tabId);
      if (idx < 0) return;
      const cur = liveTabs[idx];

      const p: Record<string, unknown> = { activeTab: tabId };
      if (cur.url !== url) {
        const nextTabs = liveTabs.slice();
        nextTabs[idx] = { ...cur, url, title: titleFor(url) };
        p.tabs = nextTabs;
        // shared history records content pages (web + search), not chrome pages
        if (record && (url.startsWith("http") || url.startsWith(SEARCH_PREFIX))) {
          const h2 = historyOf(live);
          const last = h2[h2.length - 1];
          if (!last || last.url !== url) {
            p.history = [
              ...h2,
              { title: titleFor(url).slice(0, TITLE_CAP), url, at: Date.now() },
            ].slice(-HISTORY_CAP);
          }
        }
      }
      dispatch({ t: "app:patch", id: win.id, patch: p });
      if (record && cur.url !== url) {
        setNav((n) => ({
          ...n,
          [tabId]: { back: [...(n[tabId]?.back ?? []), cur.url].slice(-40), fwd: [] },
        }));
      }
      setDirty(false);
    },
    [dispatch, win.id],
  );

  const goBack = () => {
    const st = nav[activeId] ?? { back: [], fwd: [] };
    if (st.back.length === 0) return;
    const prev = st.back[st.back.length - 1];
    const cur = activeUrl;
    setNav((n) => ({ ...n, [activeId]: { back: st.back.slice(0, -1), fwd: [cur, ...st.fwd] } }));
    navigate(activeId, prev, false);
  };

  const goForward = () => {
    const st = nav[activeId] ?? { back: [], fwd: [] };
    if (st.fwd.length === 0) return;
    const next = st.fwd[0];
    const cur = activeUrl;
    setNav((n) => ({ ...n, [activeId]: { back: [...st.back, cur], fwd: st.fwd.slice(1) } }));
    navigate(activeId, next, false);
  };

  const reload = () => {
    setTabNonce((n) => ({ ...n, [activeId]: (n[activeId] ?? 0) + 1 }));
  };

  /** Address-bar heuristics: Tube handoff → nova:// → URL → search. */
  const submitAddress = (raw: string) => {
    const v = raw.trim();
    setDirty(false);
    if (!v) {
      navigate(activeId, NEW_TAB);
      return;
    }
    if (/youtu\.?be/i.test(v)) {
      const vid = parseYouTubeId(v);
      if (vid) {
        openApp("youtube", { videoId: vid, page: "watch" });
        pushToast({ title: "Opened in Tube", body: "Playing in the shared Tube app", kind: "success" });
        return;
      }
    }
    if (v.startsWith("nova://")) {
      navigate(activeId, v);
      return;
    }
    const hasScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(v);
    const looksLikeUrl = hasScheme || (!/\s/.test(v) && /\.[a-z]/i.test(v));
    if (looksLikeUrl) {
      navigate(activeId, hasScheme ? v : `https://${v}`);
      return;
    }
    navigate(activeId, `${SEARCH_PREFIX}?q=${encodeURIComponent(v)}`);
  };

  const newTab = useCallback(() => {
    const liveTabs = tabsOf(readNova(win.id));
    const live = liveTabs.length > 0 ? liveTabs : [SEED_TAB];
    if (live.length >= TAB_CAP) {
      pushToast({ title: "Tab limit reached", body: "Nova keeps it cozy at six tabs", kind: "warn" });
      return;
    }
    const tab: NovaTab = { id: uid(), url: NEW_TAB, title: "New Tab" };
    dispatch({ t: "app:patch", id: win.id, patch: { tabs: [...live, tab], activeTab: tab.id } });
  }, [dispatch, win.id]);

  const closeTab = useCallback(
    (id: string) => {
      const liveTabs = tabsOf(readNova(win.id));
      const live = liveTabs.length > 0 ? liveTabs : [SEED_TAB];
      setNav((n) => {
        const c = { ...n };
        delete c[id];
        return c;
      });
      if (live.length <= 1) {
        // a browser window never has zero tabs — respawn a fresh one
        const tab: NovaTab = { id: uid(), url: NEW_TAB, title: "New Tab" };
        dispatch({ t: "app:patch", id: win.id, patch: { tabs: [tab], activeTab: tab.id } });
        return;
      }
      const idx = live.findIndex((t) => t.id === id);
      if (idx < 0) return;
      const next = live.filter((t) => t.id !== id);
      const liveActive =
        typeof readNova(win.id).activeTab === "string" && next.some((t) => t.id === readNova(win.id).activeTab)
          ? readNova(win.id).activeTab
          : next[0].id;
      const nextActive = liveActive === id ? next[Math.min(idx, next.length - 1)].id : liveActive;
      dispatch({ t: "app:patch", id: win.id, patch: { tabs: next, activeTab: nextActive } });
    },
    [dispatch, win.id],
  );

  const bookmarked = bookmarks.some((b) => b.url === activeUrl);
  const toggleBookmark = () => {
    const url = activeUrl;
    if (url === NEW_TAB) return;
    const bm = bookmarksOf(readNova(win.id));
    const list = bm.length > 0 || Array.isArray(readNova(win.id).bookmarks) ? bm : DEFAULT_BOOKMARKS;
    if (list.some((b) => b.url === url)) {
      dispatch({ t: "app:patch", id: win.id, patch: { bookmarks: list.filter((b) => b.url !== url) } });
      pushToast({ title: "Bookmark removed", kind: "info" });
    } else {
      dispatch({
        t: "app:patch",
        id: win.id,
        patch: { bookmarks: [{ title: titleFor(url), url }, ...list].slice(0, BOOKMARK_CAP) },
      });
      pushToast({ title: "Bookmarked", body: titleFor(url), kind: "success" });
    }
  };

  const openInTube = useCallback((url: string) => {
    const vid = parseYouTubeId(url);
    openApp("youtube", vid ? { videoId: vid, page: "watch" } : undefined);
    pushToast({
      title: "Opened in Tube",
      body: vid ? "Playing in the shared Tube app" : "Tube is on the shared desktop",
      kind: "success",
    });
  }, []);

  // safety valve for frames that never fire onLoad (refused mid-flight) —
  // setState lives in the timer callback, never synchronously in the effect
  useEffect(() => {
    if (!frameLoading) return;
    const t = window.setTimeout(() => {
      markLoaded(activeKey);
    }, 3000);
    return () => window.clearTimeout(t);
  }, [frameLoading, activeKey, markLoaded]);

  // keyboard: arrow keys walk the tab strip
  const onTablistKeys = (e: ReactKeyboardEvent) => {
    if (e.key !== "ArrowRight" && e.key !== "ArrowLeft") return;
    const idx = tabs.findIndex((t) => t.id === activeId);
    const delta = e.key === "ArrowRight" ? 1 : -1;
    const next = tabs[(idx + delta + tabs.length) % tabs.length];
    if (next) activate(next.id);
  };

  const frameSlots = tabs.filter((t) => isFrameSlot(t.url));
  const activeIsFrameSlot = isFrameSlot(activeUrl);

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      {/* ---------------- tab strip ---------------- */}
      <div className="shrink-0 bg-white/30 px-2 pt-1.5">
        <div className="flex items-end gap-1" role="tablist" aria-label="Nova tabs" onKeyDown={onTablistKeys}>
          <div className="gd-scroll flex min-w-0 flex-1 items-end gap-1 overflow-x-auto">
            <AnimatePresence initial={false} mode="popLayout">
              {tabs.map((tab) => {
                const isActive = tab.id === activeId;
                return (
                  <motion.div
                    key={tab.id}
                    layout
                    initial={{ opacity: 0, scale: 0.94 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.94 }}
                    transition={SPRING}
                    role="tab"
                    aria-selected={isActive}
                    tabIndex={0}
                    onClick={() => activate(tab.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        activate(tab.id);
                      }
                    }}
                    className={`group relative flex h-9 min-w-[112px] max-w-[184px] flex-1 cursor-default select-none items-center gap-1.5 rounded-t-lg px-3 text-xs outline-none transition-colors focus-visible:ring-2 focus-visible:ring-teal-400/60 ${
                      isActive
                        ? "bg-white/85 text-stone-800 shadow-[0_4px_12px_rgba(31,41,55,0.06),0_1px_0_rgba(255,255,255,0.9)_inset]"
                        : "bg-white/25 text-stone-500 hover:bg-white/45"
                    }`}
                  >
                    <Favicon url={tab.url} />
                    <span className="min-w-0 flex-1 truncate">{tab.title}</span>
                    <button
                      type="button"
                      aria-label={`Close ${tab.title} tab`}
                      onClick={(e) => {
                        e.stopPropagation();
                        closeTab(tab.id);
                      }}
                      className={`grid h-5 w-5 shrink-0 place-items-center rounded-md text-stone-400 transition hover:bg-stone-200/70 hover:text-stone-600 focus-visible:opacity-100 ${
                        isActive ? "opacity-60" : "opacity-0 group-hover:opacity-60"
                      }`}
                    >
                      <X className="h-3 w-3" />
                    </button>
                    {isActive && (
                      <motion.span
                        layoutId={`nova-tab-underline-${win.id}`}
                        transition={SPRING}
                        className="absolute inset-x-2 bottom-0 h-[3px] rounded-full bg-gradient-to-r from-teal-400 to-emerald-400"
                      />
                    )}
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
          <button
            type="button"
            onClick={newTab}
            aria-label="New tab"
            title="New tab (6 max)"
            className="mb-0.5 grid h-8 w-8 shrink-0 place-items-center rounded-lg text-stone-500 transition-colors hover:bg-white/60 hover:text-stone-800 focus-visible:ring-2 focus-visible:ring-teal-400/60"
          >
            <Plus className="h-4 w-4" />
          </button>
        </div>
      </div>

      {/* ---------------- toolbar ---------------- */}
      <div className="flex shrink-0 items-center gap-1 border-b border-white/60 bg-white/45 px-2.5 py-1.5">
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={goBack}
          disabled={stacks.back.length === 0}
          aria-label="Back"
          title="Back"
        >
          <ChevronLeft className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={goForward}
          disabled={stacks.fwd.length === 0}
          aria-label="Forward"
          title="Forward"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={reload}
          aria-label="Reload page"
          title="Reload"
        >
          <RotateCw className={`h-4 w-4 ${frameLoading ? "animate-spin" : ""}`} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={() => navigate(activeId, NEW_TAB)}
          aria-label="Nova start page"
          title="Nova start page"
        >
          <House className="h-4 w-4" />
        </Button>

        <form
          className="relative flex min-w-0 flex-1 items-center"
          onSubmit={(e) => {
            e.preventDefault();
            submitAddress(shownAddr);
          }}
        >
          <Search className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-stone-400" aria-hidden />
          <Input
            value={shownAddr}
            onChange={(e) => {
              setDraft(e.target.value);
              setDirty(true);
            }}
            onFocus={(e) => {
              setDraft(activeUrl === NEW_TAB ? "" : activeUrl);
              setDirty(true);
              e.target.select();
            }}
            onBlur={() => setDirty(false)}
            placeholder="Search Wikipedia or enter address"
            spellCheck={false}
            aria-label="Address and search bar"
            className="gd-mono h-8 truncate rounded-full border-white/70 bg-white/70 pl-9 pr-3 text-[11px] shadow-inner focus-visible:ring-teal-400/50"
          />
        </form>

        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={toggleBookmark}
          aria-label={bookmarked ? "Remove bookmark for this page" : "Bookmark this page"}
          aria-pressed={bookmarked}
          title="Bookmark this page"
        >
          <Star className={`h-4 w-4 ${bookmarked ? "fill-amber-400 text-amber-400" : "text-stone-500"}`} />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={() => navigate(activeId, "nova://history")}
          aria-label="History"
          title="History"
        >
          <History className="h-4 w-4 text-stone-500" />
        </Button>
        <Button
          variant="ghost"
          size="icon"
          className="h-8 w-8 rounded-lg"
          onClick={() => navigate(activeId, "nova://bookmarks")}
          aria-label="Bookmarks"
          title="Bookmarks"
        >
          <Bookmark className="h-4 w-4 text-stone-500" />
        </Button>
      </div>

      {/* ---------------- content ---------------- */}
      <div className="relative min-h-0 flex-1 overflow-hidden">
        {/* top progress bar — animated gradient, 0.9s sweep */}
        <AnimatePresence>
          {frameLoading && (
            <motion.div
              key="nova-progress"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              className="absolute inset-x-0 top-0 z-30 h-[3px] overflow-hidden"
              aria-hidden
            >
              <motion.div
                initial={{ width: "4%" }}
                animate={{ width: "86%" }}
                exit={{ width: "100%" }}
                transition={{ duration: 0.9, ease: [0.22, 1, 0.36, 1] }}
                className="h-full rounded-full bg-gradient-to-r from-teal-400 via-emerald-400 to-amber-300"
              />
            </motion.div>
          )}
        </AnimatePresence>

        {/* internal pages — active only, scrollable */}
        {!activeIsFrameSlot && (
          <div className="gd-scroll absolute inset-0 overflow-y-auto">
            {activeUrl === NEW_TAB ? (
              <NewTabPage
                bookmarks={bookmarks}
                onOpen={(url) => navigate(activeId, url)}
                onTube={() => openInTube("https://youtube.com")}
              />
            ) : activeUrl === "nova://history" ? (
              <HistoryPage
                history={history}
                onOpen={(url) => navigate(activeId, url)}
                onClear={() => {
                  patch({ history: [] });
                  pushToast({ title: "History cleared", kind: "info" });
                }}
              />
            ) : activeUrl === "nova://bookmarks" ? (
              <BookmarksPage
                bookmarks={bookmarks}
                onOpen={(url) => navigate(activeId, url)}
                onTube={openInTube}
                onRemove={(url) => patch({ bookmarks: bookmarks.filter((b) => b.url !== url) })}
              />
            ) : (
              <RefusedPage url={activeUrl} onCopy={copyText} onTube={openInTube} />
            )}
          </div>
        )}

        {/* per-tab site frames — kept mounted, visibility-swapped.
            SiteFrame itself is keyed by url|reload-nonce: navigation or
            reload REMOUNTS it (fresh skeleton), tab switches do not. */}
        {frameSlots.map((tab) => {
          const isSearch = tab.url.startsWith(SEARCH_PREFIX);
          const embeddable = isSearch || isEmbeddable(tab.url);
          const slotKey = `${tab.id}|${tab.url}|${tabNonce[tab.id] ?? 0}`;
          return (
            <div key={tab.id} className={`absolute inset-0 ${tab.id === activeId ? "" : "invisible"}`}>
              {isSearch ? (
                <SearchFrame
                  key={searchQueryOf(tab.url)}
                  q={searchQueryOf(tab.url)}
                  onLoaded={() => markLoaded(slotKey)}
                />
              ) : embeddable ? (
                <SiteFrame
                  key={`${tab.url}|${tabNonce[tab.id] ?? 0}`}
                  url={embedUrlOf(tab.url)}
                  onLoaded={() => markLoaded(slotKey)}
                />
              ) : (
                <div className="gd-scroll h-full overflow-y-auto">
                  <RefusedPage url={tab.url} onCopy={copyText} onTube={openInTube} />
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}

// ============================================================
// pages
// ============================================================

function searchQueryOf(url: string): string {
  const m = /[?&]q=([^&]*)/.exec(url);
  if (!m) return "";
  try {
    return decodeURIComponent(m[1]);
  } catch {
    return m[1];
  }
}

function NewTabPage({
  bookmarks,
  onOpen,
  onTube,
}: {
  bookmarks: NovaBookmark[];
  onOpen: (url: string) => void;
  onTube: () => void;
}) {
  const [q, setQ] = useState("");
  return (
    <div className="mx-auto flex min-h-full max-w-2xl flex-col items-center justify-center gap-8 px-6 py-10">
      <motion.div
        initial={{ opacity: 0, y: 14 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className="text-center"
      >
        <h1 className="gd-text-gradient text-5xl font-bold tracking-tight">Nova</h1>
        <p className="mt-2 text-xs tracking-wide text-stone-400">one browser · two seats · every tab in sync</p>
      </motion.div>

      <motion.form
        initial={{ opacity: 0, y: 12 }}
        animate={{ opacity: 1, y: 0 }}
        transition={{ ...SPRING, delay: 0.05 }}
        onSubmit={(e) => {
          e.preventDefault();
          const v = q.trim();
          if (v) onOpen(`${SEARCH_PREFIX}?q=${encodeURIComponent(v)}`);
        }}
        className="glass glass-sheen flex w-full max-w-xl items-center gap-2 rounded-full p-1.5 pl-4"
      >
        <Search className="h-4 w-4 shrink-0 text-stone-400" aria-hidden />
        <Input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search Wikipedia — try “glass” or “aurora”"
          aria-label="Nova search"
          className="h-8 flex-1 border-0 bg-transparent px-1 text-sm shadow-none focus-visible:ring-0"
        />
        <Button
          type="submit"
          size="icon"
          className="h-8 w-8 shrink-0 rounded-full"
          aria-label="Search"
          title="Search Wikipedia"
        >
          <ChevronRight className="h-4 w-4" />
        </Button>
      </motion.form>

      <div className="grid w-full max-w-xl grid-cols-2 gap-3 sm:grid-cols-3">
        {bookmarks.slice(0, 9).map((b, i) => (
          <motion.button
            key={b.url}
            type="button"
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ ...SPRING, delay: 0.08 + i * 0.045 }}
            whileHover={{ y: -3 }}
            whileTap={{ scale: 0.97 }}
            onClick={() => (b.yt ? onTube() : onOpen(b.url))}
            aria-label={b.yt ? `Open ${b.title} in Tube` : `Open ${b.title}`}
            className="glass flex items-center gap-3 rounded-2xl p-3 text-left transition-shadow hover:shadow-lg focus-visible:ring-2 focus-visible:ring-teal-400/60"
          >
            <span
              className={`grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br ${gradFor(b.url)} text-sm font-bold text-white shadow-sm`}
              aria-hidden
            >
              {b.title.charAt(0).toUpperCase()}
            </span>
            <span className="min-w-0">
              <span className="block truncate text-xs font-semibold text-stone-700">{b.title}</span>
              <span className="block truncate text-[10px] text-stone-400">{hostOf(b.url) || b.url}</span>
            </span>
          </motion.button>
        ))}
      </div>
    </div>
  );
}

function HistoryPage({
  history,
  onOpen,
  onClear,
}: {
  history: NovaHistoryItem[];
  onOpen: (url: string) => void;
  onClear: () => void;
}) {
  const items = [...history].reverse(); // newest first
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <div className="flex items-center justify-between gap-2 px-1">
        <h1 className="flex items-center gap-2 text-sm font-semibold text-stone-700">
          <History className="h-4 w-4 text-stone-400" aria-hidden /> History
          <span className="text-[11px] font-normal text-stone-400">· shared, both seats</span>
        </h1>
        <Button
          variant="outline"
          size="sm"
          disabled={items.length === 0}
          onClick={onClear}
          aria-label="Clear all history"
          className="rounded-full"
        >
          <Trash2 className="h-3.5 w-3.5" /> Clear history
        </Button>
      </div>

      {items.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center text-xs text-stone-400">
          Nothing here yet — pages you visit together show up in history.
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          className="glass divide-y divide-white/70 overflow-hidden rounded-2xl"
        >
          {items.map((h) => (
            <button
              key={`${h.url}-${h.at}`}
              type="button"
              onClick={() => onOpen(h.url)}
              className="flex w-full items-center gap-3 px-3 py-2.5 text-left transition-colors hover:bg-white/50 focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-400/60"
              aria-label={`Open ${h.title}`}
            >
              <Favicon url={h.url} />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-xs font-medium text-stone-700">{h.title}</span>
                <span className="gd-mono block truncate text-[10px] text-stone-400">{h.url}</span>
              </span>
              <span className="shrink-0 text-[10px] text-stone-400">{timeAgo(h.at)}</span>
            </button>
          ))}
        </motion.div>
      )}
    </div>
  );
}

function BookmarksPage({
  bookmarks,
  onOpen,
  onTube,
  onRemove,
}: {
  bookmarks: NovaBookmark[];
  onOpen: (url: string) => void;
  onTube: (url: string) => void;
  onRemove: (url: string) => void;
}) {
  return (
    <div className="mx-auto max-w-2xl space-y-3 p-4">
      <h1 className="flex items-center gap-2 px-1 text-sm font-semibold text-stone-700">
        <Bookmark className="h-4 w-4 text-stone-400" aria-hidden /> Bookmarks
        <span className="text-[11px] font-normal text-stone-400">· {bookmarks.length} of {BOOKMARK_CAP}</span>
      </h1>

      {bookmarks.length === 0 ? (
        <div className="glass rounded-2xl p-8 text-center text-xs text-stone-400">
          No bookmarks yet — tap the star in the toolbar to save the page you&apos;re on.
        </div>
      ) : (
        <motion.div
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={SPRING}
          className="glass divide-y divide-white/70 overflow-hidden rounded-2xl"
        >
          {bookmarks.map((b) => (
            <div key={b.url} className="flex items-center gap-3 px-3 py-2.5 transition-colors hover:bg-white/50">
              <button
                type="button"
                onClick={() => (b.yt ? onTube(b.url) : onOpen(b.url))}
                className="flex min-w-0 flex-1 items-center gap-3 text-left focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-teal-400/60"
                aria-label={`Open ${b.title}`}
              >
                <span
                  className={`grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-gradient-to-br ${gradFor(b.url)} text-xs font-bold text-white shadow-sm`}
                  aria-hidden
                >
                  {b.title.charAt(0).toUpperCase()}
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-xs font-medium text-stone-700">
                    {b.title}
                    {b.yt ? <span className="ml-1.5 text-[10px] font-normal text-rose-500">opens in Tube</span> : null}
                  </span>
                  <span className="gd-mono block truncate text-[10px] text-stone-400">{b.url}</span>
                </span>
                {b.yt ? <Play className="h-3.5 w-3.5 shrink-0 text-rose-400" aria-hidden /> : null}
              </button>
              <Button
                variant="ghost"
                size="icon"
                className="h-7 w-7 shrink-0 rounded-lg"
                onClick={() => onRemove(b.url)}
                aria-label={`Remove bookmark ${b.title}`}
                title="Remove bookmark"
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            </div>
          ))}
        </motion.div>
      )}
    </div>
  );
}

// ============================================================
// frames
// ============================================================

/** Wikipedia search: header bar + live frame + skeleton. Keyed by the
 *  parent on `q`, so a new query remounts (and re-skeletons) cleanly. */
function SearchFrame({ q, onLoaded }: { q: string; onLoaded: () => void }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLoaded(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-white/60 bg-white/50 px-3 py-2">
        <BookOpen className="h-3.5 w-3.5 shrink-0 text-emerald-500" aria-hidden />
        <p className="truncate text-xs text-stone-600">
          Searching Wikipedia for <span className="font-semibold text-stone-800">“{q}”</span>
        </p>
      </div>
      <div className="relative min-h-0 flex-1">
        <iframe
          src={`https://en.wikipedia.org/wiki/Special:Search?search=${encodeURIComponent(q)}`}
          title={`Wikipedia search: ${q}`}
          className="absolute inset-0 h-full w-full border-0 bg-white"
          referrerPolicy="no-referrer"
          onLoad={() => {
            setLoaded(true);
            onLoaded();
          }}
        />
        <AnimatePresence>
          {!loaded && <FrameSkeleton label={`Loading Wikipedia results…`} />}
        </AnimatePresence>
      </div>
    </div>
  );
}

/** Allowlisted host frame: real iframe + skeleton until onLoad. Keyed by
 *  the parent on url|nonce — remounts on navigation/reload, not on tab switch. */
function SiteFrame({ url, onLoaded }: { url: string; onLoaded: () => void }) {
  const [loaded, setLoaded] = useState(false);
  useEffect(() => {
    const t = window.setTimeout(() => setLoaded(true), 2500);
    return () => window.clearTimeout(t);
  }, []);
  const host = hostOf(url) || "site";
  return (
    <div className="relative h-full w-full">
      <iframe
        src={url}
        title={host}
        className="absolute inset-0 h-full w-full border-0 bg-white"
        referrerPolicy="no-referrer"
        onLoad={() => {
          setLoaded(true);
          onLoaded();
        }}
      />
      <AnimatePresence>{!loaded && <FrameSkeleton label={`Loading ${host}…`} />}</AnimatePresence>
    </div>
  );
}

function FrameSkeleton({ label }: { label: string }) {
  return (
    <motion.div
      key="frame-skeleton"
      initial={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.25 }}
      className="absolute inset-0 z-10 grid place-items-center bg-white/75 backdrop-blur-sm"
      aria-hidden
    >
      <div className="w-full max-w-md space-y-3 p-6">
        <div className="flex items-center gap-2 text-xs text-stone-400">
          <Globe className="h-3.5 w-3.5" />
          {label}
        </div>
        <Skeleton className="h-3 w-3/4 rounded bg-white/80" />
        <Skeleton className="h-3 w-full rounded bg-white/80" />
        <Skeleton className="h-3 w-5/6 rounded bg-white/80" />
        <Skeleton className="h-3 w-2/3 rounded bg-white/80" />
      </div>
    </motion.div>
  );
}

// ============================================================
// refused to connect
// ============================================================

function RefusedPage({ url, onCopy, onTube }: { url: string; onCopy: (u: string) => void; onTube: (u: string) => void }) {
  const host = hostOf(url) || url.replace(/^nova:\/\//, "") || "this site";
  const isYt = host.includes("youtu") || !!parseYouTubeId(url);
  return (
    <div className="grid min-h-full place-items-center p-6">
      <motion.div
        initial={{ opacity: 0, y: 10 }}
        animate={{ opacity: 1, y: 0 }}
        transition={SPRING}
        className="glass glass-sheen w-full max-w-md rounded-2xl p-7 text-center"
      >
        {/* globe-off mark */}
        <div className="relative mx-auto h-12 w-12" aria-hidden>
          <Globe className="h-12 w-12 text-stone-300" />
          <span className="absolute left-1/2 top-1/2 h-[2.5px] w-[58px] -translate-x-1/2 -translate-y-1/2 rotate-[38deg] rounded-full bg-rose-400/90" />
        </div>
        <h2 className="mt-4 text-sm font-semibold text-stone-800">{host} refused to connect</h2>
        <p className="mt-2 text-xs leading-relaxed text-stone-500">
          Nova only frames trusted partners — Wikipedia, OpenStreetMap, Archive.org and wttr.in. Other sites block
          embedding inside the shared PC.
        </p>
        <p className="gd-mono mt-3 break-all rounded-lg bg-stone-100/80 px-3 py-1.5 text-[10px] text-stone-400" aria-hidden>
          {url}
        </p>
        <div className="mt-5 flex flex-wrap items-center justify-center gap-2">
          <Button variant="outline" size="sm" className="rounded-full" onClick={() => onCopy(url)}>
            <Copy className="h-3.5 w-3.5" /> Copy link
          </Button>
          {isYt && (
            <Button size="sm" className="rounded-full" onClick={() => onTube(url)}>
              <Play className="h-3.5 w-3.5" /> Open in Tube
            </Button>
          )}
        </div>
      </motion.div>
    </div>
  );
}
