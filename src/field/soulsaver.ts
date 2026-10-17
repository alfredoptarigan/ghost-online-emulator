/**
 * Soul Saver field packets that differ from Game4/en-client.
 * Layouts recovered from the unpacked Soul Saver Game.exe (build 2026092201):
 * dispatcher FUN_01623330 copies 0x50 as 216 bytes, 0x1E as 416 bytes, 0x51 as 24 bytes.
 * The rest of the server builds Game4 layouts; `toSoulSaver` converts them on send.
 */
import { config } from "../config.js";
import { getTrade } from "./trade.js";

/** Base body item (client builds its own preview ENTERPLAYER with this at +0x84). */
export const SS_DEFAULT_BODY = 9000006;

/**
 * Basic-attack numbers of the worn weapon per character (item f[8] speed, f[7] range; set by refreshSsWeapon).
 * The client keeps them at skill manager +0x508/+0x518 (CHAR_ALL +0x9c/+0x9d, STAT_UP +0x40/+0x41). On Space
 * the player's +0x1868 = range: auto-target reach is range*50 px and the fan projectile (effect 1463) lives
 * range*50-50, so range 0 left the Magic User attack without target or projectile and no hit 0x45 was sent.
 * Official: TrainingFan 3/4, TrainingSword 3/1.
 */
export const ssWeaponAttack = new Map<number, { speed: number; range: number }>();

/** CHAR_ALL 0x50 — parser FUN_01343790. */
function ssCharAll(g: Buffer, charId: number): Buffer {
  const s = Buffer.alloc(216, 0);
  g.copy(s, 0, 0, 12);
  g.copy(s, 0x0c, 12, 12 + 19); // name[20]
  g.copy(s, 0x34, 52, 57); // sex, level, job, job2, guild
  s.writeUInt8(g.readUInt8(56), 0x3a); // faction (name colour 0/1/2)
  s.writeUInt32LE(g.readUInt16LE(58), 0x44); // max HP
  s.writeUInt32LE(g.readUInt16LE(60), 0x48); // HP
  s.writeUInt32LE(g.readUInt16LE(62), 0x4c); // max MP
  s.writeUInt32LE(g.readUInt16LE(64), 0x50); // MP
  s.writeUInt32LE(g.readUInt32LE(68), 0x54); // max EXP (u64)
  s.writeUInt32LE(g.readUInt32LE(76), 0x5c); // EXP (u64)
  s.writeUInt32LE(g.readUInt16LE(84), 0x64); // reputation
  s.writeUInt16LE(1200, 0x68); // max Fury (soul): always 1200 for Soul Saver characters (SS_MAX_FURY)
  s.writeUInt16LE(Math.min(1200, g.readUInt16LE(88)), 0x6a); // Fury
  g.copy(s, 0x6c, 90, 92);
  for (let i = 0; i < 4; i++) s.writeUInt16LE(g.readUInt16LE(92 + i * 2), 0x6e + i * 2); // STR DEX CON INT
  // phys max/min, magic max/min @0x78 (with weapon) and again @0x88 (official: without weapon; same values here),
  // defense @0x98 (pktmon capture: 17 at 0x98; 0x88 is phys max again, so defense written there showed 0).
  for (let i = 0; i < 4; i++) {
    s.writeUInt32LE(g.readUInt16LE(100 + i * 2), 0x78 + i * 4);
    s.writeUInt32LE(g.readUInt16LE(100 + i * 2), 0x88 + i * 4);
  }
  s.writeUInt32LE(g.readUInt16LE(108), 0x98); // defense
  const wa = ssWeaponAttack.get(charId) ?? { speed: 1, range: 1 };
  s.writeUInt8(wa.speed, 0x9c);
  s.writeUInt8(wa.range, 0x9d);
  s.writeUInt8(5, 0x9e); // official: always 5
  s.writeUInt16LE(g.readUInt16LE(114), 0xa0); // stat points
  s.writeUInt16LE(g.readUInt16LE(116), 0xa2); // skill points
  for (let i = 0; i < 6; i++) s.writeUInt16LE(g.readUInt16LE(118 + i * 2), 0xa4 + i * 2); // bonus str..damw
  s.writeUInt16LE(g.readUInt16LE(130), 0xb2); // bonus def
  return s;
}

/** ENTERPLAYER 0x1E — parser FUN_013e7ba0. */
function ssEnterPlayer(g: Buffer): Buffer {
  const s = Buffer.alloc(416, 0);
  g.copy(s, 0, 0, 12);
  g.copy(s, 0x0c, 12, 16); // charId
  g.copy(s, 0x10, 16, 16 + 19); // name[20]
  g.copy(s, 0x38, 56, 64); // map, region, x, y (u16)
  s.writeUInt8(g.readUInt8(64), 0x40); // sex
  s.writeUInt8(g.readUInt8(65), 0x41); // level
  s.writeUInt8(g.readUInt8(66), 0x42); // job
  s.writeUInt8(g.readUInt8(67), 0x43); // job2
  s.writeUInt8(g.readUInt8(68), 0x44); // guild
  s.writeUInt8(g.readUInt8(68), 0x46); // faction (name colour)
  // Avatar u32s keep the Game4 order (hair, faceUp, faceLow, hat, eye, armor, clothes, weapon, cape,
  // pet, toy), shifted from +76 to +0x50.
  g.copy(s, 0x50, 76, 120);
  s.writeUInt32LE(SS_DEFAULT_BODY, 0x84); // base body; 0 leaves the character invisible
  g.copy(s, 0x88, 120, 139); // pet name[20]
  s.writeUInt8(g.readUInt32LE(140) & 0xff, 0x9c); // pet level
  g.copy(s, 0xa0, 144, 164); // pet hp, mp, exp, decoration, use slot
  // "show" flags: the client zeroes the matching avatar slot when these are 0.
  // Official ENTERPLAYER: all 8 flags 0xd9..0xe0 are 1. 0xdd..0xdf were 0 here, which hid avatar slots (the
  // weapon among them: a Magic User basic attack then carried weapon type 0 and never hit).
  for (const o of [0xd9, 0xda, 0xdb, 0xdc, 0xdd, 0xde, 0xdf, 0xe0, 0x168, 0x169]) s.writeUInt8(1, o);
  g.copy(s, 0xe6, 206, 216); // peer ip bytes + udp port
  return s;
}

