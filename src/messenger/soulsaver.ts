import net from "node:net";
import crypto from "node:crypto";
import { fieldChecksum } from "../net/fieldCodec.js";

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
 */

const SEED_LO = 0xebd66b29;
const SEED_HI = 0x2103a92c;

const OP_HELLO = 3000;
const OP_LOGIN = 3002;
const OP_LOGIN_OK = 3322;

interface SsSession {
  sock: net.Socket;
  key: Buffer;
  seq: number;
  buf: Buffer;
  charId: number;
}

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

function onPacket(s: SsSession, pkt: Buffer, log: (l: string) => void): void {
  const op = pkt.readUInt16LE(0);
  if (op === OP_LOGIN) {
    s.charId = pkt.length >= 8 ? pkt.readUInt32LE(4) : 0;
    log(`  SS login 3002 charId=${s.charId}`);
    // 3322: op, -1 x4 (no sect), 0 — same as official/Mamluk for a character without a sect.
    send(
      s,
      makePkt(OP_LOGIN_OK, 24, (b) => {
        for (let o = 4; o < 20; o += 4) b.writeInt32LE(-1, o);
      }),
    );
    log(`  SS tx 3322 (Sect login ok)`);
    return;
  }
  log(`  SS op=${op} n=${pkt.length} ${pkt.subarray(2, 34).toString("hex")}`);
}

export function attachSoulSaverClient(sock: net.Socket, tag: string, log: (l: string) => void): void {
  const remote = `${sock.remoteAddress}:${sock.remotePort}`;
  log(`connect SS ${tag} from ${remote}`);
  const hello = crypto.randomBytes(8);
  const key = Buffer.from(hello);
  key.writeUInt32LE((key.readUInt32LE(0) ^ SEED_LO) >>> 0, 0);
  key.writeUInt32LE((key.readUInt32LE(4) ^ SEED_HI) >>> 0, 4);
  const s: SsSession = { sock, key, seq: crypto.randomInt(0x1000, 0xf000), buf: Buffer.alloc(0), charId: 0 };

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
      try {
        onPacket(s, data, log);
      } catch (e) {
        log(`  SS handler error: ${e}`);
      }
    }
  });
  sock.on("error", () => undefined);
  sock.on("close", () => log(`close SS ${tag} ${remote} char=${s.charId}`));
}

export function startSoulSaverMessenger(port: number, log: (l: string) => void): net.Server {
  const srv = net.createServer((sock) => attachSoulSaverClient(sock, `:${port}`, log));
  srv.on("error", (e) => console.warn(`[messenger] SS :${port} error`, e.message));
  srv.listen(port, "0.0.0.0", () => log(`listening 0.0.0.0:${port} (Soul Saver Sect)`));
  return srv;
}
