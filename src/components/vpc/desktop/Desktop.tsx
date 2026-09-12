"use client";

// ============================================================
// GlassDesk — the desktop surface: wallpaper + aurora, desktop
// icons (~/Desktop folder), window layer with exit animations,
// workspace veil, boot overlay, remote cursors, pointer sharing.
//
// Layout contracts honored here:
//  • root is `relative flex-1 min-h-0 overflow-hidden` (2nd flex
//    child of SessionView's <main>; the call sidebar follows) and
//    carries data-gd-root — windows measure it for edge snapping
//  • minimized windows STAY MOUNTED (Window.tsx animates them to
//    zero and blocks pointer events — iframes/audio keep running);
//    windows on OTHER workspaces stay mounted but invisible too
//    (payload is the persistence layer)
//  • boot overlay arms exactly one 2.4s timer per boot
//  • brightness (0.6..1) applies as a veil from the local uiStore
// ============================================================

import { useEffect, useRef, type MouseEvent as ReactMouseEvent } from "react";
import { AnimatePresence, motion, useMotionValue, useSpring, useTransform } from "framer-motion";
import { FilePlus2, FolderPlus, Info, Monitor, SquareTerminal, Wand2, ArrowDownAZ } from "lucide-react";
import Aurora from "@/components/vpc/Aurora";
import { LogoMarkDrawing, Wordmark } from "@/components/vpc/brand/Logo";
import { useGlassDesk } from "@/lib/vpc/store";
import { useShellUi } from "@/lib/vpc/uiStore";
import { WALLPAPERS } from "@/lib/vpc/types";
import AppSurface from "./apps/AppSurface";
import { cleanUpIcons, createOnDesktop, default as DesktopIcons, sortIconsByName } from "./DesktopIcons";
import { openContextMenu } from "./ContextMenu";
import Dock, { openApp } from "./Dock";
import RemoteCursors from "./RemoteCursors";
import Window from "./Window";
import WidgetsPanel from "./WidgetsPanel";
import ClipboardPop from "./ClipboardPop";
import Screensaver from "./Screensaver";

const BOOT_MS = 2400;
const LOG_DELAYS = [0.35, 0.9, 1.45];
const EASE_OUT_EXPO = [0.22, 1, 0.36, 1] as const;

/** Is this wallpaper one of the generated image wallpapers? (Ken Burns layer) */
function isImageWallpaper(id: string): boolean {
  return id.startsWith("wp-");
}