/** HP/MP 0x51 — "MyHP -> %d / MySP -> %d": u32 HP/MP, then soul/max soul u16. */
function ssHpMp(g: Buffer): Buffer {
  const s = Buffer.alloc(24, 0);
  g.copy(s, 0, 0, 12);
  s.writeUInt32LE(g.readUInt16LE(12), 12);
  s.writeUInt32LE(g.readUInt16LE(14), 16);
  s.writeUInt16LE(g.readUInt16LE(16), 20);
  s.writeUInt16LE(g.readUInt16LE(18), 22);
  return s;
}

/**
 * MON_ALL 0x42 — parser FUN_0128e690. 50-slot arrays as in Game4, except def (@1316) is u32, so
 * template/speed/attack id move +100 (1516/1716/1916). HP goes to 0x7e0 (→ obj+0x318, the field MON_INFO updates)
 * and max HP to 0x8a8 (→ obj+0x308). Byte arrays at 2416/2466 (display flags) stay 0.
 */
function ssMonAll(g: Buffer): Buffer {
  const s = Buffer.alloc(2568, 0);
  g.copy(s, 0, 0, 1316);
  for (let i = 0; i < 50; i++) s.writeUInt32LE(g.readUInt16LE(1316 + 2 * i), 1316 + 4 * i);
  g.copy(s, 1516, 1416, 1816); // template, speed
  // u16 @1916 (→ obj+0x300) is the id the client echoes in ATTACK 0x45 +0x10. Game4 sends 0x46cb for every
  // monster; give each its slot + 1 so the target can be found.
  for (let i = 0; i < 50; i++) s.writeUInt16LE(i + 1, 1916 + 2 * i);
  g.copy(s, 0x7e0, 2116, 2316); // HP
  g.copy(s, 0x8a8, 1916, 2116); // max HP
  return s;
}

/** Worn slots 16..24 (Soul Saver only, e.g. belt @22) per character, filled by buildEquip right before 0x65 is sent. */
export type SsWornExtra = { slot: number; itemId: number; slotByte: number; levels: number[]; soul: number };
export const ssWornExtra = new Map<number, SsWornExtra[]>();

/**
 * Worn equipment 0x65 — parser FUN_01346800: 25 slots (Game4 16). Per slot: itemId u32 @0x0c+4i,
 * slot byte @0x70+i, 10 level bytes @0x89+10i, soul% u16 @0x184+2i. Worn pet (slot 10): name @0x5d0,
 * level @0x5e4, hp/mp/exp @0x5e8/0x5ec/0x5f0, use slot @0x5f4.
 */
function ssEquip(g: Buffer, charId: number): Buffer {
  const s = Buffer.alloc(2344, 0);
  g.copy(s, 0, 0, 12);
  for (let i = 0; i < 16; i++) {
    s.writeUInt32LE(g.readUInt32LE(12 + 4 * i), 0x0c + 4 * i);
    s.writeUInt8(g.readUInt8(80 + i), 0x70 + i);
    g.copy(s, 0x89 + 10 * i, 97 + 10 * i, 107 + 10 * i);
    s.writeUInt16LE(g.readUInt16LE(268 + 2 * i), 0x184 + 2 * i);
  }
  for (const e of ssWornExtra.get(charId) ?? []) {
    if (e.slot < 16 || e.slot > 24) continue;
    s.writeUInt32LE(e.itemId >>> 0, 0x0c + 4 * e.slot);
    s.writeUInt8(e.slotByte & 0xff, 0x70 + e.slot);
    e.levels.forEach((v, k) => s.writeUInt8(v & 0xff, 0x89 + 10 * e.slot + k));
    s.writeUInt16LE(e.soul & 0xffff, 0x184 + 2 * e.slot);
  }
  g.copy(s, 0x5d0, 406, 425); // pet name
  s.writeUInt8(g.readUInt8(426), 0x5e4);
  g.copy(s, 0x5e8, 428, 444); // pet hp, mp, exp, use slot
  g.copy(s, 0x848, 444, 452);
  s.writeInt32LE(-1, 0x850);
  return s;
}

/**
 * INVENTORY_ALL 0x64  parser FUN_01359b10 (23088 bytes), sent by the official server at login before the bags.
 * The start (+0x0c .. +0x600: worn item ids, slot bytes, levels, soul%, options, worn pet) has the 0x65 layout;
 * per-slot defaults moved elsewhere: u32 100 x 25 @0x4ab8, byte flags (FF = empty) @0x654 and @0x52a4..0x58ac.
 * The bag sections stay empty here: the 0x66..0x6A bag packets that follow fill them.
 * Without this packet the client knows the worn items for display only, and the basic attack of a Magic User
 * (UDP 0x2B) never produced a hit (0x45). Built from the converted 0x65.
 */
