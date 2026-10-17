/**
 * Soul Saver spend items by their item.itm use type (data/ss_items.json "use" = [type, value, value2]; value2 is a
 * float32, the duration in seconds for timed items). Meanings from the item descriptions:
 *   0 MP +value, 1 MP +value %, 2 HP +value, 3 HP +value %, 41 HP and MP +value %  (recovery, answered with 0x51)
 *   21/22/29 HP / MP / HP and MP restored fully, "up to a total of value"  (pool not tracked: one use)
 *   5/6 max MP/HP +value, 7 attack speed, 9 movement speed, 10 leap, 11/12 physical/magic attack +value,
 *   13 defense +value, 23/24 physical/magic attack +value %, 39 physical and magic attack +value %,
 *   35/36 max HP/MP +value %                                                           (client buff packets)
 *   47 hunting EXP +value %, 57 gold drop +value %, 58 item drop +value %, 60 combo buff grade 1..4  (server rates)
 *   17 with value 1/2/11 or 3/5..8/0x7d..0x7f = torch, candle, antitoxin and firework visuals (S 0x71, client
 *   FUN_013462c0 / FUN_012b3bf0 switch on the value)
 *
 * Client buff packets (Game.exe dump, dispatcher 0x016383CC; all handled by the skill manager 0x39CBFB8):
 * u16 value @0x0C, u32 seconds left @0x10, u32 item id @0x14 (the buff icon); value 0 and 0 seconds removes the icon.
 *   0x52 max HP (28 B, FUN_01344c30)      0x53 max MP (28 B, FUN_01345020)     0x57 PATK % (28 B, FUN_013453a0)
 *   0x58 MATK % (28 B, FUN_01345600)      0x59 DEF (28 B, FUN_013459e0)        0x1fb PATK (28 B, FUN_013457c0)
 *   0x1fc MATK (28 B, FUN_013458d0)       0x26b HP % (24 B, FUN_01345ba0)      0x26c MP % (24 B, FUN_01345e90)
 *   0x54 attack speed / 0x55 movement / 0x56 leap (20 B, no item id: the client uses AzureSake 8840031,
 *   GoldenSake 8840051, ApricotSake 8840061; 0x55/0x56 read a byte @0x0C).
 * The group of each item comes from the remaining-time getter FUN_010aa110 (item id -> timer of the packet above);
 * type 39 items sit in the MATK % group. What the extra u32/u16 @0x18 of 0x53/0x57/0x58/0x1fb/0x1fc means is not
 * known (sent as 0). Attack and defense are applied by the client (it rolls the damage and sends 0x45/0x46); the
 * server does not raise its own max HP/MP for 5/6/35/36. The EXP/drop/gold buffs have no known icon packet.
 */
import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { config } from "../config.js";
import { writeHeader } from "../net/packet.js";

type Item = { n?: string; s?: number; use?: number[] };
let items: Record<string, Item> | null = null;

function item(itemId: number): Item | undefined {
  items ??= (() => {
    try {
      return JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_items.json"), "utf8")).items ?? {};
    } catch {
      return {};
    }
  })();
  return items![itemId];
}

function f32(bits: number): number {
  const b = Buffer.alloc(4);
  b.writeInt32LE(bits | 0);
  return b.readFloatLE(0);
}

/** [type, value, seconds] of a spend item, or null. */
export function ssUse(itemId: number): { type: number; value: number; secs: number } | null {
  const it = item(itemId);
  if (!it?.use || (it.s !== 7 && it.s !== 15)) return null;
  const [type = 0, value = 0, raw = 0] = it.use;
  return { type, value, secs: Math.max(0, Math.round(f32(raw))) };
}

