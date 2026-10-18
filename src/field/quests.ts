import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { config, rates } from "../config.js";
import { writeHeader } from "../net/packet.js";
import { addItemToInventory, removeInvQty, refreshBagPackets } from "./inventory.js";
import { isSsChar, setSsClass, recomputeSsStats, ssExpForLevel, SS_STAT_POINTS_PER_LEVEL, SS_SKILL_POINTS_PER_LEVEL } from "./ssstats.js";
import { ensureBeginnerSkills, buildSkillAll } from "./skills.js";

/** remote DB: quests(charid, questid, state, progress). Packets match legacy legacy quests. */

const KILL_GOALS: Record<number, { template: number; count: number }> = {
  8: { template: 1001201, count: 10 },
  28: { template: 1002201, count: 20 },
  38: { template: 1002201, count: 20 },
  29: { template: 1002801, count: 20 },
  39: { template: 1002801, count: 20 },
  49: { template: 1002801, count: 20 },
  30: { template: 1003401, count: 20 },
  40: { template: 1003401, count: 20 },
  50: { template: 1003401, count: 20 },
  31: { template: 1003801, count: 20 },
  41: { template: 1003801, count: 20 },
  44: { template: 1001201, count: 20 },
  45: { template: 1001201, count: 20 },
  46: { template: 1001601, count: 20 },
  47: { template: 1002101, count: 20 },
  48: { template: 1002401, count: 20 },
  51: { template: 1003701, count: 20 },
};

const NEED_LEVEL: Record<number, number> = {
  2: 2, 3: 2, 4: 3, 5: 5, 6: 8,
  7: 10, 15: 10, 16: 10, 17: 10, 18: 10, 19: 10, 20: 10, 21: 10, 22: 10, 23: 10,
  32: 10, 33: 10, 42: 10, 43: 10,
  8: 12, 44: 12, 45: 12,
  9: 13, 24: 13, 25: 13, 34: 13, 35: 13,
  10: 15, 11: 18, 12: 18, 26: 18, 27: 18, 36: 18, 37: 18,
  13: 20, 46: 17, 47: 21, 28: 23, 38: 23, 48: 25, 29: 28, 39: 28, 49: 29,
  14: 30, 30: 33, 40: 33, 50: 33, 51: 37, 31: 38, 41: 38,
};

const NEED_QUEST: Record<number, number> = { 4: 3, 9: 8, 12: 11, 13: 12 };

/** Turn-in consume list from quest.lua goal.getItem + deleteItem (quests 2–51). */
const TURN_IN_ITEMS: Record<number, Array<[number, number]>> = {
  2: [[8910031, 10]],
  3: [[8990002, 1]],
  4: [[8990003, 1]],
  5: [[8910051, 10]],
  6: [[8110011, 1]],
  7: [[8910101, 10]],
  9: [[8910121, 20]],
  10: [[8910161, 20]],
  11: [[8810041, 1]],
  12: [[8810041, 1]],
  13: [[8990004, 1], [8910201, 10]],
  14: [[8910301, 10]],
  15: [[8910061, 20], [8910071, 10]],
  17: [[8910081, 10]],
  18: [[8910061, 20], [8910071, 10]],
  20: [[8910061, 20], [8910071, 10]],
  22: [[8990006, 1]],
  23: [[8990009, 1]],
  24: [[8910141, 10]],
  25: [[8910141, 10]],
  26: [[8910181, 10]],
  27: [[8910181, 10]],
  32: [[8990007, 1]],
  33: [[8990010, 1]],
  34: [[8910141, 10]],
  35: [[8910141, 10]],
  36: [[8910181, 10]],
  37: [[8910181, 10]],
  42: [[8990008, 1]],
  43: [[8990011, 1]],
};

const ACCEPT_ITEMS: Record<number, number> = {
  3: 8990002, 4: 8990003, 22: 8990006, 23: 8990009,
  32: 8990007, 33: 8990010, 42: 8990008, 43: 8990011,
};

