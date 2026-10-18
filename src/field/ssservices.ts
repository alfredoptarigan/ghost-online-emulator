/**
 * Soul Saver services seen in the official capture day2_stage2 (notes section 21): GM Blessing, spirit compound and
 * the Fortune Card of the Day. Messages go out as S 0x7D0 (tb_String id @12; param type @16, param @20).
 *
 * GM Blessing: C 0x38C (20 B) u32 @12 = -1 asks the list -> S 0x38D (176 B: u32 1 @12, item ids @76+4i, event end
 *   YYMMDDhhmm @156+4i; also sent at login). u32 @12 = 99 + item id @16 uses one: the stat buff packet of the item
 *   (ssuse.ts, 3600 s). Same buff already running: S 0x7D0 1074093.
 *
 * Spirit compound (client FUN_0134d2c0 builds C 0x271, 24 B): u8 seal bag @12, u8 seal slot @13, u8 equipment bag
 *   @15, u8 equipment slot @16, u32 mode @20 (0 normal; 1 with the cash charm, 2 Composition Scroll from
 *   FUN_0134ddb0, 3 anniversary wreath: not emulated -> 1083013). The seal (SealBox..SealAmulet, section 8) must be
 *   full: soul% >= its capacity f[1] (else 11083014). Official: every try spends the seal and the gold and adds 1 to
 *   the equipment slot byte; a success also adds 1 to level byte 6 (= DB p_4); then S 0x7D0 1083005 / 1083004,
 *   S 0x6B, S 0x66 and S 0x67. Capture: SealMirror 3000 gold 2/2 ok, SealRosary 5000 gold 0/2.
 *   Not in the client and only partly in the capture (guesses): the cost of the other seal tiers, the success rate
 *   (COMPOUND_RATE) and the compound limit (COMPOUND_MAX, 1083009).
 *
 * Fortune Card of the Day (C 0x802, 12 B, 10,000 gold, once a day): S 0x80C (24 B, client FUN_012f7c40) u32 result
 *   @12 (0 ok, -1 1016085 bag full / not allowed, -2 1033003 already today), card 1 @16 (100..111), card 2 @20
 *   (200..213), drawn by nCardRate from zGsp/Chart/tb_FortuneBase.tbl. Card 1 = 100: card 2's item x count
 *   ("%s %d obtained."); otherwise card 1 is a bonus until midnight whose size is card 2's nRewardRate / 100 %.
 *   Official also resends S 0x1D4 with u32 @0x2C = 1 (fortune used today) and S 0x6B (-10000).
 */
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";
import { runningSsBuff, ssUse, startSsBuff } from "./ssuse.js";

/** S 0x7D0 system message without a parameter. */
export function sysMsgPacket(msgId: number): Buffer {
  const b = Buffer.alloc(44, 0);
  writeHeader(b, 0x07d0, 44);
  b.writeUInt32LE(msgId, 12);
  return b;
}

// ---------------------------------------------------------------- GM Blessing

export const GM_BLESSINGS = [8871511, 8871512, 8871521, 8871522, 8871531];

/** Official end stamp YYMMDDhhmm (capture: 2610190500 = next 05:00). */
function nextFiveAm(): number {
  const d = new Date();
  if (d.getHours() >= 5) d.setDate(d.getDate() + 1);
  return (d.getFullYear() % 100) * 1e8 + (d.getMonth() + 1) * 1e6 + d.getDate() * 1e4 + 500;
}

export function blessingListPacket(): Buffer {
  const b = Buffer.alloc(176, 0);
  writeHeader(b, 0x038d, 176);
  b.writeUInt32LE(1, 12);
  const end = nextFiveAm();
  GM_BLESSINGS.forEach((id, i) => {
    b.writeUInt32LE(id, 76 + 4 * i);
    b.writeUInt32LE(end, 156 + 4 * i);
  });
  return b;
}

/** C 0x38C: the packets to send back. */
export async function handleBlessing(charId: number, pkt: Buffer): Promise<Buffer[]> {
  if (pkt.length < 20) return [];
  if (pkt.readInt32LE(12) === -1) return [blessingListPacket()];
  const itemId = pkt.readUInt32LE(16);
  if (!GM_BLESSINGS.includes(itemId)) return [];
  const run = runningSsBuff(charId, itemId);
  if (run && run.value >= (ssUse(itemId)?.value ?? 0)) return [sysMsgPacket(1074093)];
  return (await startSsBuff(charId, itemId)) ?? [];
}

// ---------------------------------------------------------------- spirit compound

