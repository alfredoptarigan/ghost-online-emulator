import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import { config, rates } from "../config.js";
import { query, execute } from "../db.js";
import { frameAA55, peelAA55, hexToBuf, logPkt, bufToHex } from "../net/packet.js";
import { getOnlineCount } from "../net/online.js";
import { decodePassword, isMd5Hex, passwordMatches, readPasswordKey } from "./passwordCodec.js";
import type { RowDataPacket } from "mysql2";

const VALIDPAS = hexToBuf("AA550500310000E80355AA");
const INVALIDPAS = hexToBuf("AA550500310D00000055AA");
/** Soul Saver LOGIN_ACK as sent by the official server (15-byte payload; fields after status unknown). */
const SS_VALIDPAS = hexToBuf("AA550F0031000000008023000000000000000055AA");

/**
 * Soul Saver LOGIN_ACK payload: 31 | status | cyber-cafe | GM level | ... The client only sends "//" chat
 * commands (COMMAND 0x10) when the GM level byte (stored at 0x19d58f0) is 1 or 2.
 */
function ssLoginAck(gm: number): Buffer {
  const out = Buffer.from(SS_VALIDPAS);
  out[7] = Math.max(0, Math.min(2, gm | 0));
  return out;
}

/** Redirect client to field 127.0.0.1:15023 */
const LPACKET = hexToBuf(
  "AA551800350009003132372E302E302E31AF3A000000005F003B000055AA",
);

function hexLE32(n: number): string {
  const v = n >>> 0;
  return (
    (v & 0xff).toString(16).padStart(2, "0") +
    ((v >> 8) & 0xff).toString(16).padStart(2, "0") +
    ((v >> 16) & 0xff).toString(16).padStart(2, "0") +
    ((v >> 24) & 0xff).toString(16).padStart(2, "0")
  ).toUpperCase();
}

/**
 * SERVERLIST_ACK (opcode 0x33) — future channel/server feature notes (server-only; en-client already supports):
 *
 * Per-entry layout after IP: port u16, unk u16, count u32, maxPlayers u32, b u32 (=12 stock),
 * c u32 (=0 stock), **flag u8**, udpPort u32. Client stores flag at channel-object +0x2C.
 *
 * Stock list `u8` flag values (str1_base.hex) — NOT a PVP/18+ bitfield:
 *   1 = normal/live (ch 1–12), 2 = special/test-style (ch 13–16), 0 = hidden/disabled (ch 17–18).
 *
 * Features that are NOT this list byte (client-ready; wire from server when implementing):
 *   - 18+ / age-verified: UI badge `static_server_recommend`; reject with GAME_ACK status **0x1C**
 *     ("This is a age-verified channel. Please select other channels.").
 *   - PVP: gameplay / "PVP channel" rules — not a SERVERLIST flag.
 *   - Guild War: client expects **channel 10**; Forces War is a separate event flow.
 *   - Worlds / TEST tabs: btn_server1..8, btn_tserver1 — client UI grouping of list entries.
 *
 * LOGIN_ACK (0x31) statuses (account, not channel type): 0=ok (+Cyber Cafe if byte2=1),
 * 7–0xC freezes, 0xD bad ID, 0xE bad password, 0x1D hacking 1h ban.
 * GAME_ACK: 0=ok, 4=already logged in, 0x1C=age-verified reject.
 */
