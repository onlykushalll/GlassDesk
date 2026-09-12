"use client";

// ============================================================
// GlassDesk — reusable glass context menu (portal-anchored,
// viewport-clamped, spring-animated). Used by the desktop
// surface, desktop icons, window titlebars and the taskbar.
//
// Motion (10-c): the panel rises in (scale .96→1, y 4→0) with
// SPRING.snappy and the rows CASCADE — each row rises 3px on a
// 12ms stagger, capped at min(12ms, 180ms/rows) so even huge
// menus settle inside ~200ms. Rows are pressable (whileTap
// PRESS.tapLg via pressable()) and their icon slot nudges 1px
// right on hover (transform only). No submenus exist in this
// menu's contract — none invented here.
// ============================================================

import { useEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import { PRESS, SPRING, pressable } from "@/lib/vpc/motion";

export interface MenuItem {
  id: string;
  label?: string;
  icon?: ReactNode;
  danger?: boolean;
  disabled?: boolean;
  separator?: true;
  onSelect?: () => void;
}

interface ContextMenuState {
  x: number;
  y: number;
  items: MenuItem[];
}

let openId = 0; // bump to close any previous menu (singleton behavior)

/** Imperative open — returns nothing; the singleton <ContextMenuHost/>
 *  mounted once in SessionView renders it. */
const listeners = new Set<(s: ContextMenuState | null) => void>();

export function openContextMenu(x: number, y: number, items: MenuItem[]): void {
  openId += 1;
  const myId = openId;
  // next frame — avoids the same click that opened us immediately closing us
  requestAnimationFrame(() => {
    if (myId !== openId) return;
    listeners.forEach((l) => l({ x, y, items }));
  });
}

function closeContextMenu(): void {
  openId += 1;
  listeners.forEach((l) => l(null));
}

export function closeAllContextMenus(): void {
  closeContextMenu();
}

/** Row cascade stagger: 12ms per row, compressing so the stagger
 *  chain never exceeds ~180ms total (menus with >15 rows shrink
 *  the per-row delay instead of crawling). */
function cascadeStagger(rowCount: number): number {
  return Math.min(0.012, 0.18 / Math.max(1, rowCount));
}

/** Row entrance — rise 3px + fade, spring-settled. Children inherit
 *  the panel's stagger; no initial/animate props (variant labels
 *  propagate from the parent). */
const rowVariants: Variants = {
  hidden: { opacity: 0, y: 3 },
  show: { opacity: 1, y: 0, transition: SPRING.snappy },
};

/** Dividers participate subtly — wipe in (transform-only). */
const sepVariants: Variants = {
  hidden: { opacity: 0, scaleX: 0.72 },
  show: { opacity: 1, scaleX: 1, transition: SPRING.snappy },
};

export function ContextMenuHost() {
  const [menu, setMenu] = useState<ContextMenuState | null>(null);
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const ref = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const onMenu = (s: ContextMenuState | null): void => {
      setMenu(s);
      if (!s) setPos(null); // closing — drop the stale position in the same event
    };
    listeners.add(onMenu);
    return () => {
      listeners.delete(onMenu);
    };
  }, []);

  // global dismiss: any pointerdown outside, Escape, scroll, resize
  useEffect(() => {
    if (!menu) return;
    const onDown = (e: PointerEvent) => {
      if (ref.current && e.target instanceof Node && ref.current.contains(e.target)) return;
      closeContextMenu();
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") closeContextMenu();
    };
    window.addEventListener("pointerdown", onDown, true);
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("resize", closeContextMenu);
    return () => {
      window.removeEventListener("pointerdown", onDown, true);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("resize", closeContextMenu);
    };
  }, [menu]);

  // position lifecycle:
  //  • derive an estimate PURELY from the items (render-safe, no ref reads)
  //  • refine with the real measured size one frame later (rAF callback)
  //  • clear when the menu closes
  const estimate: { w: number; h: number } | null = menu
    ? {
        w: 210,
        h: menu.items.reduce(
          (a, it) => a + (it.separator ? 9 : 34),
          12, // padding
        ),
      }
    : null;

  useEffect(() => {
    if (!menu) return;
    const raf = requestAnimationFrame(() => {
      const el = ref.current;
      const w = el?.offsetWidth ?? 210;
      const h = el?.offsetHeight ?? estimate?.h ?? 170;
      setPos({
        x: Math.max(8, Math.min(menu.x, window.innerWidth - w - 8)),
        y: Math.max(8, Math.min(menu.y, window.innerHeight - h - 8)),
      });
    });
    return () => cancelAnimationFrame(raf);
  }, [menu]);

  // first paint position from the pure estimate (no ref access in render)
  const initialPos =
    menu && !pos
      ? {
          x: Math.max(8, Math.min(menu.x, window.innerWidth - (estimate?.w ?? 210) - 8)),
          y: Math.max(8, Math.min(menu.y, window.innerHeight - (estimate?.h ?? 170) - 8)),
        }
      : null;
  const renderPos = pos ?? initialPos;
  if (typeof document === "undefined") return null;

  // panel: rises + fades, then staggers the rows in
  const panelVariants: Variants = {
    hidden: { opacity: 0, scale: 0.96, y: 4 },
    show: {
      opacity: 1,
      scale: 1,
      y: 0,
      transition: {
        ...SPRING.snappy,
        staggerChildren: cascadeStagger(menu?.items.length ?? 1),
        delayChildren: 0.02,
      },
    },
    exit: { opacity: 0, scale: 0.96, y: 2, transition: { duration: 0.12 } },
  };

  return createPortal(
    <AnimatePresence>
      {menu && renderPos && (
        <motion.div
          ref={ref}
          role="menu"
          variants={panelVariants}
          initial="hidden"
          animate="show"
          exit="exit"
          style={{ left: renderPos.x, top: renderPos.y }}
          className="gd-menu glass-strong fixed z-[200] min-w-[190px] rounded-xl p-1.5 origin-top-left"
        >
          {menu.items.map((item) =>
            item.separator ? (
              <motion.div
                key={item.id}
                variants={sepVariants}
                className="my-1 h-px bg-stone-900/10"
                role="separator"
              />
            ) : (
              <motion.button
                key={item.id}
                type="button"
                role="menuitem"
                variants={rowVariants}
                disabled={item.disabled}
                onClick={() => {
                  closeContextMenu();
                  item.onSelect?.();
                }}
                {...pressable(PRESS.tapLg)}
                className={`group/item flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[13px] transition-colors ${
                  item.danger
                    ? "text-rose-600 hover:bg-rose-500/10"
                    : "text-stone-700 hover:bg-white/80 disabled:opacity-40 disabled:hover:bg-transparent"
                }`}
              >
                {item.icon && (
                  <span className="grid size-4 shrink-0 place-items-center text-stone-400 transition-transform duration-150 group-hover/item:translate-x-[1px]">
                    {item.icon}
                  </span>
                )}
                <span className="min-w-0 truncate">{item.label}</span>
              </motion.button>
            ),
          )}
        </motion.div>
      )}
    </AnimatePresence>,
    document.body,
  );
}