const COMPOUND_RATE = 50;
const COMPOUND_MAX = 10;
/** Gold per seal tier (SealBox 1 .. SealAmulet 10); tiers 4/5 = official 3000/5000, the rest guessed. */
const COMPOUND_COST = [1000, 1500, 2000, 3000, 5000, 8000, 12000, 20000, 30000, 50000];
const SEALS = [8510011, 8510021, 8510031, 8510041, 8510051, 8510061, 8510071, 8510081, 8510091, 8510101];
/** Spirit capacity of each seal (ss_items.json f[1]); the capture shows full seals at exactly this soul%. */
const SEAL_CAPACITY = [100, 130, 169, 220, 286, 371, 483, 627, 816, 1060];

export type CompoundResult = { msg: number; cost: number; bags: number[] };

/** C 0x271. `money` is the character's gold; the caller takes `cost` and refreshes `bags`. */
export async function compoundSpirit(charId: number, pkt: Buffer, money: number): Promise<CompoundResult> {
  const fail = (msg: number): CompoundResult => ({ msg, cost: 0, bags: [] });
  if (pkt.length < 24) return fail(1083013);
  const sealBag = pkt.readUInt8(12);
  const sealSlot = pkt.readUInt8(13);
  const eqBag = pkt.readUInt8(15);
  const eqSlot = pkt.readUInt8(16);
  if (pkt.readUInt32LE(20) !== 0 || sealBag !== 2 || eqBag !== 1) return fail(1083013);
  const seal = (await query<RowDataPacket[]>("SELECT type, soulperc FROM equip WHERE charid=? AND pos1=? AND pos2=?", [charId, sealBag, sealSlot]))[0];
  const eq = (await query<RowDataPacket[]>("SELECT type, slot FROM equip WHERE charid=? AND pos1=? AND pos2=?", [charId, eqBag, eqSlot]))[0];
  if (!seal || !eq) return fail(1083003);
  const tier = SEALS.indexOf(Number(seal.type));
  if (tier < 0) return fail(1083013);
  if (Number(seal.soulperc ?? 0) < SEAL_CAPACITY[tier]!) return fail(11083014);
  if (Number(eq.slot ?? 0) >= COMPOUND_MAX) return fail(1083009);
  const cost = COMPOUND_COST[tier]!;
  if (money < cost) return fail(1080138);
  await execute("DELETE FROM equip WHERE charid=? AND pos1=? AND pos2=?", [charId, sealBag, sealSlot]);
  const ok = Math.random() * 100 < COMPOUND_RATE;
  await execute(`UPDATE equip SET slot=slot+1${ok ? ", p_4=p_4+1" : ""} WHERE charid=? AND pos1=? AND pos2=?`, [charId, eqBag, eqSlot]);
  console.log(`[compound] char=${charId} seal=${seal.type} -> ${eq.type} (slot ${eq.slot}) ${ok ? "ok" : "fail"} cost=${cost}`);
  return { msg: ok ? 1083005 : 1083004, cost, bags: [eqBag, sealBag] };
}

// ---------------------------------------------------------------- Fortune Card of the Day

export const FORTUNE_COST = 10000;

type Card = { id: number; rate: number; reward: number; item: number; count: number };
/** zGsp/Chart/tb_FortuneBase.tbl (nCardID, nCardRate, nRewardRate, nRewardID, nRewardCount). */
const CARDS: Card[] = [
  [100, 1900, 0, 0, 0], [101, 800, 0, 0, 0], [102, 800, 0, 0, 0], [103, 800, 0, 0, 0], [104, 900, 0, 0, 0],
  [105, 900, 0, 0, 0], [106, 900, 0, 0, 0], [107, 900, 0, 0, 0], [108, 700, 0, 0, 0], [109, 400, 0, 0, 0],
  [110, 500, 0, 0, 0], [111, 500, 0, 0, 0],
  [200, 1400, 10500, 8810041, 100], [201, 1240, 10670, 8820061, 100], [202, 1110, 10840, 8810051, 100],
  [203, 1010, 11010, 8820071, 100], [204, 910, 11190, 8810061, 100], [205, 820, 11370, 8820081, 100],
  [206, 740, 11550, 8864003, 1], [207, 670, 11730, 8843012, 1], [208, 600, 11920, 8830016, 1],
  [209, 540, 12110, 8843251, 1], [210, 490, 12300, 8843241, 1], [211, 440, 12500, 8843231, 1],
  [212, 20, 15000, 8849031, 1], [213, 10, 18000, 8844051, 1],
].map(([id, rate, reward, item, count]) => ({ id: id!, rate: rate!, reward: reward!, item: item!, count: count! }));

