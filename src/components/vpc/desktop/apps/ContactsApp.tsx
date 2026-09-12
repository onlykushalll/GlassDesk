"use client";

// ============================================================
// GlassDesk — People. A shared address book: the whole people
// array + the selected id live in the shared payload, so every
// star, edit, delete and pick mirrors to both seats. Seeds 8
// OS-legend contacts on first open; caps at 80 people.
// ============================================================

import { useCallback, useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import {
  Check,
  Copy,
  Mail,
  MapPin,
  Pencil,
  Phone,
  Search,
  Star,
  Trash2,
  UserPlus,
  Users,
  X,
} from "lucide-react";
import { pushToast } from "@/lib/vpc/toast";
import { SPRING, pop, riseIn, stagger } from "@/lib/vpc/motion";
import { useGlassDesk } from "@/lib/vpc/store";
import { uid, type WindowState } from "@/lib/vpc/types";

// ---------------- payload contract ----------------

interface Person {
  id: string;
  name: string;
  role: string;
  email: string;
  phone: string;
  city: string;
  notes: string;
  fav: boolean;
  at: number;
}
interface P {
  sel: string | null;
  people: Person[];
}

const PEOPLE_CAP = 80;

// ---------------- helpers ----------------

/** Defensive payload → people (old windows may lack the field). */
function parsePeople(raw: unknown): Person[] {
  if (!Array.isArray(raw)) return [];
  const out: Person[] = [];
  for (const item of raw.slice(0, PEOPLE_CAP)) {
    if (typeof item !== "object" || item === null) continue;
    const o = item as Record<string, unknown>;
    const p: Person = {
      id: typeof o.id === "string" ? o.id : uid(),
      name: typeof o.name === "string" ? o.name.slice(0, 60) : "",
      role: typeof o.role === "string" ? o.role.slice(0, 80) : "",
      email: typeof o.email === "string" ? o.email.slice(0, 120) : "",
      phone: typeof o.phone === "string" ? o.phone.slice(0, 40) : "",
      city: typeof o.city === "string" ? o.city.slice(0, 60) : "",
      notes: typeof o.notes === "string" ? o.notes.slice(0, 600) : "",
      fav: o.fav === true,
      at: typeof o.at === "number" ? o.at : Date.now(),
    };
    if (p.name) out.push(p);
  }
  return out;
}

/** Avatar gradients — rotate by name hash. Teal/emerald/amber/rose only. */
const AV_GRADS = [
  "from-teal-400 to-emerald-500",
  "from-emerald-400 to-teal-600",
  "from-amber-400 to-orange-500",
  "from-rose-400 to-pink-500",
];

function avIdx(name: string): number {
  let h = 0;
  for (let i = 0; i < name.length; i++) h = (h * 31 + name.charCodeAt(i)) >>> 0;
  return h % AV_GRADS.length;
}

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  const first = parts[0][0] ?? "";
  const last = parts.length > 1 ? (parts[parts.length - 1][0] ?? "") : "";
  return (first + last).toUpperCase();
}

function relTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 5_000) return "just now";
  if (d < 60_000) return `${Math.max(1, Math.floor(d / 1000))}s ago`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)}m ago`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h ago`;
  const days = Math.floor(d / 86_400_000);
  return days === 1 ? "yesterday" : `${days}d ago`;
}

/** First-run contacts (deterministic ids → a double seed from both
 *  seats simply overwrites itself, never duplicates). */
