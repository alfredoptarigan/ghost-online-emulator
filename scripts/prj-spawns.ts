/**
 * Monster spawns from client data/Project/t{map}_s{region}.prj (Ghost and Soul Saver use the same record):
 *   template u32 | side i8 (1 / -1) | speed f32 | x u32 | y u32 | n u32 | n × (x u32, y u32) patrol points
 * Records follow an editor header of uninitialised bytes, so they are found by scanning and validating.
 * Record order = monster slot (m_monsterid).
 *
 *   npx tsx scripts/prj-spawns.ts <Project dir> [map/region]           print spawns
 *   npx tsx scripts/prj-spawns.ts <Project dir> --check                  diff against the monster table
 *   npx tsx scripts/prj-spawns.ts <Project dir> --import                 replace the monster table
 */
import fs from "node:fs";
import path from "node:path";

export type PrjSpawn = { template: number; side: number; speed: number; x: number; y: number; path: Array<[number, number]> };

export function parsePrj(b: Buffer): PrjSpawn[] {
  const out: PrjSpawn[] = [];
  for (let i = 0; i + 25 <= b.length; i++) {
    const t = b.readUInt32LE(i);
    if (t < 1000000 || t >= 1100000) continue;
    const side = b.readInt8(i + 4);
    const speed = b.readFloatLE(i + 5);
    const x = b.readUInt32LE(i + 9);
    const y = b.readUInt32LE(i + 13);
    const n = b.readUInt32LE(i + 17);
    if ((side !== 1 && side !== -1) || !(speed > 0.05 && speed < 30) || x > 30000 || y > 30000 || n > 64) continue;
    const end = i + 21 + 8 * n;
    if (end > b.length) continue;
    const pts: Array<[number, number]> = [];
    let ok = true;
    for (let k = 0; k < n; k++) {
      const px = b.readUInt32LE(i + 21 + 8 * k);
      const py = b.readUInt32LE(i + 25 + 8 * k);
      if (px > 30000 || py > 30000) ok = false;
      pts.push([px, py]);
    }
    if (!ok) continue;
    out.push({ template: t, side, speed, x, y, path: pts });
    i = end - 1;
  }
  return out;
}

export function readProject(dir: string): Map<string, PrjSpawn[]> {
  const res = new Map<string, PrjSpawn[]>();
  for (const f of fs.readdirSync(dir)) {
    const m = /^t(\d+)_s(\d+)\.prj$/i.exec(f);
    if (!m) continue;
    const sp = parsePrj(fs.readFileSync(path.join(dir, f)));
    if (sp.length) res.set(`${Number(m[1])}/${Number(m[2])}`, sp);
  }
  return res;
}

async function main() {
  const [dir, arg] = process.argv.slice(2);
  if (!dir) throw new Error("usage: prj-spawns.ts <Project dir> [map/region | --check | --import]");
  const all = readProject(dir);
  if (arg !== "--check" && arg !== "--import") {
    for (const [k, sp] of all) {
      if (arg && k !== arg) continue;
      console.log(`${k}: ${sp.length}`);
      if (arg) sp.forEach((s, i) => console.log(`  ${i} ${s.template} side=${s.side} speed=${s.speed} @${s.x},${s.y} path=${s.path.length}`));
    }
    console.log(`maps ${all.size}, spawns ${[...all.values()].reduce((a, s) => a + s.length, 0)}`);
    return;
  }
  const { initDb, query, execute } = await import("../src/db.js");
  await initDb();
  if (arg === "--check") {
    const rows = (await query("SELECT map, region, m_monsterid, monsterid, monsterX, monsterY FROM monster")) as any[];
    const db = new Map<string, any[]>();
    for (const r of rows) {
      const k = `${r.map}/${r.region}`;
      (db.get(k) ?? db.set(k, []).get(k)!)[Number(r.m_monsterid)] = r;
    }
    let same = 0, diff = 0;
    for (const [k, sp] of all) {
      const d = db.get(k) ?? [];
      const eq = sp.length === d.filter(Boolean).length &&
        sp.every((s, i) => d[i] && Number(d[i].monsterid) === s.template && Number(d[i].monsterX) === s.x && Number(d[i].monsterY) === s.y);
      if (eq) same++;
      else { diff++; if (diff <= 15) console.log(`diff ${k}: prj ${sp.length} db ${d.filter(Boolean).length}`); }
    }
    console.log(`prj maps ${all.size}: equal ${same}, different ${diff}; db maps ${db.size}`);
    process.exit(0);
  }
  // --import: replace every map/region present in the Project dir; keep others.
  let n = 0;
  for (const [k, sp] of all) {
    const [map, region] = k.split("/").map(Number);
    await execute("DELETE FROM monster WHERE map=? AND region=?", [map, region]);
    for (let i = 0; i < Math.min(sp.length, 50); i++) {
      const s = sp[i]!;
      await execute(
        "INSERT INTO monster (monsterid, map, region, monsterX, monsterY, m_monsterid, speed, side, health) VALUES (?,?,?,?,?,?,?,?,0)",
        [s.template, map, region, s.x, s.y, i, s.speed, s.side],
      );
      n++;
    }
  }
  console.log(`imported ${n} spawns into ${all.size} map regions`);
  process.exit(0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(new URL(import.meta.url).pathname.replace(/^\/(\w:)/, "$1"))) {
  main().catch((e) => {
    console.error(e);
    process.exit(1);
  });
}
