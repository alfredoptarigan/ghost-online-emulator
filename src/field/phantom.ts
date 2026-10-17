/**
 * Soul Saver sealed timed items (gift box rows with limitSeconds, e.g. SmallBluePhantom 432000 s).
 * Official other-bag packet 0x69 sends them with iscash 1, time = seconds, special 1 (sealed). Cancelling the seal
 * is C 0x137 (u32 bag @12, u32 slot @16; the official tutorial capture answers with the bag packet). From then on
 * the duration runs (other.expire_at) and Phantom items apply their bonus ("Applies immediately upon cancelling the
 * seal"): Blue item drop, Green EXP, Red gold, Purple all three, +50% each (item.itm descriptions).
 */
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";

const PHANTOMS: Record<number, { exp?: number; drop?: number; gold?: number }> = {
  8990050: { drop: 1.5 }, // BluePhantom
  8990071: { drop: 1.5 }, // SmallBluePhantom
  8990051: { exp: 1.5 }, // GreenPhantom
  8990072: { exp: 1.5 }, // SmallGreenPhantom
  8990052: { gold: 1.5 }, // RedPhantom
  8990073: { gold: 1.5 }, // SmallRedPhantom
  8990053: { exp: 1.5, drop: 1.5, gold: 1.5 }, // PurplePhantom
  8990074: { exp: 1.5, drop: 1.5, gold: 1.5 }, // SmallPurplePhantom
  8990115: { exp: 1.5 }, // YellowPhantom(EXP)
  8990116: { drop: 1.5, gold: 1.5 }, // YellowPhantom(Gold)
};

export type PhantomMuls = { expMul: number; dropMul: number; goldMul: number };
const NONE: PhantomMuls = { expMul: 1, dropMul: 1, goldMul: 1 };
const active = new Map<number, { muls: PhantomMuls; until: number }>();

let columnReady = false;
async function ensureColumn(): Promise<void> {
  if (columnReady) return;
  await execute("ALTER TABLE other ADD COLUMN IF NOT EXISTS expire_at bigint NOT NULL DEFAULT 0");
  columnReady = true;
}

const nowSec = () => Math.floor(Date.now() / 1000);

/** Seconds left of an unsealed timed item (for the bag packet), or the stored value when it is not running. */
export function remainingSeconds(row: RowDataPacket): number {
  const exp = Number(row.expire_at ?? 0);
  return exp > 0 ? Math.max(0, exp - nowSec()) : Number(row.timeuse ?? 0);
}

/** Drop expired unsealed items and cache the Phantom bonuses still running. */
export async function loadPhantoms(charId: number): Promise<void> {
  await ensureColumn();
  const now = nowSec();
  await execute("DELETE FROM other WHERE charid=? AND expire_at>0 AND expire_at<=?", [charId, now]);
  const rows = await query<RowDataPacket[]>("SELECT type, expire_at FROM other WHERE charid=? AND expire_at>?", [charId, now]);
  const muls = { ...NONE };
  let until = Infinity;
  for (const r of rows) {
    const ph = PHANTOMS[Number(r.type)];
    if (!ph) continue;
    muls.expMul = Math.max(muls.expMul, ph.exp ?? 1);
    muls.dropMul = Math.max(muls.dropMul, ph.drop ?? 1);
    muls.goldMul = Math.max(muls.goldMul, ph.gold ?? 1);
    until = Math.min(until, Number(r.expire_at) * 1000);
  }
  if (until === Infinity) active.delete(charId);
  else active.set(charId, { muls, until });
}

/** Current Phantom multipliers (1 when none is running). An expired cache entry is refreshed in the background. */
export function phantomMuls(charId: number): PhantomMuls {
  const a = active.get(charId);
  if (!a) return NONE;
  if (Date.now() >= a.until) {
    active.delete(charId);
    void loadPhantoms(charId).catch(() => {});
    return NONE;
  }
  return a.muls;
}

export type UnsealResult = { ok: true; bag: number; itemId: number } | { ok: false; reason: string };

/** C 0x137: cancel the seal of the item at bag/slot. */
export async function unsealItem(charId: number, bag: number, slot: number): Promise<UnsealResult> {
  await ensureColumn();
  const t = bag === 1 || bag === 2 ? ["equip", "type"] : bag === 3 ? ["spend", "itemid"] : bag === 4 ? ["other", "type"] : null;
  if (!t) return { ok: false, reason: `bag ${bag}` };
  const [table, col] = t;
  const rows = await query<RowDataPacket[]>(`SELECT * FROM ${table} WHERE charid=? AND pos1=? AND pos2=? LIMIT 1`, [charId, bag, slot]);
  const r = rows[0];
  if (!r) return { ok: false, reason: `empty ${bag}/${slot}` };
  if (Number(r.isspecial ?? 0) === 0) return { ok: false, reason: `not sealed ${bag}/${slot}` };
  const itemId = Number(r[col]);
  const secs = Number(r.timeuse ?? 0);
  const idCol = table === "equip" ? "equipid" : table === "spend" ? "spendid" : "otherid";
  if (table === "other" && secs > 0) {
    await execute(`UPDATE other SET isspecial=0, expire_at=? WHERE ${idCol}=?`, [nowSec() + secs, r[idCol]]);
  } else {
    await execute(`UPDATE ${table} SET isspecial=0 WHERE ${idCol}=?`, [r[idCol]]);
  }
  if (table === "other") await loadPhantoms(charId);
  return { ok: true, bag, itemId };
}
