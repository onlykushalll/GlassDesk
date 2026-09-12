"use client";

// ============================================================
// Landing — the GlassDesk hero + session bootstrap card.
// One screen: type your name, keep the fresh 6-digit code to host
// (pick a RAM tier) or paste the code you were given to join,
// press one button. Everything else — socket lifecycle, name
// persistence, validation, error strings — lives in the frozen
// store (src/lib/vpc/store.ts). This file is pure presentation.
// ============================================================

import { useEffect, useState, type FormEvent } from "react";
import { motion, type Variants } from "framer-motion";
import {
  AlertTriangle,
  Cpu,
  History,
  Loader2,
  LogIn,
  User,
  X,
  Zap,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { LogoMark, LogoLockup, Wordmark } from "@/components/vpc/brand/Logo";
import { RAM_TIERS, type RamMB } from "@/lib/vpc/types";
import { rememberedName, useGlassDesk } from "@/lib/vpc/store";
import { cn } from "@/lib/utils";
import Aurora from "@/components/vpc/Aurora";

// ---- staggered entrance (springs only, per design rules) ----
const container: Variants = {
  hidden: {},
  show: { transition: { staggerChildren: 0.09, delayChildren: 0.08 } },
};

const item: Variants = {
  hidden: { opacity: 0, y: 18 },
  show: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 240, damping: 26 } },
};

const FEATURES = [
  {
    icon: Cpu,
    title: "Software-defined hardware",
    text: "512 MB – 4 GB RAM reserved on node local-1 · 16 GB GlassDesk HD volume",
  },
  {
    icon: Zap,
    title: "Zero-latency sync",
    text: "every window, file and stroke syncs instantly — local-apply first",
  },
  {
    icon: History,
    title: "Preservance",
    text: "snapshotted every ~1.5 s — reload the page and everything's back",
  },
] as const;

function randomCode(): string {
  return String(100000 + Math.floor(Math.random() * 900000));
}

const MICRO_LABEL =
  "mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.08em] text-stone-500";

