import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { config } from "../config.js";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";

export type CashItem = {
  category: number;
  itemId: number;
  bargain: number;
  term: number;
  price: number;
  flag: number;
};

/** legacy `_CashShopCatIndex` / thpspx CashShopFactory lists */
const CAT_NAMES = [
  "boy_eyes",
  "girl_eyes",
  "boy_hair",
  "girl_hair",
  "face1",
  "face2",
  "hat",
  "boy_dress",
  "girl_dress",
  "mantle",
  "luckbag",
  "produce",
  "amulet",
  "pill",
  "talisman",
  "pet",
  "peteq",
  "petcon",
  "guard",
  "treasure",
];

const byCat: CashItem[][] = Array.from({ length: 20 }, () => []);
let catalog: CashItem[] = [];
/** Items filterClientItems drops for the Ghost en-client; the Soul Saver lists still offer them. */
const ssOnlyByCat: CashItem[][] = Array.from({ length: 20 }, () => []);

function pushItem(cat: number, item: Omit<CashItem, "category">, seen: Set<number>): void {
  if (cat < 0 || cat > 19) return;
  if (seen.has(item.itemId)) return;
  if (byCat[cat]!.length >= 300) return;
  if (!Number.isFinite(item.itemId) || item.itemId <= 0) return;
  seen.add(item.itemId);
  const full: CashItem = { category: cat, ...item };
  byCat[cat]!.push(full);
  catalog.push(full);
}

/** Parse client item.itm → set of item IDs (u32 immediately before a UTF-16 name). */
function loadItemItmIds(): Set<number> {
  const itmPaths = [
    path.join(config.dataDir, "client", "table", "item.itm"),
    path.join(config.rootDir, "data", "client", "table", "item.itm"),
  ];
  const ids = new Set<number>();
  let itm: Buffer | null = null;
  for (const p of itmPaths) {
    if (fs.existsSync(p)) {
      itm = fs.readFileSync(p);
      break;
    }
  }
  if (!itm) return ids;
  for (let i = 0; i + 8 < itm.length; ) {
    if (itm[i]! >= 32 && itm[i]! < 127 && itm[i + 1] === 0 && itm[i + 2]! >= 32 && itm[i + 2]! < 127 && itm[i + 3] === 0) {
      if (i >= 4) {
        const id = itm.readUInt32LE(i - 4);
        if (id >= 1_000_000 && id <= 99_999_999) ids.add(id);
      }
      let j = i;
      while (j + 1 < itm.length && !(itm[j] === 0 && itm[j + 1] === 0)) j += 2;
      i = j + 2;
      continue;
    }
    i++;
  }
  return ids;
}

/** Pet preview id: (itemId/10)%1000 must match data/client/data/OBJ/PET/pet_NNN_*.spr */
function loadPetSpriteIds(): Set<number> {
  const ids = new Set<number>();
  const dirs = [
    path.join(config.dataDir, "client", "data", "OBJ", "PET"),
    path.join(config.rootDir, "data", "client", "data", "OBJ", "PET"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) {
      const m = /^pet_(\d+)/i.exec(name);
      if (m) ids.add(Number(m[1]));
    }
    if (ids.size) break;
  }
  return ids;
}

/** Real companion pets (921xxxx). 922xxxx / 7820501 are pet equipment. */
function isCompanionPetId(itemId: number): boolean {
  return itemId >= 9210000 && itemId < 9220000;
}

/**
 * EN-client pet equipment with icons (item.itm + pet_deco.csp = 3 muffler frames).
 * 9220021–9220091 are DB leftovers with no item.itm / deco frames → blank shop slots.
 */
const PET_EQ_SUPPORTED = new Set([7820501, 9220011, 9220012, 9220013]);

function isPetEquipmentId(itemId: number): boolean {
  return PET_EQ_SUPPORTED.has(itemId);
}

