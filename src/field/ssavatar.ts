/**
 * Soul Saver spirit avatar transform (Shift). Official capture day1_stage1 (Magic User "Wildia" lv14-35, avatar
 * level 1-14), see SOULSAVER_RE_NOTES.md section 20.
 *
 * Flow: C 0x260 byte @12 = 1 start cast -> S 0x261 state 1; = 2 cast done -> CHAR_ALL 0x50 with avatar stats,
 * 0x263, 0x739, 0x3D6, 0x73F, 0x261 state 2, empty quickslot 0xA9, 0x262; = 0 cancel -> normal 0x50 + 0x263 + ...,
 * 0x261 state 0, quickslot, SKILL_ALL 0x73, 0x2DB.
 *
 * Avatar data (0x263, parser FUN_0134eba0): five stats u16 @0x0c..0x14, avatar level u16 @0x16, avatar EXP u32
 * @0x18, EXP to the next level u32 @0x1c, power u32 @0x20 (seconds of avatar time left: 1800 = 30 min, drains 1/s
 * only while transformed, the client counts it down itself), byte @0x24 = show text 0xf9071.
 * The five stats: [0] HP, [1] MP, [2] physical attack, [3] unknown, [4] defense. Official avatar-mode values follow
 * L1 3/3/0/0/0, +2/+1/+1/+1/+1 per level and +3/+3/+1/+1/+2 more every 5th level (L6, L11); outside avatar mode the
 * client shows (and the server adds) half of them: L1 1/1/0/0/0 is the "+1" of the normal HP/MP formula.
 * Avatar EXP comes from spirits picked up while transformed: S 0x26A (20 B) EXP u32 @12, min(level, 5) * 1000 @16;
 * +14..22 per spirit, more at higher character levels.
 */
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";
import { ssMaxLevel } from "./ssskills.js";

export const AVATAR_MAX_POWER = 1800;

/** Official EXP to the next avatar level, L1..L14. Higher levels are extrapolated (not captured). */
const EXP_NEXT = [6, 10, 14, 21, 32, 56, 64, 93, 161, 278, 481, 572, 681, 810];
const MAX_AVATAR_LEVEL = 99;

export function avatarExpNext(level: number): number {
  if (level <= EXP_NEXT.length) return EXP_NEXT[Math.max(1, level) - 1]!;
  return Math.round(810 * 1.18 ** (level - EXP_NEXT.length));
}

/** Avatar-mode stats [HP, MP, phys, ?, def] at an avatar level (fits all 14 captured levels exactly). */
export function avatarStats(level: number): number[] {
  const l = Math.max(1, level) - 1;
  const f = Math.floor(l / 5);
  return [3 + 2 * l + 3 * f, 3 + l + 3 * f, l + f, l + f, l + 2 * f];
}

/** Avatar skills by avatar level: passives (0x262 group 1) and actives (group 2) as [skill, level]. */
export function avatarSkills(level: number): { a: Array<[number, number]>; b: Array<[number, number]> } {
  const a: Array<[number, number]> = [[101, 1], [102, 1], [104, 1]];
  const b: Array<[number, number]> = [[105, 1]];
  // Official: DoubleLeap 107 lv1 at avatar L3, +1 every 2 levels (L13 = 6); Regenerate 103 lv1 at L6, +1 every 3.
  if (level >= 3) a.push([107, Math.min(ssMaxLevel(107), Math.floor((level - 1) / 2))]);
  if (level >= 6) b.push([103, Math.min(ssMaxLevel(103), Math.floor(level / 3) - 1)]);
  return { a, b };
}

type Avatar = {
  level: number;
  exp: number;
  power: number;
  /** Day number of the last power refill. */
  day: number;
  /** 0 normal, 1 casting, 2 transformed. */
  state: number;
  /** ms when the power was last drained (state 2). */
  since: number;
  /** Registered avatar jars (S 0x265, max 12) and the equipped index (-1 none). */
  jars: number[];
  jarEq: number;
  /** Character level last seen (jar level = level / 10). */
  charLevel: number;
};

const avatars = new Map<number, Avatar>();

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute(
    "CREATE TABLE IF NOT EXISTS ss_avatar (charid int NOT NULL PRIMARY KEY, level int NOT NULL DEFAULT 1, " +
      "exp int NOT NULL DEFAULT 0, power int NOT NULL DEFAULT 1800, day int NOT NULL DEFAULT 0)",
  );
  // Columns added after the first version of the table.
  for (const col of ["jars varchar(255) NOT NULL DEFAULT ''", "jar_eq int NOT NULL DEFAULT -1"]) {
    try {
      await execute(`ALTER TABLE ss_avatar ADD COLUMN ${col}`);
    } catch {
      /* already there */
    }
  }
  tableReady = true;
}

