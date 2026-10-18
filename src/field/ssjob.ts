/**
 * Soul Saver faction and job title bytes (client FUN_010e2eb0 builds the job name with JobGrowthTbl::GetName(class,
 * faction, job) from CHAR_ALL 0x36 job, 0x37 job2, 0x38 job3, 0x39 job4 and 0x3a faction; ENTERPLAYER 0x42..0x46).
 *   job2/job3/job4 (0xFF = not reached) code job and faction: jobs 1-5 2*job-1 Justice / 2*job Chaos (Magic User 5 =
 *   White Mage, 6 = Black Mage), jobs 6-10 job+5, Spearman 17 Justice / 18 Chaos. job2 = 2nd job (lv60, growth class
 *   3, 4 with the transcend flag), job3 = class 5 (Rebirth), job4 = class 6 (2nd-Divine).
 *   faction byte (class 2 when no job2): 0 Justice, 1 Chaos, 0xFF none. Official lv1-35 Magic User: all 0xFF.
 * DB: characters.job3 = faction (1 Justice, 2 Chaos, 3 for jobs 6-10), characters.ss_class = tier (3 after the
 * lv60 2nd Job Change, 5 Rebirth, 6 2nd-Divine). Faction comes from quest 60 (Justice) / 64 (Chaos) "Selecting
 * Faction" (lv40, JusticeFactionReferral / ChaosFactionReferral).
 */
import type { RowDataPacket } from "mysql2";
import { query } from "../db.js";

export type SsJobBytes = { job2: number; job3: number; job4: number; faction: number };
export const ssJobBytes = new Map<number, SsJobBytes>();

/** Job+faction code used by the job2/job3/job4 bytes; 0xFF when the faction is unknown. */
export function ssJobCode(job: number, faction: number): number {
  if (job >= 1 && job <= 5 && (faction === 1 || faction === 2)) return 2 * job - (faction === 1 ? 1 : 0);
  if (job >= 6 && job <= 10) return job + 5;
  if (job === 11 && (faction === 1 || faction === 2)) return faction === 1 ? 17 : 18;
  return 0xff;
}

export function ssJobBytesFor(job: number, faction: number, tier: number): SsJobBytes {
  const code = ssJobCode(job, faction);
  return {
    job2: tier >= 3 ? code : 0xff,
    job3: tier >= 5 ? code : 0xff,
    job4: tier >= 6 ? code : 0xff,
    faction: faction === 1 ? 0 : faction === 2 ? 1 : faction === 3 ? 2 : 0xff,
  };
}

/** Reload the bytes of a character (login, faction choice, job change, GM). */
export async function refreshSsJob(charId: number): Promise<SsJobBytes> {
  let r: RowDataPacket | undefined;
  try {
    r = (await query<RowDataPacket[]>("SELECT job, job3, ss_class FROM characters WHERE ID=?", [charId]))[0];
  } catch {
    r = (await query<RowDataPacket[]>("SELECT job, job3 FROM characters WHERE ID=?", [charId]))[0];
  }
  const b = ssJobBytesFor(Number(r?.job ?? 0), Number(r?.job3 ?? 0), Number(r?.ss_class ?? 0));
  ssJobBytes.set(charId, b);
  return b;
}
