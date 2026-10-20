# Perintah GM dan skill GM

Semua perintah GM chat (`//...`) dan buff GM yang ada di emulator ini, dibaca langsung dari kode
(`src/field/server.ts` fungsi `runGmCommand`, plus helper di `src/field/`). Berlaku untuk client Ghost Online EN
dan Soul Saver, kecuali disebut lain.

## Syarat akun GM

- Kolom `users.gm` harus **> 0**. Akun baru yang dibuat otomatis saat login selalu `gm = 0`.
  `database/schema.sql` membuat akun `admin` / `admin` dengan `gm = 1`.
- Menjadikan akun GM (lalu logout dan login lagi, karena `gm` dibaca saat login dan saat masuk field):

  ```sql
  UPDATE users SET gm = 1 WHERE username = 'GMMASTER';
  ```

- Tidak ada level GM bertingkat di server: semua perintah hanya mengecek `gm > 0`.
- **Soul Saver:** server login mengirim level GM di LOGIN_ACK (byte ke-7, dipotong ke 0..2). Client Soul Saver hanya
  mengirim perintah `//` (COMMAND 0x10) kalau level itu 1 atau 2, jadi pakai `gm = 1` atau `gm = 2`.
- **Ghost EN:** client sering mengirim `//` lewat CHAT 0x17. Server menangkap baris chat yang diawali `//`, menjalankannya
  sebagai perintah GM, dan tidak pernah menyiarkannya sebagai chat map.

## Aturan umum

- Bentuknya `//kata argumen...`. `//` saja atau `// halo` bukan perintah. Nama perintah tidak peka huruf besar/kecil;
  argumen dipisah spasi.
- Pemain non-GM: perintah diabaikan diam-diam (hanya log `GM denied` di server).
- Perintah tak dikenal: hanya dicatat di log (`Unknown GM cmd`), tidak ada pesan di game.
- Kebanyakan perintah tidak membalas apa pun di chat. Hasilnya terlihat dari jendela karakter, tas, atau log server
  (`[field] GM ...`).
- Semua perintah bekerja pada karakter GM itu sendiri, kecuali `//notice`, `//warp <nama>` / `//gogo <nama>` dan `//ban`.

## Tabel ringkas

| Perintah | Sintaks | Efek singkat | Client |
|---|---|---|---|
| `//notice`, `//1` | `//notice <teks>` | Pengumuman ke semua pemain online | Keduanya |
| `//heal` | `//heal` | HP dan MP penuh | Keduanya |
| `//hp` | `//hp [nilai]` | Tanpa argumen: HP penuh. Dengan angka: HP dan max HP = nilai | Keduanya |
| `//mp` | `//mp [nilai]` | Tanpa argumen: MP penuh. Dengan angka: MP dan max MP = nilai | Keduanya |
| `//expevent` | `//expevent [rate]` | Lihat / set pengali EXP event global | Keduanya |
| `//money` | `//money [jumlah]` | Tambah gold (default 10000) | Keduanya |
| `//level` | `//level <1..99>` | Set level langsung | Keduanya (aturan beda di Soul Saver) |
| `//levelup` | `//levelup` | Naik 1 level | Keduanya (aturan Ghost) |
| `//warp` | `//warp <map> <region> <x> <y>` atau `//warp <nama>` | Pindah ke map/koordinat atau ke pemain | Keduanya |
| `//gogo` | `//gogo <map> <region>` atau `//gogo <nama>` | Seperti `//warp`; 2 angka = tetap di X/Y sekarang | Keduanya |
| `//job` | `//job <0..3>` | Set job pertama, hapus job ke-2/faksi dan skill lanjutan | Keduanya (logika Ghost) |
| `//job2` | `//job2 <0..2>` | Job ke-2 Order/Chaos (atau hapus) | Ghost EN |
| `//faction` | `//faction <0..2>` (Ghost) / `<0..3>` (Soul Saver) | Set faksi | Beda per client |
| `//tier` | `//tier <0..6>` | Tier job Soul Saver (`ss_class`) | Soul Saver |
| `//skills` | `//skills` | Beri semua skill job + faksi | Beda per client |
| `//maxskills` | `//maxskills` | Semua skill yang dimiliki jadi level maksimal | Keduanya |
| `//item` | `//item [itemId] [jumlah]` | Masukkan item ke tas | Keduanya |
| `//enterself` | `//enterself` | Kirim ulang ENTERPLAYER 0x1E diri sendiri (tes) | Soul Saver |
| `//wot` | `//wot` | Buka puzzle anti-macro Window of Truth sekarang | Soul Saver |
| `//ban` | `//ban <nama>` | Putuskan koneksi pemain (kick, bukan ban permanen) | Keduanya |

