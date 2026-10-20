/**
 * Soul Saver skills, from the client's zGsp/table/skill.skl (exported to data/ss_skill_table.json by
 * re-tools/export_skl.js): 577 skills with owner job, max level and per-level attribute values
 * (tb_SkillAttribute ids: 0 HP use, 1 MP use, 2 HP heal, 3 MP heal, 7 MP use %, 8 HP heal %, 9 MP heal %, 19 duration).
 * Official checks: AirWalk lv1 costs 2 MP and WindPalm lv1 3 MP (pktmon capture), YinYangCharge max level 20.
 *
 * Jobs (tb_JobBase): 0 Novice, 1 Fencer, 2 Assassin, 3 Magic User, 4 Fighter, 5 Archer, 6 Mamluk, 7 Saladin,
 * 8 Dark Mage, 9 Berserker, 10 Janissary, 11 Spearman.
 *
 * SKILL_ALL 0x73 (708 B, parser FUN_0135eb80), one level byte per slot plus a second copy (official: same value):
 *   book 0 common   i16 ids @0x0c ×10, lv @0x20, lv2 @0x2a        (skills 1..99)
 *   book 1 1st job  i16 ids @0x34 ×20, lv @0x5c, lv2 @0x70, u32 @0x1c8 ×20 (1xxxx; 13xxx/14xxx = taehwa upgrades)
 *   book 2          i16 ids @0x84 ×10, lv @0x98, lv2 @0xa2        (2xxxx)
 *   book 3 faction  u32 ids @0xac ×20, lv @0xfc, lv2 @0x110       (3xxxx)
 *   book 4          u32 ids @0x124 ×10, lv @0x14c, lv2 @0x156     (4xxxx and up)
 *   avatar          u32 ids @0x160 ×10, lv @0x188; u32 @0x194 ×10, lv @0x1bc
 *   avatar combos   u32 ids @0x218 ×10, lv @0x240 (official: 3012..3017 for every new character, sword or fan)
 */
import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { config } from "../config.js";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";
import { avatarLevel, avatarSkills, jarSkills } from "./ssavatar.js";

export type SsSkill = {
  n: string;
  active: number;
  target: number;
  cast: number;
  max: number;
  job: number;
  pre: number[];
  attr: Record<string, number[]>;
};

const table: Record<string, SsSkill> = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_skill_table.json"), "utf8")).skills ?? {};
  } catch {
    console.warn("[ssskills] data/ss_skill_table.json missing — Soul Saver skills use defaults");
    return {};
  }
})();

/** Logged-in characters that use the Soul Saver client (skill packets differ). */
export const ssSkillClients = new Set<number>();

export function ssSkill(id: number): SsSkill | undefined {
  return table[id];
}

/** AvatarWeapon: common skill 5, given with the avatar jars at lv10 (skill.skl max 0; Mamluk shows 1/20). */
export const SS_AVATAR_WEAPON = 5;

export function ssMaxLevel(id: number): number {
  if (id === SS_AVATAR_WEAPON) return 20;
  const s = table[id];
  return s && s.max > 0 ? s.max : 1;
}

/** Official lv10: AvatarWeapon appears in book 0 at level 1 (capture day1_stage1 t=899). */
export async function grantSsAvatarWeapon(charId: number, charLevel: number): Promise<boolean> {
  if (charLevel < 10) return false;
  const rows = await query<RowDataPacket[]>("SELECT id FROM skills WHERE charid=? AND skillid=?", [charId, SS_AVATAR_WEAPON]);
  if (rows.length) return false;
  await execute("INSERT INTO skills (charid, skillid, points) VALUES (?,?,1)", [charId, SS_AVATAR_WEAPON]);
  return true;
}

/** Attribute value at a skill level (1-based); 0 when the skill has no such attribute. */
export function ssAttr(id: number, attr: number, level: number): number {
  const v = table[id]?.attr[attr];
  if (!v?.length) return 0;
  return v[Math.min(v.length, Math.max(1, level)) - 1] ?? 0;
}