/** HP/MP recovery of a potion or food, or null. */
export function ssRecover(itemId: number, maxHp: number, maxMp: number): { hp: number; mp: number } | null {
  const u = ssUse(itemId);
  if (!u || (item(itemId)?.s ?? 0) !== 7) return null;
  const pct = (max: number) => Math.floor((max * u.value) / 100);
  switch (u.type) {
    case 0: return { hp: 0, mp: u.value };
    case 1: return { hp: 0, mp: pct(maxMp) };
    case 2: return { hp: u.value, mp: 0 };
    case 3: return { hp: pct(maxHp), mp: 0 };
    case 41: return { hp: pct(maxHp), mp: pct(maxMp) };
    // "Fully restores ... each time when used, up to a total of value" (value 0 = unlimited). The remaining total
    // is not tracked yet: one use restores fully and spends the item.
    case 21: return { hp: u.value || maxHp, mp: 0 };
    case 22: return { hp: 0, mp: u.value || maxMp };
    case 29: return { hp: u.value || maxHp, mp: u.value || maxMp };
    default: return null;
  }
}

/** Use type 17 values the S 0x71 handlers draw: 1/2/11 torch, candle, antitoxin (FUN_013462c0), the rest fireworks. */
const VISUAL = new Set([1, 2, 11, 3, 5, 6, 7, 8, 0x7d, 0x7e, 0x7f]);

/** Torch/candle/antitoxin/firework items: the client draws them from S 0x71. */
export function ssUseVisual(itemId: number): boolean {
  const u = ssUse(itemId);
  return !!u && u.type === 17 && VISUAL.has(u.value);
}

const STAT: Record<number, { op: number; len: number; item?: number }> = {
  5: { op: 0x53, len: 28 },
  6: { op: 0x52, len: 28 },
  7: { op: 0x54, len: 20, item: 8840031 },
  9: { op: 0x55, len: 20, item: 8840051 },
  10: { op: 0x56, len: 20, item: 8840061 },
  11: { op: 0x1fb, len: 28 },
  12: { op: 0x1fc, len: 28 },
  13: { op: 0x59, len: 28 },
  23: { op: 0x57, len: 28 },
  24: { op: 0x58, len: 28 },
  39: { op: 0x58, len: 28 },
  35: { op: 0x26b, len: 24 },
  36: { op: 0x26c, len: 24 },
};

/** Combo buff grades (use type 60, item descriptions 8871721/8871722/8871742/8871743). */
const COMBO: Record<number, { exp: number; drop: number; gold: number }> = {
  1: { exp: 10, drop: 0, gold: 5 },
  2: { exp: 30, drop: 0, gold: 30 },
  3: { exp: 50, drop: 10, gold: 30 },
  4: { exp: 100, drop: 30, gold: 30 },
};

function rates(type: number, value: number): { exp: number; drop: number; gold: number } | null {
  if (type === 47) return { exp: value, drop: 0, gold: 0 };
  if (type === 57) return { exp: 0, drop: 0, gold: value };
  if (type === 58) return { exp: 0, drop: value, gold: 0 };
  if (type === 60) return COMBO[value] ?? null;
  return null;
}

/** Buff group: the client packet opcode for stat buffs, 1000 + use type for the rate buffs. */
function group(type: number): number | null {
  if (STAT[type]) return STAT[type]!.op;
  if (type === 47 || type === 57 || type === 58 || type === 60) return 1000 + type;
  return null;
}

/** True when the item is a timed buff this server applies. */
export function isSsBuffItem(itemId: number): boolean {
  const u = ssUse(itemId);
  return !!u && u.secs > 0 && group(u.type) !== null && (u.type !== 60 || !!COMBO[u.value]);
}

export function buffPacket(type: number, value: number, secs: number, itemId: number): Buffer | null {
  const s = STAT[type];
  if (!s) return null;
  const b = Buffer.alloc(s.len, 0);
  writeHeader(b, s.op, s.len);
  if (s.op === 0x55 || s.op === 0x56) b.writeUInt8(Math.min(255, Math.max(0, value)), 12);
  else b.writeUInt16LE(Math.min(0xffff, Math.max(0, value)), 12);
  b.writeUInt32LE(Math.max(0, secs) >>> 0, 16);
  if (s.len >= 24) b.writeUInt32LE((s.item ?? itemId) >>> 0, 20);
  return b;
}