/**
 * Drop items the original en-client cannot show (no third-party client assets):
 * - fashion/eyes/hair/face/mantle: must exist in item.itm
 * - pets: must have OBJ/PET sprite (icon may be blank for spr>=31)
 * - peteq: only Name Tag + Red/Blue/Yellow muffler
 */
function filterClientItems(): void {
  const itmIds = loadItemItmIds();
  const petSpr = loadPetSpriteIds();
  const fashionCats = new Set([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]); // eyes..mantle
  let removed = 0;
  for (let c = 0; c < byCat.length; c++) {
    const before = byCat[c]!.length;
    const all = byCat[c]!;
    if (c === 15) {
      byCat[c] = byCat[c]!.filter((it) => {
        if (!isCompanionPetId(it.itemId)) return false;
        const spr = Math.floor(it.itemId / 10) % 1000;
        return petSpr.has(spr) && spr > 0;
      });
    } else if (c === 16) {
      byCat[c] = byCat[c]!.filter((it) => PET_EQ_SUPPORTED.has(it.itemId));
    } else if (fashionCats.has(c) && itmIds.size > 0) {
      byCat[c] = byCat[c]!.filter((it) => itmIds.has(it.itemId));
    }
    removed += before - byCat[c]!.length;
    const kept = new Set(byCat[c]);
    ssOnlyByCat[c] = all.filter((it) => !kept.has(it));
  }
  catalog = byCat.flat();
  if (removed > 0) {
    console.log(
      `[cashshop] removed ${removed} unsupported en-client items (item.itm / PET sprites)`,
    );
  }
}

/**
 * Foot-trail cash items (8950101–8950105). en-client treats these as run FX when
 * equipped/unsealed (game.exe compares 0x889155–0x889159 and picks trail effect ids).
 * 8950106/7 have no client refs — drop them from mall lists.
 */
const RUN_TRAIL_IDS = new Set([8950101, 8950102, 8950103, 8950104, 8950105]);
const UNSUPPORTED_PRODUCE_IDS = new Set([8950106, 8950107]);

/** HOT Hot tab (treasure cat 19): gacha boxes, event buffs, Server Scroll. */
const HOT_TREASURE_ITEMS: Omit<CashItem, "category">[] = [
  { itemId: 8890044, bargain: 300, term: -1, price: 300, flag: 0 }, // Gift Box
  { itemId: 8890101, bargain: 300, term: -1, price: 300, flag: 0 }, // Old Treasure Box
  { itemId: 8890050, bargain: 300, term: -1, price: 300, flag: 0 }, // Christmas sock
  { itemId: 8890112, bargain: 300, term: -1, price: 300, flag: 0 }, // Lucky Spring
  { itemId: 8890200, bargain: 300, term: -1, price: 300, flag: 0 }, // Golden Xmas sox
  { itemId: 8842002, bargain: 49, term: -1, price: 49, flag: 0 }, // Server Scroll
];

/**
 * Ensure base pets 001–003 (incl. missing 9210012) and event pets 201–207.
 * 205–207 have sprites on disk but were never in commodity tables.
 */
const ENSURE_PETS: Omit<CashItem, "category">[] = [
  { itemId: 9210011, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210012, bargain: 129, term: -1, price: 129, flag: 0 }, // was missing from DB
  { itemId: 9210013, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210021, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210022, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210023, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210031, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210032, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9210033, bargain: 129, term: -1, price: 129, flag: 0 },
  // 201–204 (commodity) + 205–207 (sprites only)
  { itemId: 9212011, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212012, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212013, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212014, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212021, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212022, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212023, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212031, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212041, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212043, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212044, bargain: 129, term: -1, price: 129, flag: 0 },
  { itemId: 9212051, bargain: 149, term: -1, price: 149, flag: 0 },
  { itemId: 9212061, bargain: 149, term: -1, price: 149, flag: 0 },
  { itemId: 9212071, bargain: 149, term: -1, price: 149, flag: 0 },
];

