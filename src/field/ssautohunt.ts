/**
 * Soul Saver Auto Hunt tray (official capture day2_stage2 t=2122..10815, client handlers 0xFF3B50..0xFF8B00).
 *
 * C 0x744 u8 @12: 1 start / 0 stop -> S 0x74D (charId u32 @12, u8 @16; to the map: icon over the head,
 *   FUN_00ff8b00) + S 0x745 (u8 @12: 1 start, 0/2 stop, FUN_00ff8920).
 * C 0x746 (24 B): skill u32 @12, u16 @16, u16 @18, slot u32 @20 (0..7) -> S 0x747 echo (skill -1 = clear,
 *   echoed as zeros). Client stores the 8 slots at tray +0x390.
 * C 0x742 u32 @12: auto charge on/off -> S 0x743 u8 @12 (tb_String 111111 / 111112).
 * C 0x740: charge 100k gold into the Auto Bucket -> S 0x6B money, S 0x73F, S 0x741 u8 1 (0 = 111107 refused).
 * S 0x73F (100 B, FUN_00ff34c0; sent with every CHAR_ALL): bucket gold @12 (max 1,000,000), HP/MP gauge % @16
 *   (refill threshold, slider = %/10 - 1), option @20 (25/50/75 radio), auto charge u8 @24, 8 x (skill u32,
 *   u16, u16) @28, fatigue grade @92 (1..5 = gold rate 100/90/80/70/50 %), fatigue seconds @96 (seconds % 3600
 *   = time left in the grade). Official: grade 1 with 14400 s; the seconds only go down while Auto Hunt is on.
 * While Auto Hunt is on the official server refills HP and MP to full when one drops under the gauge %, and takes
 *   1 gold per point from the bucket (t=8796: +261 HP for 261 gold; t=8810: +303 MP for 303 gold).
 */
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";

export const BUCKET_MAX = 1_000_000;
export const BUCKET_CHARGE = 100_000;
const FATIGUE_DAY = 14_400;
const GOLD_RATE = [100, 90, 80, 70, 50];

type Slot = { skill: number; a: number; b: number };
export type AutoHunt = {
  bucket: number;
  gauge: number;
  option: number;
  autoCharge: boolean;
  slots: Slot[];
  fatigue: number;
  day: number;
  on: boolean;
  onSince: number;
};

const hunts = new Map<number, AutoHunt>();
const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);
const emptySlots = (): Slot[] => Array.from({ length: 8 }, () => ({ skill: 0, a: 0, b: 0 }));

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute(
    "CREATE TABLE IF NOT EXISTS ss_autohunt (charid int NOT NULL PRIMARY KEY, bucket int NOT NULL DEFAULT 0, " +
      "gauge int NOT NULL DEFAULT 90, opt int NOT NULL DEFAULT 75, autocharge tinyint NOT NULL DEFAULT 0, " +
      "slots varchar(255) NOT NULL DEFAULT '', fatigue int NOT NULL DEFAULT 14400, day int NOT NULL DEFAULT 0)",
  );
  tableReady = true;
}

export async function loadAutoHunt(charId: number): Promise<AutoHunt> {
  let h = hunts.get(charId);
  if (!h) {
    await ensureTable();
    const r = (await query<RowDataPacket[]>("SELECT * FROM ss_autohunt WHERE charid=?", [charId]))[0];
    const slots = emptySlots();
    try {
      (JSON.parse(String(r?.slots || "[]")) as Slot[]).slice(0, 8).forEach((s, i) => (slots[i] = s));
    } catch {
      /* bad row: empty tray */
    }
    h = {
      bucket: Number(r?.bucket ?? 0),
      gauge: Number(r?.gauge ?? 90),
      option: Number(r?.opt ?? 75),
      autoCharge: Number(r?.autocharge ?? 0) === 1,
      slots,
      fatigue: Number(r?.fatigue ?? FATIGUE_DAY),
      day: Number(r?.day ?? 0),
      on: false,
      onSince: 0,
    };
    hunts.set(charId, h);
  }
  if (h.day !== today()) {
    // Not captured: the fatigue time is assumed to come back once per day.
    h.day = today();
    h.fatigue = FATIGUE_DAY;
  }
  return h;
}

/** Use up fatigue time for the Auto Hunt time since the last call. */
function spendFatigue(h: AutoHunt): void {
  if (!h.on) return;
  const now = Date.now();
  const sec = Math.floor((now - h.onSince) / 1000);
  if (sec <= 0) return;
  h.fatigue = Math.max(0, h.fatigue - sec);
  h.onSince += sec * 1000;
}

