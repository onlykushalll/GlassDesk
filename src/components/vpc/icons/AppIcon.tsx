"use client";

// ============================================================
// GlassDesk — bespoke squircle app-icon tiles ("the icon engine").
//
// THE CONTRACT (10-b / 10-c code against this):
//   export type IconId  = AppKind | "folder" | "file" | "text" | "image"
//                       | "audio" | "video" | "archive" | "disk";
//   export function AppIcon({ id, size = 44, className, gloss = true })
//
// Pure, deterministic, zero context/store reads, memoized. Every
// icon is an inline 64×64 SVG squircle tile: per-id vertical
// linearGradient + liquid-glass top sheen + 1px inner stroke, with
// the app's lucide glyph centered as white strokes (drop-shadowed
// for depth). NO blue/indigo hues anywhere — teal/emerald lead,
// warm accents follow (hard project rule).
//
// Gradient ids are deterministic per icon id and every instance
// embeds identical <defs>, so document-wide id sharing is safe.
// At size ≤ 20 the gloss overlay is skipped and the glyph stroke
// thickens to 2.2 — small tiles stay crisp.
// ============================================================

import { memo } from "react";
import {
  Activity,
  Archive,
  Bomb,
  Calculator,
  CalendarDays,
  Camera,
  Clock3,
  CloudSun,
  Code2,
  Compass,
  File,
  FileText,
  Folder,
  Gamepad2,
  HardDrive,
  Hash,
  Image,
  Mail,
  Map as MapIcon,
  Mic,
  Music,
  Palette,
  PenTool,
  Settings,
  ShieldCheck,
  ShoppingBag,
  Sparkles,
  SquareTerminal,
  StickyNote,
  Users,
  Video,
  Youtube,
  type LucideIcon,
} from "lucide-react";
import type { AppKind } from "@/lib/vpc/types";
import { cn } from "@/lib/utils";

// ---------------- the id union (frozen) ----------------

/** Filesystem / volume icon ids. */
export type FsIcon = "folder" | "file" | "text" | "image" | "audio" | "video" | "archive" | "disk";

/** Every icon this system can render: all 28 AppKinds + 9 fs ids. */
export type IconId = AppKind | FsIcon;

// ---------------- spec table (exhaustive by type) ----------------

export interface IconSpec {
  /** gradient top color (hex) */
  from: string;
  /** gradient bottom color (hex) */
  to: string;
  /** the lucide glyph rendered white (or glyphClass) centered */
  glyph: LucideIcon;
  /** optional glyph color override (e.g. emerald terminal prompt) */
  glyphClass?: string;
  /** tile silhouette: squircle (apps) | folder shape | document page */
  shape?: "tile" | "folder" | "doc";
}

