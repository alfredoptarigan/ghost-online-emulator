/**
 * Soul Saver belt (item.itm section 24, worn slot 22), e.g. DongkuaBelt 7200011.
 * Client tooltip (FUN_010aea70 + tb_String 1015571..1015575): every absorbed spirit adds 2 points, 1 point is lost
 * per minute, at most 60 points; while points remain, hunting EXP rises by item f[8] % (record +0x5c; Dongkua 100)
 * for characters up to level f[1] (record +0x43; Dongkua 30). Unequip, map/channel change and logout reset it.
 * The client shows the points as "Ability time Limit : %d minutes left" from S 0x388 (16 B, byte @0x0c, handler
 * FUN_013440d0 → skill manager +0xc60) and zeroes them itself on MAP_INFO 0x1c.
 */
import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { query } from "../db.js";
import { config } from "../config.js";

const POINTS_PER_SPIRIT = 2;
const BELT_SLOT = 22;

type Belt = { itemId: number; maxLevel: number; expPct: number; cap: number };
type ItemsTable = Record<string, { s?: number; f?: number[] }>;
let items: ItemsTable | null = null;

const points = new Map<number, { itemId: number; points: number }>();

function beltItem(itemId: number): Belt | null {
  items ??= (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_items.json"), "utf8")).items ?? {};
    } catch {
      return {};
    }
  })();
  const it = items![itemId];
  if (it?.s !== 24 || !it.f) return null;
  return { itemId, maxLevel: (it.f[1] ?? 0) & 0xff, expPct: it.f[8] ?? 0, cap: it.f[5] || 60 };
}

/** The belt worn by a character, or null. */
export async function wornBelt(charId: number): Promise<Belt | null> {
  const rows = await query<RowDataPacket[]>("SELECT type FROM equip WHERE charid=? AND pos1=0 AND pos2=?", [
    charId,
    BELT_SLOT,
  ]);
  return rows.length ? beltItem(Number(rows[0]!.type)) : null;
}

/** S 0x388: remaining belt minutes (= points). */
export function beltPacket(minutes: number): Buffer {
  const b = Buffer.alloc(16, 0);
  b.writeUInt16LE(0x0105, 0);
  b.writeUInt16LE(0x0388, 2);
  b.writeUInt16LE(16, 4);
  b.writeUInt8(Math.max(0, Math.min(255, minutes)), 12);
  return b;
}

/** A spirit was absorbed: add points if a belt is worn. Returns the new points, or null without a belt. */
export async function beltAbsorb(charId: number): Promise<number | null> {
  const belt = await wornBelt(charId);
  if (!belt) {
    points.delete(charId);
    return null;
  }
  const cur = points.get(charId);
  const base = cur && cur.itemId === belt.itemId ? cur.points : 0;
  const next = Math.min(belt.cap, base + POINTS_PER_SPIRIT);
  points.set(charId, { itemId: belt.itemId, points: next });
  return next;
}

/** Hunting EXP multiplier from the worn belt (1 when no points are left or the level is above the belt's). */
export async function beltExpMul(charId: number, level: number): Promise<number> {
  const cur = points.get(charId);
  if (!cur || cur.points <= 0) return 1;
  const belt = beltItem(cur.itemId);
  if (!belt || level > belt.maxLevel) return 1;
  return 1 + belt.expPct / 100;
}

/** Drop the points (unequip, map change, logout). Returns true when there were any. */
export function beltReset(charId: number): boolean {
  const had = (points.get(charId)?.points ?? 0) > 0;
  points.delete(charId);
  return had;
}

/** After an equip change: drop the points when the belt was taken off or swapped (true if there were any). */
export async function beltCheckWorn(charId: number): Promise<boolean> {
  const cur = points.get(charId);
  if (!cur) return false;
  const belt = await wornBelt(charId);
  if (belt?.itemId === cur.itemId) return false;
  points.delete(charId);
  return cur.points > 0;
}

/** One minute passed: -1 point for everyone. Returns the characters whose points changed, with the new value. */
export function beltDecay(): Array<{ charId: number; points: number }> {
  const out: Array<{ charId: number; points: number }> = [];
  for (const [charId, cur] of points) {
    if (cur.points <= 0) continue;
    cur.points -= 1;
    out.push({ charId, points: cur.points });
  }
  return out;
}
