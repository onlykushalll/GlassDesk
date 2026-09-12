"use client";

// ============================================================
// GlassDesk — brand assets. The mark is a faceted glass kite
// (prism/diamond): teal + emerald facets meeting at an inner
// point, one lighter top facet to sell "glass". Reads at 20px
// (favicon) and 200px (boot).
//
//   • LogoMark({ size, className })      — the static prism
//   • LogoMarkDrawing({ size, className })— boot version: outline
//     draws via pathLength spring, facets iris in, glow pulses,
//     whole mark scale-settles (all transform/opacity)
//   • Wordmark({ className })            — "GlassDesk" gradient text
//   • LogoLockup({ size, mark, word, className }) — mark + word row
//
// Deterministic svg gradient ids (identical <defs> in every
// instance) — safe to share document-wide.
// ============================================================

import { motion } from "framer-motion";
import type { ReactNode } from "react";
import { SPRING } from "@/lib/vpc/motion";
import { cn } from "@/lib/utils";

// ---------------- kite geometry (64 box) ----------------

// T (32,2.5) · L (3,32) · R (61,32) · B (32,61.5)
// LM/RM sit 40% down the top edges · C is the inner meeting point.
const K_OUTLINE = "M32 2.5L61 32L32 61.5L3 32Z";
const K_LEFT = "M20.4 14.3L3 32L32 61.5L32 34Z";
const K_RIGHT = "M43.6 14.3L61 32L32 61.5L32 34Z";
const K_TOP = "M32 2.5L43.6 14.3L32 34L20.4 14.3Z";
const K_SEAMS = "M20.4 14.3L32 34L43.6 14.3M32 34L32 61.5";

const MARK_SHADOW = "drop-shadow(0 2px 6px rgb(13 148 136 / 0.3))";

// ---------------- the static mark ----------------

export function LogoMark({ size = 40, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <svg
      viewBox="0 0 64 64"
      width={size}
      height={size}
      role="img"
      aria-label="GlassDesk"
      className={className}
      style={{ filter: MARK_SHADOW }}
    >
      <defs>
        <linearGradient id="gd-logo-left" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#5eead4" />
          <stop offset="1" stopColor="#0d9488" />
        </linearGradient>
        <linearGradient id="gd-logo-right" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#34d399" />
          <stop offset="1" stopColor="#047857" />
        </linearGradient>
        <linearGradient id="gd-logo-top" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
          <stop offset="1" stopColor="#ffffff" stopOpacity="0.18" />
        </linearGradient>
      </defs>
      <path d={K_LEFT} fill="url(#gd-logo-left)" />
      <path d={K_RIGHT} fill="url(#gd-logo-right)" />
      <path d={K_TOP} fill="url(#gd-logo-top)" />
      <path d={K_OUTLINE} fill="none" stroke="#ffffff" strokeOpacity="0.35" strokeWidth="1.5" />
      <path d={K_SEAMS} fill="none" stroke="#ffffff" strokeOpacity="0.22" strokeWidth="1" />
    </svg>
  );
}

// ---------------- the boot mark (draws + irises in) ----------------

/** Phase plan (total ~1.3 s, boot overlay runs 2.4 s):
 *  0.00–0.75  teal outline draws itself (pathLength spring)
 *  0.45–1.00  the three facets iris in (opacity)
 *  0.80–1.20  white outline + seams settle over the color
 *  0.90–1.20  the draw-stroke dissolves; glow pulses throughout
 *  whole mark scale-settles from 0.72 (SPRING.window) */
export function LogoMarkDrawing({ size = 80, className }: { size?: number; className?: string }): React.JSX.Element {
  return (
    <motion.span
      initial={{ scale: 0.72 }}
      animate={{ scale: 1 }}
      transition={SPRING.window}
      className={cn("relative inline-block shrink-0 select-none", className)}
      style={{ width: size, height: size }}
      aria-label="GlassDesk"
      role="img"
    >
      {/* glow pulse — soft teal halo breathing behind the prism */}
      <motion.span
        aria-hidden
        className="pointer-events-none absolute -inset-7 rounded-full blur-2xl"
        style={{ background: "radial-gradient(circle at 50% 50%, rgba(20,184,166,0.5), rgba(20,184,166,0) 70%)" }}
        initial={{ opacity: 0 }}
        animate={{ opacity: [0, 0.85, 0.35, 0.55, 0.3] }}
        transition={{ duration: 1.7, times: [0, 0.2, 0.5, 0.75, 1], ease: "easeOut" }}
      />
      <svg viewBox="0 0 64 64" className="relative h-full w-full">
        <defs>
          <linearGradient id="gd-logo-left" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#5eead4" />
            <stop offset="1" stopColor="#0d9488" />
          </linearGradient>
          <linearGradient id="gd-logo-right" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#34d399" />
            <stop offset="1" stopColor="#047857" />
          </linearGradient>
          <linearGradient id="gd-logo-top" x1="0" y1="0" x2="0" y2="1">
            <stop offset="0" stopColor="#ffffff" stopOpacity="0.55" />
            <stop offset="1" stopColor="#ffffff" stopOpacity="0.18" />
          </linearGradient>
        </defs>

        {/* facets iris in */}
        <motion.path
          d={K_LEFT}
          fill="url(#gd-logo-left)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45, duration: 0.55, ease: "easeOut" }}
        />
        <motion.path
          d={K_RIGHT}
          fill="url(#gd-logo-right)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.45, duration: 0.55, ease: "easeOut" }}
        />
        <motion.path
          d={K_TOP}
          fill="url(#gd-logo-top)"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.5, duration: 0.5, ease: "easeOut" }}
        />

        {/* the draw-stroke — pathLength spring, then it dissolves */}
        <motion.path
          d={K_OUTLINE}
          fill="none"
          stroke="#14b8a6"
          strokeWidth={2}
          strokeLinecap="round"
          initial={{ pathLength: 0, opacity: 1 }}
          animate={{ pathLength: 1, opacity: [1, 1, 0] }}
          transition={{
            pathLength: { type: "spring", stiffness: 64, damping: 18 },
            opacity: { delay: 0.9, duration: 0.3, times: [0, 0.99, 1] },
          }}
        />

        {/* final white outline + facet seams settle on top */}
        <motion.path
          d={K_OUTLINE}
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.35"
          strokeWidth="1.5"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.8, duration: 0.4, ease: "easeOut" }}
        />
        <motion.path
          d={K_SEAMS}
          fill="none"
          stroke="#ffffff"
          strokeOpacity="0.22"
          strokeWidth="1"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          transition={{ delay: 0.85, duration: 0.4, ease: "easeOut" }}
        />
      </svg>
    </motion.span>
  );
}

// ---------------- wordmark + lockup ----------------

export function Wordmark({ className }: { className?: string }): React.JSX.Element {
  return <span className={cn("gd-text-gradient font-semibold tracking-tight", className)}>GlassDesk</span>;
}

export interface LogoLockupProps {
  /** mark size (only used when `mark` is not overridden) */
  size?: number;
  /** custom content for the mark slot (defaults to <LogoMark/>) */
  mark?: ReactNode;
  /** custom content for the word slot (defaults to <Wordmark/>) */
  word?: ReactNode;
  className?: string;
}

/** Mark + wordmark in a row. */
export function LogoLockup({ size = 28, mark, word, className }: LogoLockupProps): React.JSX.Element {
  return (
    <span className={cn("inline-flex items-center gap-2.5", className)}>
      {mark ?? <LogoMark size={size} />}
      {word ?? <Wordmark />}
    </span>
  );
}