function draw(lo: number): Card {
  const pool = CARDS.filter((c) => c.id >= lo && c.id < lo + 100);
  let r = Math.random() * pool.reduce((s, c) => s + c.rate, 0);
  for (const c of pool) if ((r -= c.rate) < 0) return c;
  return pool[0]!;
}

/** Bonus kinds of card 1 (tb_FortuneBase messages): which multiplier it raises. Item categories are not split. */
const BONUS: Record<number, { exp?: true; drop?: true; gold?: true }> = {
  101: { drop: true }, 102: { gold: true }, 103: { gold: true }, 104: { drop: true }, 105: { drop: true },
  106: { drop: true }, 107: { drop: true }, 108: { exp: true }, 109: { drop: true }, 110: { gold: true, exp: true },
  111: { drop: true, exp: true },
};

type Fortune = { day: string; card1: number; card2: number };
const fortunes = new Map<number, Fortune>();
const today = () => new Date().toLocaleDateString("sv");

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute("CREATE TABLE IF NOT EXISTS ss_fortune (charid int NOT NULL PRIMARY KEY, day char(10) NOT NULL, card1 int NOT NULL, card2 int NOT NULL)");
  tableReady = true;
}

/** Today's card of a character (loaded from the DB once). */
export async function loadFortune(charId: number): Promise<Fortune | null> {
  await ensureTable();
  const r = (await query<RowDataPacket[]>("SELECT day, card1, card2 FROM ss_fortune WHERE charid=?", [charId]))[0];
  const f = r && String(r.day) === today() ? { day: String(r.day), card1: Number(r.card1), card2: Number(r.card2) } : null;
  if (f) fortunes.set(charId, f);
  else fortunes.delete(charId);
  return f;
}

/** EXP/drop/gold multipliers of today's card (1 when none). */
export function fortuneMuls(charId: number): { expMul: number; dropMul: number; goldMul: number } {
  const f = fortunes.get(charId);
  const one = { expMul: 1, dropMul: 1, goldMul: 1 };
  if (!f || f.day !== today()) return one;
  const kind = BONUS[f.card1];
  const mul = (CARDS.find((c) => c.id === f.card2)?.reward ?? 10000) / 10000;
  if (!kind) return one;
  return { expMul: kind.exp ? mul : 1, dropMul: kind.drop ? mul : 1, goldMul: kind.gold ? mul : 1 };
}

export function fortuneResultPacket(result: number, card1 = 0, card2 = 0): Buffer {
  const b = Buffer.alloc(24, 0);
  writeHeader(b, 0x080c, 24);
  b.writeInt32LE(result, 12);
  b.writeUInt32LE(card1, 16);
  b.writeUInt32LE(card2, 20);
  return b;
}

/** S 0x1D4 (60 B) as the official login copy: -1 @0x28, fortune used flag @0x2C, rates % @0x30/@0x34 (EXP, 300 in the x3 event)/@0x38. */
export function fortuneStatePacket(used: boolean, expPct: number): Buffer {
  const b = Buffer.alloc(60, 0);
  writeHeader(b, 0x01d4, 60);
  b.writeInt32LE(-1, 0x28);
  b.writeUInt32LE(used ? 1 : 0, 0x2c);
  b.writeUInt32LE(100, 0x30);
  b.writeUInt32LE(Math.round(expPct), 0x34);
  b.writeUInt32LE(100, 0x38);
  return b;
}

export type FortuneDraw = { result: number; card1: number; card2: number; item?: { id: number; count: number } };

/** C 0x802. The caller checks the gold, takes FORTUNE_COST and gives `item`. */
export async function drawFortune(charId: number): Promise<FortuneDraw> {
  if (await loadFortune(charId)) return { result: -2, card1: 0, card2: 0 };
  const c1 = draw(100);
  const c2 = draw(200);
  const f = { day: today(), card1: c1.id, card2: c2.id };
  await execute("REPLACE INTO ss_fortune (charid, day, card1, card2) VALUES (?, ?, ?, ?)", [charId, f.day, f.card1, f.card2]);
  fortunes.set(charId, f);
  console.log(`[fortune] char=${charId} cards ${c1.id} / ${c2.id}`);
  return { result: 0, card1: c1.id, card2: c2.id, item: c1.id === 100 ? { id: c2.item, count: c2.count } : undefined };
}
