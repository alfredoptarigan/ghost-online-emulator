import net from "node:net";
import { SS_DEFAULT_BODY } from "../field/soulsaver.js";
import type { RowDataPacket } from "mysql2";
import { config } from "../config.js";
import { query, execute, withConnection } from "../db.js";
import { peelGame, opcodeOf, readCString, writeCString, writeHeader, logPkt, bufToHex } from "../net/packet.js";
import { decodePassword, isMd5Hex, passwordMatches } from "../login/passwordCodec.js";

/** Game4 = 0x0105 (4 char slots / 368B); en-client = 0x0037 (2 slots / 192B). */
const DEFAULT_MAGIC = 0x0105;
const EN_CLIENT_MAGIC = 0x0037;

type Client = {
  sock: net.Socket;
  buf: Buffer;
  accountId: number;
  magic: number;
  /** Session token from request header +8; en-client echoes [0x824d10]. */
  unk: number;
  /** Soul Saver client (INET password decodes to md5 hex); uses the 1584-byte CHARSTATUS. */
  soulSaver: boolean;
};

/** Match legacy _GETACCOUNTID: C-string at +17 skips leading "INET ", then
 *  StringSplit 1-based [2]=username [4]=password → 0-based [1] and [3].
 *  Full string from +12 is "INET 1000 ADMIN 0 admin ..." (C# uses [2]/[4] on that).
 *  en-client sends encoded password; key is the numeric field after INET.
 */
function parseCredentials(pkt: Buffer): { username: string; password: string; key: number | null; raw: string } {
  const rawFrom12 = readCString(pkt, 12, 240);
  const raw = readCString(pkt, 17, 240); // legacy offset

  // Prefer full "+12" form: INET <key> <user> <flag> <pass> ...
  const full = rawFrom12.split(" ");
  if (full[0] === "INET" && full.length > 4) {
    const key = /^\d+$/.test(full[1] ?? "") ? Number(full[1]) : null;
    return { username: full[2] ?? "", password: full[4] ?? "", key, raw: rawFrom12 };
  }

  // legacy +17 form: <key> <user> <flag> <pass> ...
  const parts = raw.split(" ");
  if (parts.length > 3) {
    const key = /^\d+$/.test(parts[0] ?? "") ? Number(parts[0]) : null;
    return { username: parts[1] ?? "", password: parts[3] ?? "", key, raw };
  }

  const tok = raw.split(/\s+/).filter(Boolean);
  if (tok.length >= 4 && /^\d+$/.test(tok[0]!)) {
    return { username: tok[1] ?? "", password: tok[3] ?? "", key: Number(tok[0]), raw };
  }
  if (tok.length >= 2) {
    return { username: tok[0] ?? "", password: tok[1] ?? "", key: null, raw };
  }
  return { username: "", password: "", key: null, raw };
}

function isSoulSaverInet(pkt: Buffer): boolean {
  const { password, key } = parseCredentials(pkt);
  const plain = key != null ? decodePassword(password, key) : null;
  return plain != null && isMd5Hex(plain);
}

async function getAccountId(pkt: Buffer): Promise<number> {
  const { username, password, key } = parseCredentials(pkt);
  if (!username) return 0;
  // Soul Saver sends the username uppercased.
  const rows = await query<RowDataPacket[]>(
    "SELECT password, accountid FROM users WHERE LOWER(username) = LOWER(?)",
    [username],
  );
  if (!rows.length) {
    console.log("[channel] auth fail: unknown user");
    return 0;
  }
  const ok = passwordMatches(String(rows[0].password), password, key);
  if (!ok) {
    console.log(`[channel] auth fail: bad password for user=${username}`);
    return 0;
  }
  return Number(rows[0].accountid);
}