export default function Landing() {
  const create = useGlassDesk((s) => s.create);
  const join = useGlassDesk((s) => s.join);
  const error = useGlassDesk((s) => s.error);
  const status = useGlassDesk((s) => s.status);
  const clearError = useGlassDesk((s) => s.clearError);

  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [ramMB, setRamMB] = useState<RamMB>(2048);
  const [pending, setPending] = useState<"create" | "join" | null>(null);

  // Mount-only prefill: remembered name + a fresh random code.
  // Done in an effect (not state initializers) so SSR markup stays
  // deterministic — no hydration mismatch on the prefilled values.
  // Name persistence on submit happens inside the store (persistName).
  /* eslint-disable react-hooks/set-state-in-effect -- client-only bootstrap
     from localStorage + Math.random; lazy initializers would SSR-mismatch */
  useEffect(() => {
    setName(rememberedName());
    setCode(randomCode());
  }, []);
  /* eslint-enable react-hooks/set-state-in-effect */

  // The store flips status off "connecting" by itself (success → phase
  // change, failure → error). The pressed-button spinner is DERIVED from
  // that status — no effect needed to release it.
  const busy = status === "connecting";
  const activePending = busy ? pending : null;

  const handleCreate = (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (busy) return;
    setPending("create");
    create(code, name, { ramMB });
  };

  const handleJoin = () => {
    if (busy) return;
    setPending("join");
    join(code, name);
  };

  return (
    <div className="relative flex min-h-screen w-full flex-col overflow-hidden">
      <Aurora />

      <motion.div
        variants={container}
        initial="hidden"
        animate="show"
        className="z-10 mx-auto flex w-full max-w-5xl flex-1 flex-col items-center justify-center px-4 py-12 sm:px-6"
      >
        {/* ---------- hero ---------- */}
        <motion.div variants={item} className="flex flex-col items-center text-center">
          <LogoLockup
            size={52}
            mark={<LogoMark size={52} className="drop-shadow-lg" />}
            word={<Wordmark className="text-2xl sm:text-3xl" />}
          />
          <h1 className="mt-6 max-w-2xl text-4xl font-semibold tracking-tight text-stone-800 sm:text-5xl">
            Two people. <span className="gd-text-gradient">One PC</span> made of glass.
          </h1>
          <p className="mt-4 max-w-xl text-balance text-base leading-relaxed text-stone-500 sm:text-lg">
            Create a software-defined computer in the cloud, share it with a 6-digit code, and talk
            over video while you both drive it.
          </p>
        </motion.div>

        {/* ---------- session card ---------- */}
        <motion.form
          variants={item}
          onSubmit={handleCreate}
          noValidate
          className="glass-strong glass-sheen mt-8 w-full max-w-md rounded-3xl p-6 sm:mt-10"
        >
          {/* card brand row */}
          <div className="mb-5 flex items-center justify-between">
            <LogoLockup size={22} word={<Wordmark className="text-sm" />} />
            <span className="gd-mono rounded-full bg-white/60 px-2 py-0.5 text-[10px] text-stone-400">
              node local-1
            </span>
          </div>

          {/* name */}
          <div>
            <label htmlFor="gd-name" className={MICRO_LABEL}>
              Your name
            </label>
            <div className="relative">
              <User className="pointer-events-none absolute top-1/2 left-3.5 size-4 -translate-y-1/2 text-stone-400" />
              <Input
                id="gd-name"
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="Your name"
                autoComplete="name"
                maxLength={24}
                disabled={busy}
                className="h-11 rounded-xl border-stone-200/80 bg-white/80 pl-10 text-base text-stone-800 shadow-none placeholder:text-stone-400 focus-visible:border-teal-500/70 focus-visible:ring-teal-500/15 disabled:opacity-60"
              />
            </div>
          </div>

          {/* session code */}
          <div className="mt-4">
            <label htmlFor="gd-code" className={MICRO_LABEL}>
              Session code
            </label>
            <Input
              id="gd-code"
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
              placeholder="000000"
              inputMode="numeric"
              autoComplete="off"
              maxLength={6}
              disabled={busy}
              className="gd-mono h-11 rounded-xl border-stone-200/80 bg-white/80 text-center text-lg font-semibold tracking-[0.35em] text-stone-800 shadow-none placeholder:font-normal placeholder:text-stone-300 focus-visible:border-teal-500/70 focus-visible:ring-teal-500/15 disabled:opacity-60"
            />
            <p className="mt-1.5 text-center text-[11px] leading-snug text-stone-400">
              A fresh code is ready to share — or paste the one you were given.
            </p>
          </div>

          {/* RAM tier picker */}
          <div className="mt-4">
            <div className="mb-1.5 flex items-baseline justify-between">
              <span className={cn(MICRO_LABEL, "mb-0")}>Memory</span>
              <span className="gd-mono text-[11px] text-stone-400">applies at first boot</span>
            </div>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              {RAM_TIERS.map((tier) => {
                const selected = ramMB === tier.mb;
                return (
                  <motion.button
                    key={tier.mb}
                    type="button"
                    disabled={busy}
                    aria-pressed={selected}
                    onClick={() => setRamMB(tier.mb)}
                    whileHover={busy ? undefined : { scale: 1.02 }}
                    whileTap={busy ? undefined : { scale: 0.97 }}
                    className={cn(
                      "relative flex min-h-14 cursor-pointer flex-col justify-center gap-0.5 rounded-xl border p-2.5 text-left transition-colors sm:p-3",
                      selected
                        ? "border-teal-500/60 bg-white/90 ring-2 ring-teal-500/25"
                        : "border-stone-200/80 bg-white/55 hover:border-stone-300 hover:bg-white/75",
                      busy && "cursor-not-allowed opacity-60",
                    )}
                  >
                    {selected && (
                      <span
                        aria-hidden="true"
                        className="gd-accent-gradient pointer-events-none absolute inset-0 rounded-xl opacity-[0.12]"
                      />
                    )}
                    <span className="relative text-sm font-semibold text-stone-800">
                      {tier.label}
                    </span>
                    <span className="relative text-[11px] leading-snug text-stone-500">
                      {tier.hint}
                    </span>
                  </motion.button>
                );
              })}
            </div>
          </div>

          {/* error banner */}
          {error && (
            <motion.div
              role="alert"
              initial={{ opacity: 0, y: -6, scale: 0.99 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              transition={{ type: "spring", stiffness: 400, damping: 30 }}
              className="glass relative mt-4 rounded-xl"
            >
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-xl bg-rose-400/10"
              />
              <span
                aria-hidden="true"
                className="pointer-events-none absolute inset-0 rounded-xl border border-rose-300/50"
              />
              <div className="relative flex items-start gap-2.5 py-2.5 pr-1.5 pl-3.5">
                <AlertTriangle className="mt-0.5 size-4 shrink-0 text-rose-500" />
                <p className="flex-1 py-1.5 text-sm leading-snug text-rose-700">{error}</p>
                <button
                  type="button"
                  onClick={clearError}
                  aria-label="Dismiss error"
                  className="-my-1.5 flex size-11 shrink-0 cursor-pointer items-center justify-center rounded-xl text-rose-400 transition-colors hover:bg-rose-400/10 hover:text-rose-600"
                >
                  <X className="size-4" />
                </button>
              </div>
            </motion.div>
          )}

          {/* actions */}
          <div className="mt-6 grid gap-2.5">
            <motion.div
              whileHover={busy ? undefined : { scale: 1.02 }}
              whileTap={busy ? undefined : { scale: 0.97 }}
              className="w-full"
            >
              <Button
                type="submit"
                disabled={busy}
                className="gd-accent-gradient h-12 w-full rounded-xl text-base font-semibold text-white shadow-lg shadow-teal-600/25 hover:shadow-teal-600/35"
              >
                {activePending === "create" ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <Cpu className="size-5" strokeWidth={2.2} />
                )}
                {activePending === "create" ? "Creating…" : "Create a PC"}
              </Button>
            </motion.div>
            <motion.div
              whileHover={busy ? undefined : { scale: 1.02 }}
              whileTap={busy ? undefined : { scale: 0.97 }}
              className="w-full"
            >
              <Button
                type="button"
                variant="outline"
                disabled={busy}
                onClick={handleJoin}
                className="h-12 w-full rounded-xl border-white/70 bg-white/65 text-base font-medium text-stone-700 shadow-sm backdrop-blur-lg hover:bg-white/85 hover:text-stone-800"
              >
                {activePending === "join" ? (
                  <Loader2 className="size-5 animate-spin" />
                ) : (
                  <LogIn className="size-5" strokeWidth={2.2} />
                )}
                {activePending === "join" ? "Joining…" : "Join with code"}
              </Button>
            </motion.div>
          </div>
        </motion.form>

        {/* ---------- how it works ---------- */}
        <motion.p
          variants={item}
          className="glass mt-5 rounded-full px-4 py-2 text-center text-xs text-stone-500 sm:text-sm"
        >
          <span className="font-semibold text-teal-600">1</span> · create a PC&nbsp;→&nbsp;
          <span className="font-semibold text-teal-600">2</span> · send the code to your
          friend&nbsp;→&nbsp;
          <span className="font-semibold text-teal-600">3</span> · share everything
        </motion.p>

        {/* ---------- feature cards ---------- */}
        <motion.div
          variants={item}
          className="mt-8 grid w-full max-w-4xl gap-3 sm:mt-10 sm:grid-cols-3 sm:gap-4"
        >
          {FEATURES.map((f) => (
            <div key={f.title} className="glass glass-sheen rounded-2xl p-4 sm:p-5">
              <div className="flex items-center gap-2.5">
                <span className="gd-accent-gradient flex size-8 shrink-0 items-center justify-center rounded-lg text-white shadow-sm shadow-teal-500/25">
                  <f.icon className="size-4" strokeWidth={2.2} />
                </span>
                <h3 className="text-sm font-semibold tracking-tight text-stone-800">{f.title}</h3>
              </div>
              <p className="mt-2 text-sm leading-relaxed text-stone-500">{f.text}</p>
            </div>
          ))}
        </motion.div>
      </motion.div>

      {/* ---------- pinned glass footer ---------- */}
      <footer className="z-10 mt-auto w-full px-4 pb-4 sm:pb-6">
        <p className="glass mx-auto w-fit rounded-full px-4 py-2 text-center text-xs text-stone-500">
          <LogoLockup
            size={15}
            className="mr-1.5 align-[-3px]"
            word={<Wordmark className="text-xs" />}
          />{" "}
          — a PC made of glass · both seats share full control
        </p>
      </footer>
    </div>
  );
}