const SKILL_REWARDS: Record<number, number> = {
  22: 10101, 23: 10102, 24: 10105, 25: 10103, 26: 10106, 27: 10108, 28: 10107, 29: 10104, 30: 10109, 31: 10110,
  32: 10201, 33: 10202, 34: 10203, 35: 10206, 36: 10209, 37: 10208, 38: 10204, 39: 10205, 40: 10207, 41: 10210,
  42: 10301, 43: 10302, 44: 10304, 45: 10303, 46: 10305, 47: 10306, 48: 10307, 49: 10308, 50: 10309, 51: 10310,
};

/**
 * Soul Saver quest rules, extracted from the client's zGsp/Script/quest.luc (table qt): requirements,
 * items given on accept (requstItem), items taken on turn-in (goal.getItem + deleteItem), kill goals and
 * rewards. Quests 2–51 keep the hand-written tables above (same data, Ghost client parity).
 */
type SsQuest = {
  needLevel?: number;
  needQuest?: number;
  accept?: Array<[number, number]>;
  remove?: Array<[number, number]>;
  kill?: Array<[number, number]>;
  money?: number;
  exp?: number;
  fame?: number;
  items?: Array<[number, number]>;
  skills?: number[];
};

const SS_QUESTS: Record<number, SsQuest> = (() => {
  try {
    return JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_quests.json"), "utf8"));
  } catch {
    return {};
  }
})();

const isLegacy = (qid: number) => qid >= 2 && qid <= 51;
/** Ghost tables for quests 2..51, unless a Soul Saver client has its own quest.luc entry (e.g. 45 Diablo Spear is
 * lv10 there but lv12 in Ghost, and Ghost 16/19/21 change to Ghost jobs). */
const useLegacy = (qid: number, ss: boolean) => isLegacy(qid) && !(ss && SS_QUESTS[qid] != null);

function supported(qid: number): boolean {
  return isLegacy(qid) || SS_QUESTS[qid] != null;
}

function killGoal(qid: number, ss = false): { template: number; count: number } | undefined {
  if (useLegacy(qid, ss)) return KILL_GOALS[qid];
  const k = SS_QUESTS[qid]?.kill?.[0];
  return k ? { template: k[0], count: k[1] } : undefined;
}

/**
 * Soul Saver QUEST_ALL (2252 bytes, SetQuest FUN_01365cb0): same slots, but a 2000-byte state table where
 * each byte holds two quests: '0'+state for quest j+1 plus 10*state for quest j+1001 (bytes 1000.. cover
 * 2001..4000 the same way). State 0 none, 1 active, 2 done.
 */
function ssStateTable(b: Buffer, rows: RowDataPacket[]): void {
  const base = 252;
  b.fill(0x30, base, base + 2000);
  for (const r of rows) {
    const qid = Number(r.questId);
    const st = Number(r.questState ?? 0x20);
    const v = st === 0x31 ? 1 : st === 0x32 ? 2 : 0;
    if (!v || qid < 1 || qid > 4000) continue;
    const j = qid <= 2000 ? (qid - 1) % 1000 : 1000 + ((qid - 2001) % 1000);
    const tens = (qid > 1000 && qid <= 2000) || qid > 3000;
    b[base + j] = b[base + j]! + (tens ? 10 * v : v);
  }
}