/** id → tile recipe. `Record<IconId, …>` → TS errors if any AppKind goes missing. */
export const ICON_SPECS: Record<IconId, IconSpec> = {
  // ---- apps (28) ----
  files: { from: "#fbbf24", to: "#d97706", glyph: Folder }, // amber-400 → amber-600
  textedit: { from: "#d6d3d1", to: "#78716c", glyph: FileText }, // stone-300 → stone-500
  terminal: { from: "#44403c", to: "#1c1917", glyph: SquareTerminal, glyphClass: "text-emerald-400" }, // stone-700 → stone-900
  whiteboard: { from: "#c4b5fd", to: "#e879f9", glyph: PenTool }, // violet-300 → fuchsia-400
  browser: { from: "#2dd4bf", to: "#059669", glyph: Compass }, // teal-400 → emerald-600
  media: { from: "#fb7185", to: "#e11d48", glyph: Music }, // rose-400 → rose-600
  calculator: { from: "#a8a29e", to: "#57534e", glyph: Calculator }, // stone-400 → stone-600
  settings: { from: "#34d399", to: "#0d9488", glyph: Settings }, // emerald-400 → teal-600
  taskmgr: { from: "#34d399", to: "#059669", glyph: Activity }, // emerald-400 → emerald-600
  photos: { from: "#fb923c", to: "#f43f5e", glyph: Image }, // orange-400 → rose-500
  notes: { from: "#fde047", to: "#f59e0b", glyph: StickyNote }, // yellow-300 → amber-500
  calendar: { from: "#fb7185", to: "#ef4444", glyph: CalendarDays }, // rose-400 → red-500
  clock: { from: "#5eead4", to: "#14b8a6", glyph: Clock3 }, // teal-300 → teal-500
  weather: { from: "#67e8f9", to: "#14b8a6", glyph: CloudSun }, // cyan-300 → teal-500 (teal-leaning)
  paint: { from: "#e879f9", to: "#8b5cf6", glyph: Palette }, // fuchsia-400 → violet-500
  mines: { from: "#78716c", to: "#44403c", glyph: Bomb }, // stone-500 → stone-700
  snake: { from: "#4ade80", to: "#059669", glyph: Gamepad2 }, // green-400 → emerald-600
  g2048: { from: "#fcd34d", to: "#f97316", glyph: Hash }, // amber-300 → orange-500
  youtube: { from: "#f87171", to: "#e11d48", glyph: Youtube }, // red-400 → rose-600 (Tube)
  ai: { from: "#a78bfa", to: "#c026d3", glyph: Sparkles }, // violet-400 → fuchsia-600
  code: { from: "#57534e", to: "#292524", glyph: Code2, glyphClass: "text-emerald-400" }, // stone-600 → stone-800
  mail: { from: "#5eead4", to: "#10b981", glyph: Mail }, // teal-300 → emerald-500
  camera: { from: "#78716c", to: "#44403c", glyph: Camera }, // stone-500 → stone-700
  voice: { from: "#fb7185", to: "#db2777", glyph: Mic }, // rose-400 → pink-600
  maps: { from: "#4ade80", to: "#0d9488", glyph: MapIcon }, // green-400 → teal-600 (OSM green)
  contacts: { from: "#fcd34d", to: "#fb923c", glyph: Users }, // amber-300 → orange-400
  security: { from: "#6ee7b7", to: "#0d9488", glyph: ShieldCheck }, // emerald-300 → teal-600
  store: { from: "#2dd4bf", to: "#059669", glyph: ShoppingBag }, // teal-400 → emerald-600

  // ---- filesystem / volume (9) ----
  // Documents render as macOS-style white pages: accent-colored header
  // band + folded corner + colored glyph (NOT grey squircles — the desktop
  // must feel alive, and pages read instantly as "file" next to app tiles).
  folder: { from: "#fde68a", to: "#f59e0b", glyph: Folder, shape: "folder" }, // real folder silhouette
  file: { from: "#a8a29e", to: "#57534e", glyph: File, shape: "doc" }, // stone accent page
  text: { from: "#6ee7b7", to: "#059669", glyph: FileText, shape: "doc" }, // emerald accent page
  image: { from: "#5eead4", to: "#0d9488", glyph: Image, shape: "doc" }, // teal accent page
  audio: { from: "#fda4af", to: "#e11d48", glyph: Music, shape: "doc" }, // rose accent page
  video: { from: "#c4b5fd", to: "#7c3aed", glyph: Video, shape: "doc" }, // violet accent page
  archive: { from: "#fdba74", to: "#ea580c", glyph: Archive, shape: "doc" }, // orange accent page
  disk: { from: "#a8a29e", to: "#57534e", glyph: HardDrive }, // stone (drive tile)
};

/** id → [from, to] hex pair — window tints, chips, anywhere a raw color is needed. */
export const GRADIENT_MAP: Record<IconId, [string, string]> = Object.fromEntries(
  (Object.keys(ICON_SPECS) as IconId[]).map((k) => [k, [ICON_SPECS[k].from, ICON_SPECS[k].to]]),
) as Record<IconId, [string, string]>;

// ---------------- squircle geometry (64 box) ----------------

/** Rounded-rect tile path, rx ≈ 15.5 on the 64 box (2..62). */
const SQUIRCLE = "M17.5 2h29a15.5 15.5 0 0 1 15.5 15.5v29a15.5 15.5 0 0 1-15.5 15.5h-29A15.5 15.5 0 0 1 2 46.5v-29A15.5 15.5 0 0 1 17.5 2Z";
/** Inner stroke path — inset 0.5 so the 1px highlight hugs the edge. */
const SQUIRCLE_INNER = "M17.5 2.5h29a15 15 0 0 1 15 15v29a15 15 0 0 1-15 15h-29a15 15 0 0 1-15-15v-29a15 15 0 0 1 15-15Z";

/** Shared sheen def id — identical definition in every instance. */
const GLOSS_ID = "gd-ic-gloss";

/** macOS-style folder: back panel + tab, front panel slightly lighter. */
const FOLDER_BACK = "M9 13h17.5l6 7H55a4 4 0 0 1 4 4v5H5v-12a4 4 0 0 1 4-4Z";
const FOLDER_FRONT = "M5 27h54a0 0 0 0 1 0 0v22a4 4 0 0 1-4 4H9a4 4 0 0 1-4-4V27a0 0 0 0 1 0 0Z";

/** macOS-style document page: rounded portrait sheet + folded corner. */
const DOC_PAGE = "M18 6h19l12 12v37a3 3 0 0 1-3 3H18a3 3 0 0 1-3-3V9a3 3 0 0 1 3-3Z";
const DOC_FOLD = "M37 6l12 12h-9a3 3 0 0 1-3-3V6Z";
const DOC_BAND = "M15 17V9a3 3 0 0 1 3-3h19l12 12v-1H15Z";