type Buff = { grp: number; itemId: number; type: number; value: number; until: number };
const active = new Map<number, Buff[]>();

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute(
    "CREATE TABLE IF NOT EXISTS ss_item_buff (charid int NOT NULL, grp int NOT NULL, itemid int NOT NULL, " +
      "value int NOT NULL, until bigint NOT NULL, PRIMARY KEY (charid, grp))",
  );
  tableReady = true;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Load the running buffs (expired rows are dropped). Returns the client packets that restore their icons. */
export async function loadSsBuffs(charId: number): Promise<Buffer[]> {
  await ensureTable();
  const now = nowSec();
  await execute("DELETE FROM ss_item_buff WHERE charid=? AND until<=?", [charId, now]);
  const rows = await query<RowDataPacket[]>("SELECT grp, itemid, value, until FROM ss_item_buff WHERE charid=?", [charId]);
  const list: Buff[] = [];
  const out: Buffer[] = [];
  for (const r of rows) {
    const itemId = Number(r.itemid);
    const type = ssUse(itemId)?.type ?? -1;
    const b: Buff = { grp: Number(r.grp), itemId, type, value: Number(r.value), until: Number(r.until) };
    list.push(b);
    const pkt = buffPacket(type, b.value, b.until - now, itemId);
    if (pkt) out.push(pkt);
  }
  if (list.length) active.set(charId, list);
  else active.delete(charId);
  return out;
}

/**
 * Start (or replace, same group) the buff of a used item. Returns the client packets, or null when the item is not
 * a buff this server applies.
 */
export async function startSsBuff(charId: number, itemId: number): Promise<Buffer[] | null> {
  const u = ssUse(itemId);
  if (!u || !isSsBuffItem(itemId)) return null;
  await ensureTable();
  const grp = group(u.type)!;
  const until = nowSec() + u.secs;
  await execute("REPLACE INTO ss_item_buff (charid, grp, itemid, value, until) VALUES (?, ?, ?, ?, ?)", [
    charId,
    grp,
    itemId,
    u.value,
    until,
  ]);
  const list = (active.get(charId) ?? []).filter((b) => b.grp !== grp);
  list.push({ grp, itemId, type: u.type, value: u.value, until });
  active.set(charId, list);
  const pkt = buffPacket(u.type, u.value, u.secs, itemId);
  return pkt ? [pkt] : [];
}

/** Drop the buffs that ran out; returns the icon-removal packets per character. */
export function expireSsBuffs(): { charId: number; packets: Buffer[] }[] {
  const now = nowSec();
  const res: { charId: number; packets: Buffer[] }[] = [];
  for (const [charId, list] of active) {
    const gone = list.filter((b) => b.until <= now);
    if (!gone.length) continue;
    const left = list.filter((b) => b.until > now);
    if (left.length) active.set(charId, left);
    else active.delete(charId);
    void execute("DELETE FROM ss_item_buff WHERE charid=? AND until<=?", [charId, now]).catch(() => {});
    const packets = gone.map((b) => buffPacket(b.type, 0, 0, b.itemId)).filter((p): p is Buffer => !!p);
    res.push({ charId, packets });
  }
  return res;
}

/** EXP/drop/gold multipliers of the running rate buffs (1 when none). */
export function ssBuffMuls(charId: number): { expMul: number; dropMul: number; goldMul: number } {
  const now = nowSec();
  let exp = 0;
  let drop = 0;
  let gold = 0;
  for (const b of active.get(charId) ?? []) {
    if (b.until <= now) continue;
    const r = rates(b.type, b.value);
    if (!r) continue;
    exp += r.exp;
    drop += r.drop;
    gold += r.gold;
  }
  return { expMul: 1 + exp / 100, dropMul: 1 + drop / 100, goldMul: 1 + gold / 100 };
}
