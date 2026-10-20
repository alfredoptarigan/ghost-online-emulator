import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";

const KEYS = [
  "Z", "X", "C", "V", "B", "N",
  "1", "2", "3", "4", "5", "6",
  "Insert", "Home", "PageUp", "Delete", "End", "PageDown",
  "7", "8", "9", "0", "-", "=",
];

export function quickSlotKeyName(type: number, slot: number): string {
  const map: Record<number, string[]> = {
    0: ["Z", "X", "C", "V", "B", "N"],
    1: ["1", "2", "3", "4", "5", "6"],
    2: ["Insert", "Home", "PageUp", "Delete", "End", "PageDown"],
    3: ["7", "8", "9", "0", "-", "="],
  };
  return map[type]?.[slot] ?? "";
}

export async function buildQuickSlotAll(charId: number): Promise<Buffer> {
  const b = Buffer.alloc(204, 0);
  writeHeader(b, 0x00a9, 204);
  for (let i = 0; i < 24; i++) {
    b.writeInt32LE(-1, 12 + i * 8);
    b.writeInt16LE(-1, 16 + i * 8);
    b.writeInt16LE(-1, 18 + i * 8);
  }
  try {
    const rows = await query<RowDataPacket[]>(
      "SELECT keyname, skillid, stype, sslot FROM skill_hotkeys WHERE charid=?",
      [charId],
    );
    for (const r of rows) {
      const idx = KEYS.indexOf(String(r.keyname));
      if (idx < 0) continue;
      b.writeInt32LE(Number(r.skillid), 12 + idx * 8);
      b.writeInt16LE(Number(r.stype), 16 + idx * 8);
      b.writeInt16LE(Number(r.sslot), 18 + idx * 8);
    }
  } catch (e) {
    console.error("[hotkeys] buildQuickSlotAll", e);
  }
  return b;
}

/**
 * Soul Saver avatar hotkey bar (S 0xA9 while transformed, 208 B): its own 24 entries, stored as "av_<key>" rows,
 * trailing u32 @204 = 1. Official Wildia: all -1 (never set); Mamluk keeps what the player dragged there
 * (DarkBall 3011 book type 7 slot 1, AirBeam 3012 type 7 slot 2).
 */
export const AVATAR_KEY_PREFIX = "av_";

export async function buildAvatarQuickSlot(charId: number): Promise<Buffer> {
  const b = Buffer.alloc(208, 0xff);
  writeHeader(b, 0x00a9, 208);
  b.writeUInt32LE(1, 204);
  try {
    const rows = await query<RowDataPacket[]>(
      "SELECT keyname, skillid, stype, sslot FROM skill_hotkeys WHERE charid=? AND keyname LIKE 'av\\_%'",
      [charId],
    );
    for (const r of rows) {
      const idx = KEYS.indexOf(String(r.keyname).slice(AVATAR_KEY_PREFIX.length));
      if (idx < 0) continue;
      b.writeInt32LE(Number(r.skillid), 12 + idx * 8);
      b.writeInt16LE(Number(r.stype), 16 + idx * 8);
      b.writeInt16LE(Number(r.sslot), 18 + idx * 8);
    }
  } catch (e) {
    console.error("[hotkeys] buildAvatarQuickSlot", e);
  }
  return b;
}

export async function saveQuickSlot(charId: number, pkt: Buffer, prefix = ""): Promise<void> {
  const ktype = pkt.readUInt16LE(12);
  const kslot = pkt.readUInt16LE(14);
  let sid = pkt.readInt32LE(16);
  let stype = pkt.readInt16LE(20);
  let sslot = pkt.readInt16LE(22);
  if ((stype & 0xffff) === 0xffff) stype = -1;
  if ((sslot & 0xffff) === 0xffff) sslot = -1;
  if ((sid >>> 0) === 0xffffffff) sid = -1;
  const name = quickSlotKeyName(ktype, kslot);
  if (!name) return;
  const key = prefix + name;
  await execute("DELETE FROM skill_hotkeys WHERE charid=? AND keyname=?", [charId, key]);
  if (!(sid === -1 && stype === -1 && sslot === -1)) {
    await execute("INSERT INTO skill_hotkeys (charid, keyname, skillid, stype, sslot) VALUES (?,?,?,?,?)", [
      charId,
      key,
      sid,
      stype,
      sslot,
    ]);
  }
}
