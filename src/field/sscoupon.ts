/**
 * Soul Saver coupon / serial code (NPC Security Consultant), Mamluk capture private_test2 t=2544-2562:
 *   C 0x1D7 (44 B): ASCII code @12..@41 (NUL padded), A9 76 @42.
 *   valid   -> S 0xF3 (cash u32 @12) + S 0xF2, no 0x1D8 ("sundaytest": cash 0 -> 100000).
 *   invalid -> S 0x1D8 (20 B, FF FF @18) = "the serial code is not valid".
 * Codes live in ss_coupon (code, cash); each account can use a code once (ss_coupon_used).
 * Add one: INSERT INTO ss_coupon (code, cash) VALUES ('sundaytest', 100000);
 */
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";

let tableReady = false;

async function ensureTables(): Promise<void> {
  if (tableReady) return;
  await execute(
    "CREATE TABLE IF NOT EXISTS ss_coupon (code varchar(30) NOT NULL PRIMARY KEY, cash int NOT NULL DEFAULT 0, " +
      "enabled tinyint NOT NULL DEFAULT 1, created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP)",
  );
  await execute(
    "CREATE TABLE IF NOT EXISTS ss_coupon_used (code varchar(30) NOT NULL, accountid int NOT NULL, " +
      "used_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP, PRIMARY KEY (code, accountid))",
  );
  tableReady = true;
}

/** The code of a C 0x1D7, or "" when the packet is too short. */
export function couponCode(pkt: Buffer): string {
  if (pkt.length < 42) return "";
  const raw = pkt.subarray(12, 42);
  const end = raw.indexOf(0);
  return raw.subarray(0, end < 0 ? raw.length : end).toString("latin1").trim();
}

/** S 0x1D8: the serial code is not valid (or was already used). */
export function couponInvalid(): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x01d8, 20);
  b.writeUInt16LE(0xffff, 18);
  return b;
}

/** Cash added by the code (0 = invalid, disabled or already used by this account). */
export async function redeemCoupon(accountId: number, code: string): Promise<number> {
  await ensureTables();
  if (!code || accountId <= 0) return 0;
  const rows = await query<RowDataPacket[]>("SELECT cash FROM ss_coupon WHERE code=? AND enabled=1", [code]);
  const cash = Number(rows[0]?.cash ?? 0);
  if (!rows.length || cash <= 0) return 0;
  // The primary key makes the second use by the same account fail, also when two packets race.
  const used = await execute("INSERT IGNORE INTO ss_coupon_used (code, accountid) VALUES (?,?)", [code, accountId]);
  if (used.affectedRows !== 1) return 0;
  await execute("UPDATE users SET game_points=game_points+? WHERE accountid=?", [cash, accountId]);
  return cash;
}