"Soul Saver" di tabel = hanya jalan kalau sesi memakai client Soul Saver (`p.soulSaver`). Untuk `//level`, server
mengecek kolom `characters.ss_char = 1` (karakter Soul Saver).

## Detail per perintah

### `//notice <teks>` (alias `//1`)

- Mengirim NOTICE (0x12, tipe 3) ke **semua** pemain online di field server.
- Tanpa teks: mengirim `Hello`. Teks dipotong 59 karakter.
- Contoh: `//notice Server restart 10 menit lagi`

### `//heal`

- HP = max HP, MP = max MP, disimpan ke DB (`chp`, `cmp`), lalu paket vital dikirim.
- Contoh: `//heal`

### `//hp [nilai]`

- Tanpa argumen: HP diisi penuh (MP tidak). Disimpan ke DB supaya warp berikutnya tidak memuat HP lama
  (misalnya 1 HP setelah mati).
- Dengan angka: HP **dan** max HP diset ke nilai itu (dibatasi 1..32767), disimpan ke `chp` dan `cmhp`, lalu
  CHAR_ALL dikirim ulang. Ini mengubah max HP permanen sampai statistik dihitung ulang.
- Contoh: `//hp`, `//hp 30000`

### `//mp [nilai]`

- Sama seperti `//hp`, untuk MP (`cmp`, `cmmp`).
- Contoh: `//mp`, `//mp 5000`

### `//expevent [rate]`

- Mengatur `rates.expEventRate`, pengali EXP event global (resmi: event hari Minggu = 3). Dipakai untuk EXP kill dan
  EXP hadiah (quest NPC, Quick Quest, Monster Encyclopedia).
- Nilai diterima kalau angka > 0 dan <= 100. Tanpa argumen atau nilai tidak sah: hanya menampilkan nilai sekarang.
- Membalas NOTICE ke GM: `EXP event x<rate>`.
- Hanya di memori: kembali ke `EXP_EVENT_RATE` / `rates.json` (default 1.0) setelah server restart.
- Contoh: `//expevent 3`, `//expevent`

### `//money [jumlah]`

- Menambah gold sebanyak `jumlah` (default 10000), simpan ke DB, kirim paket uang.
- Tidak ada batas atau pengecekan: angka negatif mengurangi gold. Argumen harus angka.
- Contoh: `//money 1000000`

### `//level <level>`

- Wajib angka; dibulatkan ke bawah dan dibatasi 1..99. Tanpa angka: tidak terjadi apa-apa.
- **Karakter Ghost:** level diset, EXP 0, max EXP dihitung ulang dengan kurva Ghost (`levelExpCurve`), +5 stat point dan
  +2 skill point per level yang dinaikkan (turun level tidak mengurangi poin). Kirim LEVELUP, EXP, CHAR_ALL,
  SKILL_ALL; LEVELUP juga disiarkan ke map.
- **Karakter Soul Saver** (`ss_char = 1`): sama seperti naik level asli (`ssGmLevel`): kurva `tb_Exp`, EXP 0,
  +4 stat point dan +2 skill point per level, statistik dihitung ulang dari tabel job client, HP/MP diisi penuh,
  plus hadiah naik level (jar lv10, AvatarWeapon, hadiah level-up).
- Contoh: `//level 60`

### `//levelup`

- Level +1, max EXP dikali kurva Ghost, +5 stat point, +2 skill point. Kirim LEVELUP, EXP, CHAR_ALL, SKILL_ALL.
- Memakai aturan Ghost untuk semua karakter, termasuk Soul Saver. Untuk Soul Saver lebih baik pakai `//level`.
- Contoh: `//levelup`

### `//warp` dan `//gogo`

Tiga bentuk:

1. **Ke pemain:** argumen pertama bukan angka = nama karakter (tidak peka huruf besar/kecil). GM pindah ke map, region
   dan koordinat pemain itu. Kalau pemain offline: tidak terjadi apa-apa (hanya log).
   Contoh: `//warp Budi`, `//gogo Budi`
2. **`//gogo <map> <region>`** (tepat 2 angka): pindah map, X/Y tetap posisi sekarang.
   Contoh: `//gogo 1 1`
