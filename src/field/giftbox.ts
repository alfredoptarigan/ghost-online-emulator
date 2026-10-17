/**
 * Soul Saver gift boxes and select boxes, from the client tables zGsp/Chart/tb_giftpocket.tbl and tb_SelectBox.tbl
 * (exported to data/ss_giftboxes.json with re-tools/tbl.js). Flows from the official pktmon capture (2026-10-17):
 *   - Novice Gift: C 0x1D9 (u32 2) at the Aeri Elder "Challenge! Receive Gift" → item 8846411.
 *   - Opening a box: C 0x6F (use spend item) → per gift S 0x2C6 (itemId u32 @12, "… has been given") + bag updates.
 *   - Select box (e.g. ClothingPackageBox 8856203): the client shows the choices itself, then
 *     C 0x2EF (spend slot u32 @12, choice index u32 @16, chosen item u32 @20) → S 0x2ED (slot u32 @12, 1 u32 @16).
 * Novice Gift is a chain: 8846411 → 8846412 → … → 8846418, each box holding the next one plus rewards.
 */
import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { config } from "../config.js";
import { writeHeader } from "../net/packet.js";

/** [gift, count, tab, rate, accumulate, limitSeconds] */
type PocketRow = [number, number, number, number, number, number];
/** [slotNo, item, count, tab, limitSeconds] */
type SelectRow = [number, number, number, number, number];

export const NOVICE_GIFT = 8846411;

let data: { pockets: Record<string, PocketRow[]>; selectBoxes: Record<string, SelectRow[]> } | null = null;

function tables() {
  if (!data) {
    try {
      data = JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_giftboxes.json"), "utf8"));
    } catch {
      data = { pockets: {}, selectBoxes: {} };
    }
  }
  return data!;
}

let itemLevels: Record<string, { useLv?: number }> | null = null;

/** Level needed to open a box (data/ss_items.json useLv; Novice Gift chain 1, 10, 20, 30, 40, 60, 80, 110). */
export function giftBoxLevel(itemId: number): number {
  if (!itemLevels) {
    try {
      itemLevels = JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_items.json"), "utf8")).items ?? {};
    } catch {
      itemLevels = {};
    }
  }
  return itemLevels![itemId]?.useLv ?? 0;
}

export function isGiftBox(itemId: number): boolean {
  return !!tables().pockets[itemId];
}

export type Gift = { itemId: number; count: number; tab: number };

/**
 * Contents of one box. Rows with rate 10000 or a negative rate are always given (the Novice Gift chain lists the
 * next box at 10000 and the rewards at -1, -2, …). The other rows are a random table: one of them is picked,
 * weighted by rate (or by the step of the accumulated rate when rate is 0).
 */
export function openGiftBox(itemId: number): Gift[] {
  const rows = tables().pockets[itemId] ?? [];
  const fixed = rows.filter((r) => r[3] === 10000 || r[3] < 0);
  const random = rows.filter((r) => !(r[3] === 10000 || r[3] < 0));
  const out: Gift[] = fixed.map((r) => ({ itemId: r[0], count: r[1], tab: r[2] }));
  if (random.length) {
    let prev = 0;
    const weights = random.map((r) => {
      const w = r[3] > 0 ? r[3] : Math.max(0, r[4] - prev);
      prev = r[4];
      return w;
    });
    const total = weights.reduce((a, b) => a + b, 0);
    let roll = Math.random() * (total || random.length);
    for (let i = 0; i < random.length; i++) {
      roll -= total ? weights[i]! : 1;
      if (roll < 0) {
        out.push({ itemId: random[i]![0], count: random[i]![1], tab: random[i]![2] });
        break;
      }
    }
  }
  return out;
}

/** The choice of a select box, or null when the item is not one of its options. */
export function selectBoxChoice(boxId: number, itemId: number): Gift | null {
  const row = (tables().selectBoxes[boxId] ?? []).find((r) => r[1] === itemId);
  return row ? { itemId: row[1], count: row[2], tab: row[3] } : null;
}

/** S 0x2C6 — "<item> has been given" for each item a box produced. */
export function giftGivenPacket(itemId: number): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x02c6, 16);
  b.writeUInt32LE(itemId >>> 0, 12);
  return b;
}

/** S 0x2ED — select box result: spend slot, 1 = ok. */
export function selectBoxAckPacket(slot: number, ok: boolean): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x02ed, 20);
  b.writeUInt32LE(slot >>> 0, 12);
  b.writeUInt32LE(ok ? 1 : 0, 16);
  return b;
}

let tableReady = false;

/** True the first time a character claims the Novice Gift (0x1D9); later claims are ignored. */
export async function claimNoviceGift(charId: number): Promise<boolean> {
  if (!tableReady) {
    await execute(
      "CREATE TABLE IF NOT EXISTS novice_gift (charid int NOT NULL PRIMARY KEY, claimed_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP)",
    );
    tableReady = true;
  }
  const rows = await query<RowDataPacket[]>("SELECT 1 FROM novice_gift WHERE charid=?", [charId]);
  if (rows.length) return false;
  await execute("INSERT INTO novice_gift (charid) VALUES (?)", [charId]);
  return true;
}