export async function buildQuestAll(cid: number, ss = false): Promise<Buffer> {
  const rows = await query<RowDataPacket[]>(
    "SELECT questid AS questId, state AS questState, progress AS completeMonster FROM quests WHERE charid=? ORDER BY state, id",
    [cid],
  );
  const len = ss ? 2252 : 1252;
  const b = Buffer.alloc(len, 0);
  writeHeader(b, 0x0079, len);
  let slot = 0;
  for (const r of rows) {
    if (slot >= 15) break;
    const st = Number(r.questState ?? 0x20);
    if (st === 0x20) continue;
    if (ss && st !== 0x31) continue; // official: slots hold only active quests; done ones are in the state table
    b.writeUInt32LE(Number(r.completeMonster ?? 0), 12 + slot * 16);
    b.writeUInt16LE(Number(r.questId) & 0xffff, 24 + slot * 16);
    b.writeUInt8(1, 26 + slot * 16);
    b.writeUInt8(0, 27 + slot * 16);
    slot++;
  }
  if (ss) {
    ssStateTable(b, rows);
    return b;
  }
  const base = 12 + 15 * 16;
  for (let i = 0; i < 999; i++) b.writeUInt8(0x20, base + i);
  for (const r of rows) {
    const qid = Number(r.questId);
    const st = Number(r.questState ?? 0x20);
    if (qid < 1 || qid > 999 || st === 0x20) continue;
    b.writeUInt8(st & 0xff, base + (qid - 1));
  }
  return b;
}

function questUpdate(complete: number, questId: number, stateA: number, stateB: number): Buffer {
  const b = Buffer.alloc(28, 0);
  writeHeader(b, 0x0080, 28);
  b.writeUInt32LE(complete, 12);
  b.writeUInt16LE(questId & 0xffff, 24);
  b.writeUInt8(stateA & 0xff, 26);
  b.writeUInt8(stateB & 0xff, 27);
  return b;
}

async function getRow(cid: number, qid: number): Promise<RowDataPacket | null> {
  const rows = await query<RowDataPacket[]>(
    "SELECT id, questid AS questId, state AS questState, progress AS completeMonster FROM quests WHERE charid=? AND questid=? LIMIT 1",
    [cid, qid],
  );
  return rows[0] ?? null;
}

async function removeItemById(cid: number, itemId: number, qty: number): Promise<Buffer[]> {
  const out: Buffer[] = [];
  let left = qty;
  const bags: Array<{ bag: number; col: string; table: string }> = [
    { bag: 3, col: "itemid", table: "spend" },
    { bag: 4, col: "type", table: "other" },
  ];
  for (const t of bags) {
    if (left <= 0) break;
    const rows = await query<RowDataPacket[]>(
      `SELECT pos2, amount FROM ${t.table} WHERE charid=? AND ${t.col}=? AND amount>0 ORDER BY pos2`,
      [cid, itemId],
    );
    for (const r of rows) {
      if (left <= 0) break;
      const take = Math.min(left, Number(r.amount));
      await removeInvQty(cid, t.bag, Number(r.pos2), take);
      left -= take;
      out.push(...(await refreshBagPackets(cid, t.bag)));
    }
  }
  // Equip (bags 0–2): one row per piece — legacy parity
  if (left > 0) {
    const rows = await query<RowDataPacket[]>(
      "SELECT pos1, pos2 FROM equip WHERE charid=? AND type=? ORDER BY pos1, pos2 LIMIT ?",
      [cid, itemId, left],
    );
    const refreshed = new Set<number>();
    for (const r of rows) {
      const bag = Number(r.pos1);
      await removeInvQty(cid, bag, Number(r.pos2), 1);
      left -= 1;
      if (!refreshed.has(bag)) {
        refreshed.add(bag);
        out.push(...(await refreshBagPackets(cid, bag)));
      }
    }
  }
  return out;
}

async function grantSkill(cid: number, skillId: number): Promise<void> {
  const rows = await query<RowDataPacket[]>("SELECT id FROM skills WHERE charid=? AND skillid=?", [cid, skillId]);
  if (!rows.length) await execute("INSERT INTO skills (charid, skillid, points) VALUES (?,?,1)", [cid, skillId]);
}

async function addMoney(cid: number, amount: number): Promise<void> {
  await execute("UPDATE characters SET money=money+? WHERE ID=?", [amount, cid]);
}

async function addFame(cid: number, amount: number): Promise<void> {
  await execute("UPDATE characters SET honor=honor+? WHERE ID=?", [amount, cid]);
}