const today = () => Math.floor((Date.now() - new Date().getTimezoneOffset() * 60000) / 86400000);

/**
 * Load (or create) the avatar row. Power never recovered during the official capture (1800 -> 0 over ~50 min of
 * avatar time in one day); here it refills once per day (not captured).
 */
export async function loadAvatar(charId: number): Promise<Avatar> {
  const cached = avatars.get(charId);
  if (cached) return cached;
  await ensureTable();
  const rows = await query<RowDataPacket[]>("SELECT level, exp, power, day, jars, jar_eq FROM ss_avatar WHERE charid=?", [charId]);
  const r = rows[0];
  const av: Avatar = {
    level: Math.max(1, Number(r?.level ?? 1)),
    exp: Number(r?.exp ?? 0),
    power: Number(r?.power ?? AVATAR_MAX_POWER),
    day: Number(r?.day ?? 0),
    state: 0,
    since: 0,
    jars: String(r?.jars ?? "")
      .split(",")
      .map(Number)
      .filter((x) => x > 0),
    jarEq: Number(r?.jar_eq ?? -1),
    charLevel: 1,
  };
  if (av.day !== today()) {
    av.power = AVATAR_MAX_POWER;
    av.day = today();
  }
  avatars.set(charId, av);
  if (!r) await saveAvatar(charId);
  return av;
}

export async function saveAvatar(charId: number): Promise<void> {
  const av = avatars.get(charId);
  if (!av) return;
  await ensureTable();
  await execute(
    "INSERT INTO ss_avatar (charid, level, exp, power, day, jars, jar_eq) VALUES (?, ?, ?, ?, ?, ?, ?) " +
      "ON DUPLICATE KEY UPDATE level=VALUES(level), exp=VALUES(exp), power=VALUES(power), day=VALUES(day), " +
      "jars=VALUES(jars), jar_eq=VALUES(jar_eq)",
    [charId, av.level, av.exp, av.power, av.day, av.jars.join(","), av.jarEq],
  );
}

/** Take the elapsed avatar time off the power (1 per second while transformed). */
function drain(av: Avatar): void {
  if (av.state !== 2) return;
  const secs = Math.floor((Date.now() - av.since) / 1000);
  if (secs <= 0) return;
  av.power = Math.max(0, av.power - secs);
  av.since += secs * 1000;
}

export function avatarActive(charId: number): boolean {
  return avatars.get(charId)?.state === 2;
}

/** Avatar stats for the stat formulas (ssstats.ts): full values when transformed, else half. */
export function avatarMods(charId: number): { a: number[]; active: boolean } {
  const av = avatars.get(charId);
  return { a: avatarStats(av?.level ?? 1), active: av?.state === 2 };
}

export function avatarLevel(charId: number): number {
  return avatars.get(charId)?.level ?? 1;
}

/** Power left (seconds), after draining. */
export function avatarPower(charId: number): number {
  const av = avatars.get(charId);
  if (!av) return 0;
  drain(av);
  return av.power;
}

/** Change state (0/1/2); drains and saves when leaving the transform. Returns the previous state. */
export async function setAvatarState(charId: number, state: number): Promise<number> {
  const av = await loadAvatar(charId);
  const prev = av.state;
  drain(av);
  av.state = state;
  if (state === 2 && prev !== 2) av.since = Date.now();
  if (prev === 2 && state !== 2) await saveAvatar(charId);
  return prev;
}

/** Logout / disconnect: keep the power used so far; the transform itself does not survive a relog. */
export async function avatarLeave(charId: number): Promise<void> {
  const av = avatars.get(charId);
  if (!av) return;
  drain(av);
  av.state = 0;
  await saveAvatar(charId);
  avatars.delete(charId);
}

/**
 * A spirit picked up while transformed: avatar EXP (official +14 at character lv15, ~+20 at lv30, +22 at lv35;
 * one level at a time, leftover EXP kept). Returns the 0x26A packets and whether the avatar levelled.
 */
