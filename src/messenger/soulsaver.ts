import net from "node:net";
import crypto from "node:crypto";
import type { RowDataPacket } from "mysql2";
import { fieldChecksum } from "../net/fieldCodec.js";
import { query, execute } from "../db.js";

/**
 * Soul Saver "Sect server" (CMessengerServer; official .34:15111). The login 0x3C second pair points here.
 *
 * Wire: AA 55 | len u32 | payload[len] | 55 AA
 * payload: seq u16 | flags u8 | data | chk u8   (chk = 0x56 ^ xor(payload[0..len-2]), client only logs a mismatch)
 * flags: bit0 = LZF (S>C), bit1 = encrypted (C>S): data = cipher(pkt) || crc32(cipher) (FUN_017304d0)
 * cipher = field cipher (FUN_017302c0), key = hello key ^ seed 0x2103A92C_EBD66B29.
 * pkt: op u16 @0 (u32 on the wire), body after. Client recv FUN_0164f470 -> dispatcher FUN_0164d160.
 *
 * Login (official order): S 3000 hello {op, u32 conn, key[8]} -> C 3002 {charId u32 @4, cmdline[256] @10}
 * + C 3608 -> S 3322 (0xCFA, 6×u32: op, -1×4, 0) -> C 3630. S 3322 = FUN_01647b60: sets
 * CMessengerServer+0x677AC = 1, which the faction quests 60/64 check (FUN_01271950 -> FUN_01642060,
 * "You cannot select a Faction without connecting to the Sect server first").
 * Periodic C 3004 / 3112 need no reply.
 *
 * Friends (dispatcher cases 0xE11..0xE1A):
 *   C 3600 refresh -> S 3601 list: op, count u32 @4, 50 × 36 B slots @8 — name[20], level u32 @0x14
 *     (blank if 0), sect id @0x18 (-1), channel u8 @0x1C (0xFF = offline, shown +1), job tiers u8 @0x1D..0x20
 *     (@0x1D != 0 marks a used slot), faction u8 @0x21 (0 Justice, 1 Chaos, 2 Evil Force).
 *   C 3602 /addfriend {name @2} -> target S 3602 {inviter @2} ("%s's Friend Request" dialog)
 *   C 3604 reply {u32 @4: 0 accept / 1 reject, inviter @8} -> S 3603 {u32 @4 result}: 0 added, 1 failed,
 *     2 your list full, 3 their list full, 4 not found, 5 declined, 6 not accepting requests.
 *   C 3606 delete {name @2}. S 3610 {name @2, u16 @0x16 = 0} "[Friend] %s has logged in" (client then sends 3600).
 */

const SEED_LO = 0xebd66b29;
const SEED_HI = 0x2103a92c;

const OP_HELLO = 3000;
const OP_LOGIN = 3002;
const OP_LOGIN_OK = 3322;
const OP_FRIEND_REFRESH = 3600;
const OP_FRIEND_LIST = 3601;
const OP_FRIEND_ADD = 3602;
const OP_FRIEND_RESULT = 3603;
const OP_FRIEND_REPLY = 3604;
const OP_FRIEND_DELETE = 3606;
const OP_FRIEND_LOGIN = 3610;

const MAX_FRIENDS = 50;
const SLOT = 36;
const NAME_LEN = 20;

const ADD_OK = 0;
const ADD_FAIL = 1;
const ADD_MY_FULL = 2;
const ADD_THEIR_FULL = 3;
const ADD_NOT_FOUND = 4;
const ADD_DECLINED = 5;

interface SsSession {
  sock: net.Socket;
  key: Buffer;
  seq: number;
  buf: Buffer;
  charId: number;
  name: string;
}

interface SsFriend {
  id: number;
  name: string;
  level: number;
  job: number;
  job3: number;
}

const byCharId = new Map<number, SsSession>();
/** target charId -> inviter charIds waiting for a C 3604 reply */
const pending = new Map<number, Set<number>>();

function cipher(data: Buffer, key: Buffer): Buffer {
  const out = Buffer.alloc(data.length);
  const seed = (data.length * 0x9d) & 0xff;
  let st = 0x86d;
  for (let i = 0; i < data.length; i++) {
    out[i] = key[i & 7]! ^ data[i]! ^ ((st >>> 8) & 0xff) ^ seed;
    st = Math.imul(st, 0x87b) >>> 0;
  }
  return out;
}

