"use client";

// ============================================================
// GlassDesk — shared motion language. One source of truth so
// every app + the shell move with the SAME physics. Motion
// designer pass: springs only (no linear tweening anywhere),
// transform/opacity only (zero layout thrash), GPU-friendly.
// ============================================================

import type { TargetAndTransition, Transition, Variants } from "framer-motion";

/** The house springs. Named, tuned, reused everywhere. */
export const SPRING = {
  /** snappy UI micro-interactions (hover pops, chips, toggles) */
  snappy: { type: "spring", stiffness: 520, damping: 30, mass: 0.9 },
  /** window/panel entrances — confident, slightly bouncy */
  window: { type: "spring", stiffness: 460, damping: 26, mass: 1 },
  /** big surfaces (start menu, widgets, sheets) — weighty but fast */
  sheet: { type: "spring", stiffness: 380, damping: 28, mass: 1.15 },
  /** playful accents (dock bounce, genie tails, confetti) */
  playful: { type: "spring", stiffness: 560, damping: 14, mass: 1.1 },
  /** teleports/z reorder — no fade, pure position */
  glide: { type: "spring", stiffness: 700, damping: 40, mass: 1 },
} satisfies Record<string, Transition>;

/** Standard entrance: rise + settle. transform-only. */
export const riseIn: Variants = {
  hidden: { opacity: 0, y: 14, scale: 0.985 },
  show: {
    opacity: 1,
    y: 0,
    scale: 1,
    transition: SPRING.window,
  },
  exit: { opacity: 0, y: 10, scale: 0.99, transition: { duration: 0.16 } },
};

/** Stagger container for lists/grids. */
export const stagger = (staggerChildren = 0.03, delayChildren = 0.02): Variants => ({
  hidden: {},
  show: { transition: { staggerChildren, delayChildren } },
});

/** Pop for small chips/buttons. */
export const pop: Variants = {
  rest: { scale: 1 },
  hover: { scale: 1.045, transition: SPRING.snappy },
  tap: { scale: 0.96, transition: SPRING.snappy },
};

/** For layout-animated lists (FLIP) — spring, not tween. */
export const FLIP: Transition = { type: "spring", stiffness: 420, damping: 32 };

/** Press physics (10-c) — one tap scale for small chips, one for
 *  large rows/surfaces, plus the 1px hover lift every pressable
 *  shares. Transform-only; for future waves, append-only token. */
export const PRESS = { tap: 0.96, tapLg: 0.98, hoverLift: -1 } as const;

/** whileTap/whileHover combo for pressable elements — spread onto a
 *  motion component. Small chips use the default (PRESS.tap); rows
 *  and large surfaces pass PRESS.tapLg. Snappy spring, transforms
 *  only (scale + 1px y-lift). */
export function pressable(scale: number = PRESS.tap): {
  whileTap: TargetAndTransition;
  whileHover: TargetAndTransition;
} {
  return {
    whileTap: { scale, transition: SPRING.snappy },
    whileHover: { y: PRESS.hoverLift, transition: SPRING.snappy },
  };
}