export async function gainAvatarExp(charId: number, charLevel: number): Promise<{ packets: Buffer[]; leveled: boolean }> {
  const av = await loadAvatar(charId);
  if (av.state !== 2) return { packets: [], leveled: false };
  const k = Math.min(av.level, 5) * 1000;
  av.exp += Math.round(8 + 0.4 * charLevel);
  const packets = [avatarExpPacket(av.exp, k)];
  let leveled = false;
  if (av.level < MAX_AVATAR_LEVEL && av.exp >= avatarExpNext(av.level)) {
    av.exp -= avatarExpNext(av.level);
    av.level++;
    leveled = true;
    packets.push(avatarExpPacket(av.exp, k));
  }
  await saveAvatar(charId);
  return { packets, leveled };
}

/** S 0x261 (24 B, parser FUN_012d3810): charId u16 @12, state u16 @14 (1 cast, 2 transformed, 0 normal), -1 @16. */
export function avatarStatePacket(charId: number, state: number): Buffer {
  const b = Buffer.alloc(24, 0);
  writeHeader(b, 0x0261, 24);
  b.writeUInt16LE(charId & 0xffff, 12);
  b.writeUInt16LE(state, 14);
  b.writeInt32LE(-1, 16);
  return b;
}

/** S 0x263 (40 B): avatar stats/level/EXP/power (see the header comment). */
export function avatarInfoPacket(charId: number): Buffer {
  const av = avatars.get(charId);
  const level = av?.level ?? 1;
  const active = av?.state === 2;
  if (av) drain(av);
  const b = Buffer.alloc(40, 0);
  writeHeader(b, 0x0263, 40);
  avatarStats(level).forEach((v, i) => b.writeUInt16LE(active ? v : Math.floor(v / 2), 0x0c + 2 * i));
  b.writeUInt16LE(level, 0x16);
  b.writeUInt32LE(av?.exp ?? 0, 0x18);
  b.writeUInt32LE(avatarExpNext(level), 0x1c);
  b.writeUInt32LE(av?.power ?? AVATAR_MAX_POWER, 0x20);
  return b;
}

/** S 0x26A (20 B): avatar EXP u32 @12, u32 @16 (official min(level, 5) * 1000). */
function avatarExpPacket(exp: number, k: number): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x026a, 20);
  b.writeUInt32LE(exp >>> 0, 12);
  b.writeUInt32LE(k, 16);
  return b;
}

/** S 0x262 (116 B, FUN_0134e870): avatar skills, group 1 u32 @0x0c x10 + level @0x34, group 2 @0x40 + @0x68. */
export function avatarSkillsPacket(charId: number): Buffer {
  const { a, b: act } = avatarSkills(avatarLevel(charId));
  const b = Buffer.alloc(116, 0);
  writeHeader(b, 0x0262, 116);
  a.forEach(([id, lv], i) => {
    b.writeUInt32LE(id, 0x0c + 4 * i);
    b.writeUInt8(lv, 0x34 + i);
  });
  act.forEach(([id, lv], i) => {
    b.writeUInt32LE(id, 0x40 + 4 * i);
    b.writeUInt8(lv, 0x68 + i);
  });
  return b;
}

/**
 * The packets the official server sends after every CHAR_ALL + 0x263: 0x739 (32 B) and 0x3D6 (152 B) always zero,
 * 0x73F (100 B): 90 @0x10, 75 @0x14, 1 @0x5c, 14400 @0x60 (always the same for this character).
 */
export function avatarTailPackets(): Buffer[] {
  const p739 = Buffer.alloc(32, 0);
  writeHeader(p739, 0x0739, 32);
  const p3d6 = Buffer.alloc(152, 0);
  writeHeader(p3d6, 0x03d6, 152);
  const p73f = Buffer.alloc(100, 0);
  writeHeader(p73f, 0x073f, 100);
  p73f.writeUInt32LE(90, 0x10);
  p73f.writeUInt32LE(75, 0x14);
  p73f.writeUInt32LE(1, 0x5c);
  p73f.writeUInt32LE(14400, 0x60);
  return [p739, p3d6, p73f];
}

/** Official avatar-mode quickslot: all 24 entries empty (-1) and the trailing byte @204 = 1 (208 B, SS layout). */
export function avatarQuickSlotPacket(): Buffer {
  const b = Buffer.alloc(208, 0xff);
  writeHeader(b, 0x00a9, 208);
  b.writeUInt32LE(1, 204);
  return b;
}

/** S 0x2DB (20 B, zeros), sent by the official server after a cancel. */
export function avatarCancelTailPacket(): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x02db, 20);
  return b;
}