function lzfDecompress(src: Buffer): Buffer {
  const out: number[] = [];
  let si = 0;
  while (si < src.length) {
    const t = src[si++]!;
    if (t < 0x20) {
      for (let k = 0; k <= t && si < src.length; k++) out.push(src[si++]!);
      continue;
    }
    let n = t >>> 5;
    if (n === 7) n = src[si++]! + 7;
    let r = out.length - (((t & 0x1f) << 8) + 1 + src[si++]!);
    if (r < 0) break;
    for (let k = 0; k < n + 2; k++) out.push(out[r++]!);
  }
  return Buffer.from(out);
}

function send(s: SsSession, pkt: Buffer): void {
  const n = 3 + pkt.length + 1;
  const out = Buffer.alloc(6 + n + 2);
  out[0] = 0xaa;
  out[1] = 0x55;
  out.writeUInt32LE(n, 2);
  s.seq = (s.seq + 1) & 0xffff;
  out.writeUInt16LE(s.seq, 6);
  out[8] = 0; // plain, uncompressed
  pkt.copy(out, 9);
  let chk = 0x56;
  for (let i = 6; i < 6 + n - 1; i++) chk ^= out[i]!;
  out[6 + n - 1] = chk;
  out[6 + n] = 0x55;
  out[6 + n + 1] = 0xaa;
  try {
    s.sock.write(out);
  } catch {
    /* ignore */
  }
}

function makePkt(op: number, size: number, fill?: (b: Buffer) => void): Buffer {
  const b = Buffer.alloc(size);
  b.writeUInt32LE(op, 0);
  fill?.(b);
  return b;
}

function readName(b: Buffer, off: number): string {
  if (off >= b.length) return "";
  const end = Math.min(b.length, off + NAME_LEN);
  let z = b.indexOf(0, off);
  if (z < 0 || z > end) z = end;
  return b.toString("latin1", off, z).trim();
}

function namePkt(op: number, size: number, name: string): Buffer {
  return makePkt(op, size, (b) => b.write(name.slice(0, NAME_LEN - 1), 2, "latin1"));
}

async function loadFriendRow(where: string, arg: number | string): Promise<SsFriend | null> {
  const rows = await query<RowDataPacket[]>(
    `SELECT ID, name, level, job, job3 FROM characters WHERE ${where} LIMIT 1`,
    [arg],
  );
  const r = rows[0];
  if (!r) return null;
  return {
    id: Number(r.ID),
    name: String(r.name ?? "").trim(),
    level: Number(r.level ?? 1),
    job: Number(r.job ?? 0),
    job3: Number(r.job3 ?? -1),
  };
}

async function listFriends(charId: number): Promise<SsFriend[]> {
  const rows = await query<RowDataPacket[]>(
    `SELECT c.ID, c.name, c.level, c.job, c.job3
     FROM friends f JOIN characters c ON c.ID = f.friendid
     WHERE f.charid = ? ORDER BY c.name LIMIT ?`,
    [charId, MAX_FRIENDS],
  );
  return rows.map((r) => ({
    id: Number(r.ID),
    name: String(r.name ?? "").trim(),
    level: Number(r.level ?? 1),
    job: Number(r.job ?? 0),
    job3: Number(r.job3 ?? -1),
  }));
}

async function friendCount(charId: number): Promise<number> {
  const rows = await query<RowDataPacket[]>("SELECT COUNT(*) AS n FROM friends WHERE charid = ?", [charId]);
  return Number(rows[0]?.n ?? 0);
}

async function areFriends(a: number, b: number): Promise<boolean> {
  const rows = await query<RowDataPacket[]>(
    "SELECT 1 AS ok FROM friends WHERE charid = ? AND friendid = ? LIMIT 1",
    [a, b],
  );
  return rows.length > 0;
}

/** S 3601: empty slots match the official template (capture: `ffffffff ff 00 ffffffff`). */
function buildFriendList(friends: SsFriend[]): Buffer {
  return makePkt(OP_FRIEND_LIST, 8 + MAX_FRIENDS * SLOT, (b) => {
    b.writeUInt32LE(Math.min(friends.length, MAX_FRIENDS), 4);
    for (let i = 0; i < MAX_FRIENDS; i++) {
      const o = 8 + i * SLOT;
      const f = friends[i];
      b.writeInt32LE(-1, o + 0x18);
      b.fill(0xff, o + 0x1c, o + 0x22);
      b[o + 0x1d] = 0;
      if (!f) continue;
      b.write(f.name.slice(0, NAME_LEN - 1), o, "latin1");
      b.writeUInt32LE(Math.max(1, f.level), o + 0x14);
      if (byCharId.has(f.id)) b[o + 0x1c] = 0; // channel 1
      b[o + 0x1d] = Math.max(1, Math.min(0x7f, f.job));
      if (f.job3 >= 1 && f.job3 <= 3) b[o + 0x21] = f.job3 - 1;
    }
  });
}