/** Build private-server channel list: channel 1 -> 127.0.0.1:15013 */
function buildServerList(): Buffer {
  const ip = "127.0.0.1";
  const ipBuf = Buffer.from(ip, "ascii");
  const count = getOnlineCount();
  // payload after AA55 length field
  // opcode 0x0033 + header junk + one channel entry (and pad zeros for client)
  const entrySize = 2 + 2 + 2 + ipBuf.length + 2 + 2 + 4 + 4 + 4 + 4 + 1 + 4;
  // Keep similar structure to stock: header 28 bytes then entries
  const header = Buffer.alloc(28, 0);
  header.writeUInt16LE(0x0033, 0);
  // stock junk
  Buffer.from("D0CFCFCFCFCFCFCFCFCFCFCF", "hex").copy(header, 2);
  header.writeUInt16LE(1, 14); // something
  header.writeUInt16LE(0, 16);
  header.writeUInt16LE(1, 18);
  header.writeUInt16LE(0, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt16LE(0, 24);
  header.writeUInt16LE(1, 26);

  const entry = Buffer.alloc(entrySize, 0);
  let o = 0;
  entry.writeUInt16LE(1, o); o += 2; // channelIdA
  entry.writeUInt16LE(1, o); o += 2; // channelIdB
  entry.writeUInt16LE(ipBuf.length, o); o += 2;
  ipBuf.copy(entry, o); o += ipBuf.length;
  entry.writeUInt16LE(config.channelPort, o); o += 2; // 15013
  entry.writeUInt16LE(0, o); o += 2;
  entry.writeUInt32LE(count, o); o += 4;
  entry.writeUInt32LE(800, o); o += 4;
  entry.writeUInt32LE(12, o); o += 4;
  entry.writeUInt32LE(0, o); o += 4;
  entry.writeUInt8(1, o); o += 1; // list flag: stock 0/1/2 only (see block comment above)
  entry.writeUInt32LE(config.udpPort, o); o += 4; // 13997

  // Also try loading stock template and patching FEEDFACE if present (compat)
  try {
    const stockPath = path.join(config.rootDir, "src", "data", "str1_base.hex");
    if (fs.existsSync(stockPath)) {
      let hex = fs.readFileSync(stockPath, "utf8").trim();
      hex = hex.replace(/FEEDFACE/gi, hexLE32(count));
      // Prefer custom PS list for channel 1 IP — still send stock for client that expects many channels
      const stock = Buffer.from(hex, "hex");
      // Patch channel-1 current players already done; also patch first IP region if possible
      return frameAA55(stock.subarray(4, stock.length - 2)); // stock file is full AA55 frame without? 
      // str1_base.hex is FULL frame including AA55...55AA from legacy 0x string (no AA55 wrapper in hex - includes AA55)
      // Actually hex starts with AA553803... so it's full frame. Return as-is.
    }
  } catch {
    /* fall through */
  }

  const payload = Buffer.concat([header, entry]);
  return frameAA55(payload);
}

function serverListPacket(): Buffer {
  // Use stock template with online count patched — Game4 expects full multi-channel layout
  try {
    const stockPath = path.join(config.rootDir, "src", "data", "str1_base.hex");
    let hex = fs.readFileSync(stockPath, "utf8").trim();
    hex = hex.replace(/FEEDFACE/gi, hexLE32(getOnlineCount()));
    const full = Buffer.from(hex, "hex");
    const ip = "127.0.0.1";
    // Patch EVERY channel entry IP -> 127.0.0.1 (padded) and port -> channelPort
    if (full.length > 50 && full[0] === 0xaa) {
      let off = 28; // first entry
      while (off + 8 < full.length - 2) {
        const idA = full.readUInt16LE(off);
        const idB = full.readUInt16LE(off + 2);
        const ipLen = full.readUInt16LE(off + 4);
        if (ipLen < 7 || ipLen > 64 || off + 6 + ipLen + 2 > full.length) break;
        const padded = Buffer.alloc(ipLen, 0);
        Buffer.from(ip, "ascii").copy(padded);
        padded.copy(full, off + 6);
        const portOff = off + 6 + ipLen;
        full.writeUInt16LE(config.channelPort, portOff);
        // Entry: idA u16, idB u16, ipLen u16, ip[ipLen], port u16, unk u16, count u32,
        //        a u32, b u32, c u32, flag u8 (0/1/2), udpPort u32  => ipLen+31
        // (flag left as stock; see buildServerList block comment for 18+/PVP/war notes)
        const stride = ipLen + 31;
        if (idA === 0 && idB === 0) break;
        off += stride;
        if (off + 20 >= full.length - 2) break;
      }
      return full;
    }
    return full;
  } catch {
    return buildServerList();
  }
}

/** `soulSaver` is true when the client sent md5(password); only the Soul Saver client does that. */
async function checkUser(frame: Buffer): Promise<{ ok: boolean; soulSaver: boolean; gm: number }> {
  // frame includes AA55 header; username at +5 len, +7 name (same as legacy on full packet)
  // Password on the wire is client-encoded; key is u16 LE immediately after password bytes.
  const fail = { ok: false, soulSaver: false, gm: 0 };
  if (frame.length < 10) return fail;
  const uLen = frame[5] ?? 0;
  if (frame.length < 7 + uLen + 1) return fail;
  const username = frame.subarray(7, 7 + uLen).toString("ascii");
  const pLen = frame[7 + uLen] ?? 0;
  const pOff = 7 + uLen + 2;
  if (frame.length < pOff + pLen) return fail;
  const wirePass = frame.subarray(pOff, pOff + pLen).toString("ascii");
  const key = readPasswordKey(frame, pOff, pLen);
  const plainFromWire = key != null ? decodePassword(wirePass, key) : null;
  const soulSaver = plainFromWire != null && isMd5Hex(plainFromWire);

  // Soul Saver sends the username uppercased; Ghost Online sends it as typed.
  const rows = await query<RowDataPacket[]>("SELECT password, gm FROM users WHERE LOWER(username) = LOWER(?)", [
    username,
  ]);
  if (!rows.length) {
    // Prefer storing decoded plaintext so later logins (new key each time) still work.
    const toStore = plainFromWire ?? wirePass;
    const maxRows = await query<RowDataPacket[]>("SELECT COALESCE(MAX(accountid),0) AS m FROM users");
    const next = Number(maxRows[0]?.m ?? 0) + 1;
    await execute("INSERT INTO users (accountid, username, password, gm, game_points) VALUES (?,?,?,?,?)", [
      next,
      username,
      toStore,
      0,
      rates.defaultGamePoints,
    ]);
    console.log(`[login] created user ${username}`);
    return { ok: true, soulSaver, gm: 0 };
  }
  const ok = passwordMatches(String(rows[0].password), wirePass, key);
  if (!ok) {
    console.log(`[login] bad password for ${username}`);
  }
  return { ok, soulSaver, gm: Number(rows[0].gm ?? 0) };
}

/**
 * Soul Saver login-stage packets (from a capture of the official server, 2026-10-15).
 * Channel entry layout is identical to Ghost Online; the list header differs.
 */
function ssString(s: string): Buffer {
  const b = Buffer.alloc(2 + s.length);
  b.writeUInt16LE(s.length, 0);
  b.write(s, 2, "ascii");
  return b;
}

/** SERVERLIST_ACK (0x33): official header, 18 entries (8 live, 10 disabled like the official list). */
function ssServerListPacket(): Buffer {
  const header = Buffer.from("33ffffffffffffffffffffffffff01000000000012000000", "hex");
  const entries: Buffer[] = [];
  for (let ch = 1; ch <= 18; ch++) {
    const live = ch <= 8;
    const ip = ssString("127.0.0.1");
    const tail = Buffer.alloc(25, 0);
    // Official list port equals the 0x35 redirect port, i.e. the field server.
    tail.writeUInt16LE(live ? config.ssFieldPort : 0, 0);
    tail.writeUInt32LE(live && ch === 1 ? getOnlineCount() : 0, 4);
    tail.writeUInt32LE(ch <= 12 ? (live ? 300 : 400) : 100, 8);
    tail.writeUInt32LE(12, 12);
    tail.writeUInt8(live ? 1 : ch <= 12 ? 0 : 2, 20);
    tail.writeUInt32LE(live ? config.udpPort : 0, 21);
    const id = Buffer.alloc(4);
    id.writeUInt16LE(ch, 0);
    id.writeUInt16LE(ch, 2);
    entries.push(id, ip, tail);
  }
  return frameAA55(Buffer.concat([header, ...entries]));
}

/**
 * 0x3B -> 0x3C: two server ip/port string pairs (official ports 15011 / 15111).
 * The client sends "INET <key> <user> ..." (op 0x08) to the first pair: that is the channel
 * (character select) server. The second pair is presumably the messenger.
 */
function ssServerAddrPacket(): Buffer {
  return frameAA55(
    Buffer.concat([
      Buffer.from([0x3c]),
      ssString("127.0.0.1"),
      ssString(String(config.channelPort)),
      ssString("127.0.0.1"),
      ssString(String(config.messengerPort)),
    ]),
  );
}

/** 0x34 (channel select) -> 0x35: status u8, ip, field tcp port u16, unk u16, udp port u32. */
function ssChannelRedirectPacket(): Buffer {
  const tail = Buffer.alloc(8, 0);
  tail.writeUInt16LE(config.ssFieldPort, 0);
  tail.writeUInt32LE(config.udpPort, 4);
  return frameAA55(Buffer.concat([Buffer.from([0x35, 0x00]), ssString("127.0.0.1"), tail]));
}

type Client = { sock: net.Socket; buf: Buffer; authed: boolean; soulSaver: boolean; id: number };

export function startLoginServer(): net.Server {
  let nextId = 1;
  const clients = new Map<net.Socket, Client>();

  const server = net.createServer((sock) => {
    const client: Client = { sock, buf: Buffer.alloc(0), authed: false, soulSaver: false, id: nextId++ };
    clients.set(sock, client);
    console.log(`[login] connect #${client.id}`);

    sock.on("data", async (chunk) => {
      client.buf = Buffer.concat([client.buf, chunk]);
      const { frames, rest } = peelAA55(client.buf);
      client.buf = rest;
      for (const frame of frames) {
        logPkt("IN", `login#${client.id}`, frame);
        try {
          if (client.authed && client.soulSaver) {
            // Soul Saver: dispatch on the opcode byte; the server only answers requests.
            const op = frame[4];
            const out =
              op === 0x32 ? ssServerListPacket()
              : op === 0x3b ? ssServerAddrPacket()
              : op === 0x34 ? ssChannelRedirectPacket()
              : null;
            console.log(`[login] #${client.id} soulsaver op=0x${(op ?? 0).toString(16)} len=${frame.length}`);
            if (out) {
              sock.write(out);
              logPkt("OUT", `login#${client.id} ss`, out);
            }
            continue;
          }
          if (!client.authed) {
            const { ok, soulSaver, gm } = await checkUser(frame);
            const out = ok ? (soulSaver ? ssLoginAck(gm) : VALIDPAS) : INVALIDPAS;
            sock.write(out);
            logPkt("OUT", `login#${client.id}`, out);
            if (ok && soulSaver) {
              // Official server sends nothing more; the client asks for the list with 0x32.
              client.authed = true;
              client.soulSaver = true;
              console.log(`[login] #${client.id} auth ok (soulsaver)`);
              continue;
            }
            if (ok) {
              client.authed = true;
              // en-client expects a channel list right after auth; don't wait for AA550100.
              const list = serverListPacket();
              sock.write(list);
              logPkt("OUT", `login#${client.id} list-after-auth`, list);
              console.log(`[login] #${client.id} auth ok → sent channel list`);
            }
          }
          // opcode discriminator from legacy StringLeft 10 of hex "0xAA55...."
          const head = "0x" + bufToHex(frame.subarray(0, 4));
          console.log(`[login] #${client.id} frame head=${head} len=${frame.length} authed=${client.authed}`);
          // legacy matched StringLeft hex "0xAA550100" / "0xAA550500" (bytes AA 55 | len_lo len_hi)
          if (frame[0] === 0xaa && frame[1] === 0x55) {
            if (frame[2] === 0x01 && frame[3] === 0x00) {
              const list = serverListPacket();
              sock.write(list);
              logPkt("OUT", `login#${client.id} list`, list);
              console.log(`[login] #${client.id} list-request → sent channel list`);
            } else if (frame[2] === 0x05 && frame[3] === 0x00 && client.authed) {
              // Only treat as field redirect when already authed (avoid colliding with VALIDPAS-sized frames)
              sock.write(LPACKET);
              logPkt("OUT", `login#${client.id} field`, LPACKET);
            }
          }
        } catch (e) {
          console.error("[login] handler error", e);
        }
      }
    });

    const refresh = setInterval(() => {
      if (!client.authed || client.soulSaver || sock.destroyed) return;
      try {
        sock.write(serverListPacket());
      } catch {
        /* ignore */
      }
    }, 8000);

    sock.on("close", () => {
      clearInterval(refresh);
      clients.delete(sock);
    });
    sock.on("error", () => {
      clearInterval(refresh);
      clients.delete(sock);
    });
  });

  server.listen(config.loginPort, config.loginHost, () => {
    console.log(`[login] listening ${config.loginHost}:${config.loginPort}`);
  });
  return server;
}
