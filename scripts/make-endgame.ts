/**
 * Promote an existing character to endgame: Lv 99, 2nd job + faction, all skills maxed.
 *
 *   npx tsx scripts/make-endgame.ts <charName> [job 1|2|3] [path 1|2]
 *     job:  1 Warrior, 2 Assassin, 3 Mage            (default 1)
 *     path: 1 Order (Knight/Ninja/White Mage), 2 Chaos (default 1)
 *
 * Run while the character is logged out (field server caches the live player).
 */
import type { RowDataPacket } from "mysql2";
import { initDb, query, execute, getPool } from "../src/db.js";
import { rates } from "../src/config.js";
import { job2ClassId, job2ClassName, syncJobSkills, maxAllSkills } from "../src/field/skills.js";

const [name, jobArg = "1", pathArg = "1"] = process.argv.slice(2);
if (!name) {
  console.error("usage: npx tsx scripts/make-endgame.ts <charName> [job 1|2|3] [path 1|2]");
  process.exit(1);
}
const job = Math.min(3, Math.max(1, Number(jobArg) | 0));
const path = Number(pathArg) === 2 ? 2 : 1;
const level = 99;

await initDb();
const rows = await query<RowDataPacket[]>("SELECT ID FROM characters WHERE name = ?", [name]);
if (!rows.length) {
  console.error(`character not found: ${name}`);
  process.exit(1);
}
const charId = Number(rows[0]!.ID);
const job2 = job2ClassId(job, path);

let mexp = 30;
for (let lv = 1; lv < level; lv++) mexp = Math.floor(mexp * rates.levelExpCurve);

// Same point grants as //level (5 stat + 2 skill per level) plus the 40 from a job change.
await execute(
  `UPDATE characters SET level=?, mexp=?, exp=0, job=?, job2=?, job3=?,
     str=3, dex=3, vit=3, intel=3, st_point=?, sk_point=?, money=GREATEST(money, 100000000)
   WHERE ID=?`,
  [level, mexp, job, job2, path, (level - 1) * 5 + 40, (level - 1) * 2, charId],
);
await syncJobSkills(charId, job, job2, path);
const maxed = await maxAllSkills(charId);

console.log(`${name} (id=${charId}) -> Lv ${level} ${job2ClassName(job2)}, faction=${path}, ${maxed} skills maxed`);
await getPool().end();