/**
 * Avatar jars ("Avatar Spirit" window). Item.itm use type 25 ("Right-click to register"): WhiteSpiritJar 8843801
 * (Justice) / BlackSpiritJar 8843901 (Chaos) are given at character level 10 (official: both, with the lv10 quest),
 * IceFish/Tree/WindNymph 88438x2..4 and FireMoth/Headstone/SnakeSpirit 88439x2..4 are bought.
 * Each jar family has a passive + 7 attack skills (skill.skl 2010.., 2020.., 2040.., 3010.., 3020.., 3030..). Official:
 * equipping a jar (C 0x267 byte @12 = list index) puts its first attack skill (WhiteBall 2011 / DarkBall 3011) into
 * skill book 0 at the jar level and answers SKILL_ALL, 0x2DB, the stat packets and S 0x268.
 * Jar level: S 0x265 @0x0D = max jar level = character level / 10 ("+1 for every 10 Character Levels").
 */
const JAR_SKILL_BASE: Record<number, number> = {
  8843801: 2010, 8843802: 2020, 8843812: 2020, 8843804: 2040, 8843814: 2040,
  8843901: 3010, 8843902: 3020, 8843912: 3020, 8843903: 3030, 8843913: 3030,
};
export const SS_START_JARS = [8843801, 8843901];

export function isAvatarJar(itemId: number): boolean {
  return Math.floor(itemId / 100) === 88438 || Math.floor(itemId / 100) === 88439;
}

const jarLevel = (charLevel: number) => Math.max(1, Math.floor(charLevel / 10));

/** Official lv10: both basic jars appear in the list. Returns true when the list changed. */
export async function grantStartJars(charId: number, charLevel: number): Promise<boolean> {
  const av = await loadAvatar(charId);
  av.charLevel = charLevel;
  if (charLevel < 10 || av.jars.length) return false;
  av.jars = [...SS_START_JARS];
  await saveAvatar(charId);
  return true;
}

/** Register a jar item (use type 25). Returns false when it is already registered or the list is full. */
export async function registerJar(charId: number, itemId: number): Promise<boolean> {
  const av = await loadAvatar(charId);
  if (av.jars.includes(itemId) || av.jars.length >= 12) return false;
  av.jars.push(itemId);
  await saveAvatar(charId);
  return true;
}

/** Equip the jar at a list index; returns its item id, or 0 for a bad index. */
export async function equipJar(charId: number, idx: number): Promise<number> {
  const av = await loadAvatar(charId);
  const item = av.jars[idx] ?? 0;
  if (!item) return 0;
  av.jarEq = idx;
  await saveAvatar(charId);
  return item;
}

/** Attack skill of the equipped jar for skill book 0, as [skill, level]; null when none. */
export function jarSkill(charId: number): [number, number] | null {
  const av = avatars.get(charId);
  const charLevel = av?.charLevel ?? 1;
  const item = av ? (av.jars[av.jarEq] ?? 0) : 0;
  const base = JAR_SKILL_BASE[item];
  if (!base) return null;
  return [base + 1, Math.min(ssMaxLevel(base + 1), jarLevel(charLevel))];
}

/**
 * S 0x265 (128 B, FUN_01302500): equipped index i8 @0x0C (-1 none), max jar level i8 @0x0D, 12 entries: level i8
 * @0x0E+i, jar item u32 @0x1C+4i, duration u32 @0x4C+4i (official lv1 5000, lv2 6000, the window "Duration"),
 * byte @0x7C (1 = jar levelled).
 */
export function avatarJarsPacket(charId: number, charLevel: number): Buffer {
  const av = avatars.get(charId);
  if (av) av.charLevel = charLevel;
  const b = Buffer.alloc(128, 0);
  writeHeader(b, 0x0265, 128);
  const lv = jarLevel(charLevel);
  b.writeInt8(av && av.jars[av.jarEq] ? av.jarEq : -1, 0x0c);
  b.writeInt8(lv, 0x0d);
  (av?.jars ?? []).slice(0, 12).forEach((item, i) => {
    b.writeInt8(lv, 0x0e + i);
    b.writeUInt32LE(item, 0x1c + 4 * i);
    b.writeUInt32LE(4000 + 1000 * lv, 0x4c + 4 * i);
  });
  return b;
}

/** S 0x268 (24 B, FUN_01303820): charId u32 @12, jar item u32 @16, list index i8 @0x14, 1 @0x15 (equipped). */
export function avatarJarEquipPacket(charId: number, item: number, idx: number): Buffer {
  const b = Buffer.alloc(24, 0);
  writeHeader(b, 0x0268, 24);
  b.writeUInt32LE(charId >>> 0, 12);
  b.writeUInt32LE(item >>> 0, 16);
  b.writeInt8(idx, 0x14);
  b.writeUInt8(1, 0x15);
  return b;
}