/** Move mufflers / name tag out of Pets into Pet Equipment; ensure pets 001–003 + 201–207. */
function rearrangePetEquipment(): void {
  const pets = byCat[15] ?? [];
  const keepPets: CashItem[] = [];
  const peteq: CashItem[] = [];
  const peteqSeen = new Set<number>();
  const petSeen = new Set<number>();

  for (const it of pets) {
    if (isPetEquipmentId(it.itemId) || (it.itemId >= 9220000 && it.itemId < 9230000) || it.itemId === 7820501) {
      if (PET_EQ_SUPPORTED.has(it.itemId) && !peteqSeen.has(it.itemId)) {
        peteq.push({ ...it, category: 16 });
        peteqSeen.add(it.itemId);
      }
      // drop unsupported 9220021–9220091 (invisible in EN client)
    } else if (isCompanionPetId(it.itemId)) {
      keepPets.push(it);
      petSeen.add(it.itemId);
    }
  }

  for (const d of ENSURE_PETS) {
    if (!petSeen.has(d.itemId)) {
      keepPets.push({ category: 15, ...d });
      petSeen.add(d.itemId);
    }
  }

  // Only EN-supported equipment (Name Tag + 3 muffler colors).
  const eqDefaults: Omit<CashItem, "category">[] = [
    { itemId: 7820501, bargain: 49, term: -1, price: 49, flag: 0 },
    { itemId: 9220011, bargain: 159, term: -1, price: 159, flag: 0 }, // Red
    { itemId: 9220012, bargain: 159, term: -1, price: 159, flag: 0 }, // Blue
    { itemId: 9220013, bargain: 159, term: -1, price: 159, flag: 0 }, // Yellow
  ];
  for (const d of eqDefaults) {
    if (!peteqSeen.has(d.itemId)) {
      peteq.push({ category: 16, ...d });
      peteqSeen.add(d.itemId);
    }
  }

  byCat[15] = keepPets;
  byCat[16] = peteq;
  catalog = byCat.flat();
  const sprs = new Set(keepPets.map((p) => Math.floor(p.itemId / 10) % 1000));
  console.log(
    `[cashshop] Pet remap: pets=${keepPets.length} (spr ${[...sprs].sort((a, b) => a - b).join(",")}), peteq=${peteq.length}`,
  );
}

/**
 * Split Mileage produce into:
 *   produce (11) = name-frame decorations → HOT New
 *   pill (13)    = run trails → HOT Event
 * treasure (19)  = boxes / buffs / Server Scroll → HOT Hot
 *
 * NOTE: en-client's visible "HOT" New/Event/Hot radios are fed by opcode 0x126
 * (same 3-slot shape as Charm). 0x124 is the Best/HOT list in docs; we fill both.
 */
function rearrangeHotMileageTabs(): void {
  const produce = byCat[11] ?? [];
  const trails: CashItem[] = [];
  const frames: CashItem[] = [];
  for (const it of produce) {
    if (UNSUPPORTED_PRODUCE_IDS.has(it.itemId)) continue;
    if (RUN_TRAIL_IDS.has(it.itemId)) {
      trails.push({ ...it, category: 13 });
    } else {
      frames.push(it);
    }
  }
  byCat[11] = frames;
  const existingPill = (byCat[13] ?? []).filter((it) => !RUN_TRAIL_IDS.has(it.itemId));
  byCat[13] = [...trails, ...existingPill];

  // HOT Hot = treasure; strip these from luckbag so ticket stays fireworks-only.
  const treasureIds = new Set(HOT_TREASURE_ITEMS.map((i) => i.itemId));
  byCat[10] = (byCat[10] ?? []).filter((it) => !treasureIds.has(it.itemId));
  const treasure: CashItem[] = [];
  const seen = new Set<number>();
  for (const d of HOT_TREASURE_ITEMS) {
    if (seen.has(d.itemId)) continue;
    treasure.push({ category: 19, ...d });
    seen.add(d.itemId);
  }
  byCat[19] = treasure;

  catalog = byCat.flat();
  console.log(
    `[cashshop] HOT remap: New/frames=${frames.length}, Event/trails=${trails.length}, Hot/treasure=${treasure.length}`,
  );
}