function buildFriendResult(code: number): Buffer {
  return makePkt(OP_FRIEND_RESULT, 8, (b) => b.writeUInt32LE(code, 4));
}

async function pushFriendList(s: SsSession, log: (l: string) => void): Promise<void> {
  const friends = s.charId > 0 ? await listFriends(s.charId) : [];
  send(s, buildFriendList(friends));
  log(`  SS tx 3601 friend list char=${s.charId} n=${friends.length}`);
}

/** Refresh every online friend of `charId` (after login/logout/delete). */
async function refreshFriendsOf(charId: number, log: (l: string) => void): Promise<void> {
  for (const f of await listFriends(charId)) {
    const o = byCharId.get(f.id);
    if (o) await pushFriendList(o, log);
  }
}

async function handleLogin(s: SsSession, pkt: Buffer, log: (l: string) => void): Promise<void> {
  s.charId = pkt.length >= 8 ? pkt.readUInt32LE(4) : 0;
  const me = s.charId > 0 ? await loadFriendRow("ID = ?", s.charId) : null;
  s.name = me?.name ?? "";
  log(`  SS login 3002 charId=${s.charId} name="${s.name}"`);
  // 3322: op, -1 x4 (no sect), 0 — same as official/Mamluk for a character without a sect.
  send(
    s,
    makePkt(OP_LOGIN_OK, 24, (b) => {
      for (let o = 4; o < 20; o += 4) b.writeInt32LE(-1, o);
    }),
  );
  log(`  SS tx 3322 (Sect login ok)`);
  if (s.charId <= 0) return;
  const old = byCharId.get(s.charId);
  if (old && old !== s) old.sock.destroy();
  byCharId.set(s.charId, s);
  await pushFriendList(s, log);
  for (const f of await listFriends(s.charId)) {
    const o = byCharId.get(f.id);
    if (o && s.name) send(o, namePkt(OP_FRIEND_LOGIN, 24, s.name));
  }
}

async function handleFriendAdd(s: SsSession, targetName: string, log: (l: string) => void): Promise<void> {
  if (!s.charId || !targetName) return;
  const target = await loadFriendRow("name = ?", targetName);
  const other = target ? byCharId.get(target.id) : undefined;
  log(`  SS friend add ${s.name} -> "${targetName}" found=${!!target} online=${!!other}`);
  if (!target || target.id === s.charId || !other) {
    send(s, buildFriendResult(ADD_NOT_FOUND));
    return;
  }
  if (await areFriends(s.charId, target.id)) {
    send(s, buildFriendResult(ADD_OK));
    await pushFriendList(s, log);
    return;
  }
  if ((await friendCount(s.charId)) >= MAX_FRIENDS) return send(s, buildFriendResult(ADD_MY_FULL));
  if ((await friendCount(target.id)) >= MAX_FRIENDS) return send(s, buildFriendResult(ADD_THEIR_FULL));
  let set = pending.get(target.id);
  if (!set) pending.set(target.id, (set = new Set()));
  set.add(s.charId);
  send(other, namePkt(OP_FRIEND_ADD, 22, s.name));
  log(`  SS tx 3602 friend request to ${target.name}`);
}

async function handleFriendReply(s: SsSession, pkt: Buffer, log: (l: string) => void): Promise<void> {
  if (!s.charId || pkt.length < 9) return;
  const accept = pkt.readUInt32LE(4) === 0;
  const inviter = await loadFriendRow("name = ?", readName(pkt, 8));
  const set = pending.get(s.charId);
  const had = !!inviter && !!set?.delete(inviter.id);
  if (set && set.size === 0) pending.delete(s.charId);
  log(`  SS friend reply ${s.name} ${accept ? "accept" : "reject"} inviter=${inviter?.name} pending=${had}`);
  if (!inviter || !had) return;
  const other = byCharId.get(inviter.id);
  if (!accept) {
    if (other) send(other, buildFriendResult(ADD_DECLINED));
    return;
  }
  if ((await friendCount(s.charId)) >= MAX_FRIENDS || (await friendCount(inviter.id)) >= MAX_FRIENDS) {
    if (other) send(other, buildFriendResult(ADD_THEIR_FULL));
    send(s, buildFriendResult(ADD_MY_FULL));
    return;
  }
  await execute("INSERT IGNORE INTO friends (charid, friendid) VALUES (?, ?), (?, ?)", [
    s.charId,
    inviter.id,
    inviter.id,
    s.charId,
  ]);
  send(s, buildFriendResult(ADD_OK));
  await pushFriendList(s, log);
  if (other) {
    send(other, buildFriendResult(ADD_OK));
    await pushFriendList(other, log);
  }
}