export function ssInventoryAll(ss65: Buffer): Buffer {
  const s = Buffer.alloc(23088, 0);
  ss65.copy(s, 0, 0, 0x600);
  s.writeUInt16LE(0x0064, 2);
  s.writeUInt16LE(23088, 4);
  s.writeUInt16LE((0x0064 + 23088 + s.readUInt16LE(0)) & 0xffff, 6);
  s.fill(0xff, 0x654, 0x664);
  for (let i = 0; i < 25; i++) s.writeUInt32LE(100, 0x4ab8 + 4 * i);
  s.fill(0xff, 0x52a4, 0x58ac);
  return s;
}

/** Soul Saver bags hold 72 slots; Game4 sends 24. */
const SS_BAG_SLOTS = 72;
const G4_BAG_SLOTS = 24;

/**
 * Equip bags 0x66 / 0x67 — parsers FUN_0135ab10 / FUN_0135af20 (6636 / 6348 bytes). Per slot: itemId
 * u32 @0x0c+4i, slot byte @0x12c+i, 10 level bytes @0x174+10i, soul% u16 @0x444+2i, iscash @0x4d4+i.
 * The time/special arrays sit at different offsets in the two bags and stay 0.
 */
function ssEquipBag(len: number) {
  return (g: Buffer): Buffer => {
    const s = Buffer.alloc(len, 0);
    g.copy(s, 0, 0, 12);
    for (let i = 0; i < G4_BAG_SLOTS; i++) {
      s.writeUInt32LE(g.readUInt32LE(12 + 4 * i), 0x0c + 4 * i);
      s.writeUInt8(g.readUInt8(108 + i), 0x12c + i);
      g.copy(s, 0x174 + 10 * i, 132 + 10 * i, 142 + 10 * i);
      s.writeUInt16LE(g.readUInt16LE(372 + 2 * i), 0x444 + 2 * i);
      s.writeUInt8(g.readUInt8(420 + i), 0x4d4 + i);
    }
    return s;
  };
}

/** Spend bag 0x68 — FUN_0135b540 (1528 bytes): id, amount u16, per u32, iscash, time i32, special u16. */
function ssSpend(g: Buffer): Buffer {
  const s = Buffer.alloc(1528, 0);
  g.copy(s, 0, 0, 12);
  for (let i = 0; i < G4_BAG_SLOTS; i++) {
    s.writeUInt32LE(g.readUInt32LE(12 + 4 * i), 0x0c + 4 * i);
    s.writeUInt16LE(g.readUInt16LE(108 + 2 * i), 0x12c + 2 * i);
    s.writeUInt32LE(g.readUInt32LE(156 + 4 * i), 0x1bc + 4 * i);
    s.writeUInt8(g.readUInt8(252 + i), 0x2dc + i);
    s.writeInt32LE(g.readInt32LE(276 + 4 * i), 0x324 + 4 * i);
    s.writeUInt16LE(g.readUInt16LE(374 + 2 * i), 0x446 + 2 * i);
  }
  return s;
}

/** Other bag 0x69 — FUN_0135ddc0 (1236 bytes): id, amount u16, iscash, time i32, special u16. */
function ssOther(g: Buffer): Buffer {
  const s = Buffer.alloc(1236, 0);
  g.copy(s, 0, 0, 12);
  for (let i = 0; i < G4_BAG_SLOTS; i++) {
    s.writeUInt32LE(g.readUInt32LE(12 + 4 * i), 0x0c + 4 * i);
    s.writeUInt16LE(g.readUInt16LE(108 + 2 * i), 0x12c + 2 * i);
    s.writeUInt8(g.readUInt8(156 + i), 0x1bc + i);
    s.writeInt32LE(g.readInt32LE(180 + 4 * i), 0x204 + 4 * i);
    s.writeUInt16LE(g.readUInt16LE(278 + 2 * i), 0x324 + 2 * i);
  }
  return s;
}

/**
 * Pet bag 0x6A — FUN_0135e250 (5052 bytes): id, name[20] @0x12c, level @0x6cc, hp/exp/mp u32
 * @0x714/0x834/0x954, -1 array @0xa74, locked u16 @0xb94 (same order as Game4 108/588/612/708/804/900/996).
 */
function ssPetBag(g: Buffer): Buffer {
  const s = Buffer.alloc(5052, 0);
  g.copy(s, 0, 0, 12);
  for (let i = 0; i < SS_BAG_SLOTS; i++) s.writeInt32LE(-1, 0xa74 + 4 * i);
  for (let i = 0; i < G4_BAG_SLOTS; i++) {
    s.writeUInt32LE(g.readUInt32LE(12 + 4 * i), 0x0c + 4 * i);
    g.copy(s, 0x12c + 20 * i, 108 + 20 * i, 127 + 20 * i);
    s.writeUInt8(g.readUInt8(588 + i), 0x6cc + i);
    s.writeUInt32LE(g.readUInt32LE(612 + 4 * i), 0x714 + 4 * i);
    s.writeUInt32LE(g.readUInt32LE(708 + 4 * i), 0x834 + 4 * i);
    s.writeUInt32LE(g.readUInt32LE(804 + 4 * i), 0x954 + 4 * i);
    s.writeInt32LE(g.readInt32LE(900 + 4 * i), 0xa74 + 4 * i);
    s.writeUInt16LE(g.readUInt16LE(996 + 2 * i), 0xb94 + 2 * i);
  }
  return s;
}