export interface AppIconProps {
  id: IconId;
  size?: number;
  className?: string;
  /** render the liquid-glass top highlight (skipped automatically at size ≤ 20) */
  gloss?: boolean;
}

function AppIconImpl({ id, size = 44, className, gloss = true }: AppIconProps): React.JSX.Element {
  const spec = ICON_SPECS[id];
  const small = size <= 20;
  const showGloss = gloss && !small;
  const Glyph = spec.glyph;
  const gid = `gd-ic-${id}`;
  const shape = spec.shape ?? "tile";

  // Documents: white page — glyph tinted with the accent, sized to the sheet.
  const isDoc = shape === "doc";
  const glyphSize = isDoc ? Math.round(size * 0.4) : Math.round(size * 0.52);

  return (
    <span
      aria-hidden
      className={cn("relative inline-block shrink-0 select-none", className)}
      style={{ width: size, height: size }}
    >
      {/* the artwork — squircle / folder / document page */}
      <svg
        viewBox="0 0 64 64"
        className="absolute inset-0 h-full w-full"
        style={small ? undefined : { filter: "drop-shadow(0 2px 5px rgb(0 0 0 / 0.16))" }}
      >
        <defs>
          <linearGradient id={gid} x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor={spec.from} />
            <stop offset="1" stopColor={spec.to} />
          </linearGradient>
          {isDoc && (
            <linearGradient id={`${gid}-page`} x1="0" y1="0" x2="0.35" y2="1">
              <stop offset="0" stopColor="#ffffff" />
              <stop offset="1" stopColor="#f0efee" />
            </linearGradient>
          )}
          {showGloss && (
            <linearGradient id={GLOSS_ID} x1="0" y1="0" x2="0" y2="0.55">
              <stop offset="0" stopColor="#ffffff" stopOpacity="0.35" />
              <stop offset="1" stopColor="#ffffff" stopOpacity="0" />
            </linearGradient>
          )}
        </defs>

        {shape === "tile" && (
          <>
            <path d={SQUIRCLE} fill={`url(#${gid})`} />
            {showGloss && <path d={SQUIRCLE} fill={`url(#${GLOSS_ID})`} />}
            <path d={SQUIRCLE_INNER} fill="none" stroke="#ffffff" strokeOpacity="0.4" strokeWidth="1" />
          </>
        )}

        {shape === "folder" && (
          <>
            {/* back panel + tab (deeper amber), then lighter front */}
            <path d={FOLDER_BACK} fill={spec.to} />
            <path d={FOLDER_FRONT} fill={`url(#${gid})`} />
            {showGloss && (
              <path d="M7 29h50v10H7Z" fill={`url(#${GLOSS_ID})`} clipPath="none" opacity="0.9" />
            )}
            <path
              d={FOLDER_FRONT}
              fill="none"
              stroke="#ffffff"
              strokeOpacity="0.35"
              strokeWidth="1"
            />
          </>
        )}

        {isDoc && (
          <>
            <path d={DOC_PAGE} fill={`url(#${gid}-page)`} />
            {/* accent header band + matching fold shadow */}
            <path d={DOC_BAND} fill={`url(#${gid})`} />
            <path d={DOC_FOLD} fill="#f5f5f4" />
            <path d={DOC_PAGE} fill="none" stroke="#ffffff" strokeOpacity="0.9" strokeWidth="1" />
            <path d={DOC_PAGE} fill="none" stroke="#1c1917" strokeOpacity="0.08" strokeWidth="1" transform="translate(0.5,0.5)" />
          </>
        )}
      </svg>

      {/* the glyph — colored strokes for docs, white for tiles, dead-center.
          Folder silhouettes carry no glyph (a folder IS the glyph). */}
      {shape !== "folder" && (
        <span
          className="absolute inset-0 grid place-items-center"
          style={{
            filter: isDoc
              ? "drop-shadow(0 1px 0.5px rgb(0 0 0 / 0.18))"
              : "drop-shadow(0 1px 1px rgb(0 0 0 / 0.25))",
            // nudge glyphs to the page's optical center (sheet sits x 15..48)
            transform: isDoc ? "translateX(-8%) translateY(6%)" : undefined,
          }}
        >
          <Glyph
            size={glyphSize}
            strokeWidth={small ? 2.2 : 2}
            className={isDoc ? "" : cn("text-white", spec.glyphClass)}
            color={isDoc ? spec.to : undefined}
          />
        </span>
      )}
    </span>
  );
}

/** Memoized (props are primitives). Decorative by design — callers label it. */
export const AppIcon = memo(AppIconImpl);
AppIcon.displayName = "AppIcon";