/** Load equipped items for many chars in one round-trip. */
async function getEquippedBatch(charIds: number[]): Promise<Map<number, Record<number, number>>> {
  const out = new Map<number, Record<number, number>>();
  for (const id of charIds) out.set(id, {});
  if (!charIds.length) return out;
  const ph = charIds.map(() => "?").join(",");
  const rows = await query<RowDataPacket[]>(
    `SELECT charid, type, pos2 FROM equip WHERE pos1 = 0 AND charid IN (${ph})`,
    charIds,
  );
  for (const r of rows) {
    const cid = Number(r.charid);
    const map = out.get(cid) ?? {};
    map[Number(r.pos2)] = Number(r.type);
    out.set(cid, map);
  }
  return out;
}

async function charStatus(accountId: number, magic = DEFAULT_MAGIC, unk = 0): Promise<Buffer> {
  const chars = await query<RowDataPacket[]>(
    "SELECT ID, name, sex, level, job, job2, job3 FROM characters WHERE userid = ? ORDER BY ID",
    [accountId],
  );
  // Game4/legacy: 4×88 + 16 = 368. en-client: 2×88 + 16 = 192 (0xC0).
  const slots = magic === EN_CLIENT_MAGIC ? 2 : 4;
  const total = 16 + slots * 88;
  const buf = Buffer.alloc(total, 0);
  writeHeader(buf, 0x0009, total, magic, unk);
  buf.writeUInt32LE(Math.min(chars.length, slots), 12);

  const n = Math.min(chars.length, slots);
  const ids = chars.slice(0, n).map((c) => Number(c.ID));
  const equips = await getEquippedBatch(ids);

  for (let i = 0; i < n; i++) {
    const c = chars[i]!;
    const base = 16 + i * 88;
    writeCString(buf, base, String(c.name ?? ""), 40);
    // sex@+40, level@+41, job@+42 relative to slot base (same in both clients)
    buf.writeUInt8(Number(c.sex ?? 0), base + 40);
    buf.writeUInt8(Number(c.level ?? 1), base + 41);
    buf.writeUInt8(Number(c.job ?? 0), base + 42);

    // +43 is a signed gate used for BOTH the select-screen bubble and class-name path:
    //   0xFF (-1) → no bubble; parchment uses basic job→Peasant/Warrior/Assassin/Magician
    //   else      → bubble on; parchment takes advanced 2nd-job names (Knight/Ninja/…)
    // +44 is NOT the DB job2 class id (1–8). Client compares it to 0/1 only:
    //   0 = Order (Knight/Ninja/White Mage/…), 1 = Chaos (Dark Knight/Killer/…)
    // Sending class id 3 here fails the name lookup and Class stays as Level's "%d".
    const job2Raw = Number(c.job2);
    const job3Raw = Number(c.job3);
    const hasJob2 = Number.isFinite(job2Raw) && job2Raw >= 1 && job2Raw <= 8;
    const hasFaction = Number.isFinite(job3Raw) && job3Raw > 0;
    if (hasJob2) {
      buf.writeUInt8(1, base + 43); // bubble + advanced class names
      // Odd class ids = Order → 0; even = Chaos → 1 (same as job3 wire guild)
      buf.writeUInt8(job2Raw % 2 === 1 ? 0 : 1, base + 44);
    } else {
      buf.writeUInt8(0xff, base + 43); // no bubble + basic class names
      buf.writeUInt8(0xff, base + 44);
    }
    // Game4 faction aura (ec1); en-client CHARSTATUS does not read +45 today.
    buf.writeUInt8(hasFaction ? 1 : 0, base + 45);

    const eq = equips.get(Number(c.ID)) ?? {};
    buf.writeUInt32LE(eq[0] ?? 0, base + 52); // weapon
    buf.writeUInt32LE(eq[1] ?? 0, base + 56); // armor
    buf.writeUInt32LE(eq[9] ?? 0, base + 60); // faceUpper
    buf.writeUInt32LE(eq[12] ?? 0, base + 64); // faceLower
    buf.writeUInt32LE(eq[6] ?? 0, base + 68); // hat
    buf.writeUInt32LE(eq[8] ?? 0, base + 72); // eye
    buf.writeUInt32LE(eq[11] ?? 0, base + 76); // clothes
    buf.writeUInt32LE(eq[4] ?? 0, base + 80); // cape
    buf.writeUInt32LE(eq[7] ?? 0, base + 84); // hair
  }
  return buf;
}