/**
 * SETAVATAR 0x5C — FUN_013effd0 (192 bytes): the ENTERPLAYER avatar block moved to +0x10 (body @0x44,
 * pet name @0x48, pet level @0x5c, pet hp/mp/exp/deco/use @0x60, show flags as in ENTERPLAYER).
 */
function ssSetAvatar(g: Buffer): Buffer {
  const s = Buffer.alloc(192, 0);
  g.copy(s, 0, 0, 60); // header, charId, 11 avatar u32s
  s.writeUInt32LE(SS_DEFAULT_BODY, 0x44);
  g.copy(s, 0x48, 60, 79); // pet name
  s.writeUInt8(g.readUInt32LE(80) & 0xff, 0x5c);
  g.copy(s, 0x60, 84, 104); // pet hp, mp, exp, decoration, use slot
  for (const o of [0x99, 0x9a, 0x9b, 0x9c, 0x9d, 0x9e, 0x9f, 0xa0, 0xb2, 0xb3, 0xb4]) s.writeUInt8(1, o); // official: 0x99..0xa0 and 0xb2..0xb4 = 1
  return s;
}

/**
 * SKILL_ALL 0x73 — FUN_0135eb80 (708 bytes). Book types keep their order: type0 i16 ids @0x0c / lv @0x20,
 * type1 @0x34 / @0x5c (20 slots), type2 @0x84 / @0x98, type3 u32 ids @0xac / @0xfc, type4 u32 @0x124 /
 * @0x14c. Later sections (@0x160..0x2c4) are Soul Saver-only and stay empty.
 */
/** 1st job of each logged-in Soul Saver character, for packets whose layout depends on the class. */
export const ssCharJob = new Map<number, number>();

/**
 * Soul Saver-only SKILL_ALL sections (official capture, new Magic User): avatar skills 101/102/104 as u32 @0x160
 * (levels @0x180) and 105 @0x194 (levels @0x1bc); the 6 basic-attack combo skills @0x218 (levels @0x240) 
 * Magic User 3012..3017 (attack effects 1620 + 1622..1627). Without them the basic attack (UDP 0x2B) found no
 * target and never sent a hit 0x45. Combo skills of the other classes are not captured yet.
 */
const SS_COMBO_SKILLS: Record<number, number[]> = { 3: [3012, 3013, 3014, 3015, 3016, 3017] };

function ssSkillAll(g: Buffer, charId: number): Buffer {
  const s = Buffer.alloc(708, 0);
  [101, 102, 104].forEach((id, i) => {
    s.writeUInt32LE(id, 0x160 + 4 * i);
    s.writeUInt8(1, 0x180 + i);
  });
  s.writeUInt32LE(105, 0x194);
  s.writeUInt8(1, 0x1bc);
  (SS_COMBO_SKILLS[ssCharJob.get(charId) ?? -1] ?? []).forEach((id, i) => {
    s.writeUInt32LE(id, 0x218 + 4 * i);
    s.writeUInt8(1, 0x240 + i);
  });
  g.copy(s, 0, 0, 12);
  const short = (gi: number, gl: number, si: number, sl: number, n: number) => {
    for (let i = 0; i < n; i++) {
      s.writeInt16LE(g.readInt16LE(gi + 2 * i), si + 2 * i);
      s.writeUInt8(g.readUInt8(gl + i), sl + i);
    }
  };
  short(12, 32, 0x0c, 0x20, 10);
  short(42, 62, 0x34, 0x5c, 10);
  short(72, 92, 0x84, 0x98, 10);
  for (let i = 0; i < 20; i++) {
    s.writeInt32LE(g.readInt16LE(102 + 2 * i), 0xac + 4 * i);
    s.writeUInt8(g.readUInt8(142 + i), 0xfc + i);
  }
  for (let i = 0; i < 10; i++) {
    s.writeUInt32LE(g.readUInt32LE(162 + 4 * i), 0x124 + 4 * i);
    s.writeUInt8(g.readUInt8(202 + i), 0x14c + i);
  }
  return s;
}

/** QUICKSLOT 0xA9 — same 24×8-byte entries as Game4 plus one trailing byte (208 bytes). */
function ssQuickSlot(g: Buffer): Buffer {
  const s = Buffer.alloc(208, 0);
  g.copy(s, 0, 0, 204);
  return s;
}

/** PET_LIFE 0x107 — FUN_013f17e0 (20 bytes): charId @12, life @16 (Game4: item, hp, mp, charId, life). */
function ssPetLife(g: Buffer): Buffer {
  const s = Buffer.alloc(20, 0);
  g.copy(s, 0, 0, 12);
  s.writeUInt32LE(g.readUInt32LE(24), 12);
  s.writeUInt32LE(g.readUInt32LE(28), 16);
  return s;
}

/**
 * MONEY 0x6B — 28 bytes (case 0x16299f3): new money i64 @12; the client derives "X gold obtained/lost" from the
 * difference itself. i64 @20 is the tuition paid to a mentor ("(Paid %I64d for tuition)", shown when > 0), not
 * the Game4 delta, so it stays 0.
 */