/** Book (tab) of a skill id; -1 for avatar/combo skills, which have fixed sections. */
export function ssBook(id: number): number {
  if (id < 100) return 0;
  if (id < 10000) return -1;
  const d = Math.floor(id / 10000);
  return d >= 4 ? 4 : d;
}

const BOOK_SLOTS = [10, 20, 10, 20, 10];
const COMBOS = [3012, 3013, 3014, 3015, 3016, 3017];

type Row = { id: number; skillid: number; points: number };

async function rowsByBook(charId: number): Promise<Row[][]> {
  const rows = await query<RowDataPacket[]>("SELECT id, skillid, points FROM skills WHERE charid=? ORDER BY skillid", [charId]);
  const books: Row[][] = [[], [], [], [], []];
  for (const r of rows) {
    const sid = Number(r.skillid);
    const b = ssBook(sid);
    if (b < 0 || books[b]!.length >= BOOK_SLOTS[b]!) continue;
    // Levels from the Ghost rules can exceed the Soul Saver max (Meditate 20 → 6).
    const points = Math.min(ssMaxLevel(sid), Math.max(1, Number(r.points ?? 1)));
    books[b]!.push({ id: Number(r.id), skillid: sid, points });
  }
  return books;
}

export async function ssSkillByBookSlot(charId: number, book: number, slot: number): Promise<Row | null> {
  if (book < 0 || book > 4 || slot < 0 || slot >= BOOK_SLOTS[book]!) return null;
  return (await rowsByBook(charId))[book]![slot] ?? null;
}

export async function buildSsSkillAll(charId: number): Promise<Buffer> {
  const s = Buffer.alloc(708, 0);
  writeHeader(s, 0x0073, 708);
  const books = await rowsByBook(charId);
  const layout: Array<[ids: number, wide: boolean, lv: number, lv2: number]> = [
    [0x0c, false, 0x20, 0x2a],
    [0x34, false, 0x5c, 0x70],
    [0x84, false, 0x98, 0xa2],
    [0xac, true, 0xfc, 0x110],
    [0x124, true, 0x14c, 0x156],
  ];
  books.forEach((rows, b) => {
    const [ids, wide, lv, lv2] = layout[b]!;
    rows.forEach((r, i) => {
      if (wide) s.writeUInt32LE(r.skillid, ids + 4 * i);
      else s.writeInt16LE(r.skillid, ids + 2 * i);
      s.writeUInt8(Math.min(255, r.points), lv + i);
      s.writeUInt8(Math.min(255, r.points), lv2 + i);
    });
  });
  // Equipped avatar jar: its unlocked attack skills (DarkBall 3011 / WhiteBall 2011, ...) follow the common skills
  // in book 0 (official t=7603: 1..5 then 2011; Mamluk: 1..5 then 3011). Without them the client never casts the
  // jar skill from the avatar hotkey bar (book type 7).
  let n0 = books[0]!.length;
  for (const [id, lv] of jarSkills(charId)) {
    if (n0 >= BOOK_SLOTS[0]!) break;
    s.writeInt16LE(id, 0x0c + 2 * n0);
    s.writeUInt8(lv, 0x20 + n0);
    s.writeUInt8(lv, 0x2a + n0);
    n0++;
  }
  // Avatar skills grow with the avatar level (official DoubleLeap 107 from L3, Regenerate 103 from L6).
  const av = avatarSkills(avatarLevel(charId));
  av.a.forEach(([id, lv], i) => {
    s.writeUInt32LE(id, 0x160 + 4 * i);
    s.writeUInt8(lv, 0x188 + i);
  });
  av.b.forEach(([id, lv], i) => {
    s.writeUInt32LE(id, 0x194 + 4 * i);
    s.writeUInt8(lv, 0x1bc + i);
  });
  COMBOS.forEach((id, i) => {
    s.writeUInt32LE(id, 0x218 + 4 * i);
    s.writeUInt8(1, 0x240 + i);
  });
  return s;
}

export type SsSkillUp = { ok: true; skillId: number; level: number; skPoint: number } | { ok: false; reason: string };