/**
 * Soul Saver CHARSTATUS (op 0x09), from an official capture (2026-10-16):
 * 16-byte header (+12 = char count), 13 slots × 120 bytes, 8-byte tail (char count u32, 1 u32).
 * Slot: name[20], title[20] ("Wanderer" for a new char), +40 slot-open flag (first 4 slots),
 * +41 sex, +42 level, +43 job, +44..+59 flags copied from the capture,
 * +60 equipment u32s in the Ghost Online order (weapon, armor, faceUpper, faceLower, hat, eye, clothes, cape, hair).
 */
const SS_SLOTS = 13;
const SS_SLOT_SIZE = 120;
const SS_OPEN_SLOTS = 4;

async function ssCharStatus(accountId: number, unk = 0): Promise<Buffer> {
  const chars = await query<RowDataPacket[]>(
    "SELECT ID, name, sex, level, job FROM characters WHERE userid = ? ORDER BY ID",
    [accountId],
  );
  const total = 16 + SS_SLOTS * SS_SLOT_SIZE + 8;
  const buf = Buffer.alloc(total, 0);
  writeHeader(buf, 0x0009, total, DEFAULT_MAGIC, unk);
  const n = Math.min(chars.length, SS_OPEN_SLOTS);
  buf.writeUInt32LE(n, 12);
  buf.writeUInt32LE(n, total - 8);
  buf.writeUInt32LE(1, total - 4);
  for (let i = 0; i < SS_OPEN_SLOTS; i++) buf.writeUInt8(1, 16 + i * SS_SLOT_SIZE + 40);

  const equips = await getEquippedBatch(chars.slice(0, n).map((c) => Number(c.ID)));
  for (let i = 0; i < n; i++) {
    const c = chars[i]!;
    const base = 16 + i * SS_SLOT_SIZE;
    writeCString(buf, base, String(c.name ?? ""), 20);
    writeCString(buf, base + 20, "Wanderer", 20);
    buf.writeUInt8(Number(c.sex ?? 0), base + 41);
    buf.writeUInt8(Number(c.level ?? 1), base + 42);
    buf.writeUInt8(Number(c.job ?? 0), base + 43);
    Buffer.from("ff0000ff000001000100010001000000", "hex").copy(buf, base + 44);
    const eq = equips.get(Number(c.ID)) ?? {};
    [0, 1, 9, 12, 6, 8, 11, 4, 7].forEach((pos, k) => buf.writeUInt32LE(eq[pos] ?? 0, base + 60 + k * 4));
    buf.writeUInt32LE(SS_DEFAULT_BODY, base + 104); // base body; 0 = invisible on select screen
    buf.writeUInt32LE(1, base + 108);
    buf.writeUInt32LE(1, base + 112);
  }
  return buf;
}

async function checkName(pkt: Buffer): Promise<boolean> {
  const name = readCString(pkt, 12, 20);
  const rows = await query<RowDataPacket[]>("SELECT ID FROM characters WHERE name = ?", [name]);
  return rows.length === 0;
}