export function fatigueGrade(h: AutoHunt): number {
  return h.fatigue > 0 ? Math.max(1, 5 - Math.ceil(h.fatigue / 3600)) : 5;
}

export function goldRate(h: AutoHunt): number {
  return GOLD_RATE[fatigueGrade(h) - 1]!;
}

export async function saveAutoHunt(charId: number): Promise<void> {
  const h = hunts.get(charId);
  if (!h) return;
  spendFatigue(h);
  await ensureTable();
  await execute(
    "REPLACE INTO ss_autohunt (charid, bucket, gauge, opt, autocharge, slots, fatigue, day) VALUES (?,?,?,?,?,?,?,?)",
    [charId, h.bucket, h.gauge, h.option, h.autoCharge ? 1 : 0, JSON.stringify(h.slots), h.fatigue, h.day],
  );
}

/** Logout: save, and Auto Hunt is off on the next login. */
export async function leaveAutoHunt(charId: number): Promise<void> {
  await saveAutoHunt(charId);
  hunts.delete(charId);
}

export function autoHuntStatePacket(h: AutoHunt): Buffer {
  spendFatigue(h);
  const b = Buffer.alloc(100, 0);
  writeHeader(b, 0x073f, 100);
  b.writeUInt32LE(h.bucket, 12);
  b.writeUInt32LE(h.gauge, 16);
  b.writeUInt32LE(h.option, 20);
  b.writeUInt8(h.autoCharge ? 1 : 0, 24);
  h.slots.forEach((s, i) => {
    b.writeInt32LE(s.skill, 28 + 8 * i);
    b.writeUInt16LE(s.a & 0xffff, 32 + 8 * i);
    b.writeUInt16LE(s.b & 0xffff, 34 + 8 * i);
  });
  b.writeUInt32LE(fatigueGrade(h), 92);
  b.writeUInt32LE(h.fatigue, 96);
  return b;
}

function u8Packet(op: number, v: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, op, 16);
  b.writeUInt8(v, 12);
  return b;
}

/** S 0x74D to the map: Auto Hunt icon over the character. */
export function autoHuntMapPacket(charId: number, on: boolean): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x074d, 20);
  b.writeUInt32LE(charId, 12);
  b.writeUInt8(on ? 1 : 0, 16);
  return b;
}

/** C 0x744: returns S 0x745 for the player (the caller broadcasts S 0x74D). */
export function setAutoHunt(h: AutoHunt, on: boolean): Buffer {
  spendFatigue(h);
  if (on && !h.on) h.onSince = Date.now();
  h.on = on;
  return u8Packet(0x0745, on ? 1 : 0);
}

export function isAutoHunting(charId: number): boolean {
  return hunts.get(charId)?.on ?? false;
}

/** C 0x746 -> S 0x747. */
export function setAutoHuntSkill(h: AutoHunt, pkt: Buffer): Buffer | null {
  if (pkt.length < 24) return null;
  const slot = pkt.readInt32LE(20);
  if (slot < 0 || slot > 7) return null;
  const skill = pkt.readInt32LE(12);
  h.slots[slot] = skill > 0 ? { skill, a: pkt.readUInt16LE(16), b: pkt.readUInt16LE(18) } : { skill: 0, a: 0, b: 0 };
  const s = h.slots[slot]!;
  const b = Buffer.alloc(24, 0);
  writeHeader(b, 0x0747, 24);
  b.writeInt32LE(s.skill, 12);
  b.writeUInt16LE(s.a, 16);
  b.writeUInt16LE(s.b, 18);
  b.writeInt32LE(slot, 20);
  return b;
}

/** C 0x742 -> S 0x743. */
export function setAutoCharge(h: AutoHunt, on: boolean): Buffer {
  h.autoCharge = on;
  return u8Packet(0x0743, on ? 1 : 0);
}

/** Bucket charge: true when there was room (the caller takes the gold). */
export function chargeBucket(h: AutoHunt): boolean {
  if (h.bucket + BUCKET_CHARGE > BUCKET_MAX) return false;
  h.bucket += BUCKET_CHARGE;
  return true;
}

export function chargeResultPacket(ok: boolean): Buffer {
  return u8Packet(0x0741, ok ? 1 : 0);
}

/** Characters with Auto Hunt on. */
export function autoHunters(): number[] {
  return [...hunts].filter(([, h]) => h.on).map(([id]) => id);
}

export function autoHuntOf(charId: number): AutoHunt | undefined {
  return hunts.get(charId);
}
