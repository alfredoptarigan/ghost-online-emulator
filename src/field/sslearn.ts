/**
 * Soul Saver NPC skill learning (faction skills etc., client "Learn" window): C 0x25B u32 skillId @12, answered with
 * S 0x25C (20 B): u32 result @12, u32 skillId @16 (client case 0x1632469). Result 1 = "[%s] obtained." and the window
 * refreshes; -1 TB_STR_SKILL_SKILL_LEARN_NO_JOB, -2 LEVEL_SHORTAGE, -3 MONEY_SHORTAGE, anything else LEARN_FAIL.
 * Rules come from tb_LearnSkill (data/ss_skills.json "learn"): mJob bit (1 << job), mFaction bit (1 << faction:
 * 2 Justice, 4 Chaos, 8 for jobs 6-10), mClass bit (1 << tb_JobGrowth class: 120 = classes 3-6, i.e. from the lv60
 * 2nd job), nLevel, nGameMoney.
 */
import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { config } from "../config.js";
import { query, execute } from "../db.js";
import { writeHeader } from "../net/packet.js";
import { ssGrowthClass } from "./ssstats.js";

type LearnRow = { nID: number; nLevel: number; mClass: number; mJob: number; mFaction: number; nGameMoney: number; szSkillName: string };
let learn: Map<number, LearnRow> | null = null;
function table(): Map<number, LearnRow> {
  if (!learn) {
    learn = new Map();
    try {
      const rows: LearnRow[] = JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_skills.json"), "utf8")).learn ?? [];
      for (const r of rows) learn.set(Number(r.nID), r);
    } catch {
      console.warn("[sslearn] data/ss_skills.json missing");
    }
  }
  return learn;
}

export function learnResultPacket(result: number, skillId: number): Buffer {
  const b = Buffer.alloc(20, 0);
  writeHeader(b, 0x025c, 20);
  b.writeInt32LE(result, 12);
  b.writeUInt32LE(skillId >>> 0, 16);
  return b;
}

export type LearnResult = { result: number; cost: number; name: string };

/** Check and apply one purchase; money is taken from the DB here (the caller updates the live player). */
export async function learnSkill(charId: number, skillId: number): Promise<LearnResult> {
  const row = table().get(skillId);
  if (!row) return { result: 0, cost: 0, name: "?" };
  const c = (await query<RowDataPacket[]>("SELECT job, job3, ss_class, level, money FROM characters WHERE ID=?", [charId]))[0];
  if (!c) return { result: 0, cost: 0, name: row.szSkillName };
  const job = Number(c.job ?? 0);
  const faction = Number(c.job3 ?? 0);
  const level = Number(c.level ?? 1);
  const cls = level >= 10 ? ssGrowthClass(Math.max(1, Number(c.ss_class ?? 0)), faction) : 0;
  const fail = (result: number) => ({ result, cost: 0, name: row.szSkillName });
  if (!(row.mJob & (1 << job))) return fail(-1);
  if (row.mFaction && !(faction >= 1 && faction <= 3 && row.mFaction & (1 << faction))) return fail(-1);
  if (row.mClass && !(row.mClass & (1 << cls))) return fail(-1);
  if (level < row.nLevel) return fail(-2);
  if (Number(c.money ?? 0) < row.nGameMoney) return fail(-3);
  const owned = await query<RowDataPacket[]>("SELECT id FROM skills WHERE charid=? AND skillid=?", [charId, skillId]);
  if (owned.length) return fail(0);
  await execute("UPDATE characters SET money=money-? WHERE ID=?", [row.nGameMoney, charId]);
  await execute("INSERT INTO skills (charid, skillid, points) VALUES (?,?,1)", [charId, skillId]);
  return { result: 1, cost: row.nGameMoney, name: row.szSkillName };
}
