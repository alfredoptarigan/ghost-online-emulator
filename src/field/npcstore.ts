/**
 * Soul Saver NPC shops, from the client tables zGsp/Chart/tb_NpcStoreItem.tbl and tb_NpcStoreL.tbl
 * (exported to data/ss_npcstore.json with re-tools/tbl.js).
 * Buy (official pktmon capture 2026-10-17): C 0x3C5 = store list id u32 @12 (tb_NpcStoreL nID), store item id u32 @16
 * (tb_NpcStoreItem nID), count u32 @20. The official server answers with the bag update and MONEY 0x6B only.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";

/** [storeId, itemId, price, moneyType, tradeItemId, sale] */
type StoreItem = [number, number, number, number, number, number];
/** [storeId, npcId, stage] */
type StoreList = [number, number, number];

let data: { items: Record<string, StoreItem>; lists: Record<string, StoreList> } | null = null;

function tables() {
  if (!data) {
    try {
      data = JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_npcstore.json"), "utf8"));
    } catch {
      data = { items: {}, lists: {} };
    }
  }
  return data!;
}

/**
 * Validate a Soul Saver buy request. Only gold purchases (moneyType 0) are supported; trade-item and fame shops
 * return null until they are mapped.
 */
export function storeBuy(listId: number, storeItemId: number, count: number): { itemId: number; total: number } | null {
  const t = tables();
  const list = t.lists[listId];
  const item = t.items[storeItemId];
  if (!list || !item || item[0] !== list[0] || !item[5]) return null;
  if (item[3] !== 0) return null;
  if (!(count >= 1 && count <= 100)) return null;
  return { itemId: item[1], total: item[2] * count };
}