async function handleFriendDelete(s: SsSession, name: string, log: (l: string) => void): Promise<void> {
  if (!s.charId) return;
  const f = await loadFriendRow("name = ?", name);
  log(`  SS friend delete ${s.name} -x- "${name}" found=${!!f}`);
  if (f) {
    await execute("DELETE FROM friends WHERE (charid = ? AND friendid = ?) OR (charid = ? AND friendid = ?)", [
      s.charId,
      f.id,
      f.id,
      s.charId,
    ]);
    const o = byCharId.get(f.id);
    if (o) await pushFriendList(o, log);
  }
  await pushFriendList(s, log);
}

async function onPacket(s: SsSession, pkt: Buffer, log: (l: string) => void): Promise<void> {
  const op = pkt.readUInt16LE(0);
  switch (op) {
    case OP_LOGIN:
      return handleLogin(s, pkt, log);
    case OP_FRIEND_REFRESH:
      return pushFriendList(s, log);
    case OP_FRIEND_ADD:
      return handleFriendAdd(s, readName(pkt, 2), log);
    case OP_FRIEND_REPLY:
      return handleFriendReply(s, pkt, log);
    case OP_FRIEND_DELETE:
      return handleFriendDelete(s, readName(pkt, 2), log);
    case 3004:
    case 3112:
    case 3608:
    case 3630:
      return;
    default:
      log(`  SS op=${op} n=${pkt.length} ${pkt.subarray(2, 34).toString("hex")}`);
  }
}

export function attachSoulSaverClient(sock: net.Socket, tag: string, log: (l: string) => void): void {
  const remote = `${sock.remoteAddress}:${sock.remotePort}`;
  log(`connect SS ${tag} from ${remote}`);
  const hello = crypto.randomBytes(8);
  const key = Buffer.from(hello);
  key.writeUInt32LE((key.readUInt32LE(0) ^ SEED_LO) >>> 0, 0);
  key.writeUInt32LE((key.readUInt32LE(4) ^ SEED_HI) >>> 0, 4);
  const s: SsSession = {
    sock,
    key,
    seq: crypto.randomInt(0x1000, 0xf000),
    buf: Buffer.alloc(0),
    charId: 0,
    name: "",
  };
  let chain = Promise.resolve();

  send(
    s,
    makePkt(OP_HELLO, 16, (b) => {
      b.writeUInt32LE(crypto.randomInt(1, 0x1000), 4);
      hello.copy(b, 8);
    }),
  );

  sock.on("data", (d) => {
    s.buf = Buffer.concat([s.buf, d]);
    while (s.buf.length >= 8) {
      if (s.buf[0] !== 0xaa || s.buf[1] !== 0x55) {
        log(`  SS bad frame start ${s.buf.subarray(0, 8).toString("hex")}`);
        s.buf = Buffer.alloc(0);
        return;
      }
      const n = s.buf.readUInt32LE(2);
      if (n < 4 || n > 0x20000) {
        log(`  SS bad frame len ${n}`);
        sock.destroy();
        return;
      }
      if (s.buf.length < 6 + n + 2) break;
      const p = s.buf.subarray(6, 6 + n);
      s.buf = s.buf.subarray(8 + n);
      const flags = p[2]!;
      let data = p.subarray(3, n - 1);
      if (flags & 2) {
        if (data.length < 4) continue;
        const body = data.subarray(0, data.length - 4);
        if (fieldChecksum(body) !== data.readUInt32LE(data.length - 4)) log(`  SS crc mismatch`);
        data = cipher(body, s.key);
      }
      if (flags & 1) data = lzfDecompress(data);
      if (data.length < 2) continue;
      const pkt = data;
      chain = chain.then(() => onPacket(s, pkt, log)).catch((e) => log(`  SS handler error: ${e}`));
    }
  });
  sock.on("error", () => undefined);
  sock.on("close", () => {
    log(`close SS ${tag} ${remote} char=${s.charId} name="${s.name}"`);
    if (s.charId <= 0 || byCharId.get(s.charId) !== s) return;
    byCharId.delete(s.charId);
    pending.delete(s.charId);
    chain = chain.then(() => refreshFriendsOf(s.charId, log)).catch((e) => log(`  SS logout refresh error: ${e}`));
  });
}

export function startSoulSaverMessenger(port: number, log: (l: string) => void): net.Server {
  const srv = net.createServer((sock) => attachSoulSaverClient(sock, `:${port}`, log));
  srv.on("error", (e) => console.warn(`[messenger] SS :${port} error`, e.message));
  srv.listen(port, "0.0.0.0", () => log(`listening 0.0.0.0:${port} (Soul Saver Sect)`));
  return srv;
}