async function addExp(cid: number, amount: number): Promise<void> {
  const rows = await query<RowDataPacket[]>("SELECT exp, mexp, level, st_point, sk_point FROM characters WHERE ID=?", [cid]);
  if (!rows.length) return;
  let exp = Number(rows[0]!.exp ?? 0) + amount;
  let mexp = Number(rows[0]!.mexp ?? 30);
  let level = Number(rows[0]!.level ?? 1);
  let st = Number(rows[0]!.st_point ?? 0);
  let sk = Number(rows[0]!.sk_point ?? 0);
  const ss = await isSsChar(cid);
  const startLevel = level;
  while (exp >= mexp && level < (ss ? 200 : 99)) {
    exp -= mexp;
    level += 1;
    if (ss) {
      // Soul Saver: tb_Exp curve and +4/+2 points, so the starter quests level a new character as officially.
      // Official: the new level starts at 0 EXP (quest 1107 at lv5 15/398 + 500 -> lv6 0/690).
      exp = 0;
      st += SS_STAT_POINTS_PER_LEVEL;
      sk += SS_SKILL_POINTS_PER_LEVEL;
      mexp = ssExpForLevel(level) || mexp;
    } else {
      st += 5;
      sk += 1;
      mexp = Math.floor(mexp * rates.questExpRate) + rates.questExpFlat;
    }
  }
  await execute("UPDATE characters SET exp=?, mexp=?, level=?, st_point=?, sk_point=? WHERE ID=?", [
    exp, mexp, level, st, sk, cid,
  ]);
  if (ss && level > startLevel) {
    const st2 = await recomputeSsStats(cid);
    if (st2) await execute("UPDATE characters SET chp=?, cmp=? WHERE ID=?", [st2.maxHp, st2.maxMp, cid]);
  }
}

async function jobChange(cid: number, job: number): Promise<Buffer[]> {
  await execute("UPDATE characters SET str=3,dex=3,vit=3,intel=3,st_point=40,job=? WHERE ID=?", [job, cid]);
  // Original: job change does not unlock skills — those come from job-master quests (22–51).
  await ensureBeginnerSkills(cid);
  return [await buildSkillAll(cid)];
}

async function applySsRewards(cid: number, q: SsQuest): Promise<Buffer[]> {
  const out: Buffer[] = [];
  for (const [iid, n] of q.remove ?? []) out.push(...(await removeItemById(cid, iid, n)));
  if (q.money) await addMoney(cid, q.money);
  if (q.exp) await addExp(cid, q.exp);
  if (q.fame) await addFame(cid, q.fame);
  for (const [iid, n] of q.items ?? []) {
    const bag = await addItemToInventory(cid, iid, n);
    if (bag >= 0) out.push(...(await refreshBagPackets(cid, bag)));
  }
  if (q.skills?.length) {
    for (const sid of q.skills) await grantSkill(cid, sid);
    out.push(await buildSkillAll(cid));
  }
  return out;
}

async function applyRewards(cid: number, questId: number, ss = false): Promise<Buffer[]> {
  if (!useLegacy(questId, ss)) return applySsRewards(cid, SS_QUESTS[questId]!);
  const out: Buffer[] = [];
  for (const [iid, q] of TURN_IN_ITEMS[questId] ?? []) {
    out.push(...(await removeItemById(cid, iid, q)));
  }

  const money: Record<number, number> = {
    2: 200, 3: 300, 4: 400, 5: 600, 6: 1200, 7: 1500, 8: 1800, 9: 2000, 10: 3000, 13: 9000, 14: 54000,
  };
  const exp: Record<number, number> = {
    3: 30, 4: 30, 5: 50, 6: 200, 7: 300, 8: 500, 9: 500, 11: 100, 12: 100, 13: 2000, 14: 5000,
  };
  const fame: Record<number, number> = {
    3: 1, 4: 1, 5: 1, 6: 5, 8: 1, 9: 1, 11: 2, 12: 2,
  };
  if (money[questId]) await addMoney(cid, money[questId]!);
  if (exp[questId]) await addExp(cid, exp[questId]!);
  if (fame[questId]) await addFame(cid, fame[questId]!);

  if (questId === 7) {
    const b1 = await addItemToInventory(cid, 8810011, 20);
    const b2 = await addItemToInventory(cid, 8820011, 40);
    if (b1 >= 0) out.push(...(await refreshBagPackets(cid, b1)));
    if (b2 >= 0) out.push(...(await refreshBagPackets(cid, b2)));
  }
  if (questId === 12) {
    const b = await addItemToInventory(cid, 8990004, 1);
    if (b >= 0) out.push(...(await refreshBagPackets(cid, b)));
  }

  if (questId === 16) out.push(...(await jobChange(cid, 1)));
  if (questId === 19) out.push(...(await jobChange(cid, 2)));
  if (questId === 21) out.push(...(await jobChange(cid, 3)));

  const sid = SKILL_REWARDS[questId];
  if (sid) {
    await grantSkill(cid, sid);
    out.push(await buildSkillAll(cid));
  }
  return out;
}