/** C 0x74 (book, slot): +1 level up to the skill.skl max, one skill point each. */
export async function ssSkillPointUp(charId: number, book: number, slot: number): Promise<SsSkillUp> {
  const row = await ssSkillByBookSlot(charId, book, slot);
  if (!row) return { ok: false, reason: `empty slot book=${book} slot=${slot}` };
  const chars = await query<RowDataPacket[]>("SELECT sk_point FROM characters WHERE ID=?", [charId]);
  const sk = Number(chars[0]?.sk_point ?? 0);
  if (sk < 1) return { ok: false, reason: "no sk_point" };
  const cap = ssMaxLevel(row.skillid);
  if (row.points >= cap) return { ok: false, reason: `capped skill=${row.skillid} lv=${row.points}/${cap}` };
  const lv = row.points + 1;
  await execute("UPDATE skills SET points=? WHERE id=?", [lv, row.id]);
  await execute("UPDATE characters SET sk_point=sk_point-1 WHERE ID=? AND sk_point>0", [charId]);
  return { ok: true, skillId: row.skillid, level: lv, skPoint: sk - 1 };
}

/** GM //maxskills: every owned skill to its skill.skl max. */
export async function ssMaxAllSkills(charId: number): Promise<number> {
  const rows = await query<RowDataPacket[]>("SELECT id, skillid FROM skills WHERE charid=?", [charId]);
  for (const r of rows) await execute("UPDATE skills SET points=? WHERE id=?", [ssMaxLevel(Number(r.skillid)), r.id]);
  return rows.length;
}

/**
 * Skills a Soul Saver job can own: common 1..4, the 1st-job book (1xxxx of that job, without the 13xxx/14xxx taehwa
 * upgrades, which replace a skill at level 65) and, with a faction (1 Justice, 2 Chaos, 3 for jobs 6..10), the
 * 2xxxx..5xxxx skills of that faction digit.
 */
export function ssSkillsForJob(job: number, faction: number): number[] {
  const out = [1, 2, 3, 4];
  for (const [k, s] of Object.entries(table)) {
    const id = Number(k);
    if (s.job !== job || id < 10000 || s.max <= 0) continue;
    const tier = Math.floor(id / 10000);
    const sub = Math.floor(id / 1000) % 10;
    if (tier === 1 && sub !== 3 && sub !== 4) out.push(id);
    else if (tier >= 2 && tier <= 5 && faction > 0 && sub === faction) out.push(id);
  }
  return out;
}

/** GM //skills: own exactly the skills of the job (and faction), keeping levels of skills already owned. */
export async function ssSyncJobSkills(charId: number, job: number, faction: number): Promise<number> {
  const keep = new Set(ssSkillsForJob(job, faction));
  const rows = await query<RowDataPacket[]>("SELECT id, skillid FROM skills WHERE charid=?", [charId]);
  const have = new Set<number>();
  for (const r of rows) {
    const sid = Number(r.skillid);
    if (!keep.has(sid) && sid !== SS_AVATAR_WEAPON) await execute("DELETE FROM skills WHERE id=?", [r.id]);
    else have.add(sid);
  }
  for (const sid of keep) if (!have.has(sid)) await execute("INSERT INTO skills (charid, skillid, points) VALUES (?,?,1)", [charId, sid]);
  return keep.size;
}

/** MP and HP a cast costs (attr 1 / 7 % of max MP / 0). */
export function ssSkillCost(id: number, level: number, maxMp: number): { mp: number; hp: number } {
  const mp = ssAttr(id, 1, level) + Math.floor((maxMp * ssAttr(id, 7, level)) / 100);
  return { mp: Math.max(0, Math.floor(mp)), hp: Math.max(0, Math.floor(ssAttr(id, 0, level))) };
}

/** Self heal of a cast (attr 2/3 flat, 8/9 % of max). */
export function ssSkillHeal(id: number, level: number, maxHp: number, maxMp: number): { hp: number; mp: number } {
  return {
    hp: Math.floor(ssAttr(id, 2, level) + (maxHp * ssAttr(id, 8, level)) / 100),
    mp: Math.floor(ssAttr(id, 3, level) + (maxMp * ssAttr(id, 9, level)) / 100),
  };
}