function finalizeCashCatalog(): void {
  rearrangePetEquipment();
  filterClientItems();
  rearrangeHotMileageTabs();
}

/** Load cash shop catalog from MySQL `cash_shop` only (seeded by database/schema.sql). */
export async function loadCashShopFromDb(): Promise<void> {
  catalog = [];
  for (let i = 0; i < 20; i++) byCat[i] = [];
  for (let i = 0; i < 20; i++) ssOnlyByCat[i] = [];
  const seen = new Map<number, Set<number>>();
  let fromDb = 0;

  try {
    const rows = await query<RowDataPacket[]>(
      "SELECT category, item_id AS itemId, price, bargain, term, flag FROM cash_shop ORDER BY category, id",
    );
    for (const r of rows) {
      const cat = Number(r.category);
      const set = seen.get(cat) ?? new Set<number>();
      seen.set(cat, set);
      pushItem(
        cat,
        {
          itemId: Number(r.itemId),
          bargain: Number(r.bargain),
          term: Number(r.term),
          price: Number(r.price),
          flag: Number(r.flag),
        },
        set,
      );
      fromDb++;
    }
  } catch (e) {
    console.warn("[cashshop] failed to load cash_shop from DB:", e);
  }

  finalizeCashCatalog();
  const counts = byCat.map((c, i) => (c.length ? `${CAT_NAMES[i]}=${c.length}` : "")).filter(Boolean);
  console.log(`[cashshop] loaded ${catalog.length} items from DB (${fromDb} rows; ${counts.join(", ")})`);
}

/**
 * en-client init fills empty slots with term=-1 (see game.exe cash list ctors).
 * legacy used 0 for fashion empties (Game4); en-client needs -1.
 */
function emptyTermFor(_cat: number): number {
  return -1;
}

/**
 * Game4 / York use 300 slots/category (L1 = 58812 bytes).
 * en-client loops `cmp reg, 0xC8` (200) — sending 300 blanks the mall UI.
 */
export function cashSlotsForMagic(magic: number): number {
  return (magic & 0xffff) === 0x0037 ? 200 : 300;
}

function writeListOpcode(cats: number[], opcode: number, slotsPer: number): Buffer {
  const body = cats.length * slotsPer * 28;
  const total = 12 + body;
  const buf = Buffer.alloc(total, 0);
  // unk must be 0 — matches cash list templates in en-client / legacy.
  writeHeader(buf, opcode, total, 0x0105, 0);
  let off = 12;
  for (const cat of cats) {
    const items = cat >= 0 && cat <= 19 ? byCat[cat]! : [];
    const emptyTerm = emptyTermFor(cat);
    for (let i = 0; i < slotsPer; i++) {
      const it = items[i];
      buf.writeUInt32LE(it ? it.itemId : 0, off);
      buf.writeUInt32LE(1, off + 4);
      buf.writeInt32LE(it ? it.bargain : 0, off + 8);
      buf.writeInt32LE(it ? it.term : emptyTerm, off + 12);
      buf.writeInt32LE(it ? it.price : 0, off + 16);
      buf.writeInt32LE(it ? it.flag : 0, off + 20);
      buf.writeInt32LE(0, off + 24);
      off += 28;
    }
  }
  return buf;
}

/**
 * en-client tab → opcode (from game.exe list ctors + UI jump table):
 *   0x11F Look (7)  0x120 Equip (5)  0x121 Ability (3)  0x122 Pet (3)
 *   0x123 ticket (1)  0x124 Best/HOT (3)  0x125 Mileage (2)
 *   0x126 Charm / visible HOT New·Event·Hot (3)  0x127 pad (1)
 *
 * HOT: New=frames(11), Event=trails(13), Hot=treasure boxes+Server Scroll(19)
 * Pet: Pets(15), Equipment(16), —
 * Mileage emptied. Ticket = fireworks luckbags only.
 */
