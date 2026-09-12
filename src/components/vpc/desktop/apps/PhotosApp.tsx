"use client";

// ============================================================
// GlassDesk — Photos. Shared gallery, watch-party synced:
// payload { album, sel, slideshow } merges live to both seats,
// so seat B's Photos window follows seat A's photo, album
// filter and slideshow frame-for-frame.
// ============================================================

import { useCallback, useEffect, useMemo, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import {
  Building2,
  ChevronLeft,
  ChevronRight,
  Image as ImageIcon,
  Images,
  Mountain,
  Pause,
  Play,
  Sparkles,
  X,
} from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import type { WindowState } from "@/lib/vpc/types";
import {
  ALBUM_META,
  PHOTOS,
  photoByFile,
  photoUrl,
  type AlbumId,
  type PhotoAlbum,
  type PhotoItem,
} from "@/lib/vpc/photos";

const SPRING = { type: "spring", stiffness: 420, damping: 30 } as const;
const SOFT_SPRING = { type: "spring", stiffness: 380, damping: 28 } as const;

const ALBUM_ICONS: Record<AlbumId, typeof Images> = {
  all: Images,
  nature: Mountain,
  city: Building2,
  abstract: Sparkles,
};

/** An <img> that never shows broken pixels: tint gradient behind,
 *  fade-in on load, icon placeholder if the file is missing. */
function SmartImg({
  photo,
  className = "",
  imgClassName = "",
  alt,
}: {
  photo: PhotoItem;
  className?: string;
  imgClassName?: string;
  alt?: string;
}) {
  const [status, setStatus] = useState<"loading" | "ok" | "err">("loading");
  return (
    <div
      className={`relative overflow-hidden ${className}`}
      style={{ background: photo.tint }}
      aria-label={alt ?? photo.title}
      role="img"
    >
      {status === "err" ? (
        <div className="absolute inset-0 grid place-items-center gap-1.5">
          <ImageIcon className="size-6 text-white/80 drop-shadow-sm" aria-hidden="true" />
          <span className="px-2 text-center text-[10px] font-medium text-white/85 drop-shadow-sm">
            {photo.title}
          </span>
        </div>
      ) : (
        <img
          src={photoUrl(photo.file)}
          alt={alt ?? `${photo.title} — ${photo.album} photo`}
          draggable={false}
          loading="lazy"
          onLoad={() => setStatus("ok")}
          onError={() => setStatus("err")}
          className={`absolute inset-0 size-full object-cover transition-opacity duration-500 ${imgClassName}`}
          style={{ opacity: status === "ok" ? 1 : 0 }}
        />
      )}
      {status === "loading" && (
        <div className="absolute inset-0 animate-pulse bg-white/15" aria-hidden="true" />
      )}
    </div>
  );
}

export default function PhotosApp({ win }: { win: WindowState }) {
  // read the LIVE window so remote patches (watch party) land instantly
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;

  const payload = w.payload as { album?: unknown; sel?: unknown; slideshow?: unknown };
  const album: AlbumId =
    payload.album === "nature" || payload.album === "city" || payload.album === "abstract"
      ? (payload.album as PhotoAlbum)
      : "all";
  const selFile = typeof payload.sel === "string" ? payload.sel : null;
  const slideshow = payload.slideshow === true;

  const patch = useCallback(
    (p: Record<string, unknown>) => dispatch({ t: "app:patch", id: win.id, patch: p }),
    [dispatch, win.id],
  );

  const filtered = useMemo(
    () => (album === "all" ? PHOTOS : PHOTOS.filter((p) => p.album === album)),
    [album],
  );
  const selPhoto = photoByFile(selFile);
  const selIndex = selPhoto ? filtered.findIndex((p) => p.file === selPhoto.file) : -1;

  // responsive grid columns driven by the LIVE window width (win:geom
  // patches re-render this, so maximizing/max snaps the grid too)
  const cols = w.w < 500 ? 2 : w.w < 680 ? 3 : w.w < 900 ? 4 : 5;

  const closeLightbox = useCallback(() => patch({ sel: null, slideshow: false }), [patch]);

  const step = useCallback(
    (dir: 1 | -1) => {
      if (filtered.length === 0) return;
      const base = selIndex < 0 ? (dir === 1 ? -1 : 1) : selIndex;
      const next = filtered[(base + dir + filtered.length) % filtered.length];
      patch({ sel: next.file });
    },
    [filtered, selIndex, patch],
  );

  // keyboard navigation while the lightbox is open
  useEffect(() => {
    if (!selFile) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeLightbox();
      else if (e.key === "ArrowRight") step(1);
      else if (e.key === "ArrowLeft") step(-1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selFile, closeLightbox, step]);

  // slideshow: local 4s timer that walks payload.sel (both seats patch,
  // whoever is watching advances the frame — sync wins)
  useEffect(() => {
    if (!slideshow) return;
    if (!selFile && filtered.length > 0) {
      patch({ sel: filtered[0].file });
      return;
    }
    const id = window.setInterval(() => {
      if (filtered.length < 2) return;
      const i = filtered.findIndex((p) => p.file === selFile);
      const next = filtered[(i < 0 ? 0 : i + 1) % filtered.length];
      patch({ sel: next.file });
    }, 4000);
    return () => window.clearInterval(id);
  }, [slideshow, selFile, filtered, patch]);

  const albumMeta = ALBUM_META.find((a) => a.id === album) ?? ALBUM_META[0];

  return (
    <div className="relative flex h-full overflow-hidden">
      {/* ------------------------- sidebar ------------------------- */}
      <aside className="flex w-36 shrink-0 flex-col gap-4 border-r border-white/60 bg-white/35 p-3">
        <div>
          <p className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
            Library
          </p>
          <div className="flex flex-col gap-1">
            {ALBUM_META.map((a) => {
              const Icon = ALBUM_ICONS[a.id];
              const count = a.id === "all" ? PHOTOS.length : PHOTOS.filter((p) => p.album === a.id).length;
              const active = album === a.id;
              return (
                <motion.button
                  key={a.id}
                  type="button"
                  layout
                  transition={SOFT_SPRING}
                  whileTap={{ scale: 0.96 }}
                  onClick={() => patch({ album: a.id })}
                  aria-pressed={active}
                  className={`flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm outline-none transition-colors focus-visible:ring-2 focus-visible:ring-stone-300 ${
                    active
                      ? "glass font-medium text-teal-700"
                      : "text-stone-600 hover:bg-white/60"
                  }`}
                >
                  <Icon
                    className={`size-4 shrink-0 ${active ? "text-teal-600" : "text-stone-400"}`}
                    aria-hidden="true"
                  />
                  <span className="truncate">{a.label}</span>
                  <span className="ml-auto text-[10px] tabular-nums text-stone-400">{count}</span>
                </motion.button>
              );
            })}
          </div>
        </div>

        <div className="mt-auto">
          <p className="px-1 pb-2 text-[10px] font-semibold uppercase tracking-[0.14em] text-stone-400">
            Playback
          </p>
          <motion.button
            type="button"
            whileTap={{ scale: 0.96 }}
            transition={SPRING}
            onClick={() => {
              patch({ slideshow: !slideshow });
              pushToast({
                title: slideshow ? "Slideshow paused" : "Slideshow running",
                body: slideshow ? "You stopped the shared slideshow." : "Both seats see the same photo, advancing every 4 seconds.",
                kind: slideshow ? "info" : "success",
              });
            }}
            aria-pressed={slideshow}
            className={`flex w-full items-center gap-2 rounded-lg px-2.5 py-2 text-sm outline-none focus-visible:ring-2 focus-visible:ring-stone-300 ${
              slideshow
                ? "gd-accent-gradient font-medium text-white shadow-sm"
                : "glass text-stone-600 hover:bg-white/80"
            }`}
          >
            {slideshow ? (
              <Pause className="size-4 shrink-0" aria-hidden="true" />
            ) : (
              <Play className="size-4 shrink-0" aria-hidden="true" />
            )}
            <span>{slideshow ? "Pause" : "Slideshow"}</span>
            {slideshow && (
              <span className="relative ml-auto flex size-2" aria-hidden="true">
                <span className="absolute inline-flex size-full animate-ping rounded-full bg-white opacity-75" />
                <span className="relative inline-flex size-2 rounded-full bg-white" />
              </span>
            )}
          </motion.button>
        </div>
      </aside>

      {/* ------------------------- grid ------------------------- */}
      <div className="flex min-w-0 flex-1 flex-col bg-white/25">
        <header className="flex items-center gap-2 border-b border-white/60 px-4 py-2.5">
          <h2 className="text-sm font-semibold text-stone-700">{albumMeta.label}</h2>
          <span className="text-xs text-stone-400">
            {filtered.length} {filtered.length === 1 ? "photo" : "photos"}
          </span>
          <span className="ml-auto flex items-center gap-1.5 rounded-full bg-emerald-50/80 px-2 py-0.5 text-[10px] font-medium text-emerald-600">
            <span className="relative flex size-1.5" aria-hidden="true">
              <span className="absolute inline-flex size-full animate-ping rounded-full bg-emerald-400 opacity-70" />
              <span className="relative inline-flex size-1.5 rounded-full bg-emerald-500" />
            </span>
            synced on both seats
          </span>
        </header>

        <div className="gd-scroll min-h-0 flex-1 overflow-y-auto p-3">
          <div
            className="grid gap-2.5"
            style={{ gridTemplateColumns: `repeat(${cols}, minmax(0, 1fr))` }}
          >
            <AnimatePresence mode="popLayout">
              {filtered.map((p) => (
                <motion.button
                  key={p.file}
                  type="button"
                  layout
                  initial={{ opacity: 0, scale: 0.92 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.92 }}
                  transition={SOFT_SPRING}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => patch({ sel: p.file })}
                  aria-label={`Open ${p.title}`}
                  className="group relative overflow-hidden rounded-xl text-left shadow-sm outline-none transition-shadow hover:shadow-lg focus-visible:ring-2 focus-visible:ring-teal-400"
                >
                  <SmartImg
                    photo={p}
                    className="aspect-[4/3] w-full"
                    imgClassName="transition-transform duration-500 ease-out group-hover:scale-[1.02]"
                  />
                  <span
                    className="glass absolute inset-x-0 bottom-0 flex translate-y-full items-center gap-1.5 px-2 py-1.5 opacity-0 transition-all duration-300 group-hover:translate-y-0 group-hover:opacity-100"
                    aria-hidden="true"
                  >
                    <span
                      className="size-1.5 shrink-0 rounded-full"
                      style={{ background: p.dot }}
                    />
                    <span className="truncate text-[11px] font-medium text-stone-700">
                      {p.title}
                    </span>
                  </span>
                </motion.button>
              ))}
            </AnimatePresence>
          </div>
        </div>
      </div>

      {/* ------------------------- lightbox ------------------------- */}
      <AnimatePresence>
        {selPhoto && (
          <motion.div
            key="lightbox"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={SOFT_SPRING}
            className="absolute inset-0 z-30 flex flex-col bg-stone-950/85 backdrop-blur-xl"
            role="dialog"
            aria-label={`Photo viewer — ${selPhoto.title}`}
          >
            {/* top bar */}
            <div className="flex items-center gap-2 px-4 py-3">
              <div className="flex min-w-0 items-center gap-2">
                <span
                  className="size-2 shrink-0 rounded-full"
                  style={{ background: selPhoto.dot }}
                  aria-hidden="true"
                />
                <p className="truncate text-sm font-semibold text-white">{selPhoto.title}</p>
                <span className="hidden rounded-full bg-white/10 px-2 py-0.5 text-[10px] uppercase tracking-wider text-white/70 sm:inline">
                  {selPhoto.album}
                </span>
              </div>
              <div className="ml-auto flex items-center gap-1.5">
                {slideshow && (
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.92 }}
                    transition={SPRING}
                    onClick={() => patch({ slideshow: false })}
                    aria-label="Pause slideshow"
                    className="glass flex items-center gap-1.5 rounded-full px-3 py-1.5 text-xs font-medium text-white/90 hover:bg-white/25"
                  >
                    <Pause className="size-3.5" aria-hidden="true" /> Live
                  </motion.button>
                )}
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.92 }}
                  transition={SPRING}
                  onClick={() => patch({ slideshow: !slideshow })}
                  aria-label={slideshow ? "Pause slideshow" : "Start slideshow"}
                  className="glass flex items-center justify-center rounded-full p-2 text-white/80 hover:bg-white/25"
                >
                  {slideshow ? (
                    <Pause className="size-4" aria-hidden="true" />
                  ) : (
                    <Play className="size-4" aria-hidden="true" />
                  )}
                </motion.button>
                <motion.button
                  type="button"
                  whileTap={{ scale: 0.92 }}
                  transition={SPRING}
                  onClick={closeLightbox}
                  aria-label="Close photo"
                  className="glass flex items-center justify-center rounded-full p-2 text-white/80 hover:bg-rose-400/80"
                >
                  <X className="size-4" aria-hidden="true" />
                </motion.button>
              </div>
            </div>

            {/* stage */}
            <div className="relative min-h-0 flex-1">
              <div className="absolute inset-0 flex items-center justify-center overflow-hidden px-12 pb-2">
                <LightboxImage key={selPhoto.file} photo={selPhoto} />
              </div>

              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                transition={SPRING}
                onClick={() => step(-1)}
                aria-label="Previous photo"
                className="glass absolute left-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-stone-700 hover:bg-white/90"
              >
                <ChevronLeft className="size-5" aria-hidden="true" />
              </motion.button>
              <motion.button
                type="button"
                whileTap={{ scale: 0.9 }}
                transition={SPRING}
                onClick={() => step(1)}
                aria-label="Next photo"
                className="glass absolute right-2 top-1/2 flex size-9 -translate-y-1/2 items-center justify-center rounded-full text-stone-700 hover:bg-white/90"
              >
                <ChevronRight className="size-5" aria-hidden="true" />
              </motion.button>
            </div>

            {/* filmstrip */}
            <div className="gd-scroll flex shrink-0 items-center gap-1.5 overflow-x-auto px-3 pb-3 pt-1">
              {filtered.map((p) => {
                const active = p.file === selPhoto.file;
                return (
                  <motion.button
                    key={p.file}
                    type="button"
                    whileTap={{ scale: 0.92 }}
                    transition={SPRING}
                    onClick={() => patch({ sel: p.file })}
                    aria-label={`Show ${p.title}`}
                    aria-current={active}
                    className={`relative h-10 w-14 shrink-0 overflow-hidden rounded-md outline-none transition-all focus-visible:ring-2 focus-visible:ring-teal-300 ${
                      active ? "ring-2 ring-teal-300 ring-offset-1 ring-offset-stone-950" : "opacity-60 hover:opacity-100"
                    }`}
                  >
                    <SmartImg photo={p} className="size-full" alt={`${p.title} thumbnail`} />
                  </motion.button>
                );
              })}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** Big lightbox image with zoom toggle (1 → 1.6 spring) + fallback.
 *  Remounted via key={photo.file} so zoom resets per photo. */
function LightboxImage({ photo }: { photo: PhotoItem }) {
  const [zoomed, setZoomed] = useState(false);
  const [status, setStatus] = useState<"loading" | "ok" | "err">("loading");

  return (
    <motion.div
      animate={{ scale: zoomed ? 1.6 : 1 }}
      transition={{ type: "spring", stiffness: 400, damping: 27 }}
      className="flex h-full w-full items-center justify-center"
    >
      <button
        type="button"
        onClick={() => setZoomed((z) => !z)}
        aria-label={zoomed ? `Zoom out of ${photo.title}` : `Zoom into ${photo.title}`}
        className={`relative flex max-h-full max-w-full cursor-zoom-in items-center justify-center overflow-hidden rounded-xl shadow-2xl ${
          zoomed ? "cursor-zoom-out" : ""
        }`}
        style={{ background: photo.tint }}
      >
        {status === "err" ? (
          <span className="grid aspect-[4/3] w-72 place-items-center gap-2">
            <ImageIcon className="size-10 text-white/80" aria-hidden="true" />
            <span className="text-xs font-medium text-white/85 drop-shadow-sm">{photo.title}</span>
            <span className="sr-only">photo not available yet</span>
          </span>
        ) : (
          <img
            src={photoUrl(photo.file)}
            alt={`${photo.title} — ${photo.album} photo`}
            draggable={false}
            onLoad={() => setStatus("ok")}
            onError={() => setStatus("err")}
            className="max-h-full max-w-full object-contain transition-opacity duration-500"
            style={{ opacity: status === "ok" ? 1 : 0 }}
          />
        )}
      </button>
    </motion.div>
  );
}