export default function Desktop() {
  const state = useGlassDesk((s) => s.state);
  const sendPointer = useGlassDesk((s) => s.sendPointer);
  const brightness = useShellUi((s) => s.brightness);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const bootArmed = useRef<string | null>(null);

  const booted = state ? state.booted : null;
  const hostname = state ? state.machine.hostname : null;

  // ---- wallpaper parallax — cursor-normalized background drift.
  // Motion values + a soft spring: no re-renders, composited
  // transforms only. The OVERSIZED layer (-inset-8) hides edges;
  // icons/windows live OUTSIDE this layer so grid coordinates and
  // hit-testing stay exact — only the world behind them moves.
  const parallaxX = useMotionValue(0);
  const parallaxY = useMotionValue(0);
  const driftX = useSpring(parallaxX, { stiffness: 42, damping: 18, mass: 1.2 });
  const driftY = useSpring(parallaxY, { stiffness: 42, damping: 18, mass: 1.2 });
  const bgX = useTransform(driftX, (v: number) => v * -12);
  const bgY = useTransform(driftY, (v: number) => v * -9);

  // Boot sequence — exactly one timer per boot. Guarded by a ref keyed
  // on the machine hostname and rearmed after each completed boot.
  useEffect(() => {
    if (booted === true) {
      bootArmed.current = null;
      return;
    }
    if (booted !== false || !hostname) return;
    if (bootArmed.current === hostname) return;
    bootArmed.current = hostname;
    const timer = setTimeout(() => {
      const s = useGlassDesk.getState();
      if (s.state && !s.state.booted) s.dispatch({ t: "sys", patch: { booted: true } });
    }, BOOT_MS);
    return () => clearTimeout(timer);
  }, [booted, hostname]);

  function onMouseMove(e: ReactMouseEvent<HTMLDivElement>): void {
    const root = rootRef.current;
    if (!root) return;
    const rect = root.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) return;
    const x = Math.min(1, Math.max(0, (e.clientX - rect.left) / rect.width));
    const y = Math.min(1, Math.max(0, (e.clientY - rect.top) / rect.height));
    sendPointer(x, y); // store caps at ~30Hz
    // wallpaper parallax — normalized -1..1, motion values only
    parallaxX.set(x * 2 - 1);
    parallaxY.set(y * 2 - 1);
  }

  // desktop context menu — the OS heart of the right-click
  function onContextMenu(e: ReactMouseEvent<HTMLDivElement>): void {
    if (!state) return;
    e.preventDefault();
    const s = useGlassDesk.getState();
    openContextMenu(e.clientX, e.clientY, [
      {
        id: "newfolder",
        label: "New Folder",
        icon: <FolderPlus size={13} />,
        onSelect: () => createOnDesktop("folder"),
      },
      {
        id: "newfile",
        label: "New Text File",
        icon: <FilePlus2 size={13} />,
        onSelect: () => createOnDesktop("file"),
      },
      { id: "sep1", separator: true },
      {
        id: "termhere",
        label: "Open Terminal Here",
        icon: <SquareTerminal size={13} />,
        onSelect: () => openApp("terminal", { cwd: "f-desk" }),
      },
      { id: "sep2", separator: true },
      {
        id: "wallpaper",
        label: "Change Wallpaper…",
        icon: <Monitor size={13} />,
        onSelect: () => openApp("settings"),
      },
      {
        id: "nextwall",
        label: "Next Wallpaper",
        icon: <Wand2 size={13} />,
        onSelect: () => {
          const ids = WALLPAPERS.map((w) => w.id);
          const cur = s.state?.wallpaper ?? "aurora";
          const next = ids[(ids.indexOf(cur) + 1) % ids.length];
          s.dispatch({ t: "sys", patch: { wallpaper: next } });
        },
      },
      {
        id: "cleanup",
        label: "Clean Up Icons",
        onSelect: () => cleanUpIcons(),
      },
      {
        id: "sortaz",
        label: "Sort Icons by Name",
        icon: <ArrowDownAZ size={13} />,
        onSelect: () => sortIconsByName(),
      },
      { id: "sep3", separator: true },
      {
        id: "about",
        label: "About GlassDesk",
        icon: <Info size={13} />,
        onSelect: () => useShellUi.getState().setAboutOpen(true),
      },
    ]);
  }

  if (!state) return null;

  const wallpaperCss = WALLPAPERS.find((w) => w.id === state.wallpaper)?.css ?? WALLPAPERS[0].css;
  const imageWallpaper = isImageWallpaper(state.wallpaper);

  const logs = [
    `[machine] ${state.machine.hostname} · node ${state.machine.node}`,
    `[ram]     ${state.machine.ramMB} MB reserved · ${state.machine.cores} vCores`,
    `[disk]    ${state.machine.diskGB} GB GlassDesk HD (SQLite volume) mounted`,
  ];

  return (
    <div
      ref={rootRef}
      data-gd-root
      onMouseMove={onMouseMove}
      onContextMenu={onContextMenu}
      // overflow-clip (not hidden): the root now spans the FULL viewport
      // (12-d, menubar removed), so a titlebar drag to y≈0 reaches the
      // root's scrollport top edge — Chromium's drag auto-scroll would
      // silently scrollTop a hidden scroller and offset the whole
      // desktop. `clip` makes the box truly non-scrollable.
      className="relative flex-1 min-h-0 overflow-clip"
      style={{ background: wallpaperCss }}
    >
      {/* wallpaper depth layer — everything BEHIND the icons
          drifts against the cursor (parallax); Ken Burns keeps
          image wallpapers alive inside it. Oversized so the drift
          never exposes edges. */}
      <motion.div aria-hidden className="pointer-events-none absolute -inset-8" style={{ x: bgX, y: bgY }}>
        {imageWallpaper && (
          <motion.div
            className="pointer-events-none absolute -inset-10"
            style={{ background: wallpaperCss }}
            initial={{ scale: 1.05 }}
            animate={{
              scale: [1.05, 1.13, 1.05],
              x: [0, -18, 0],
              y: [0, 12, 0],
            }}
            transition={{ duration: 95, repeat: Infinity, ease: "easeInOut" }}
          />
        )}

        {/* ambient blobs drift over the wallpaper (wash off — the
            wallpaper itself is visible beneath) */}
        <Aurora dim wash={false} />
      </motion.div>

      {/* desktop icons (~/Desktop folder) */}
      {state.booted && <DesktopIcons />}

      {/* window layer — minimized + other-workspace windows stay mounted
          (Window.tsx animates minimized ones to zero; iframes/audio live) */}
      <AnimatePresence>
        {state.windows.map((w) => (
          <Window key={w.id} win={w} hidden={w.workspace !== state.workspace}>
            <AppSurface win={w} />
          </Window>
        ))}
      </AnimatePresence>

      <Dock />

      <RemoteCursors />

      {/* shell feature pack — widgets board (left edge), clipboard
          history (Ctrl+Shift+V), idle screensaver. All self-gated:
          they render nothing until opened/activated. */}
      <WidgetsPanel />
      <ClipboardPop />
      <Screensaver />

      {/* workspace switch veil — sweeps across while the layer swaps */}
      <WorkspaceVeil workspace={state.workspace} />

      {/* brightness veil (local pref) */}
      {brightness < 1 && (
        <div
          aria-hidden
          className="pointer-events-none absolute inset-0 z-[55] bg-stone-900"
          style={{ opacity: (1 - brightness) * 0.45 }}
        />
      )}

      {/* boot overlay — the prism draws itself in (pathLength spring +
          iris facets + glow pulse), the wordmark fades in beneath, the
          shimmer bar + kernel log lines keep their cadence. Total 2.4 s. */}
      <AnimatePresence>
        {!state.booted && (
          <motion.div
            key="boot"
            className="absolute inset-0 z-[60] glass-strong flex flex-col items-center justify-center gap-7 px-6"
            initial={{ opacity: 1 }}
            exit={{ opacity: 0, scale: 1.03 }}
            transition={{ duration: 0.5, ease: EASE_OUT_EXPO }}
          >
            <LogoMarkDrawing size={84} />

            <div className="flex flex-col items-center gap-1.5">
              <motion.div
                initial={{ opacity: 0, y: 10 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.75, duration: 0.45, ease: EASE_OUT_EXPO }}
              >
                <Wordmark className="text-2xl sm:text-3xl" />
              </motion.div>
              <motion.span
                initial={{ opacity: 0, y: 8 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.95, duration: 0.4, ease: EASE_OUT_EXPO }}
                className="gd-mono text-lg sm:text-xl font-medium tracking-tight text-stone-500"
              >
                {state.machine.hostname}
              </motion.span>
            </div>

            <div className="w-56 sm:w-72 h-1.5 rounded-full bg-white/70 border border-white/60 overflow-hidden relative">
              <motion.div
                className="h-full gd-accent-gradient rounded-full"
                initial={{ width: "0%" }}
                animate={{ width: "100%" }}
                transition={{ duration: BOOT_MS / 1000, ease: "easeInOut" }}
              />
              <div className="gd-shimmer pointer-events-none absolute inset-0" aria-hidden />
            </div>

            <div className="flex flex-col gap-1.5 min-h-[4rem]">
              {logs.map((line, i) => (
                <motion.div
                  key={line}
                  initial={{ opacity: 0, x: -6 }}
                  animate={{ opacity: 1, x: 0 }}
                  transition={{ delay: LOG_DELAYS[i] ?? 0.35, duration: 0.3, ease: "easeOut" }}
                  className={`gd-mono text-xs text-stone-500 whitespace-pre ${
                    i === logs.length - 1 ? "gd-caret" : ""
                  }`}
                >
                  {line}
                </motion.div>
              ))}
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

/** A soft glass wipe that plays once per workspace change. Keyed remount
 *  (on the workspace value) re-arms the animation naturally. */
function WorkspaceVeil({ workspace }: { workspace: number }) {
  return (
    <motion.div
      key={workspace}
      aria-hidden
      initial={{ opacity: 0.55 }}
      animate={{ opacity: 0 }}
      transition={{ duration: 0.45, ease: "easeOut" }}
      className="pointer-events-none absolute inset-0 z-[58] bg-white"
    />
  );
}
