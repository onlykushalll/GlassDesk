"use client";

// ============================================================
// GlassDesk — Mail. THE shared mailbox: one account on the
// software PC, both seats read & write the same store.
//
// payload { box, sel, mails } rides in win.payload via app:patch,
// so the two seats share ONE view of ONE mailbox — sending a
// mail lands it in Sent for BOTH seats, and a Postmaster ack
// drops into the shared inbox 2.5s later as a little nudge.
//
// Seeding uses fixed ids (BrowserApp migration pattern) so two
// seats mounting concurrently converge to the same mailbox.
// Search + the compose sheet are LOCAL (never synced); every
// mutation (send / star / read / trash / folder / selection)
// patches the shared payload.
// ============================================================

import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion, type Variants } from "framer-motion";
import type { LucideIcon } from "lucide-react";
import {
  FilePen,
  Inbox,
  Mail as MailIcon,
  Pen,
  Reply,
  ReplyAll,
  Search,
  SendHorizontal,
  Star,
  Trash2,
  Users,
  X,
} from "lucide-react";
import { useGlassDesk } from "@/lib/vpc/store";
import { pushToast } from "@/lib/vpc/toast";
import { SPRING, pop, riseIn, stagger } from "@/lib/vpc/motion";
import { uid, type WindowState } from "@/lib/vpc/types";

// ---------------- payload contract ----------------

interface Mail {
  id: string;
  box: "inbox" | "sent" | "drafts" | "trash";
  from: string;
  to: string;
  subject: string;
  body: string;
  at: number;
  read: boolean;
  starred?: boolean;
}
interface P {
  box: string;
  sel: string | null;
  mails: Mail[];
}

interface ComposeSheet {
  mode: "new" | "reply";
  to: string;
  toName: string;
  subject: string;
  body: string;
}

const MAIL_CAP = 60;
const FOLDER_IDS = ["inbox", "starred", "drafts", "sent", "trash"];
const SEED_IDS = new Set(["m-seed-1", "m-seed-2", "m-seed-3", "m-seed-4", "m-seed-5"]);
const POSTMASTER = "GlassDesk Postmaster";
const ACK_DELAY_MS = 2500;

const FOLDER_META: { id: string; label: string; icon: LucideIcon }[] = [
  { id: "inbox", label: "Inbox", icon: Inbox },
  { id: "starred", label: "Starred", icon: Star },
  { id: "drafts", label: "Drafts", icon: FilePen },
  { id: "sent", label: "Sent", icon: SendHorizontal },
  { id: "trash", label: "Trash", icon: Trash2 },
];

/** Display-name → shared-box address (the flavor: everything @glassdesk). */
const SENDER_ADDR: Record<string, string> = {
  "GlassDesk Team": "team@glassdesk",
  "Nova Browser": "nova@glassdesk",
  "Glass Store": "store@glassdesk",
  "Glass AI": "ai@glassdesk",
  Weather: "weather@glassdesk",
  "GlassDesk Postmaster": "postmaster@glassdesk",
};

// ---------------- helpers ----------------

function mailsOf(p: P): Mail[] {
  if (!Array.isArray(p.mails)) return [];
  return p.mails.filter(
    (m): m is Mail =>
      !!m &&
      typeof m.id === "string" &&
      typeof m.from === "string" &&
      typeof m.to === "string" &&
      typeof m.subject === "string" &&
      typeof m.body === "string" &&
      typeof m.at === "number" &&
      (m.box === "inbox" || m.box === "sent" || m.box === "drafts" || m.box === "trash"),
  );
}

/** Append + keep only the newest MAIL_CAP mails. */
function appendMail(list: Mail[], m: Mail): Mail[] {
  return [...list, m].sort((a, b) => b.at - a.at).slice(0, MAIL_CAP);
}

function addrOf(name: string): string {
  if (name.includes("@")) return name;
  return SENDER_ADDR[name] ?? "friend@glassdesk";
}

function initialsOf(s: string): string {
  const parts = s
    .replace(/@.*/, "")
    .split(/[\s+_+.]+/)
    .filter(Boolean);
  return ((parts[0]?.[0] ?? "?") + (parts[1]?.[0] ?? "")).toUpperCase();
}

function previewOf(m: Mail): string {
  return m.body.replace(/\s+/g, " ").trim();
}

