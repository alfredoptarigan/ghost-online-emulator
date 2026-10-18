/**
 * Soul Saver anti-macro "Window of Truth" (official capture day2_stage2: 8 popups, about every 20-25 min of hunting).
 *
 * S 0x73D (40 B, client FUN_010143b0): six code characters, each sent as char + offset and in a shuffled order:
 *   letter 1 = u32 @12 - 0x31, 2 = @28 - 0x32, 3 = @16 - 0x33, 4 = @20 - 0x34, 5 = @32 - 0x35, 6 = @24 - 0x36
 *   (u32 @12 <= 0x30 closes the window). Characters are 0-9 / A-Z (glyph = char - 0x30 / char - 0x37 in
 *   Number_WindowsTruth.spr). u32 @36: formula = value % 10; a value < 10 also restarts the 60 s countdown
 *   (the client closes the window by itself after 60 ticks of 1 s, FUN_01014310, without sending anything).
 * C 0x73E (16 B, FUN_01014510 on [OK]): u32 @12 = checksum of the typed text c0..c5 (UTF-16 code units):
 *   formula 0: c3 - c2 - c4 - c5 + c1 + c0
 *   formula 1: c4*c1 - c3*c2 + c5*c0
 *   formula 2: c4 - c3 - c2 + c1 + c5 + c0
 *   (capture: CQLC39 formula 1 -> 2858, HQI5CX formula 0 -> -22).
 * Success: S 0x7D0 tb_String 111071 "Received %s." (param type 2 = item id 8890102 RewardPlaque) + S 0xEA u32 1.
 * Failure (wrong answer or no answer): moved to a village (tb_String 111070).
 */
import { writeHeader } from "../net/packet.js";

const CHARS = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ";
/** Packet word (u32 index from @12) that carries each code character, and its offset. */
const SLOT = [0, 4, 1, 2, 5, 3];
export const WOT_REWARD_ITEM = 8890102;
const ANSWER_MS = 60_000 + 10_000; // client countdown + network slack
const MIN_GAP_MS = 20 * 60_000;
const MAX_GAP_MS = 25 * 60_000;
/** "Hunting" = killed a monster within this time. */
const HUNT_WINDOW_MS = 120_000;

type Pending = { code: string; formula: number; expected: number; deadline: number };
type State = { nextAt: number; lastKill: number; pending: Pending | null };

const states = new Map<number, State>();

const gap = () => MIN_GAP_MS + Math.floor(Math.random() * (MAX_GAP_MS - MIN_GAP_MS));

function state(charId: number): State {
  let s = states.get(charId);
  if (!s) {
    s = { nextAt: Date.now() + gap(), lastKill: 0, pending: null };
    states.set(charId, s);
  }
  return s;
}

/** Checksum the client sends for a typed code (FUN_01014510). */
export function wotAnswer(code: string, formula: number): number {
  const c = [...code.padEnd(6, "\0")].slice(0, 6).map((ch) => ch.charCodeAt(0) & 0xffff);
  const [c0, c1, c2, c3, c4, c5] = c as [number, number, number, number, number, number];
  if (formula === 1) return (c4 * c1 - c3 * c2 + c5 * c0) | 0;
  if (formula === 2) return (c4 - ((c3 << 24) >> 24) - c2 + c1 + c5 + c0) | 0;
  return (c3 - c2 - c4 - c5 + c1 + c0) | 0;
}

export function wotPuzzlePacket(code: string, formula: number): Buffer {
  const b = Buffer.alloc(40, 0);
  writeHeader(b, 0x073d, 40);
  for (let i = 0; i < 6; i++) b.writeUInt32LE(code.charCodeAt(i) + 0x31 + i, 12 + 4 * SLOT[i]!);
  b.writeUInt32LE(formula, 36);
  return b;
}

/** S 0x7D0 system message: tb_String id @12, param type @16 (2 = item id), param @20. */
export function sysMsgItemPacket(msgId: number, itemId: number): Buffer {
  const b = Buffer.alloc(44, 0);
  writeHeader(b, 0x07d0, 44);
  b.writeUInt32LE(msgId, 12);
  b.writeUInt32LE(2, 16);
  b.writeUInt32LE(itemId, 20);
  return b;
}

/** Note a monster kill (only hunting characters get the popup). */
export function wotNoteKill(charId: number): void {
  state(charId).lastKill = Date.now();
}

/** Start a puzzle now; returns the S 0x73D packet. */
export function wotStart(charId: number): Buffer {
  const code = Array.from({ length: 6 }, () => CHARS[Math.floor(Math.random() * CHARS.length)]).join("");
  const formula = Math.floor(Math.random() * 3);
  state(charId).pending = { code, formula, expected: wotAnswer(code, formula), deadline: Date.now() + ANSWER_MS };
  return wotPuzzlePacket(code, formula);
}

/** Characters due for a popup (hunting, interval elapsed, none open). */
export function wotDue(charIds: Iterable<number>): number[] {
  const now = Date.now();
  const out: number[] = [];
  for (const id of charIds) {
    const s = state(id);
    if (!s.pending && now >= s.nextAt && now - s.lastKill <= HUNT_WINDOW_MS) out.push(id);
  }
  return out;
}

/** Characters whose open puzzle ran out (cleared; they fail). */
export function wotExpired(): number[] {
  const now = Date.now();
  const out: number[] = [];
  for (const [id, s] of states) {
    if (s.pending && now > s.pending.deadline) {
      s.pending = null;
      s.nextAt = now + gap();
      out.push(id);
    }
  }
  return out;
}

/** C 0x73E: true = right, false = wrong, null = no puzzle open. */
export function wotCheck(charId: number, answer: number): { ok: boolean; code: string } | null {
  const s = states.get(charId);
  const p = s?.pending;
  if (!s || !p) return null;
  s.pending = null;
  s.nextAt = Date.now() + gap();
  return { ok: (answer | 0) === p.expected, code: p.code };
}

export function wotLeave(charId: number): void {
  states.delete(charId);
}