export function buildCashLists(slotsPer = 200): Buffer[] {
  const hotCats = [11, 13, 19];
  return [
    writeListOpcode([0, 1, 2, 3, 4, 5, 6], 0x11f, slotsPer), // Look
    writeListOpcode([7, 8, 9, -1, 11], 0x120, slotsPer), // Equip
    writeListOpcode([12, -1, 14], 0x121, slotsPer), // Ability
    writeListOpcode([15, 16, -1], 0x122, slotsPer), // Pet: pets / equipment / —
    writeListOpcode([10], 0x123, slotsPer), // ticket: fireworks
    writeListOpcode(hotCats, 0x124, slotsPer), // Best/HOT
    writeListOpcode([-1, -1], 0x125, slotsPer), // Mileage empty
    writeListOpcode(hotCats, 0x126, slotsPer), // visible HOT
    writeListOpcode([-1], 0x127, slotsPer),
  ];
}

/** @deprecated alias — use buildCashLists */
export function buildCashListsCompact(): Buffer[] {
  return buildCashLists();
}

export async function buildBalance(accountId: number): Promise<Buffer[]> {
  const rows = await query<RowDataPacket[]>(
    "SELECT game_points, gift_points, bonus_points FROM users WHERE accountid = ?",
    [accountId],
  );
  const gp = Number(rows[0]?.game_points ?? 0);
  const gift = Number(rows[0]?.gift_points ?? 0);
  const bonus = Number(rows[0]?.bonus_points ?? 0);
  const f3 = Buffer.alloc(20, 0);
  writeHeader(f3, 0x00f3, 20);
  f3.writeInt32LE(gp, 12);
  f3.writeInt32LE(gift, 16);
  const f2 = Buffer.alloc(16, 0);
  writeHeader(f2, 0x00f2, 16);
  f2.writeInt32LE(bonus, 12);
  return [f3, f2];
}

export async function buildWarehouse(charId: number): Promise<Buffer> {
  const rows = await query<RowDataPacket[]>(
    "SELECT slot, itemid, amount, islocked, term FROM cash_inven WHERE charid = ? ORDER BY slot",
    [charId],
  );
  const b = Buffer.alloc(932, 0);
  writeHeader(b, 0x00e6, 932);
  for (const r of rows) {
    const s = Number(r.slot);
    if (s < 0 || s >= 20) continue;
    b.writeUInt32LE(Number(r.itemid), 12 + s * 4);
    b.writeUInt16LE(Number(r.amount ?? 1), 392 + s * 2);
    b.writeUInt8(Number(r.islocked ?? 1), 432 + s);
    const term = Number(r.term ?? -1);
    b.writeInt32LE(term === -1 ? 0 : term, 452 + s * 4);
  }
  return b;
}

/** Soul Saver cash storage 0xE6 slots (client ctor FUN_011646c0 loops 0x50). Ghost en-client has 20. */
export const SS_CASH_SLOTS = 80;

/**
 * Soul Saver cash storage S 0xE6 (5056 B, ctor FUN_011646c0, parser FUN_01165c40). Per slot i:
 * itemId u32 @0x0C+4i, flag bytes @0x14C+i / @0x69C+i / @0x6EC+i, 10 B @0x19C+10i, term u32 @0x4BC+4i
 * (guess: 0 for every permanent item in the private_test2 capture), amount u16 @0x5FC+2i, 20 B @0x73C+20i
 * (last byte 1); u16 1 @0xD7C. Bytes set to match the capture; their meaning is not known.
 */