function seedPeople(): Person[] {
  const now = Date.now();
  const mk = (
    id: string,
    name: string,
    role: string,
    email: string,
    phone: string,
    city: string,
    notes: string,
    fav = false,
  ): Person => ({ id, name, role, email, phone, city, notes, fav, at: now });
  return [
    mk("p-ada", "Ada Lovelace", "Mathematician", "ada@analytical-engine.org", "+44 20 7946 0958", "London",
      "Sketched the first program before the hardware existed. Wants the loop demo on Friday — do not be late.", true),
    mk("p-grace", "Grace Hopper", "Compiler pioneer", "grace.hopper@navy.mil", "+1 212 555 0147", "New York",
      "Debugged a literal moth out of the Mark II. Ships compilers before breakfast.", true),
    mk("p-linus", "Linus T.", "Kernel maintainer", "linus@kernel.org", "+358 40 555 0154", "Helsinki",
      "Merge window opens Tuesday. Please do not top-post.", false),
    mk("p-steve", "Steve J.", "Design review", "steve@cupertino.design", "+1 408 555 0100", "Cupertino",
      "One more thing: rounded corners on the dock. And absolutely no beige.", false),
    mk("p-guido", "Guido van R.", "Python emeritus", "guido@python.org", "+31 20 555 0189", "Amsterdam",
      "Retired gracefully. Still has strong opinions about whitespace.", false),
    mk("p-margaret", "Margaret H.", "Apollo engineer", "margaret@apollo-onboard.dev", "+1 617 555 0132", "Boston",
      "Landed on the Moon with 36KB of RAM. Ask her about the 1202 alarm.", false),
    mk("p-ken", "Ken Thompson", "Unix co-creator", "ken@bell-labs.org", "+1 510 555 0121", "Berkeley",
      "Built an OS on a PDP-7 because the game needed a file system. Currently tuning his chess engine.", false),
    mk("p-radia", "Radia Perlman", "Network pioneer", "radia@spanning-tree.net", "+1 617 555 0145", "Boston",
      "The mother of the internet. Will not tolerate loops in your topology.", false),
  ].map((p, i) => ({ ...p, at: now - i * 1000 }));
}

interface Draft {
  name: string;
  role: string;
  email: string;
  phone: string;
  city: string;
  notes: string;
}

const EMPTY_DRAFT: Draft = { name: "", role: "", email: "", phone: "", city: "", notes: "" };

/** Which inline form is open. An "edit" form bound to a selection that has
 *  moved on (locally or on the co-seat) auto-closes — derived, not reset. */
type FormMode = { kind: "new" } | { kind: "edit"; sel: string } | null;

// ============================================================
// main component
// ============================================================