function relTime(at: number): string {
  const s = Math.max(0, Math.floor((Date.now() - at) / 1000));
  if (s < 60) return "now";
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  if (d < 7) return `${d}d`;
  return new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function fullDate(at: number): string {
  return new Date(at).toLocaleString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

/** Quote a mail for a reply body ("> " lines, mail-client style). */
function quoteOf(m: Mail): string {
  const quoted = m.body
    .split("\n")
    .map((l) => (l.trim() ? `> ${l}` : ">"))
    .join("\n");
  return `\n\nOn ${fullDate(m.at)}, ${m.from} wrote:\n${quoted}`;
}

function seedMails(): Mail[] {
  const now = Date.now();
  const H = 3_600_000;
  return [
    {
      id: "m-seed-1",
      box: "inbox",
      from: "GlassDesk Team",
      to: "you+friend@glassdesk",
      subject: "Welcome to your shared mailbox",
      body:
        "Hi you two 👋\n\nThis inbox belongs to the whole PC — GlassDesk has exactly one mail\naccount, and both seats read and write it.\n\nWhat that means in practice:\n\n• Anything either of you sends lands in Sent for BOTH seats — the\n  sync is live, so it shows up on the other screen in a blink.\n• Mails, stars and read state are snapshotted with the session, so\n  reload + rejoin this code and the mailbox comes right back.\n• The Trash is shared too — careful in there.\n\nTerminal tips: open Terminal and try `help`, then `neofetch`, `ps`\nand `free` — you can even watch this app's memory in the process\nlist.\n\n— the GlassDesk team",
      at: now - 46 * H,
      read: true,
      starred: true,
    },
    {
      id: "m-seed-2",
      box: "inbox",
      from: "Nova Browser",
      to: "you+friend@glassdesk",
      subject: "Your co-browsing history is ready",
      body:
        "You two have been out on the web together — and every stop either\nseat made is already filed.\n\nOpen Nova and type nova://history to see the whole trail, newest\nfirst. Star the good ones so they graduate into bookmarks.\n\nHappy co-browsing,\n— Nova",
      at: now - 26 * H,
      read: true,
    },
    {
      id: "m-seed-3",
      box: "inbox",
      from: "Glass Store",
      to: "you+friend@glassdesk",
      subject: "9 new apps just landed",
      body:
        "The wave-9 delivery van stopped by. Fresh on this PC:\n\n• Mail (yep, this one)\n• Code · AI · Camera · Voice\n• Maps · Contacts · Security · Store\n\nNo installs, no updates — they're preloaded and shared between\nseats, like everything else on GlassDesk.\n\n— Glass Store",
      at: now - 8 * H,
      read: true,
    },
    {
      id: "m-seed-4",
      box: "inbox",
      from: "Glass AI",
      to: "you+friend@glassdesk",
      subject: "I'm here if you need me",
      body:
        "Stuck on wording? Want a snippet explained, a plan drafted, or a\nname brainstormed at 2am?\n\nOpen the AI app and ask away — the whole thread is visible to both\nseats, so your co-pilot can pick up mid-thought.\n\n— Glass AI",
      at: now - 3 * H,
      read: false,
    },
    {
      id: "m-seed-5",
      box: "inbox",
      from: "Weather",
      to: "you+friend@glassdesk",
      subject: "Today in Bengaluru: 29°C partly cloudy",
      body:
        "Bengaluru · Karnataka\n29°C · partly cloudy · feels like 31°\n\nLight westerly breeze, moderate UV. A fine day to leave the\nwindows open — both the glass kind and the OS kind.\n\n— Weather",
      at: now - 40 * 60_000,
      read: false,
    },
  ];
}

/** Row entrance — self-contained stagger (index via `custom`), springs only. */
const ROW_V: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: (i: number) => ({
    opacity: 1,
    y: 0,
    transition: { ...SPRING.window, delay: Math.min(i * 0.035, 0.28) },
  }),
  exit: { opacity: 0, y: 8, scale: 0.98, transition: { duration: 0.15 } },
};

// ============================================================
// main component
// ============================================================

export default function MailApp({ win }: { win: WindowState }) {
  const dispatch = useGlassDesk((s) => s.dispatch);
  const me = useGlassDesk((s) => s.name);
  // live payload (proven sibling pattern — beats stale prop snapshots).
  // double cast: Record<string, unknown> → P (TS's own suggestion)
  const liveWin = useGlassDesk((s) => s.state?.windows.find((x) => x.id === win.id));
  const w = liveWin ?? win;
  const p = w.payload as unknown as P;

  const patch = (o: Partial<P>) => dispatch({ t: "app:patch", id: win.id, patch: o });

  // local (never synced) ui state
  const [q, setQ] = useState("");
  const [sheet, setSheet] = useState<ComposeSheet | null>(null);

  // bookkeeping
  const seededRef = useRef(false);
  const seenRef = useRef<Set<string> | null>(null); // ids already toasted/baselined
  const mineRef = useRef<Set<string>>(new Set()); // ids this seat created → never self-toast
  const ackRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // ---- first-run seed (BrowserApp migration pattern, mount-once) ----
  useEffect(() => {
    if (seededRef.current) return;
    seededRef.current = true;
    if (!Array.isArray(p.mails) || p.mails.length === 0) {
      patch({ mails: seedMails() });
    }
  }, [p.mails, patch]);

  // ---- toast on NEW REMOTE mail arrival (never own sends / seeds) ----
  useEffect(() => {
    const list = mailsOf(p);
    if (seenRef.current === null) {
      seenRef.current = new Set(list.map((m) => m.id));
      return;
    }
    const seen = seenRef.current;
    let inboxNew = 0;
    let inboxSubject = "";
    let inboxFrom = "";
    let sentFrom = "";
    let sentSubject = "";
    for (const m of list) {
      if (seen.has(m.id)) continue;
      seen.add(m.id);
      if (SEED_IDS.has(m.id) || mineRef.current.has(m.id)) continue;
      if (m.box === "inbox") {
        inboxNew += 1;
        inboxSubject = m.subject;
        inboxFrom = m.from;
      } else if (m.box === "sent") {
        sentFrom = m.from;
        sentSubject = m.subject;
      }
    }
    if (inboxNew === 1) {
      pushToast({ title: "New mail", body: `${inboxSubject} — ${inboxFrom}`, kind: "info" });
    } else if (inboxNew > 1) {
      pushToast({ title: `${inboxNew} new mails`, body: "The shared inbox just grew.", kind: "info" });
    }
    if (sentFrom) {
      pushToast({
        title: `${sentFrom} sent a mail`,
        body: `${sentSubject} — it's in Sent for both seats.`,
        kind: "success",
      });
    }
  }, [p.mails]);

  // ---- guard the postmaster auto-ack timeout against unmount ----
  useEffect(
    () => () => {
      if (ackRef.current) clearTimeout(ackRef.current);
    },
    [],
  );

  // ---- derived data ----
  const mails = mailsOf(p);
  const box = FOLDER_IDS.includes(p.box) ? p.box : "inbox";
  const folderLabel = FOLDER_META.find((f) => f.id === box)?.label ?? "Inbox";
  const unreadCount = mails.reduce((n, m) => (m.box === "inbox" && !m.read ? n + 1 : n), 0);
  const trashCount = mails.reduce((n, m) => (m.box === "trash" ? n + 1 : n), 0);
  const ql = q.trim().toLowerCase();
  const rows = (box === "starred" ? mails.filter((m) => m.starred) : mails.filter((m) => m.box === box))
    .slice()
    .sort((a, b) => b.at - a.at)
    .filter((m) => !ql || `${m.from} ${m.to} ${m.subject} ${m.body}`.toLowerCase().includes(ql));
  const selMail = typeof p.sel === "string" ? mails.find((m) => m.id === p.sel) : undefined;
  const canSend =
    !!sheet && sheet.to.trim() !== "" && (sheet.subject.trim() !== "" || sheet.body.trim() !== "");

  /** Freshest mails straight from the store (beats stale closures). */
  const liveMails = (): Mail[] => {
    const st = useGlassDesk.getState().state;
    const lw = st?.windows.find((x) => x.id === win.id);
    return mailsOf((lw?.payload ?? win.payload) as unknown as P);
  };

  // ---- shared actions (all patch the payload) ----

  const setBox = (b: string) => {
    if (b === box) return;
    patch({ box: b, sel: null });
  };

  const open = (m: Mail) => {
    if (m.read) {
      patch({ sel: m.id });
      return;
    }
    patch({ sel: m.id, mails: liveMails().map((x) => (x.id === m.id ? { ...x, read: true } : x)) });
  };

  const toggleStar = (m: Mail) => {
    patch({ mails: liveMails().map((x) => (x.id === m.id ? { ...x, starred: !x.starred } : x)) });
  };

  const remove = (m: Mail) => {
    if (m.box === "trash") {
      patch({ mails: liveMails().filter((x) => x.id !== m.id), sel: null });
      pushToast({ title: "Message deleted", body: m.subject.slice(0, 70), kind: "info" });
    } else {
      patch({ mails: liveMails().map((x) => (x.id === m.id ? { ...x, box: "trash" } : x)) });
      pushToast({ title: "Moved to Trash", body: m.subject.slice(0, 70), kind: "info" });
    }
  };

  const emptyTrash = () => {
    const cur = liveMails();
    const next = cur.filter((x) => x.box !== "trash");
    if (next.length === cur.length) return;
    const selGone = typeof p.sel === "string" && next.every((x) => x.id !== p.sel);
    patch(selGone ? { mails: next, sel: null } : { mails: next });
    pushToast({ title: "Trash emptied", body: "Removed for both seats.", kind: "success" });
  };

  const startCompose = () =>
    setSheet({ mode: "new", to: "friend@glassdesk", toName: "your co-seat", subject: "", body: "" });

  const startReply = (m: Mail) => {
    setSheet({
      mode: "reply",
      to: addrOf(m.from),
      toName: m.from,
      subject: m.subject.startsWith("Re:") ? m.subject : `Re: ${m.subject}`,
      body: quoteOf(m),
    });
  };

  const closeSheet = () => setSheet(null);

  /** Postmaster auto-ack — drops into the shared inbox after 2.5s. */
  const scheduleAck = (to: string, subject: string) => {
    if (ackRef.current) clearTimeout(ackRef.current);
    const id = uid();
    mineRef.current.add(id);
    ackRef.current = setTimeout(() => {
      ackRef.current = null;
      const ack: Mail = {
        id,
        box: "inbox",
        from: POSTMASTER,
        to,
        subject: `Delivered: ${subject}`,
        body:
          "Delivered instantly — the other seat can read it in Sent. Shared\nmailboxes, zero latency.\n\n— the GlassDesk Postmaster",
        at: Date.now(),
        read: false,
      };
      patch({ mails: appendMail(liveMails(), ack) });
    }, ACK_DELAY_MS);
  };

  const sendSheet = () => {
    if (!sheet) return;
    const to = sheet.to.trim() || "friend@glassdesk";
    const subject = sheet.subject.trim() || "(no subject)";
    const m: Mail = {
      id: uid(),
      box: "sent",
      from: me.trim() || "you@glassdesk",
      to,
      subject,
      body: sheet.body,
      at: Date.now(),
      read: true,
    };
    mineRef.current.add(m.id);
    patch({ mails: appendMail(liveMails(), m), box: "sent", sel: m.id });
    setSheet(null);
    pushToast({ title: "Mail sent", body: "It's in Sent for both seats.", kind: "success" });
    scheduleAck(to, subject);
  };

  // ============================================================
  // render — 3 panes + compose sheet
  // ============================================================

  return (
    <div className="relative flex h-full w-full overflow-hidden">
      {/* ── pane 1 · folder rail ─────────────────────────────── */}
      <aside className="flex w-[150px] shrink-0 flex-col gap-2.5 border-r border-white/70 bg-white/40 p-2.5">
        {/* app header */}
        <div className="flex items-center gap-2.5 px-0.5">
          <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-rose-400 to-amber-400 shadow-md shadow-amber-500/20">
            <MailIcon className="h-[18px] w-[18px] text-white" aria-hidden />
          </div>
          <div className="min-w-0">
            <h1 className="truncate text-sm font-bold tracking-tight text-stone-800">Mail</h1>
            <p className="truncate text-[9px] font-semibold uppercase tracking-[0.12em] text-stone-400">
              shared inbox
            </p>
          </div>
        </div>

        {/* account card + shared badge */}
        <div className="glass rounded-xl p-2">
          <div className="flex items-center gap-2">
            <span className="relative grid h-7 w-7 shrink-0 place-items-center rounded-full gd-accent-gradient text-[9px] font-bold text-white shadow-sm">
              {initialsOf("you+friend@glassdesk")}
              <span className="absolute -bottom-1 -right-1.5 flex items-center rounded-full bg-white px-[3px] py-[2px] shadow ring-1 ring-white/70">
                <Users className="-mr-[5px] h-2.5 w-2.5 text-teal-600/80" aria-hidden />
                <Users className="h-2.5 w-2.5 text-emerald-500/80" aria-hidden />
              </span>
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate gd-mono text-[10px] font-medium text-stone-700">
                you+friend@glassdesk
              </p>
              <p className="text-[9px] font-semibold uppercase tracking-wide text-stone-400">
                1 mailbox · 2 seats
              </p>
            </div>
          </div>
        </div>

        {/* folders */}
        <motion.nav
          variants={stagger(0.05, 0.06)}
          initial="hidden"
          animate="show"
          className="mt-0.5 flex flex-col gap-0.5"
          aria-label="Mailboxes"
        >
          {FOLDER_META.map((f) => {
            const active = box === f.id;
            const Icon = f.icon;
            const badge = f.id === "inbox" ? unreadCount : 0;
            return (
              <motion.button
                key={f.id}
                type="button"
                variants={riseIn}
                whileHover={{ scale: 1.02, x: 1.5 }}
                whileTap={{ scale: 0.97 }}
                transition={SPRING.snappy}
                onClick={() => setBox(f.id)}
                aria-current={active ? "true" : undefined}
                className={`relative flex items-center gap-2 rounded-[10px] px-2.5 py-[7px] text-left text-xs font-medium ${
                  active
                    ? "gd-accent-gradient text-white shadow-md"
                    : "text-stone-600 hover:bg-white/80"
                }`}
              >
                <Icon
                  className={`h-3.5 w-3.5 shrink-0 ${active ? "text-white" : "text-stone-400"}`}
                  aria-hidden
                />
                <span className="flex-1 truncate">{f.label}</span>
                {badge > 0 && (
                  <motion.span
                    key={badge}
                    initial={{ scale: 0.6, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={SPRING.snappy}
                    className={`grid h-[17px] min-w-[17px] place-items-center rounded-full px-1 text-[10px] font-bold leading-none ${
                      active ? "bg-white/90" : "gd-accent-gradient text-white shadow-sm"
                    }`}
                    style={active ? { color: "var(--gd-accent)" } : undefined}
                  >
                    {badge}
                  </motion.span>
                )}
              </motion.button>
            );
          })}
        </motion.nav>

        {/* footer */}
        <div className="mt-auto px-1 pt-1">
          <p className="gd-mono truncate text-[9px] text-stone-400">
            {mails.length}/{MAIL_CAP} mails · snapshotted
          </p>
        </div>
      </aside>

      {/* ── pane 2 · mail list ───────────────────────────────── */}
      <section className="relative flex w-[300px] shrink-0 flex-col border-r border-white/70 bg-white/30">
        {/* search (local, never synced) */}
        <div className="p-2.5 pb-1.5">
          <div className="relative">
            <Search
              className="pointer-events-none absolute left-2.5 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-stone-400"
              aria-hidden
            />
            <input
              type="text"
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Search from, subject, text…"
              aria-label="Search mail"
              className="glass h-8 w-full rounded-full pl-8 pr-3 text-xs font-medium text-stone-700 shadow-sm outline-none transition-shadow placeholder:font-normal placeholder:text-stone-400 focus:shadow-md"
              style={{ caretColor: "var(--gd-accent)" }}
            />
          </div>
        </div>

        {/* folder header row (+ empty-trash) */}
        <div className="flex items-center justify-between px-3.5 pb-1">
          <h2 className="text-[10px] font-bold uppercase tracking-[0.14em] text-stone-400">
            {folderLabel}
          </h2>
          <div className="flex items-center gap-1.5">
            <span className="gd-mono text-[10px] text-stone-400">{rows.length}</span>
            {box === "trash" && trashCount > 0 && (
              <motion.button
                type="button"
                variants={pop}
                initial="rest"
                whileHover="hover"
                whileTap="tap"
                onClick={emptyTrash}
                className="flex items-center gap-1 rounded-full px-2 py-[3px] text-[10px] font-semibold text-stone-500 transition-colors hover:bg-rose-500/15 hover:text-rose-600"
              >
                <Trash2 className="h-3 w-3" aria-hidden />
                Empty
              </motion.button>
            )}
          </div>
        </div>

        {/* rows */}
        <div className="gd-scroll relative min-h-0 flex-1 overflow-y-auto px-1.5 pb-16">
          <AnimatePresence initial={false} mode="popLayout">
            {rows.map((m, i) => (
              <MailRow key={m.id} m={m} i={i} selected={p.sel === m.id} onOpen={open} onStar={toggleStar} />
            ))}
          </AnimatePresence>
          {rows.length === 0 && (
            <div className="grid h-28 place-items-center text-center">
              <div>
                <MailIcon className="mx-auto h-5 w-5 text-stone-300" aria-hidden />
                <p className="mt-1.5 text-[11px] font-medium text-stone-400">
                  {ql
                    ? "Nothing matches that."
                    : box === "trash"
                      ? "Trash is empty."
                      : box === "drafts"
                        ? "No drafts."
                        : "No mail here."}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* floating compose */}
        <motion.button
          type="button"
          variants={pop}
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          onClick={startCompose}
          aria-label="Compose a new message"
          className="absolute bottom-4 left-1/2 z-10 grid h-11 w-11 place-items-center rounded-full gd-accent-gradient text-white shadow-xl shadow-black/15 ring-1 ring-white/50"
          style={{ x: "-50%" }}
        >
          <Pen className="h-5 w-5" aria-hidden />
        </motion.button>
      </section>

      {/* ── pane 3 · reading pane ────────────────────────────── */}
      <section className="flex min-w-0 flex-1 flex-col bg-white/50">
        {!selMail ? (
          <div className="grid h-full w-full place-items-center px-6">
            <motion.div variants={riseIn} initial="hidden" animate="show" className="text-center">
              <motion.div
                animate={{ y: [0, -9, 0] }}
                transition={{ duration: 3.8, repeat: Infinity, ease: "easeInOut" }}
                className="mx-auto grid h-16 w-16 place-items-center rounded-2xl bg-gradient-to-br from-rose-400 to-amber-400 shadow-xl shadow-amber-500/25"
              >
                <MailIcon className="h-8 w-8 text-white" aria-hidden />
              </motion.div>
              <p className="mt-5 text-sm font-semibold text-stone-500">Select a message</p>
              <p className="mt-1 text-xs leading-relaxed text-stone-400">
                One mailbox, two seats — mail you send lands in Sent for both of you.
              </p>
            </motion.div>
          </div>
        ) : (
          <>
            <header className="px-5 pb-3 pt-4">
              <h2 className="text-xl font-semibold leading-snug tracking-tight text-stone-800">
                {selMail.subject}
              </h2>
              <div className="mt-3 flex flex-wrap items-center gap-2">
                <AvatarChip label="From" name={selMail.from} addr={addrOf(selMail.from)} />
                <AvatarChip
                  label="To"
                  name={selMail.to.split("@")[0]}
                  addr={selMail.to}
                />
                <span className="ml-auto text-[11px] font-medium text-stone-400">
                  {fullDate(selMail.at)}
                </span>
              </div>

              {/* actions */}
              <div className="mt-3 flex items-center gap-1.5">
                <motion.button
                  type="button"
                  variants={pop}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  onClick={() => startReply(selMail)}
                  className="flex h-8 items-center gap-1.5 rounded-full px-3.5 text-xs font-semibold text-white shadow-md gd-accent-gradient"
                >
                  <Reply className="h-3.5 w-3.5" aria-hidden />
                  Reply
                </motion.button>
                <motion.button
                  type="button"
                  variants={pop}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  onClick={() => startReply(selMail)}
                  className="flex h-8 items-center gap-1.5 rounded-full border border-white/70 bg-white/60 px-3 text-xs font-semibold text-stone-600 shadow-sm"
                >
                  <ReplyAll className="h-3.5 w-3.5" aria-hidden />
                  Reply All
                </motion.button>

                <motion.button
                  type="button"
                  variants={pop}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  onClick={() => toggleStar(selMail)}
                  aria-label={selMail.starred ? "Remove star" : "Star this message"}
                  aria-pressed={!!selMail.starred}
                  className="grid h-8 w-8 place-items-center rounded-full border border-white/70 bg-white/60 text-stone-500 shadow-sm"
                >
                  <motion.span
                    key={selMail.starred ? "on" : "off"}
                    initial={{ scale: 0.5 }}
                    animate={{ scale: 1 }}
                    transition={SPRING.snappy}
                    className="block"
                  >
                    <Star
                      className={`h-4 w-4 ${selMail.starred ? "fill-amber-400 text-amber-400" : ""}`}
                      aria-hidden
                    />
                  </motion.span>
                </motion.button>

                <motion.button
                  type="button"
                  variants={pop}
                  initial="rest"
                  whileHover="hover"
                  whileTap="tap"
                  onClick={() => remove(selMail)}
                  aria-label={selMail.box === "trash" ? "Delete forever" : "Move to Trash"}
                  className="ml-auto grid h-8 w-8 place-items-center rounded-full border border-white/70 bg-white/60 text-stone-500 shadow-sm transition-colors hover:border-rose-300 hover:bg-rose-500/15 hover:text-rose-600"
                >
                  <Trash2 className="h-4 w-4" aria-hidden />
                </motion.button>
              </div>
            </header>

            {/* body — the only scrollable region of the pane */}
            <div className="gd-scroll min-h-0 flex-1 overflow-y-auto px-5 pb-6">
              <p className="whitespace-pre-wrap text-sm leading-relaxed text-stone-700">
                {selMail.body}
              </p>
            </div>
          </>
        )}
      </section>

      {/* ── compose sheet: scrim + panel ─────────────────────── */}
      <AnimatePresence>
        {sheet && (
          <motion.div
            key="mail-scrim"
            className="absolute inset-0 z-30 bg-stone-900/25"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18 }}
            onClick={closeSheet}
            aria-hidden
          />
        )}
      </AnimatePresence>
      <AnimatePresence>
        {sheet && (
          <motion.div
            key="mail-sheet"
            role="dialog"
            aria-label={sheet.mode === "reply" ? "Reply" : "New message"}
            className="glass-strong absolute inset-x-4 bottom-4 top-20 z-40 flex flex-col rounded-2xl p-4 shadow-2xl"
            initial={{ y: "112%", opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: "112%", opacity: 0 }}
            transition={SPRING.sheet}
          >
            {/* sheet header */}
            <div className="flex items-center gap-2.5 pb-2.5">
              <div className="grid h-8 w-8 shrink-0 place-items-center rounded-xl bg-gradient-to-br from-rose-400 to-amber-400 shadow-md shadow-amber-500/20">
                <Pen className="h-4 w-4 text-white" aria-hidden />
              </div>
              <div className="min-w-0">
                <h3 className="text-sm font-bold tracking-tight text-stone-800">
                  {sheet.mode === "reply" ? "Reply" : "New message"}
                </h3>
                <p className="truncate text-[10px] text-stone-400">
                  {sheet.mode === "reply"
                    ? `to ${sheet.toName} · via the shared mailbox`
                    : "from you+friend@glassdesk"}
                </p>
              </div>
              <motion.button
                type="button"
                variants={pop}
                initial="rest"
                whileHover="hover"
                whileTap="tap"
                onClick={closeSheet}
                aria-label="Discard message"
                className="ml-auto grid h-7 w-7 place-items-center rounded-full bg-white/70 text-stone-500 transition-colors hover:bg-white hover:text-rose-500"
              >
                <X className="h-4 w-4" aria-hidden />
              </motion.button>
            </div>

            {/* fields */}
            <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border border-white/80 bg-white/65">
              <div className="flex items-center gap-2.5 border-b border-stone-200/70 px-3 py-2">
                <span className="w-11 shrink-0 text-[9px] font-bold uppercase tracking-[0.14em] text-stone-400">
                  To
                </span>
                <input
                  type="text"
                  value={sheet.to}
                  autoFocus={sheet.mode === "new"}
                  onChange={(e) => setSheet((s) => (s ? { ...s, to: e.target.value } : s))}
                  placeholder="friend@glassdesk"
                  aria-label="To"
                  className="gd-mono min-w-0 flex-1 bg-transparent text-xs font-medium text-stone-700 outline-none"
                  style={{ caretColor: "var(--gd-accent)" }}
                />
              </div>
              <div className="flex items-center gap-2.5 border-b border-stone-200/70 px-3 py-2">
                <span className="w-11 shrink-0 text-[9px] font-bold uppercase tracking-[0.14em] text-stone-400">
                  Subj
                </span>
                <input
                  type="text"
                  value={sheet.subject}
                  autoFocus={sheet.mode === "reply"}
                  onChange={(e) => setSheet((s) => (s ? { ...s, subject: e.target.value } : s))}
                  placeholder="Subject"
                  aria-label="Subject"
                  className="min-w-0 flex-1 bg-transparent text-sm font-semibold text-stone-800 outline-none"
                  style={{ caretColor: "var(--gd-accent)" }}
                />
              </div>
              <textarea
                value={sheet.body}
                onChange={(e) => setSheet((s) => (s ? { ...s, body: e.target.value } : s))}
                placeholder="Write something nice — the other seat sees it in Sent the moment you hit Send."
                aria-label="Message body"
                className="gd-scroll min-h-0 flex-1 resize-none bg-transparent px-3 py-2.5 text-sm leading-relaxed text-stone-700 outline-none placeholder:text-stone-400"
                style={{ caretColor: "var(--gd-accent)" }}
              />
            </div>

            {/* send row */}
            <div className="mt-3 flex items-center gap-2">
              <p className="min-w-0 flex-1 truncate text-[10px] leading-normal text-stone-400">
                One mailbox, two seats — this lands in Sent for both of you.
              </p>
              <motion.button
                type="button"
                variants={pop}
                initial="rest"
                whileHover="hover"
                whileTap="tap"
                onClick={sendSheet}
                disabled={!canSend}
                className="flex h-9 shrink-0 items-center gap-2 rounded-full px-5 text-xs font-bold text-white shadow-lg disabled:opacity-40 gd-accent-gradient"
              >
                <SendHorizontal className="h-4 w-4" aria-hidden />
                Send
              </motion.button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

// ============================================================
// presentational sub-components (module scope — static)
// ============================================================

/** One mail row in the list pane. */
function MailRow({
  m,
  i,
  selected,
  onOpen,
  onStar,
}: {
  m: Mail;
  i: number;
  selected: boolean;
  onOpen: (m: Mail) => void;
  onStar: (m: Mail) => void;
}) {
  return (
    <motion.div
      custom={i}
      variants={ROW_V}
      initial="hidden"
      animate="show"
      exit="exit"
      role="button"
      tabIndex={0}
      onClick={() => onOpen(m)}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onOpen(m);
        }
      }}
      className={`group relative mb-[3px] cursor-pointer rounded-xl px-2.5 py-2 transition-colors ${
        selected ? "bg-white/75" : "hover:bg-white/70"
      }`}
    >
      {selected && (
        <>
          <span
            className="pointer-events-none absolute inset-0 rounded-xl gd-accent-gradient opacity-[0.10]"
            aria-hidden
          />
          <span
            className="pointer-events-none absolute bottom-1.5 left-0 top-1.5 w-[3px] rounded-full gd-accent-gradient"
            aria-hidden
          />
        </>
      )}

      <div className="relative flex items-center gap-2">
        {!m.read ? (
          <motion.span
            initial={{ scale: 0 }}
            animate={{ scale: 1 }}
            transition={SPRING.playful}
            className="h-2 w-2 shrink-0 rounded-full"
            style={{ background: "var(--gd-accent)" }}
            aria-label="Unread"
            role="img"
          />
        ) : (
          <span className="h-2 w-2 shrink-0" aria-hidden />
        )}
        <span
          className={`min-w-0 flex-1 truncate text-xs ${
            m.read ? "font-medium text-stone-600" : "font-bold text-stone-900"
          }`}
        >
          {m.from}
        </span>
        <motion.button
          type="button"
          variants={pop}
          initial="rest"
          whileHover="hover"
          whileTap="tap"
          onClick={(e) => {
            e.stopPropagation();
            onStar(m);
          }}
          aria-label={m.starred ? `Unstar ${m.subject}` : `Star ${m.subject}`}
          className={`shrink-0 rounded-full p-1 transition-opacity ${
            m.starred ? "opacity-100" : "opacity-0 group-hover:opacity-60 focus-visible:opacity-60"
          }`}
        >
          <motion.span
            key={m.starred ? "on" : "off"}
            initial={{ scale: 0.55 }}
            animate={{ scale: 1 }}
            transition={SPRING.snappy}
            className="block"
          >
            <Star
              className={`h-3.5 w-3.5 ${m.starred ? "fill-amber-400 text-amber-400" : "text-stone-400"}`}
              aria-hidden
            />
          </motion.span>
        </motion.button>
        <span className="shrink-0 text-[10px] font-medium tabular-nums text-stone-400">
          {relTime(m.at)}
        </span>
      </div>

      <p
        className={`relative mt-0.5 truncate text-xs ${
          m.read ? "font-medium text-stone-700" : "font-semibold text-stone-900"
        }`}
      >
        {m.subject}
      </p>
      <p className="relative mt-0.5 truncate text-[11px] leading-normal text-stone-400">
        {previewOf(m)}
      </p>
    </motion.div>
  );
}

/** From/To chip with initials avatar. */
function AvatarChip({ label, name, addr }: { label: string; name: string; addr: string }) {
  return (
    <span className="glass flex items-center gap-1.5 rounded-full py-[3px] pl-[3px] pr-2.5 shadow-sm">
      <span className="grid h-[22px] w-[22px] shrink-0 place-items-center rounded-full gd-accent-gradient text-[9px] font-bold text-white">
        {initialsOf(name || addr)}
      </span>
      <span className="text-[10px] font-semibold uppercase tracking-wide text-stone-400">{label}</span>
      <span className="max-w-[110px] truncate text-[11px] font-medium text-stone-700">{name}</span>
      <span className="gd-mono max-w-[110px] truncate text-[10px] text-stone-400">{addr}</span>
    </span>
  );
}
