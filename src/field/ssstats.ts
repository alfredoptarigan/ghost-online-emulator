/**
 * Soul Saver character stats, derived from official captures (pktmon 2026-10-17, Magic User "MamaGicc" lv1-4)
 * and the client tables tb_JobBase / tb_JobGrowth / tb_Exp (data/ss_jobs.json, data/ss_exp.json).
 * Coefficients are the table values / 100:
 *   max HP = 1 + floor(CON*ConHP + STR*StrHP) + level*growthHP      (Magic User lv1: 1 + 64 + 10 = 75)
 *   max MP = 1 + floor(INT*IntSP) + level*growthSP                    (lv1: 1 + 9 + 15 = 25)
 *   phys   = floor(STR*StrAtt) + floor(DEX*DexMax) / … + floor(DEX*DexMin)   (10 / 8)
 *   magic  = 7 + floor(INT*IntAtt), min = max - 2                     (13 / 11; 40 / 38 at INT 15)
 *   def    = floor(CON*ConDef)                                        (14)
 * plus the worn equipment (weapon: item f[4] phys, f[5] magic; armor: f[4] def — TrainingFan magic +8 and
 * BasicClothes def +3 give the official 21/19 magic and defense 17). Growth uses the Novice row until a faction
 * is chosen (+10 HP / +15 MP per level, as captured). Level up: +4 stat points, +2 skill points.
 * Only characters created through the Soul Saver client (characters.ss_char = 1) use these rules.
 */
import fs from "node:fs";
import path from "node:path";
import type { RowDataPacket } from "mysql2";
import { query, execute } from "../db.js";
import { config } from "../config.js";

export const SS_STAT_POINTS_PER_LEVEL = 4;
export const SS_SKILL_POINTS_PER_LEVEL = 2;

type JobBase = {
  nID: number;
  nStateStrAtt: number;
  nStateStrHP: number;
  nStateDexMax: number;
  nStateDexMin: number;
  nStateConDef: number;
  nStateConHP: number;
  nStateIntAtt: number;
  nStateIntSP: number;
};

type JobsTable = { base: JobBase[]; growth: Array<{ eClass: number; nGlowthHP: number; nGlowthSP: number }> };
type ItemsTable = Record<string, { s?: number; f?: number[] }>;
let jobs: JobsTable | null = null;
let expTable: Record<string, number> | null = null;
let items: ItemsTable | null = null;

function load<T>(file: string, pick: (j: any) => T, fallback: T): T {
  try {
    return pick(JSON.parse(fs.readFileSync(path.join(config.dataDir, file), "utf8")));
  } catch {
    return fallback;
  }
}

/** EXP needed to go from `level` to the next one (tb_Exp: 10, 25, 65, 150, 398, …). */
export function ssExpForLevel(level: number): number {
  const t = (expTable ??= load("ss_exp.json", (j) => j.exp, {} as Record<string, number>));
  return Number(t[level] ?? 0) || 0;
}

let columnReady = false;
async function ensureColumn(): Promise<void> {
  if (columnReady) return;
  await execute("ALTER TABLE characters ADD COLUMN IF NOT EXISTS ss_char tinyint NOT NULL DEFAULT 0");
  columnReady = true;
}

export async function markSsChar(charId: number): Promise<void> {
  await ensureColumn();
  await execute("UPDATE characters SET ss_char=1, mexp=? WHERE ID=?", [ssExpForLevel(1), charId]);
}

export async function isSsChar(charId: number): Promise<boolean> {
  await ensureColumn();
  const rows = await query<RowDataPacket[]>("SELECT ss_char FROM characters WHERE ID=?", [charId]);
  return Number(rows[0]?.ss_char ?? 0) === 1;
}

export type SsStats = {
  maxHp: number;
  maxMp: number;
  phyMax: number;
  phyMin: number;
  magMax: number;
  magMin: number;
  def: number;
};

export function ssDerive(job: number, level: number, str: number, dex: number, con: number, int: number, worn: number[]): SsStats {
  const jt = (jobs ??= load<JobsTable>("ss_jobs.json", (j) => j, { base: [], growth: [] }));
  const it0 = (items ??= load<ItemsTable>("ss_items.json", (j) => j.items ?? {}, {}));
  const b = jt.base.find((r) => r.nID === job) ?? jt.base.find((r) => r.nID === 0);
  const g = jt.growth.find((r) => r.eClass === 0) ?? { nGlowthHP: 1000, nGlowthSP: 1500 };
  const c = (v: number | undefined) => (v ?? 0) / 100;
  let phyAdd = 0;
  let magAdd = 0;
  let defAdd = 0;
  for (const id of worn) {
    const it = it0[id];
    if (!it?.f) continue;
    if (it.s === 1) {
      phyAdd += it.f[4] ?? 0;
      magAdd += it.f[5] ?? 0;
    } else if (it.s === 2) {
      defAdd += it.f[4] ?? 0;
    }
  }
  const magBase = 7 + Math.floor(int * c(b?.nStateIntAtt));
  return {
    maxHp: 1 + Math.floor(con * c(b?.nStateConHP) + str * c(b?.nStateStrHP)) + Math.floor((level * g.nGlowthHP) / 100),
    maxMp: 1 + Math.floor(int * c(b?.nStateIntSP)) + Math.floor((level * g.nGlowthSP) / 100),
    phyMax: Math.floor(str * c(b?.nStateStrAtt)) + Math.floor(dex * c(b?.nStateDexMax)) + phyAdd,
    phyMin: Math.floor(str * c(b?.nStateStrAtt)) + Math.floor(dex * c(b?.nStateDexMin)) + phyAdd,
    magMax: magBase + magAdd,
    magMin: magBase - 2 + magAdd,
    def: Math.floor(con * c(b?.nStateConDef)) + defAdd,
  };
}

/** Recompute and store the derived stats of a Soul Saver character; null for other characters. */
export async function recomputeSsStats(charId: number): Promise<SsStats | null> {
  if (!(await isSsChar(charId))) return null;
  const rows = await query<RowDataPacket[]>(
    "SELECT job, level, str, dex, vit, intel, chp, cmp FROM characters WHERE ID=?",
    [charId],
  );
  const r = rows[0];
  if (!r) return null;
  const worn = await query<RowDataPacket[]>("SELECT type FROM equip WHERE charid=? AND pos1=0", [charId]);
  const s = ssDerive(
    Number(r.job ?? 0),
    Number(r.level ?? 1),
    Number(r.str ?? 3),
    Number(r.dex ?? 3),
    Number(r.vit ?? 3),
    Number(r.intel ?? 3),
    worn.map((w) => Number(w.type)),
  );
  await execute(
    `UPDATE characters SET cmhp=?, cmmp=?, chp=LEAST(chp, ?), cmp=LEAST(cmp, ?),
       maxdamphy=?, mindamphy=?, maxdamw=?, mindamw=?, def=?, mexp=? WHERE ID=?`,
    [s.maxHp, s.maxMp, s.maxHp, s.maxMp, s.phyMax, s.phyMin, s.magMax, s.magMin, s.def, ssExpForLevel(Number(r.level ?? 1)), charId],
  );
  return s;
}