function ssMoney(g: Buffer): Buffer {
  const s = Buffer.alloc(28, 0);
  g.copy(s, 0, 0, 12);
  s.writeBigInt64LE(BigInt(g.readInt32LE(12)), 12);
  return s;
}

/**
 * STAT_UP_ACK 0x60 — FUN_01345fd0 (92 bytes), same field order as the CHAR_ALL stat block: max HP/MP
 * u32 @0x0c/0x10, STR..INT u16 @0x14, damage u32 @0x1c..0x28, def u32 @0x2c, weapon speed/range @0x40/0x41
 * (see ssWeaponAttack), stat/skill points @0x44/0x46, bonus str..damw @0x48..0x52, bonus def @0x56.
 */
function ssStatUp(g: Buffer, charId: number): Buffer {
  const s = Buffer.alloc(92, 0);
  g.copy(s, 0, 0, 12);
  s.writeUInt32LE(g.readUInt16LE(12), 0x0c);
  s.writeUInt32LE(g.readUInt16LE(14), 0x10);
  g.copy(s, 0x14, 16, 24); // STR DEX CON INT
  // dmg x4 @0x1c and again @0x2c (official: without weapon), defense @0x3c (pktmon capture).
  for (let i = 0; i < 4; i++) {
    s.writeUInt32LE(g.readUInt16LE(24 + 2 * i), 0x1c + 4 * i);
    s.writeUInt32LE(g.readUInt16LE(24 + 2 * i), 0x2c + 4 * i);
  }
  s.writeUInt32LE(g.readUInt16LE(32), 0x3c);
  const wa = ssWeaponAttack.get(charId) ?? { speed: 1, range: 1 };
  s.writeUInt8(wa.speed, 0x40);
  s.writeUInt8(wa.range, 0x41);
  s.writeUInt16LE(g.readUInt16LE(38), 0x44);
  s.writeUInt16LE(g.readUInt16LE(40), 0x46);
  g.copy(s, 0x48, 42, 54); // bonus str..damw
  s.writeUInt16LE(g.readUInt16LE(54), 0x56);
  return s;
}

/**
 * MON_INFO 0x38 — FUN_01290270 (96 bytes). Same as Game4 up to +0x33, then damage is u32 @0x34 (Game4
 * u16 dmg + u16 hit flag), hit flag byte @0x38, HP u32 @0x3c and @0x40 (→ obj+0x318), damage-number
 * position u16 @0x58/0x5a. +0x50/+0x54 feed a separate effect when +0x54 > 0 and stay 0.
 * Status 9 → SetState(4) (die), 0x0D → SetState(0xA).
 */
function ssMonInfo(g: Buffer): Buffer {
  const s = Buffer.alloc(96, 0);
  g.copy(s, 0, 0, 0x34);
  s.writeUInt32LE(g.readUInt16LE(52), 0x34);
  s.writeUInt32LE(g.readUInt32LE(60), 0x3c);
  s.writeUInt32LE(g.readUInt32LE(60), 0x40);
  s.writeUInt8(g.readUInt16LE(54) & 0xff, 0x38);
  // Official speed on hit (status 7) is always 5.0 and on death (9) 7.0, whatever the monster's walk speed.
  const st = g.readUInt32LE(12);
  if (st === 7) s.writeFloatLE(5, 28);
  else if (st === 9) s.writeFloatLE(7, 28);
  // Damage numbers are drawn at this world position; use the monster position (Game4 +32/+34).
  s.writeUInt16LE(g.readUInt16LE(32), 0x58);
  s.writeUInt16LE(g.readUInt16LE(34), 0x5a);
  return s;
}

/** LV_EXP 0x5B — FUN_016205b0 (40 bytes): level @12, EXP u64 @16, bonus EXP @0x24. */
function ssLvExp(g: Buffer): Buffer {
  const s = Buffer.alloc(40, 0);
  g.copy(s, 0, 0, 16);
  s.writeBigUInt64LE(BigInt(g.readUInt32LE(16)), 16);
  return s;
}

/**
 * DROP_SPAWN 0x4E — 28 bytes: oid, itemId, x/y, owner charId u32 @24 (→ drop obj+0x2dc). A different
 * owner makes pickup fail with "You do not have permission to obtain this item". Emulator drops are
 * free for all, so each recipient is told it owns the drop.
 */
function ssDropSpawn(g: Buffer, charId: number): Buffer {
  const itemId = g.readUInt32LE(16);
  if (itemId >= 9900001 && itemId <= 9909998) return ssSpiritDrop(g, charId);
  const s = Buffer.alloc(28, 0);
  g.copy(s, 0, 0, 24);
  s.writeUInt32LE(charId >>> 0, 24);
  return s;
}

/**
 * Spirits as the official server sends them: DROP 0x4A (144 bytes, parser FUN_01272900), here with one slot.
 * Seven slots: drop id u32 @0x0c+4i, item u32 @0x28+4i, x/y u16 @0x44+2i/@0x52+2i, owner charId @0x60,
 * qty u32 @0x64+4i. 0x4A has the spirit branch (items 9900001..9909998: no gravity, own scale and lifetime);
 * a spirit sent as 0x4E was created and removed again within one frame, so none ever showed.
 */