3. **`//warp <map> <region> <x> <y>`** (atau `//gogo` dengan 1 atau 4 angka): default map 1, region 1, x 100, y 100.
   Contoh: `//warp 1 1 250 300`

Map/region yang tidak ada di data client ditolak (log `warp rejected missing map`). Koordinat dirapikan ke posisi
yang sah di map itu. Toko pribadi yang sedang buka ditutup. Posisi baru disimpan ke DB.

### `//job <0..3>`

- Set job pertama (dibatasi 0..3; 0 = belum punya job). Job ke-2 dan faksi dikosongkan (`job2`, `job3` = -1).
- Semua skill lanjutan (id >= 10000) dihapus, skill pemula dipastikan ada; jendela skill job jadi kosong.
  Pakai `//skills` sesudahnya untuk mengisi.
- Kirim ulang CHAR_ALL, SKILL_ALL, ENTERPLAYER dan avatar (juga ke map) supaya judul class berganti.
- Catatan Soul Saver: perintah ini masih logika Ghost (job 0..3 saja, tidak menyentuh `ss_class`).
- Contoh: `//job 1`

### `//job2 <0..2>` (Ghost EN)

- Butuh job pertama 1..3; kalau belum, ditolak (log saja).
- `1` = Order, `2` = Chaos (nilai > 2 dianggap 2). Job ke-2 sesuai job pertama:

  | Job pertama | `//job2 1` (Order) | `//job2 2` (Chaos) |
  |---|---|---|
  | 1 Warrior | Knight (1) | Dark Knight (2) |
  | 2 Assassin | Ninja (3) | Killer (4) |
  | 3 Mage | White Mage (5) | Black Mage (6) |

- Faksi (`job3`) ikut diset ke jalur yang sama. Skill job 1 + job 2 + faksi diberikan, skill di luar jalur dihapus.
- `0` = hapus job ke-2 dan faksi; skill job ke-2/faksi dihapus, skill job pertama tetap.
- Contoh: `//job2 2`

### `//faction`

**Ghost EN:** `//faction <0..2>`

- Butuh job pertama 1..3. `1` = Order (Force of Order), `2` = Chaos. Argumen harus angka, bukan nama.
- Sekaligus mengatur job ke-2 yang cocok (sama seperti `//job2`) dan menyinkronkan skill (termasuk buku Guild/faksi).
- `0` = hapus faksi dan job ke-2.
- Contoh: `//faction 1`

**Soul Saver:** `//faction <0..3>`

- `1` = Justice, `2` = Chaos, `3` = faksi untuk job 6..10, `0` = tanpa faksi. Nilai > 3 dianggap 3.
- Hanya mengubah `characters.job3`. Lalu byte job/judul dihitung ulang (`ssjob.ts`), statistik dihitung ulang dari
  `tb_JobGrowth`, dan tampilan karakter dikirim ulang. Skill tidak diubah: jalankan `//skills` sesudahnya.
- Cara normal di game: quest 60 (Justice) / 64 (Chaos) "Selecting Faction" di level 40.
- Contoh: `//faction 2`

### `//tier <0..6>` (Soul Saver)

- Menyimpan nilai ke `characters.ss_class` (tier job), lalu byte judul dan statistik dihitung ulang seperti
  `//faction`.
- Nilai: 0..2 = belum ada job lanjutan, 3 = 2nd Job (lv60), 5 = Rebirth, 6 = 2nd-Divine.
  Byte `job2` hanya terisi dari tier 3, `job3` dari tier 5, `job4` dari tier 6, dan semuanya butuh faksi yang cocok
  (lihat `src/field/ssjob.ts`).
- Contoh: `//faction 1` lalu `//tier 3`

### `//skills`

- **Ghost EN:** memberi semua skill untuk progres sekarang (job 1 + jalur job 2 + Guild/faksi) dan menghapus skill
  di luar progres itu (job lain, id faksi lama). Level tidak dimaksimalkan.
- **Soul Saver:** karakter memiliki tepat skill job-nya (pemilik di `skill.skl`): skill umum 1..4, buku job pertama
  (tanpa upgrade 13xxx/14xxx), dan dengan faksi (`job3` 1..3) skill 2xxxx..5xxxx faksi itu. Skill lain dihapus
  kecuali AvatarWeapon; level skill yang sudah dimiliki tetap, skill baru level 1.
- Contoh: `//skills` lalu `//maxskills`

### `//maxskills`