async function createChar(accountId: number, pkt: Buffer): Promise<number> {
  const t0 = Date.now();
  const name = readCString(pkt, 12, 20);
  const sex = pkt.readUInt8(32);
  const eye = pkt.readUInt32LE(36);
  const hair = pkt.readUInt32LE(40);
  const weapon = pkt.readUInt32LE(44);
  const armor = pkt.readUInt32LE(48);
  const soul = 8510011;

  // Two remote DB round-trips total (was ~18): meta SELECT, then multi-statement inserts.
  const numChars = await withConnection(async (conn) => {
    const [metaRows] = await conn.query<RowDataPacket[]>(
      `SELECT
         (SELECT COUNT(*) FROM characters WHERE name = ?) AS name_taken,
         (SELECT COALESCE(MAX(ID),0) FROM characters) AS max_id,
         (SELECT COALESCE(MAX(equipid),0) FROM equip) AS max_eid,
         (SELECT COUNT(*) FROM characters WHERE userid = ?) AS char_count`,
      [name, accountId],
    );
    const meta = metaRows[0]!;
    if (Number(meta.name_taken) > 0) return 0;

    const charId = Number(meta.max_id) + 1;
    const eid0 = Number(meta.max_eid);
    const prevCount = Number(meta.char_count);

    await conn.query(
      `INSERT INTO characters (ID, name, userid, sex) VALUES (?,?,?,?);
       INSERT INTO equip (equipid, type, charid, pos1, pos2) VALUES
         (?,?,?,0,0),(?,?,?,0,1),(?,?,?,0,5),(?,?,?,0,7),(?,?,?,0,8);
       INSERT INTO skills (charid, skillid, points) VALUES
         (?,?,1),(?,?,1),(?,?,1),(?,?,1)`,
      [
        charId, name, accountId, sex,
        eid0 + 1, weapon, charId,
        eid0 + 2, armor, charId,
        eid0 + 3, soul, charId,
        eid0 + 4, hair, charId,
        eid0 + 5, eye, charId,
        charId, 1, charId, 2, charId, 3, charId, 4,
      ],
    );
    return prevCount + 1;
  });

  console.log(`[channel] createChar name=${name} chars=${numChars} ${Date.now() - t0}ms`);
  return numChars;
}

async function deleteChar(accountId: number, pkt: Buffer): Promise<number> {
  const slot = pkt.readUInt8(12) & 0x0f;
  const chars = await query<RowDataPacket[]>("SELECT ID FROM characters WHERE userid = ? ORDER BY ID", [accountId]);
  if (slot >= chars.length) return 0;
  const charId = Number(chars[slot]!.ID);
  await execute("DELETE FROM characters WHERE ID = ?", [charId]);
  await execute("DELETE FROM equip WHERE charid = ?", [charId]);
  await execute("DELETE FROM other WHERE charid = ?", [charId]);
  await execute("DELETE FROM spend WHERE charid = ?", [charId]);
  await execute("DELETE FROM skills WHERE charid = ?", [charId]);
  return Math.max(0, chars.length - 1);
}

function createAck(numChars: number, magic = DEFAULT_MAGIC, unk = 0): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x000b, 16, magic, unk);
  b.writeUInt8(1, 12);
  b.writeUInt8(numChars & 0xff, 13);
  return b;
}

function deleteAck(numChars: number, magic = DEFAULT_MAGIC, unk = 0): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x000f, 16, magic, unk);
  b.writeUInt32LE(numChars, 12);
  return b;
}

function nameAck(ok: boolean, magic = DEFAULT_MAGIC, unk = 0): Buffer {
  const b = Buffer.alloc(16, 0);
  writeHeader(b, 0x000d, 16, magic, unk);
  b.writeUInt32LE(ok ? 1 : 0, 12);
  return b;
}

