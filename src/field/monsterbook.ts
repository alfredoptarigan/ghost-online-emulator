import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { config } from "../config.js";
import { writeHeader } from "../net/packet.js";

/**
 * Soul Saver Monster Encyclopedia (CEncyclopedia, data object 0x3c1fd08). Each monster has 9 pieces; piece k of
 * template 1000000 + T*100 + V is spend item 1100000 + T*100 + k*10 + V (e.g. 1100511..1100591 for 1000501).
 * The client sends a plain use-item (0x6F) when a piece is registered.
 *
 * 0x16D (1212 B, FUN_013123f0): 2 bytes per monster in zGsp/table/mob.mdd order (u32 count, u32 ids):
 *   +0x0D+2i pieces 1..6 in bits 0..5 (the client doubles the byte when it is < 0x40, so bit 6 is set),
 *   +0x0C+2i pieces 7..9 in bits 0..2.
 * 0x16E (20 B, FUN_01312220): template u32 @0x0C (0 = failure message), pieces 1..9 as u16 bits @0x10.
 */

let order: number[] | null = null;

function mobOrder(): number[] {
  if (order) return order;
  try {
    const b = fs.readFileSync(path.join(config.dataDir, "ss_mob.mdd"));
    const n = Math.min(b.readUInt32LE(0), 600);
    order = [];
    for (let i = 0; i < n; i++) order.push(b.readUInt32LE(4 + 4 * i));
  } catch {
    order = [];
  }
  return order;
}

/**
 * Completion reward (all 9 pieces), from data/ss_book_rewards.json (re-tools/book_rewards.js): EXP = 150 × the
 * monster kill EXP (matches the SpoilGhost fan table), fame +1 per 10 monster levels (max 15).
 */
let rewards: Record<number, { exp: number; fame: number }> | null = null;

function rewardFor(template: number): { exp: number; fame: number } | null {
  if (!rewards) {
    try {
      rewards = JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_book_rewards.json"), "utf8"));
    } catch {
      rewards = {};
    }
  }
  return rewards![template] ?? null;
}

let tableReady = false;

async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute(
    "CREATE TABLE IF NOT EXISTS monster_book (charid int NOT NULL, template int NOT NULL, bits int NOT NULL DEFAULT 0, PRIMARY KEY (charid, template))",
  );
  tableReady = true;
}

/** Piece item → monster template and piece number (1..9), or null when the item is not a known piece. */
export function pieceOf(itemId: number): { template: number; piece: number } | null {
  if (itemId < 1100000 || itemId >= 1200000) return null;
  const rest = itemId - 1100000;
  const piece = Math.floor(rest / 10) % 10;
  if (piece < 1 || piece > 9) return null;
  const template = 1000000 + Math.floor(rest / 100) * 100 + (rest % 10);
  return mobOrder().includes(template) ? { template, piece } : null;
}

function bookUpdate(template: number, bits: number): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x016e, 20);
  b.writeUInt32LE(template >>> 0, 12);
  b.writeUInt16LE(bits & 0x1ff, 16);
  return b;
}

export async function buildMonsterBook(cid: number): Promise<Buffer> {
  await ensureTable();
  const b = Buffer.alloc(1212, 0);
  writeHeader(b, 0x016d, 1212);
  const rows = await query<RowDataPacket[]>("SELECT template, bits FROM monster_book WHERE charid=?", [cid]);
  const bits = new Map(rows.map((r) => [Number(r.template), Number(r.bits)]));
  mobOrder().forEach((tpl, i) => {
    const v = bits.get(tpl) ?? 0;
    b[0x0c + 2 * i] = (v >> 6) & 0x07;
    b[0x0d + 2 * i] = 0x40 | (v & 0x3f);
  });
  return b;
}

/**
 * Register a piece. Returns null when the item is not a piece; `consume` is false when the piece was already
 * registered (the caller then sells the duplicate for gold, as the client tooltip says).
 */
export async function registerPiece(cid: number, itemId: number): Promise<{
  consume: boolean;
  packet: Buffer;
  reward: { exp: number; fame: number } | null;
} | null> {
  const info = pieceOf(itemId);
  if (!info) return null;
  await ensureTable();
  const rows = await query<RowDataPacket[]>("SELECT bits FROM monster_book WHERE charid=? AND template=?", [
    cid,
    info.template,
  ]);
  const old = Number(rows[0]?.bits ?? 0);
  const bit = 1 << (info.piece - 1);
  if (old & bit) return { consume: false, packet: bookUpdate(info.template, old), reward: null };
  const bits = old | bit;
  await execute(
    "INSERT INTO monster_book (charid, template, bits) VALUES (?,?,?) ON DUPLICATE KEY UPDATE bits=VALUES(bits)",
    [cid, info.template, bits],
  );
  const reward = bits === 0x1ff ? rewardFor(info.template) : null;
  return { consume: true, packet: bookUpdate(info.template, bits), reward };
}