- Semua skill yang **sudah dimiliki** diset ke level maksimal: Ghost memakai batas `maxSkillLevel` (umumnya 20),
  Soul Saver memakai batas tabel skill Soul Saver. Tidak menambah skill baru.
- Kirim ulang SKILL_ALL dan CHAR_ALL.
- Contoh: `//maxskills`

### `//item [itemId] [jumlah]`

- Menambah item ke tas (default item 8810011 = umpan pancing, jumlah 1), lalu tas di-refresh.
- Tas penuh: tidak terjadi apa-apa (hanya log `inventory full`).
- Contoh: `//item 8871511 5`

### `//enterself` (Soul Saver)

- Hanya alat tes: mengirim ulang ENTERPLAYER 0x1E milik GM sendiri, seperti yang dikirim server resmi (Mamluk) setelah
  quest faksi. Dipakai untuk menguji dugaan crash (catatan RE bagian 23).
- Contoh: `//enterself`

### `//wot` (Soul Saver)

- Langsung membuka puzzle anti-macro "Window of Truth" (S 0x73D) untuk GM, tanpa menunggu jadwal berburu.
  Jawab dalam 60 detik. Logika di `src/field/ssantimacro.ts`; jadwal otomatis bisa dimatikan dengan `SS_ANTIMACRO=0`.
- Di client Ghost EN perintah ini tidak melakukan apa-apa.
- Contoh: `//wot`

### `//ban <nama>`

- Memutus socket pemain online dengan nama itu (kick). Tidak ada yang disimpan ke DB, jadi pemain bisa login lagi.
- Pemain offline atau tanpa nama: tidak terjadi apa-apa.
- Contoh: `//ban Budi`

## Skill / buff GM: GM Blessing (Soul Saver)

GM Blessing adalah buff event dari server resmi (capture day2_stage2, catatan RE bagian 21), diimplementasikan di
`src/field/ssservices.ts` dan `src/field/ssuse.ts` (commit c349054). Ini **bukan** perintah `//` dan **tidak** butuh
akun GM: semua pemain Soul Saver bisa memakainya.

| Item id | Nama data | Efek | Durasi |
|---|---|---|---|
| 8871511 | GMJewangsBlessing | Serangan fisik +250 (S 0x1FB) | 3600 detik |
| 8871512 | GMHolyungsBlessing | Serangan sihir +250 (S 0x1FC) | 3600 detik |
| 8871521 | GMSosBlessing | Max HP +1000 (S 0x52) | 3600 detik |
| 8871522 | GMMuyungsBlessing | Max MP +1000 (S 0x53) | 3600 detik |
| 8871531 | GMLeunsBlessing | Defense +500 (S 0x59) | 3600 detik |

Nilai dan durasi dari `data/ss_items.json` (use type 11/12/6/5/13, value, detik).

### Cara kerja dan cara memakai

1. Saat login server mengirim daftar blessing (S 0x38D) dengan tanggal selesai event = jam 05:00 berikutnya.
   Client juga bisa meminta daftar itu (C 0x38C dengan u32 -1).
2. Pemain memilih salah satu blessing di jendela GM Blessing client. Client mengirim C 0x38C (u32 99 + item id).
3. Server memasang buff item itu selama 3600 detik dan mengirim paket buff (waktu dalam 1/40 detik, jadi 144000).
   Buff disimpan di tabel `ss_item_buff`, jadi tetap jalan (sisa waktunya) setelah relog. Ikon dihapus saat habis.
4. Kalau buff di grup yang sama dengan nilai sama atau lebih tinggi sudah aktif, server membalas S 0x7D0 1074093
   "A buff at the same or a higher grade is in effect."
5. Kelima blessing berbeda grup, jadi semuanya bisa aktif bersamaan.

Catatan:

- Serangan dan defense diterapkan oleh client; server tidak menaikkan max HP/MP-nya sendiri untuk buff max HP/MP.
- Item blessing juga bisa diberikan sebagai item biasa dengan `//item 8871511` (dan seterusnya) lalu dipakai dari tas,
  karena item buff Soul Saver ditangani `ssuse.ts`.
- Ghost EN tidak punya GM Blessing (paket 0x38C hanya diproses untuk sesi Soul Saver).

## Fitur GM lain di luar chat

- **Hunting dashboard, teleport:** API `teleport` di hunting assistant (`docs/hunting-assistant.md`) hanya mau
  memindahkan karakter yang online dengan `gm > 0` (selain itu HTTP 403 "Emulator GM character required").
