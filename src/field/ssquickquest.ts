/**
 * Soul Saver Quick Quest (the "Quick Quest" tab, tb_LetterQuest.tbl -> data/ss_quickquests.json). Official capture
 * day2_stage2 (Magic User "Wildia" lv35-55), see SOULSAVER_RE_NOTES.md section 21.
 *
 * C 0x35F (20 B): u8 mode @12 (1 accept, 2 claim, 3 give up), `78 FD 00` @13, u32 questId @16 (the client also sends a
 * 16 B give-up without the id).
 * S 0x35E (24 B, client handler at 0x1638023): u32 questId @12, u32 kills @16, u8 @20 = 1 running / 2 target reached,
 * u8 @21 = 1 progress, 2 "Unable to accept due to level requirement." (1032269), 3 quest removed, 4 (after give up);
 * u8 @22 = 1 when removed because it was claimed.
 *
 * One quest at a time. Kills of the target monster (party members on the same map too) count up to nHuntingCount; more
 * kills resend the "target reached" packet. Claiming grants the EXP, removes the quest (00 03 01) and the client
 * accepts it again right away, so the quests repeat (101632 was done 23 times).
 */
import type { RowDataPacket } from "mysql2";
import fs from "node:fs";
import path from "node:path";
import { query, execute } from "../db.js";
import { config } from "../config.js";
import { writeHeader } from "../net/packet.js";

type QuickQuest = { lv: number; limitLv: number; mob: number; count: number; exp: number; correct: number; name: string };

let table: Record<number, QuickQuest> | null = null;
function quickQuest(id: number): QuickQuest | undefined {
  if (!table) {
    try {
      const file = path.join(config.dataDir, "ss_quickquests.json");
      table = (JSON.parse(fs.readFileSync(file, "utf8")) as { quests: Record<number, QuickQuest> }).quests;
    } catch (e) {
      console.warn("[quickquest] ss_quickquests.json not loaded", e);
      table = {};
    }
  }
  return table[id];
}

/**
 * Reward EXP at the player's level (before the EXP event / gear multipliers). Official: full nRewardEXP at the quest
 * level, then ceil(exp * (1 - d * lv / (correct * L))) with d = L - lv; matches all 61 claims of the capture (quest lv
 * 35..55, d 0..4, nEXPCorrect 15). Using nEXPCorrect as the divisor for the 20 of the Zodiac quests is a guess.
 */
export function quickQuestExp(id: number, level: number): number {
  const q = quickQuest(id);
  if (!q) return 0;
  const d = Math.max(0, level - q.lv);
  if (d === 0) return q.exp;
  return Math.max(0, Math.ceil(q.exp * (1 - (d * q.lv) / ((q.correct || 15) * level)) - 1e-9));
}

function packet(questId: number, kills: number, b20: number, b21: number, b22 = 0): Buffer {
  const b = Buffer.alloc(24, 0);
  writeHeader(b, 0x035e, 24);
  b.writeUInt32LE(questId >>> 0, 12);
  b.writeUInt32LE(kills >>> 0, 16);
  b[20] = b20;
  b[21] = b21;
  b[22] = b22;
  return b;
}

function progressPacket(questId: number, kills: number): Buffer {
  const q = quickQuest(questId);
  return packet(questId, kills, q && kills >= q.count ? 2 : 1, 1);
}

type Active = { questId: number; kills: number };
const active = new Map<number, Active | null>();

let tableReady = false;
async function ensureTable(): Promise<void> {
  if (tableReady) return;
  await execute(
    "CREATE TABLE IF NOT EXISTS ss_quickquest (charid int NOT NULL PRIMARY KEY, questid int NOT NULL, " +
      "kills int NOT NULL DEFAULT 0)",
  );
  tableReady = true;
}

async function load(charId: number): Promise<Active | null> {
  if (active.has(charId)) return active.get(charId)!;
  await ensureTable();
  const rows = await query<RowDataPacket[]>("SELECT questid, kills FROM ss_quickquest WHERE charid=?", [charId]);
  const a = rows[0] ? { questId: Number(rows[0].questid), kills: Number(rows[0].kills) } : null;
  active.set(charId, a);
  return a;
}

async function save(charId: number, a: Active | null): Promise<void> {
  active.set(charId, a);
  await ensureTable();
  if (a) {
    await execute(
      "INSERT INTO ss_quickquest (charid, questid, kills) VALUES (?,?,?) ON DUPLICATE KEY UPDATE questid=VALUES(questid), kills=VALUES(kills)",
      [charId, a.questId, a.kills],
    );
  } else {
    await execute("DELETE FROM ss_quickquest WHERE charid=?", [charId]);
  }
}

/** Login: official sends the running quest (S 0x35E) right after entering the field. */
export async function quickQuestLoginPackets(charId: number): Promise<Buffer[]> {
  active.delete(charId);
  const a = await load(charId);
  return a && quickQuest(a.questId) ? [progressPacket(a.questId, a.kills)] : [];
}

/** Monster kill (killer and same-map party members). */
export async function quickQuestOnKill(charId: number, template: number): Promise<Buffer[]> {
  const a = await load(charId);
  if (!a) return [];
  const q = quickQuest(a.questId);
  if (!q || q.mob !== template) return [];
  if (a.kills < q.count) {
    a.kills++;
    await save(charId, a);
  }
  return [progressPacket(a.questId, a.kills)];
}

export type QuickQuestResult = { packets: Buffer[]; exp: number; questId: number };

/** C 0x35F. `exp` > 0 = grant it (claim) before sending the packets. */
export async function handleQuickQuest(charId: number, level: number, pkt: Buffer): Promise<QuickQuestResult> {
  const mode = pkt.length > 12 ? pkt[12]! : 0;
  const questId = pkt.length >= 20 ? pkt.readUInt32LE(16) : 0;
  const a = await load(charId);
  if (mode === 1) {
    const q = quickQuest(questId);
    if (!q) return { packets: [], exp: 0, questId };
    // Official (t=2056): lv41 accepting the lv42 quest 101635 -> 0x35E id, 0, 01 02. Above nLQuestLimitLv is assumed
    // to fail the same way (the client lists only quests for the current level).
    if (level < q.lv || level > q.limitLv) return { packets: [packet(questId, 0, 1, 2)], exp: 0, questId };
    if (a && a.questId === questId) return { packets: [progressPacket(questId, a.kills)], exp: 0, questId };
    await save(charId, { questId, kills: 0 });
    return { packets: [progressPacket(questId, 0)], exp: 0, questId };
  }
  if (mode === 2) {
    const q = a ? quickQuest(a.questId) : undefined;
    if (!a || !q || a.kills < q.count || (questId && questId !== a.questId)) return { packets: [], exp: 0, questId };
    await save(charId, null);
    return { packets: [packet(0, 0, 0, 3, 1)], exp: quickQuestExp(a.questId, level), questId: a.questId };
  }
  if (mode === 3) {
    // Official give up: two packets, 00 03 00 then 00 04 00 (the client sends a 20 B and a 16 B 0x35F).
    if (!a) return { packets: [], exp: 0, questId };
    await save(charId, null);
    return { packets: [packet(0, 0, 0, 3, 0), packet(0, 0, 0, 4, 0)], exp: 0, questId: a.questId };
  }
  return { packets: [], exp: 0, questId };
}

export function quickQuestLogout(charId: number): void {
  active.delete(charId);
}