async function handlePacket(client: Client, pkt: Buffer): Promise<void> {
  client.magic = pkt.readUInt16LE(0) || DEFAULT_MAGIC;
  client.unk = pkt.readUInt32LE(8);
  const op = opcodeOf(pkt);
  console.log(
    `[channel] pkt op=0x${op.toString(16)} magic=0x${client.magic.toString(16)} unk=${client.unk} len=${pkt.length} hex=${bufToHex(pkt.subarray(0, Math.min(64, pkt.length)))}`,
  );
  logPkt("IN", `channel op=${op.toString(16)}`, pkt);

  if (op === 0x0008) {
    // Future: age-verified channels reject via GAME_ACK status 0x1C (en-client ready; server-only).
    // PVP / Guild War (ch 10) are field/channel rules, not SERVERLIST flags — see login/server.ts.
    const aid = await getAccountId(pkt);
    client.accountId = aid;
    if (!aid) {
      console.log("[channel] login rejected — no CHARSTATUS sent");
      return;
    }
    client.soulSaver = isSoulSaverInet(pkt);
    const list = client.soulSaver ? await ssCharStatus(aid, client.unk) : await charStatus(aid, client.magic, client.unk);
    client.sock.write(list);
    console.log(
      `[channel] CHARSTATUS sent account=${aid} magic=0x${client.magic.toString(16)} bytes=${list.length} head=${bufToHex(list.subarray(0, 16))}`,
    );
    logPkt("OUT", "channel CHARSTATUS", list);
  } else if (op === 0x000b && client.soulSaver) {
    // Soul Saver sends 0x0B (01 00 00 00 01 00 00 00) on the create screen; official server echoes it.
    client.sock.write(pkt);
  } else if (op === 0x000a && client.soulSaver) {
    if (!client.accountId) return;
    // Same layout as Ghost Online plus a u32 job at +52; official server answers with CHARSTATUS.
    const n = await createChar(client.accountId, pkt);
    if (n > 0 && pkt.length >= 56) {
      await execute("UPDATE characters SET job = ? WHERE userid = ? AND name = ?", [
        pkt.readUInt32LE(52),
        client.accountId,
        readCString(pkt, 12, 20),
      ]);
    }
    console.log(`[channel] soulsaver create account=${client.accountId} chars=${n}`);
    client.sock.write(await ssCharStatus(client.accountId, client.unk));
  } else if (op === 0x000a) {
    if (!client.accountId) return;
    const t0 = Date.now();
    const n = await createChar(client.accountId, pkt);
    // legacy: only 0x000b on success — no CHARSTATUS. Client enters UI mode 0x1B
    // (create→select jump cinematic); an immediate 0x0009 forces mode 0x0B and skips it.
    if (n > 0) {
      client.sock.write(createAck(n, client.magic, client.unk));
      console.log(`[channel] createAck account=${client.accountId} chars=${n} ${Date.now() - t0}ms`);
    } else {
      console.log(`[channel] create failed account=${client.accountId} ${Date.now() - t0}ms`);
    }
  } else if (op === 0x000e) {
    if (!client.accountId) return;
    const n = await deleteChar(client.accountId, pkt);
    // legacy: deleteAck only (no CHARSTATUS)
    client.sock.write(deleteAck(n, client.magic, client.unk));
  } else if (op === 0x000c) {
    const ok = await checkName(pkt);
    client.sock.write(nameAck(ok, client.magic, client.unk));
  }
}

export function startChannelServer(): net.Server {
  const server = net.createServer((sock) => {
    const client: Client = { sock, buf: Buffer.alloc(0), accountId: 0, magic: DEFAULT_MAGIC, unk: 0, soulSaver: false };
    console.log("[channel] connect from", sock.remoteAddress, sock.remotePort);

    sock.on("data", async (chunk) => {
      console.log(`[channel] raw +${chunk.length}B ${bufToHex(chunk.subarray(0, Math.min(48, chunk.length)))}`);
      client.buf = Buffer.concat([client.buf, chunk]);
      const { frames, rest } = peelGame(client.buf);
      client.buf = rest;
      if (!frames.length && client.buf.length >= 12) {
        console.log(
          `[channel] buffered ${client.buf.length}B waiting (lenField=${client.buf.readUInt16LE(4)})`,
        );
      }
      for (const pkt of frames) {
        try {
          await handlePacket(client, pkt);
        } catch (e) {
          console.error("[channel] error", e);
        }
      }
    });

    sock.on("close", () => console.log("[channel] disconnect"));
    sock.on("error", (e) => console.log("[channel] sock err", e.message));
  });

  server.listen(config.channelPort, config.channelHost, () => {
    console.log(`[channel] listening ${config.channelHost}:${config.channelPort}`);
  });
  return server;
}