export async function acceptQuest(cid: number, level: number, questId: number, ss = false): Promise<Buffer[]> {
  if (!supported(questId)) return [await buildQuestAll(cid, ss)];
  const legacy = useLegacy(questId, ss);
  const needLv = (legacy ? NEED_LEVEL[questId] : SS_QUESTS[questId]!.needLevel) ?? 1;
  if (level < needLv) return [await buildQuestAll(cid, ss)];
  const needQ = legacy ? NEED_QUEST[questId] : SS_QUESTS[questId]!.needQuest;
  if (needQ) {
    const prereq = await getRow(cid, needQ);
    if (!prereq || Number(prereq.questState) !== 0x32) return [await buildQuestAll(cid, ss)];
  }
  const existing = await getRow(cid, questId);
  if (existing) {
    const st = Number(existing.questState);
    if (st === 0x31 || st === 0x32) return [await buildQuestAll(cid, ss)];
    await execute("UPDATE quests SET state=49, progress=0 WHERE id=?", [existing.id]);
  } else {
    await execute("INSERT INTO quests (charid, questid, state, progress) VALUES (?,?,49,0)", [cid, questId]);
  }
  const out: Buffer[] = [];
  const acceptItems: Array<[number, number]> = legacy
    ? ACCEPT_ITEMS[questId] ? [[ACCEPT_ITEMS[questId]!, 1]] : []
    : SS_QUESTS[questId]!.accept ?? [];
  for (const [iid, n] of acceptItems) {
    const bag = await addItemToInventory(cid, iid, n);
    if (bag >= 0) out.push(...(await refreshBagPackets(cid, bag)));
  }
  out.push(await buildQuestAll(cid, ss));
  return out;
}

export async function giveUpQuest(cid: number, questId: number, ss = false): Promise<Buffer[]> {
  await execute("DELETE FROM quests WHERE charid=? AND questid=?", [cid, questId]);
  return [await buildQuestAll(cid, ss)];
}

export type QuestCompleteResult = { packets: Buffer[]; refreshChar: boolean };

/** Soul Saver lv10 Job Change quests (Fencer, Assassin, Magic User, Fighter, Archer, Spearman) � job tier 1. */
const SS_JOB_CHANGE = new Set([16, 19, 21, 351, 612, 2018]);
/** lv60 "2nd Job Change(3)" quests � job tier 3. */
const SS_JOB2_CHANGE = new Set([169, 172, 175, 178, 181, 184, 385, 388, 635, 638, 2092, 2095]);