function ssSpiritDrop(g: Buffer, charId: number): Buffer {
  const s = Buffer.alloc(144, 0);
  g.copy(s, 0, 0, 12);
  s.writeUInt16LE(0x4a, 2);
  s.writeUInt32LE(g.readUInt32LE(12), 0x0c); // drop id (C 0x4C pickup)
  s.writeUInt32LE(g.readUInt32LE(16), 0x28); // item
  s.writeUInt16LE(g.readUInt16LE(20), 0x44); // x
  s.writeUInt16LE(g.readUInt16LE(22), 0x52); // y
  s.writeUInt32LE(charId >>> 0, 0x60); // owner: every recipient may pick it up (as for 0x4E)
  s.writeUInt32LE(Math.max(1, g.readUInt32LE(28)), 0x64); // qty (official 1)
  return s;
}

/** DROP_CLEAR 0x4D — 40 bytes (constructor FUN_0136ae30): Game4 28 bytes, then 0xFF @0x1c. */
function ssDropClear(g: Buffer): Buffer {
  const s = Buffer.alloc(40, 0);
  g.copy(s, 0, 0, 28);
  s.writeUInt8(0xff, 0x1c);
  return s;
}

/**
 * MON_REGEN 0x3F — FUN_0128fcc0 (52 bytes). Same as Game4 up to +0x27 (template, level, side, move type,
 * x/y, HP @0x1c, slot @0x20, atk1/atk2/crash); def is u32 @0x28, attack type byte @0x2c, attack id u16
 * @0x2e (→ obj+0x300, echoed in ATTACK 0x45; slot + 1 as in MON_ALL).
 */
function ssMonRegen(g: Buffer): Buffer {
  const s = Buffer.alloc(52, 0);
  g.copy(s, 0, 0, 0x28);
  s.writeUInt32LE(g.readUInt16LE(40), 0x28);
  s.writeUInt8(g.readUInt16LE(42) & 0xff, 0x2c);
  s.writeUInt16LE((g.readUInt16LE(32) + 1) & 0xffff, 0x2e);
  return s;
}

/**
 * CHAT 0x17 — FUN_01620b80 (240 bytes, same layout both ways): charId @12, type @16, name[20] @0x14,
 * message[200] UTF-8 @0x28. Game4 packs "name: msg" (or "name >> msg" for whispers) at +20.
 */
function ssChat(g: Buffer): Buffer {
  const s = Buffer.alloc(240, 0);
  g.copy(s, 0, 0, 20);
  const line = g.toString("latin1", 20, 100).split(" ")[0]!;
  const m = line.match(/^(.*?)(?:: | >> )(.*)$/);
  s.write((m ? m[1]! : "").slice(0, 19), 0x14, "latin1");
  Buffer.from((m ? m[2]! : line).slice(0, 199), "utf8").copy(s, 0x28, 0, 199);
  return s;
}

/** Packets whose Soul Saver layout only appends fields: copy the Game4 bytes and zero-fill to `len`. */
function ssPad(len: number) {
  return (g: Buffer): Buffer => {
    const s = Buffer.alloc(len, 0);
    g.copy(s, 0, 0, Math.min(g.length, len));
    return s;
  };
}

/**
 * SHOUT 0xFB - FUN_01622400 (440 bytes): channel @12 (0xFF = all channels), name[20] @13, message @0x21
 * (the client drops the whole shout when it is longer than 199 bytes), type u16 @0xEA (2/3 = highlighted).
 * u32s @0xEC..0x118 are the speaker avatar for the shout portrait; out-of-range ids are ignored, so 0 is safe.
 */
function ssShout(g: Buffer): Buffer {
  const s = Buffer.alloc(440, 0);
  g.copy(s, 0, 0, 0x21);
  const end = g.indexOf(0, 0x21);
  g.copy(s, 0x21, 0x21, Math.min(end < 0 ? 0x121 : end, 0x21 + 199));
  s.writeUInt16LE(g.readUInt16LE(0x121), 0xea);
  return s;
}

/**
 * TRADE_PUT 0x9A - FUN_012aafa0 (2812 bytes): charId A @12, charId B @16, money A/B u32 @20/@24, then 12 items
 * for A @0x1c and 12 for B @0x58c, 116 bytes each (Game4 48). The first 20 bytes of an item (id, spirit,
 * quantity, 10 levels, fusion) keep the Game4 order; the rest (options, pet name, ...) stays 0.
 */
function ssTradePut(g: Buffer): Buffer {
  const s = Buffer.alloc(2812, 0);
  g.copy(s, 0, 0, 28);
  for (let i = 0; i < 24; i++) g.copy(s, 0x1c + 0x74 * i, 28 + 48 * i, 48 + 48 * i);
  return s;
}

/** TRADE_RESPONSE 0x93 - FUN_012cec20 (20 bytes): response @12, partner charId @16 (an invalid one cancels). */
function ssTradeResponse(g: Buffer, charId: number): Buffer {
  const s = Buffer.alloc(20, 0);
  g.copy(s, 0, 0, 16);
  s.writeInt32LE(getTrade(charId)?.partnerId ?? -1, 16);
  return s;
}

/**
 * PARTY_UPDATE 0x9D - FUN_012b10d0 (500 bytes): 6 members x 80 bytes from 12 (Game4 44): charId @0, level
 * u16 @4, name @6, max HP/HP/max MP/MP u32 @0x1c..0x28, UDP port u16 @0x2c, ip bytes @0x2e and @0x32, a second
 * string @0x36. Loot/EXP share modes u32 @0x1ec/@0x1f0 (0 or 1).
 */
