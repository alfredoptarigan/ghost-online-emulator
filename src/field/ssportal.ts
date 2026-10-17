/**
 * Soul Saver teleport items (item.itm use type 14). The item data has no destination, only the description
 * ("Sends you to Chaste Hall"), so the towns are matched by name to tb_Map (data/ss_maps.json maps) and the
 * landing spot is the worldmapdata.etb target X/Y of that map (columns K/L), or the middle of the map snapped to
 * the ground when the table has none. Which region of a multi-region town the official server uses is not known:
 * the first town region is used.
 *   - Portals 8850021..8850171: fixed town.
 *   - ReturnScroll 8849003, TownScroll 8850011, CheerfulBlackNoodle 8890201: the town of the current world area
 *     (worldmapdata column C). This server has no save point, so "back to your save point" also goes there.
 *   - TeleportScroll 8849036 ("return to your save point while it lasts", timed cash item): same, not consumed.
 *   - TrackingScroll 8849008, WhiteChocolate 8890183, SourCandy 8890193 (move to a character) and Dream's Flower
 *     8850161 (hiding place in Fantasy Jagged Lady): destination unknown, not implemented.
 */
import fs from "node:fs";
import path from "node:path";
import { config } from "../config.js";
import { mapWidthPx, snapMonsterY } from "./pex.js";

const PORTALS: Record<number, [number, number]> = {
  8850021: [1, 1], // ChasteHallPortal → ChasteHall
  8850031: [15, 1], // DragonCastlePortal → DragonCastle(E)
  8850041: [10, 1], // DuskCastlePortal → DuskCastle(E)
  8850051: [25, 1], // HermitTownPortal → HermitTown(S)
  8850061: [16, 1], // LakePortal → NamelessLake
  8850071: [12, 1], // DragonTavernPortal → DragonTavern
  8850081: [42, 2], // HanyaPortal → Hanyaville(S)
  8850091: [46, 1], // HauntvillePortal → Hauntville(N)
  8850101: [39, 1], // TavernConchPortal → TavernConch
  8850111: [50, 1], // ZephyrHallPortal → ZephyrHall(S)
  8850121: [53, 1], // EvergreenPalacePortal → EvergreenPalace(E)
  8850131: [27, 1], // BuddhaTownPortal → BuddhaTown
  8850141: [18, 13], // TowerofFatePortal → TowerofFate ("by the entrance")
  8850151: [57, 3], // AngoraTownPortal → AngoraPalace ("Sends you to Angora Palace")
  8850171: [67, 1], // HangingGardenPortal → UpperHangingGarden
};

/** Return-to-town items; the value says whether the item is spent. */
const RETURNS: Record<number, boolean> = { 8849003: true, 8850011: true, 8890201: true, 8849036: false };

/** Town of each worldmapdata world area (column C). */
const AREA_TOWN: Record<number, [number, number]> = {
  0: [1, 1],
  1: [10, 1],
  2: [15, 1],
  5: [25, 1],
  6: [27, 1],
  7: [39, 1],
  8: [42, 2],
  9: [46, 1],
  10: [50, 1],
  12: [53, 1],
  13: [57, 1],
  15: [67, 1],
};

type WorldRow = (string | number)[];
let world: { area: Map<number, number>; target: Map<string, [number, number]> } | null = null;

function worldmap() {
  if (world) return world;
  world = { area: new Map(), target: new Map() };
  try {
    const rows: WorldRow[] = JSON.parse(fs.readFileSync(path.join(config.dataDir, "ss_maps.json"), "utf8")).worldmap ?? [];
    for (const r of rows) {
      const area = Number(r[2]);
      const map = Number(r[8]);
      const region = Number(r[9]);
      if (map !== 99 && !world.area.has(map)) world.area.set(map, area);
      const x = Number(r[10]);
      const y = Number(r[11]);
      if (x > 0 && y > 0 && !world.target.has(`${map}/${region}`)) world.target.set(`${map}/${region}`, [x, y]);
    }
  } catch {
    /* no table: fall back to the map middle */
  }
  return world;
}

/** Landing spot in a map: the world map target, or the middle of the map on the ground. */
export function landingSpot(map: number, region: number): { x: number; y: number } {
  const t = worldmap().target.get(`${map}/${region}`);
  if (t) return { x: t[0], y: snapMonsterY(map, region, t[0], t[1]) };
  const x = Math.floor(mapWidthPx(map, region) / 2);
  return { x, y: snapMonsterY(map, region, x, 0) };
}

export type PortalUse = { map: number; region: number; x: number; y: number; consume: boolean } | { unknown: true };

/** Destination of a teleport item (null when the item is not use type 14). */
export function ssPortal(itemId: number, curMap: number, fallbackTown: number): PortalUse | null {
  const fixed = PORTALS[itemId];
  if (fixed) return { map: fixed[0], region: fixed[1], ...landingSpot(fixed[0], fixed[1]), consume: true };
  if (itemId in RETURNS) {
    const area = worldmap().area.get(curMap);
    const [map, region] = (area !== undefined && AREA_TOWN[area]) || [fallbackTown, 1];
    return { map, region, ...landingSpot(map, region), consume: RETURNS[itemId]! };
  }
  if ([8849008, 8890183, 8890193, 8850161].includes(itemId)) return { unknown: true };
  return null;
}