export async function completeQuest(cid: number, questId: number, ss = false): Promise<QuestCompleteResult> {
  const row = await getRow(cid, questId);
  if (!row || Number(row.questState) !== 0x31 || !supported(questId)) {
    return { packets: [await buildQuestAll(cid, ss)], refreshChar: false };
  }
  await execute("UPDATE quests SET state=50 WHERE charid=? AND questid=?", [cid, questId]);
  const rewardPkts = await applyRewards(cid, questId, ss);
  if (ss && SS_JOB_CHANGE.has(questId)) await setSsClass(cid, 1);
  if (ss && SS_JOB2_CHANGE.has(questId)) await setSsClass(cid, 3);
  // lv40 "Selecting Faction": 60 Justice (JusticeFactionReferral), 64 Chaos (ChaosFactionReferral).
  if (ss && (questId === 60 || questId === 64)) {
    await execute("UPDATE characters SET job3=? WHERE ID=?", [questId === 60 ? 1 : 2, cid]);
  }
  return {
    // Soul Saver's 0x80 handler (FUN_01362410) stores +26 as the quest state, so 1 would re-open the quest
    // in the Quest Alert; send 2 (done).
    packets: [...rewardPkts, await buildQuestAll(cid, ss), questUpdate(Number(row.completeMonster), questId, ss ? 2 : 1, 0)],
    refreshChar: true,
  };
}

export async function onMonsterKill(cid: number, template: number, ss = false): Promise<Buffer[]> {
  const rows = await query<RowDataPacket[]>(
    "SELECT id, questid AS questId, progress AS completeMonster, state AS questState FROM quests WHERE charid=? AND state=49",
    [cid],
  );
  const out: Buffer[] = [];
  for (const r of rows) {
    const qid = Number(r.questId);
    const def = killGoal(qid, ss);
    if (!def || def.template !== template) continue;
    let done = Number(r.completeMonster ?? 0);
    if (done >= def.count) continue;
    done += 1;
    // Keep state=49 (0x31) until turn-in — legacy parity
    await execute("UPDATE quests SET progress=? WHERE id=?", [done, r.id]);
    out.push(questUpdate(done, qid, 1, 0));
  }
  return out;
}

/** legacy: 0x7A accept, 0x7B giveup, 0x7C done, 0x7D return, 0x7E done2, 0x7F update */
export async function handleQuestPacket(
  cid: number,
  level: number,
  opcode: number,
  pkt: Buffer,
  ss = false,
): Promise<QuestCompleteResult> {
  const qid = pkt.length >= 14 ? pkt.readUInt16LE(12) : 0;
  if (opcode === 0x007a) return { packets: await acceptQuest(cid, level, qid, ss), refreshChar: false };
  if (opcode === 0x007b) return { packets: await giveUpQuest(cid, qid, ss), refreshChar: false };
  if (opcode === 0x007c) return completeQuest(cid, qid, ss);
  if (opcode === 0x007e) {
    const questId = pkt.length >= 22 ? pkt.readUInt16LE(20) : qid;
    return completeQuest(cid, questId, ss);
  }
  if (opcode === 0x007d) {
    const questId = pkt.length >= 18 ? pkt.readUInt16LE(16) : qid;
    const stage = pkt.length >= 20 ? pkt.readUInt16LE(18) : 0;
    await execute("UPDATE quests SET progress=? WHERE charid=? AND questid=? AND state=49", [stage, cid, questId]);
    const row = await getRow(cid, questId);
    // Only answer for an active quest: the client sends 0x7D again when talking to the NPC after the turn-in,
    // and a QUEST_UPDATE with state 1 re-opened the finished quest in the Quest Alert.
    if (!row || Number(row.questState) !== 0x31) return { packets: [], refreshChar: false };
    return { packets: [questUpdate(Number(row.completeMonster), questId, 1, stage & 0xff)], refreshChar: false };
  }
  if (opcode === 0x007f) {
    const row = await getRow(cid, qid);
    if (!row || Number(row.questState) !== 0x31) return { packets: [], refreshChar: false };
    return { packets: [questUpdate(Number(row.completeMonster), qid, 1, 0)], refreshChar: false };
  }
  return { packets: [await buildQuestAll(cid, ss)], refreshChar: false };
}

/** @deprecated alias */
export async function buildQuestList(cid: number): Promise<Buffer[]> {
  return [await buildQuestAll(cid)];
}