export default function ContactsApp({ win }: { win: WindowState }) {
  const liveWin = useGlassDesk((s) => s.state?.windows.find((w) => w.id === win.id));
  const dispatch = useGlassDesk((s) => s.dispatch);
  const w = liveWin ?? win;
  const payload = (w.payload ?? {}) as Partial<P>;

  const people = parsePeople(payload.people);
  const sel = typeof payload.sel === "string" ? payload.sel : null;
  const person = people.find((p) => p.id === sel) ?? null;

  const patch = useCallback(
    (p: Record<string, unknown>) => dispatch({ t: "app:patch", id: win.id, patch: p }),
    [dispatch, win.id],
  );

  /** Freshest people straight from the store (beats stale render copies). */
  const livePeople = useCallback((): Person[] => {
    const s = useGlassDesk.getState();
    const live = s.state?.windows.find((x) => x.id === win.id);
    return parsePeople(live?.payload.people ?? win.payload.people);
  }, [win.id, win.payload.people]);

  // ---- first-run seed (missing OR empty → seed the OS legends) ----
  const seededRef = useRef(false);
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (Array.isArray(payload.people) && people.length > 0) return;
    patch({ people: seedPeople() });
  }, [people.length, patch]);

  // ---- local ui state ----
  const [query, setQuery] = useState("");
  const [mode, setMode] = useState<FormMode>(null);
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [formErr, setFormErr] = useState<string | null>(null);
  // delete is armed FOR a specific selection (derived two-click confirm)
  const [armedSel, setArmedSel] = useState<string | null>(null);

  const editStale = mode?.kind === "edit" && mode.sel !== sel;
  const formOpen = mode !== null && !editStale;
  const confirmDel = armedSel !== null && armedSel === sel;

  // delete confirm is a two-click, time-boxed gesture
  useEffect(() => {
    if (armedSel === null) return;
    const t = window.setTimeout(() => setArmedSel(null), 2600);
    return () => window.clearTimeout(t);
  }, [armedSel]);

  const sorted = [...people].sort(
    (a, b) => Number(b.fav) - Number(a.fav) || a.name.localeCompare(b.name),
  );
  const needle = query.trim().toLowerCase();
  const visible = needle
    ? sorted.filter(
        (p) =>
          p.name.toLowerCase().includes(needle) ||
          p.role.toLowerCase().includes(needle) ||
          p.city.toLowerCase().includes(needle),
      )
    : sorted;

  // ---- synced actions (whole-array patches) ----
  const select = (id: string) => {
    setMode(null);
    setArmedSel(null);
    patch({ sel: id });
  };

  const toggleFav = (id: string) => {
    const next = livePeople().map((p) => (p.id === id ? { ...p, fav: !p.fav } : p));
    patch({ people: next });
  };

  const startNew = () => {
    setDraft(EMPTY_DRAFT);
    setFormErr(null);
    setMode({ kind: "new" });
    setArmedSel(null);
  };

  const startEdit = () => {
    if (!person) return;
    setDraft({
      name: person.name,
      role: person.role,
      email: person.email,
      phone: person.phone,
      city: person.city,
      notes: person.notes,
    });
    setFormErr(null);
    setMode({ kind: "edit", sel: person.id });
    setArmedSel(null);
  };

  const save = () => {
    const name = draft.name.trim();
    if (!name) {
      setFormErr("Name is required.");
      return;
    }
    setFormErr(null);
    const live = livePeople();
    if (mode?.kind === "new") {
      if (live.length >= PEOPLE_CAP) {
        pushToast({
          title: "Address book is full",
          body: `${PEOPLE_CAP} people is the cap — remove someone first.`,
          kind: "warn",
        });
        return;
      }
      const fresh: Person = {
        id: uid(),
        name: name.slice(0, 60),
        role: draft.role.trim().slice(0, 80),
        email: draft.email.trim().slice(0, 120),
        phone: draft.phone.trim().slice(0, 40),
        city: draft.city.trim().slice(0, 60),
        notes: draft.notes.trim().slice(0, 600),
        fav: false,
        at: Date.now(),
      };
      patch({ people: [fresh, ...live], sel: fresh.id });
      setMode(null);
      pushToast({ title: `Added ${fresh.name}`, body: "Synced to both seats", kind: "success" });
      return;
    }
    if (mode?.kind === "edit" && person) {
      const next = live.map((p) =>
        p.id === person.id
          ? {
              ...p,
              name: name.slice(0, 60),
              role: draft.role.trim().slice(0, 80),
              email: draft.email.trim().slice(0, 120),
              phone: draft.phone.trim().slice(0, 40),
              city: draft.city.trim().slice(0, 60),
              notes: draft.notes.trim().slice(0, 600),
              at: Date.now(),
            }
          : p,
      );
      patch({ people: next });
      setMode(null);
      pushToast({ title: "Saved", body: `${name} updated on both seats`, kind: "success" });
    }
  };

  const remove = () => {
    if (!person) return;
    if (!confirmDel) {
      setArmedSel(person.id);
      return;
    }
    const next = livePeople().filter((p) => p.id !== person.id);
    patch({ people: next, sel: null });
    setArmedSel(null);
    setMode(null);
    pushToast({ title: `Removed ${person.name}`, body: "Gone from both seats", kind: "danger" });
  };

  const copyField = async (value: string, what: string) => {
    const text = value.trim();
    if (!text) {
      pushToast({ title: `No ${what.toLowerCase()} to copy`, kind: "warn" });
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      pushToast({ title: `${what} copied`, body: text, kind: "success" });
    } catch {
      pushToast({ title: "Clipboard blocked", body: "The browser refused clipboard access", kind: "warn" });
    }
  };

  // ---------------- form field (shared by New/Edit) ----------------
  const field = (
    label: string,
    key: keyof Draft,
    props: { textarea?: boolean; placeholder?: string } = {},
  ) => (
    <label className="block">
      <span className="mb-1 block text-[10px] font-semibold uppercase tracking-wide text-stone-400">
        {label}
        {key === "name" ? " *" : ""}
      </span>
      {props.textarea ? (
        <textarea
          value={draft[key]}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          rows={3}
          placeholder={props.placeholder}
          className="w-full resize-none rounded-xl border border-white/70 bg-white/70 px-3 py-2 text-xs text-stone-700 shadow-sm outline-none backdrop-blur placeholder:text-stone-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-400/40"
        />
      ) : (
        <input
          value={draft[key]}
          onChange={(e) => setDraft((d) => ({ ...d, [key]: e.target.value }))}
          placeholder={props.placeholder}
          className={`h-8 w-full rounded-xl border bg-white/70 px-3 text-xs text-stone-700 shadow-sm outline-none backdrop-blur placeholder:text-stone-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-400/40 ${
            key === "name" && formErr ? "border-rose-300 ring-2 ring-rose-300/50" : "border-white/70"
          }`}
        />
      )}
      {key === "name" && formErr ? (
        <span className="mt-1 block text-[10px] font-medium text-rose-500">{formErr}</span>
      ) : null}
    </label>
  );

  return (
    <div className="flex h-full min-h-0 overflow-hidden">
      {/* ---------------- list pane (~46%) ---------------- */}
      <aside className="flex w-[46%] min-w-[240px] flex-col border-r border-white/60 bg-white/30">
        <header className="shrink-0 space-y-2 border-b border-white/60 p-2.5">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400" aria-hidden />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search name, role, city…"
              aria-label="Search people"
              spellCheck={false}
              className="h-8 w-full rounded-full border border-white/70 bg-white/70 pl-9 pr-3 text-xs text-stone-700 shadow-sm outline-none backdrop-blur placeholder:text-stone-400 focus:border-teal-300 focus:ring-2 focus:ring-teal-400/40"
            />
          </div>
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-medium text-stone-500">
              {visible.length} of {people.length}
            </span>
            <motion.button
              variants={pop}
              initial="rest"
              whileHover="hover"
              whileTap="tap"
              type="button"
              onClick={startNew}
              className="gd-accent-gradient flex items-center gap-1.5 rounded-full px-3 py-1.5 text-[11px] font-semibold text-white shadow-sm"
            >
              <UserPlus className="h-3.5 w-3.5" />
              New person
            </motion.button>
          </div>
        </header>

        <div className="gd-scroll min-h-0 flex-1 overflow-y-auto p-2">
          {visible.length === 0 ? (
            <div className="grid h-full place-items-center px-4 text-center">
              <p className="text-xs text-stone-400">
                {needle ? "No one matches that search." : "The address book is empty — add someone."}
              </p>
            </div>
          ) : (
            <motion.div
              key={needle}
              variants={stagger(0.03, 0.02)}
              initial="hidden"
              animate="show"
              className="flex flex-col gap-1"
            >
              {visible.map((p) => {
                const active = p.id === sel;
                return (
                  <motion.div
                    key={p.id}
                    variants={riseIn}
                    whileHover={{ x: 2 }}
                    transition={SPRING.snappy}
                    role="button"
                    tabIndex={0}
                    onClick={() => select(p.id)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter" || e.key === " ") {
                        e.preventDefault();
                        select(p.id);
                      }
                    }}
                    className={`group flex w-full cursor-pointer items-center gap-2.5 rounded-xl px-2.5 py-2 outline-none focus-visible:ring-2 focus-visible:ring-teal-400/60 ${
                      active ? "bg-white/85 shadow-sm ring-1 ring-teal-200/80" : "hover:bg-white/60"
                    }`}
                  >
                    <span
                      className={`grid h-8 w-8 shrink-0 place-items-center rounded-full bg-gradient-to-br text-xs font-bold text-white shadow-sm ${AV_GRADS[avIdx(p.name)]}`}
                    >
                      {initials(p.name)}
                    </span>
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-xs font-semibold text-stone-800">{p.name}</span>
                      <span className="block truncate text-[11px] text-stone-500">{p.role}</span>
                    </span>
                    <motion.button
                      key={p.fav ? "on" : "off"}
                      type="button"
                      initial={{ scale: 0.4, rotate: -18 }}
                      animate={{ scale: 1, rotate: 0 }}
                      transition={SPRING.playful}
                      onClick={(e) => {
                        e.stopPropagation();
                        toggleFav(p.id);
                      }}
                      aria-label={p.fav ? `Unfavorite ${p.name}` : `Favorite ${p.name}`}
                      aria-pressed={p.fav}
                      className="grid h-6 w-6 shrink-0 place-items-center rounded-full hover:bg-white/80"
                    >
                      <Star
                        className={`h-3.5 w-3.5 ${
                          p.fav ? "fill-amber-400 text-amber-400" : "text-stone-300 group-hover:text-stone-400"
                        }`}
                      />
                    </motion.button>
                  </motion.div>
                );
              })}
            </motion.div>
          )}
        </div>
      </aside>

      {/* ---------------- detail pane (54%) ---------------- */}
      <section className="gd-scroll min-w-0 flex-1 overflow-y-auto p-4">
        {formOpen ? (
          /* ---------- inline form (New / Edit) ---------- */
          <motion.div
            key="form"
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={SPRING.window}
            className="mx-auto flex max-w-sm flex-col gap-2.5"
          >
            <h2 className="flex items-center gap-2 text-sm font-semibold text-stone-700">
              {mode?.kind === "new" ? (
                <>
                  <UserPlus className="h-4 w-4 text-teal-500" /> New contact
                </>
              ) : (
                <>
                  <Pencil className="h-4 w-4 text-teal-500" /> Edit {person?.name ?? "contact"}
                </>
              )}
            </h2>
            {field("Name", "name", { placeholder: "Ada Lovelace" })}
            {field("Role", "role", { placeholder: "Mathematician" })}
            {field("Email", "email", { placeholder: "ada@example.org" })}
            {field("Phone", "phone", { placeholder: "+44 20 7946 0958" })}
            {field("City", "city", { placeholder: "London" })}
            {field("Notes", "notes", { textarea: true, placeholder: "Anything the other seat should know…" })}
            <div className="mt-1 flex items-center gap-2">
              <motion.button
                variants={pop}
                initial="rest"
                whileHover="hover"
                whileTap="tap"
                type="button"
                onClick={save}
                className="gd-accent-gradient flex items-center gap-1.5 rounded-full px-4 py-1.5 text-xs font-semibold text-white shadow-sm"
              >
                <Check className="h-3.5 w-3.5" />
                Save
              </motion.button>
              <motion.button
                variants={pop}
                initial="rest"
                whileHover="hover"
                whileTap="tap"
                type="button"
                onClick={() => {
                  setMode(null);
                  setFormErr(null);
                }}
                className="flex items-center gap-1.5 rounded-full border border-white/70 bg-white/70 px-4 py-1.5 text-xs font-medium text-stone-600 shadow-sm"
              >
                <X className="h-3.5 w-3.5" />
                Cancel
              </motion.button>
              <span className="ml-auto text-[10px] text-stone-400">synced on save</span>
            </div>
          </motion.div>
        ) : person ? (
          /* ---------- person detail (rises + staggers) ---------- */
          <motion.div key={person.id} variants={stagger(0.06, 0.04)} initial="hidden" animate="show">
            <motion.div variants={riseIn} className="flex items-start gap-3.5">
              <span
                className={`grid h-14 w-14 shrink-0 place-items-center rounded-2xl bg-gradient-to-br text-base font-bold text-white shadow-md ${AV_GRADS[avIdx(person.name)]}`}
              >
                {initials(person.name)}
              </span>
              <div className="min-w-0 flex-1">
                <h2 className="truncate text-xl font-semibold text-stone-800">{person.name}</h2>
                <p className="truncate text-xs text-stone-500">{person.role || "—"}</p>
                <p className="mt-0.5 text-[10px] text-stone-400">added {relTime(person.at)}</p>
              </div>
              <div className="flex shrink-0 items-center gap-1.5">
                <motion.button
                  variants={pop}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  type="button"
                  onClick={() => toggleFav(person.id)}
                  aria-label={person.fav ? `Unfavorite ${person.name}` : `Favorite ${person.name}`}
                  aria-pressed={person.fav}
                  title={person.fav ? "Remove favorite" : "Mark favorite"}
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/70 bg-white/70 shadow-sm"
                >
                  <motion.span
                    key={person.fav ? "on" : "off"}
                    initial={{ scale: 0.4, rotate: -18 }}
                    animate={{ scale: 1, rotate: 0 }}
                    transition={SPRING.playful}
                    className="grid place-items-center"
                  >
                    <Star
                      className={`h-4 w-4 ${person.fav ? "fill-amber-400 text-amber-400" : "text-stone-400"}`}
                    />
                  </motion.span>
                </motion.button>
                <motion.button
                  variants={pop}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  type="button"
                  onClick={startEdit}
                  title="Edit"
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/70 bg-white/70 text-stone-600 shadow-sm"
                >
                  <Pencil className="h-4 w-4" />
                </motion.button>
                <motion.button
                  variants={pop}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  type="button"
                  onClick={remove}
                  title={confirmDel ? "Click again to confirm" : "Delete"}
                  className={`flex h-8 items-center gap-1.5 rounded-full border px-3 text-[11px] font-semibold shadow-sm ${
                    confirmDel
                      ? "border-rose-300 bg-rose-500 text-white"
                      : "border-rose-200 bg-rose-50/70 text-rose-600"
                  }`}
                >
                  <Trash2 className="h-3.5 w-3.5" />
                  {confirmDel ? "Confirm?" : "Delete"}
                </motion.button>
              </div>
            </motion.div>

            {/* field grid */}
            <div className="mt-4 grid grid-cols-1 gap-2 sm:grid-cols-2">
              {(
                [
                  { icon: <Mail className="h-4 w-4 shrink-0 text-teal-500" />, label: "Email", value: person.email },
                  { icon: <Phone className="h-4 w-4 shrink-0 text-teal-500" />, label: "Phone", value: person.phone },
                  { icon: <MapPin className="h-4 w-4 shrink-0 text-teal-500" />, label: "City", value: person.city },
                ] as const
              ).map((f, i) => (
                <motion.div
                  key={f.label}
                  variants={riseIn}
                  className={`flex items-center gap-3 rounded-xl border border-white/70 bg-white/60 px-3 py-2.5 ${
                    i === 0 ? "sm:col-span-2" : ""
                  }`}
                >
                  {f.icon}
                  <div className="min-w-0 flex-1">
                    <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{f.label}</p>
                    <p className="truncate text-xs font-medium text-stone-700">{f.value || "—"}</p>
                  </div>
                  <motion.button
                    variants={pop}
                    initial="rest"
                    whileHover="hover"
                    whileTap="tap"
                    type="button"
                    onClick={() => void copyField(f.value, f.label)}
                    aria-label={`Copy ${f.label.toLowerCase()}`}
                    title={`Copy ${f.label.toLowerCase()}`}
                    className="grid h-7 w-7 shrink-0 place-items-center rounded-full text-stone-400 hover:bg-white/80 hover:text-stone-600"
                  >
                    <Copy className="h-3.5 w-3.5" />
                  </motion.button>
                </motion.div>
              ))}
            </div>

            {/* notes */}
            <motion.div
              variants={riseIn}
              className="mt-3 rounded-xl border border-white/70 bg-white/60 p-3.5"
            >
              <p className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">Notes</p>
              <p className="mt-1 text-xs leading-relaxed text-stone-600">
                {person.notes || "No notes yet — both seats can add some."}
              </p>
            </motion.div>
          </motion.div>
        ) : (
          /* ---------- empty state ---------- */
          <div className="grid h-full place-items-center">
            <motion.div
              initial={{ opacity: 0, y: 12 }}
              animate={{ opacity: 1, y: 0 }}
              transition={SPRING.window}
              className="flex flex-col items-center gap-3 text-center"
            >
              <motion.div
                animate={{ y: [0, -6, 0] }}
                transition={{ duration: 3.2, repeat: Infinity, ease: "easeInOut" }}
                className="grid h-14 w-14 place-items-center rounded-2xl border border-white/70 bg-white/70 shadow-md"
              >
                <Users className="h-7 w-7 text-teal-500" />
              </motion.div>
              <p className="text-sm font-semibold text-stone-600">Pick someone</p>
              <p className="max-w-[220px] text-xs text-stone-400">
                Choose a card on the left — the same card opens on the other seat.
              </p>
            </motion.div>
          </div>
        )}
      </section>
    </div>
  );
}