function ssPartyUpdate(g: Buffer): Buffer {
  const s = Buffer.alloc(500, 0);
  g.copy(s, 0, 0, 12);
  for (let i = 0; i < 6; i++) {
    const go = 12 + 44 * i;
    const so = 12 + 80 * i;
    g.copy(s, so, go, go + 26); // charId, level, name
    for (let k = 0; k < 4; k++) s.writeUInt32LE(g.readUInt16LE(go + 26 + 2 * k), so + 0x1c + 4 * k);
    g.copy(s, so + 0x2c, go + 34, go + 44); // port, ip x2
  }
  return s;
}

/** PARTY_HP 0xA1 - FUN_012ab8d0 (32 bytes): charId @12, max HP/HP/max MP/MP u32 @0x10..0x1c (Game4 u16). */
function ssPartyHp(g: Buffer): Buffer {
  const s = Buffer.alloc(32, 0);
  g.copy(s, 0, 0, 16);
  for (let k = 0; k < 4; k++) s.writeUInt32LE(g.readUInt16LE(16 + 2 * k), 16 + 4 * k);
  return s;
}

/**
 * refreshBagPackets() without a magic (quests, player shops, trade) builds the en-client layouts (20 slots:
 * equip 692, spend 276, other 232). Rewrite them into the Game4 layout first so the converters below apply.
 */
const EN_SLOTS = 20;
const enToGame4: Record<number, { len: number; fn: (e: Buffer) => Buffer }> = {
  0x66: { len: 692, fn: (e) => enEquipBag(e, 610) },
  0x67: { len: 692, fn: (e) => enEquipBag(e, 630) },
  0x68: {
    len: 276,
    fn: (e) => {
      const g = Buffer.alloc(466, 0);
      e.copy(g, 0, 0, 12);
      for (let i = 0; i < EN_SLOTS; i++) {
        g.writeUInt32LE(e.readUInt32LE(12 + 4 * i), 12 + 4 * i);
        g.writeUInt16LE(e.readUInt16LE(0x5c + 2 * i), 108 + 2 * i);
        g.writeUInt32LE(e.readUInt32LE(0x84 + 4 * i), 156 + 4 * i);
        g.writeUInt8(e.readUInt8(0xd4 + i), 252 + i);
        g.writeInt32LE(e.readUInt16LE(0xea + 2 * i), 276 + 4 * i);
      }
      return g;
    },
  },
  0x69: {
    len: 232,
    fn: (e) => {
      const g = Buffer.alloc(462, 0);
      e.copy(g, 0, 0, 12);
      for (let i = 0; i < EN_SLOTS; i++) {
        g.writeUInt32LE(e.readUInt32LE(12 + 4 * i), 12 + 4 * i);
        g.writeUInt16LE(e.readUInt16LE(0x5c + 2 * i), 108 + 2 * i);
        g.writeUInt8(e.readUInt8(0x84 + i), 156 + i);
        g.writeInt32LE(e.readInt32LE(0x98 + 4 * i), 180 + 4 * i);
      }
      return g;
    },
  },
};

function enEquipBag(e: Buffer, len: number): Buffer {
  const g = Buffer.alloc(len, 0);
  e.copy(g, 0, 0, 12);
  for (let i = 0; i < EN_SLOTS; i++) {
    g.writeUInt32LE(e.readUInt32LE(12 + 4 * i), 12 + 4 * i);
    g.writeUInt8(e.readUInt8(0x5c + i), 108 + i);
    e.copy(g, 132 + 10 * i, 0x70 + 10 * i, 0x7a + 10 * i);
    g.writeUInt16LE(e.readUInt16LE(0x138 + 2 * i), 372 + 2 * i);
    g.writeUInt8(e.readUInt8(0x160 + i), 420 + i);
  }
  return g;
}

/** LEVEL_UP 0x5D  20 bytes (pktmon capture): charId u32 @12, new level u8 @16, FF FF FF. */
function ssLevelUp(g: Buffer): Buffer {
  const s = Buffer.alloc(20, 0);
  g.copy(s, 0, 0, 16);
  s.writeUInt8(g.readUInt8(16), 16);
  s.fill(0xff, 17, 20);
  return s;
}

const converters: Record<number, { len: number; fn: (g: Buffer, charId: number) => Buffer }> = {
  0x50: { len: 132, fn: ssCharAll },
  0x1e: { len: 274, fn: ssEnterPlayer },
  0x51: { len: 20, fn: ssHpMp },
  0x42: { len: 2316, fn: ssMonAll },
  // 0x65 must be converted: the client copies 2344 bytes, so a raw 458-byte Game4 packet leaves stale
  // packet bytes in the per-slot option arrays (@0x654.. → obj+0x10d8..), and the item tooltip
  // (FUN_012f17e0) indexes a 50-entry string table with them → null read at 0x12f1c84.
  0x65: { len: 458, fn: ssEquip },
  0x66: { len: 610, fn: ssEquipBag(6636) },
  0x67: { len: 630, fn: ssEquipBag(6348) },
  0x68: { len: 466, fn: ssSpend },
  0x69: { len: 462, fn: ssOther },
  0x6a: { len: 1308, fn: ssPetBag },
  0x5c: { len: 178, fn: ssSetAvatar },
  0x73: { len: 244, fn: ssSkillAll },
  0xa9: { len: 204, fn: ssQuickSlot },
  0x107: { len: 32, fn: ssPetLife },
  0x6b: { len: 28, fn: ssMoney },
  0x60: { len: 78, fn: ssStatUp },
  0x38: { len: 98, fn: ssMonInfo },
  0x5b: { len: 54, fn: ssLvExp },
  0x4e: { len: 32, fn: ssDropSpawn },
  0x4d: { len: 28, fn: ssDropClear },
  0x3f: { len: 70, fn: ssMonRegen },
  0x17: { len: 120, fn: ssChat },
  // NOTICE: type @12, message @13 (up to 127 bytes); same as Game4 apart from the length.
  0x12: { len: 80, fn: ssPad(140) },
  0x5d: { len: 42, fn: ssLevelUp },
  0xfb: { len: 0x124, fn: ssShout },
  0x93: { len: 16, fn: ssTradeResponse },
  0x9a: { len: 1180, fn: ssTradePut },
  // PARTY_INVITE: inviter charId @12; the name @16 is only read when the charId is negative.
  0x9b: { len: 16, fn: ssPad(36) },
  0x9d: { len: 276, fn: ssPartyUpdate },
  0xa1: { len: 28, fn: ssPartyHp },
  // HIDE 0x61 (FUN_012cf8a0): charId u16 @12, active @14, effect id u32 @16 (0 = default effect 0x3e9).
  0x61: { len: 16, fn: ssPad(20) },
};