export async function buildSsWarehouse(charId: number): Promise<Buffer> {
  const rows = await query<RowDataPacket[]>(
    "SELECT slot, itemid, amount, term FROM cash_inven WHERE charid = ? ORDER BY slot",
    [charId],
  );
  const b = Buffer.alloc(0x13c0, 0);
  writeHeader(b, 0x00e6, 0x13c0);
  for (const r of rows) {
    const s = Number(r.slot);
    if (s < 0 || s >= SS_CASH_SLOTS) continue;
    b.writeUInt32LE(Number(r.itemid), 0x0c + s * 4);
    b[0x14c + s] = 1;
    const term = Number(r.term ?? -1);
    b.writeInt32LE(term > 0 ? term : 0, 0x4bc + s * 4);
    b.writeUInt16LE(Number(r.amount ?? 1), 0x5fc + s * 2);
    b[0x69c + s] = 1;
    b[0x6ec + s] = 1;
    b[0x73c + s * 20 + 19] = 1;
  }
  b.writeUInt16LE(1, 0xd7c);
  return b;
}

/**
 * Soul Saver catalog lists S 0x11C.. (Game.exe field dispatcher memcpy sizes; layout from the private
 * server capture, SOULSAVER_RE_NOTES §23). 32 B entries from @12, entry = sub*300 + idx: itemId u32,
 * qty u32, price u32, duration i32 (-1 permanent), price2 u32, u32 0, flag bytes @24/@25. Empty
 * entries keep qty 1 and duration -1 like the capture. Each sub lists the emulator categories shown
 * there (same item kinds as the captured mall). 0x122 is ignored by the client; 0x124..0x128 (stride
 * 48) and 0x129..0x12B were empty or duplicates there, so they are not sent.
 */
const SS_LISTS: { op: number; size: number; subs: number[][] }[] = [
  { op: 0x11c, size: 38412, subs: [[0], [1], [2], [3]] }, // eyes M/F, hair M/F
  { op: 0x11d, size: 38412, subs: [[4], [5], [6], []] }, // face, beard/tattoo, hat, (ears)
  { op: 0x11e, size: 57612, subs: [[7], [8], [9], [], [], []] }, // dress M/F, back, (tools, gems, weapons)
  { op: 0x11f, size: 64012, subs: [[12, 14, 10, 19], [], [11, 13]] }, // consumables, (potions), shop/trails
  { op: 0x120, size: 38412, subs: [[15], [16], [17], []] }, // pets, pet equipment, pet consumables
  { op: 0x121, size: 38412, subs: [[18], []] }, // guard (sculptures)
  { op: 0x123, size: 9612, subs: [[]] },
];

type SsTables = { items: Record<string, unknown>; pets: Record<string, unknown> };
let ssTables: SsTables | null = null;

/** Item ids the Soul Saver client knows (ss_items.json / ss_pets.json); others show as blank slots. */
function ssKnows(itemId: number): boolean {
  ssTables ??= (() => {
    const load = (f: string, key: string): Record<string, unknown> => {
      try {
        return JSON.parse(fs.readFileSync(path.join(config.dataDir, f), "utf8"))[key] ?? {};
      } catch {
        return {};
      }
    };
    return { items: load("ss_items.json", "items"), pets: load("ss_pets.json", "pets") };
  })();
  return itemId in ssTables.items || itemId in ssTables.pets;
}

/** @24 / @25 flags as the captured mall sets them: wearables 01 01, pets 01 00, consumables 00 00. */
function ssEntryFlags(cat: number): [number, number] {
  if (cat <= 9) return [1, 1];
  if (cat === 15 || cat === 16) return [1, 0];
  return [0, 0];
}