/**
 * Game4 packets whose Soul Saver layout differs and is not mapped yet; sending them would be parsed as
 * garbage. Cash lists 0x11F (64012 B), 0x120/0x121 (38412 B), 0x123..0x127 (58800 B blocks; 0x122 is
 * ignored by the client) and warehouse 0xE6 (5056 B).
 */
const unmapped = new Set([0x11f, 0x120, 0x121, 0x122, 0x123, 0x124, 0x125, 0x126, 0x127, 0xe6]);

/**
 * Convert a Game4-layout field packet to Soul Saver layout (header length fixed by the caller).
 * Returns null for packets that must not be sent to Soul Saver.
 */
export function toSoulSaver(buf: Buffer, charId: number): Buffer | null {
  if (buf.length < 12) return buf;
  const op = buf.readUInt16LE(2);
  if (unmapped.has(op)) return null;
  const en = enToGame4[op];
  if (en && buf.length === en.len) buf = en.fn(buf);
  const c = converters[op];
  if (!c || buf.length !== c.len) return buf;
  const out = c.fn(buf, charId);
  out.writeUInt16LE(out.length, 4);
  return out;
}

/**
 * Client→server packets that Soul Saver XOR-encrypts before sending (FUN_010e00b0, called with the
 * header sequence value): body[i] ^= ((k*0x2137 ^ 0x7b21c3f4) >> (i%4)) ^ (i*0x25), k = low byte of
 * header +8.
 */
const ENCRYPTED_IN = new Set([0x45, 0x46, 0x47]);

function decryptBody(pkt: Buffer): Buffer {
  const b = Buffer.from(pkt);
  const key = ((b[8]! * 0x2137) ^ 0x7b21c3f4) >>> 0;
  for (let i = 0; i + 12 < b.length; i++) b[12 + i]! ^= ((key >>> (i % 4)) & 0xff) ^ ((i * 0x25) & 0xff);
  return b;
}

/**
 * Decrypt and convert a Soul Saver client packet to the Game4 layout the handlers expect.
 * 0x45 ATTACK (52 B, built by FUN_01189660): target count u16 @0x0c, target attack id u16 @0x10 (MON_ALL
 * @1916, slot + 1), damage u32 @0x14, attack counter @0x24, hit x/y u16 @0x2c/0x2e → Game4 slot @14,
 * damage i16 @18, hit x/y @20/22.
 */
export function fromSoulSaver(pkt: Buffer): Buffer {
  if (pkt.length < 12) return pkt;
  const op = pkt.readUInt16LE(2);
  const b = ENCRYPTED_IN.has(op) ? decryptBody(pkt) : pkt;
  if (op === 0x45 && b.length >= 0x30) {
    const g = Buffer.alloc(24, 0);
    b.copy(g, 0, 0, 12);
    g.writeUInt16LE(24, 4);
    g.writeUInt16LE((b.readUInt16LE(0x10) - 1) & 0xffff, 14);
    g.writeInt16LE(Math.min(0x7fff, b.readUInt32LE(0x14)), 18);
    g.writeUInt16LE(b.readUInt16LE(0x2c), 20);
    g.writeUInt16LE(b.readUInt16LE(0x2e), 22);
    return g;
  }
  if (op === 0x17 && b.length >= 0x28) {
    // CHAT: name/whisper target @0x14, UTF-8 message @0x28 → Game4 message @20, whisper target @0x64.
    const g = Buffer.alloc(240, 0);
    b.copy(g, 0, 0, 20);
    const msg = b.toString("utf8", 0x28, Math.min(b.length, 0x28 + 200)).split(" ")[0]!;
    Buffer.from(msg, "utf8").copy(g, 20, 0, 79);
    b.copy(g, 0x64, 0x14, 0x28);
    return g;
  }
  if (op === 0x46 && b.length >= 0x14) {
    // MON_HIT_ME (constructor FUN_010c88d0): damage u32 @0x0c (equals the UDP 0x2D monster-attack damage),
    // monster attack id u16 @0x12 (MON_ALL @1916). Game4 reads damage u16 @12.
    const g = Buffer.from(b);
    g.writeUInt16LE(Math.min(0xffff, Math.max(0, b.readInt32LE(0x0c))), 12);
    g.writeUInt16LE(0, 14);
    return g;
  }
  return b;
}