export function buildSsCashLists(): Buffer[] {
  return SS_LISTS.map(({ op, size, subs }) => {
    const buf = Buffer.alloc(size, 0);
    writeHeader(buf, op, size, 0x0105, 0);
    const entries = (size - 12) / 32;
    for (let i = 0; i < entries; i++) {
      buf.writeUInt32LE(1, 12 + i * 32 + 4);
      buf.writeInt32LE(-1, 12 + i * 32 + 12);
    }
    subs.forEach((cats, sub) => {
      const items = cats.flatMap((c) => [...byCat[c]!, ...ssOnlyByCat[c]!]).filter((it) => ssKnows(it.itemId));
      items.slice(0, 300).forEach((it, idx) => {
        const o = 12 + (sub * 300 + idx) * 32;
        if (o + 32 > size) return;
        buf.writeUInt32LE(it.itemId, o);
        buf.writeUInt32LE(cashAmount(it.itemId), o + 4);
        buf.writeUInt32LE(it.bargain, o + 8);
        buf.writeInt32LE(it.term, o + 12);
        buf.writeUInt32LE(it.bargain, o + 16);
        [buf[o + 24], buf[o + 25]] = ssEntryFlags(it.category);
      });
    });
    return buf;
  });
}

/** Stack size delivered per purchase. */
function cashAmount(itemId: number): number {
  if (itemId === 8842002) return 10;
  if (itemId >= 8841001 && itemId <= 8841005) return 20;
  if (itemId === 8890031 || itemId === 8890037) return 100;
  return 1;
}

export async function cashBuy(accountId: number, charId: number, itemId: number, soulSaver = false): Promise<boolean> {
  const item =
    catalog.find((c) => c.itemId === itemId) ??
    (soulSaver ? ssOnlyByCat.flat().find((c) => c.itemId === itemId) : undefined);
  const maxSlots = soulSaver ? SS_CASH_SLOTS : 20;
  if (!item) return false;
  const rows = await query<RowDataPacket[]>("SELECT game_points FROM users WHERE accountid = ?", [accountId]);
  const gp = Number(rows[0]?.game_points ?? 0);
  if (gp < item.bargain) return false;
  const used = await query<RowDataPacket[]>("SELECT slot FROM cash_inven WHERE charid = ?", [charId]);
  const usedSlots = new Set(used.map((r) => Number(r.slot)));
  let slot = -1;
  for (let i = 0; i < maxSlots; i++) if (!usedSlots.has(i)) { slot = i; break; }
  if (slot < 0) return false;
  const amount = cashAmount(itemId);
  // All mall purchases arrive sealed (IsLocked=1) — tradeable until 0x140 unseal.
  const locked = 1;
  await execute("UPDATE users SET game_points = game_points - ? WHERE accountid = ?", [item.bargain, accountId]);
  await execute(
    "INSERT INTO cash_inven (charid, slot, itemid, amount, islocked, term) VALUES (?,?,?,?,?,?)",
    [charId, slot, itemId, amount, locked, item.term],
  );
  return true;
}

export function findCashItem(itemId: number): CashItem | undefined {
  return catalog.find((c) => c.itemId === itemId);
}

export async function deliverCashGifts(charId: number, charName: string): Promise<number> {
  const gifts = await query<RowDataPacket[]>(
    "SELECT id, itemid, amount, islocked, term FROM gifts WHERE name=? AND receive=0",
    [charName],
  );
  if (!gifts.length) return 0;
  const used = await query<RowDataPacket[]>("SELECT slot FROM cash_inven WHERE charid=?", [charId]);
  const usedSlots = new Set(used.map((r) => Number(r.slot)));
  let count = 0;
  for (const g of gifts) {
    let slot = -1;
    for (let i = 0; i < 20; i++) {
      if (!usedSlots.has(i)) {
        slot = i;
        break;
      }
    }
    if (slot < 0) break;
    const amount = Math.max(1, Number(g.amount ?? 1));
    await execute(
      "INSERT INTO cash_inven (charid, slot, itemid, amount, islocked, term) VALUES (?,?,?,?,?,?)",
      [charId, slot, Number(g.itemid), amount, Number(g.islocked ?? 1), Number(g.term ?? -1)],
    );
    await execute("UPDATE gifts SET receive=1 WHERE id=?", [g.id]);
    usedSlots.add(slot);
    count++;
  }
  if (count > 0) console.log(`[cashshop] delivered ${count} gift(s) to char=${charId}`);
  return count;
}
