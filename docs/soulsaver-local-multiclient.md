# Soul Saver: membuka dua client lokal (tanpa XIGNCODE)

Hanya untuk tes lokal ke emulator ini. **Jangan dipakai di server resmi, dan jangan ikut paket rilis.**

## Cara cepat

```bash
powershell -ExecutionPolicy Bypass -File "D:\Client Ghost Online\re-tools\multiclient.ps1"
```

Setiap kali dijalankan, script ini membuka satu window `Game.exe` baru. Untuk dua window, jalankan dua kali.
`-NoStart` hanya menutup mutex tanpa membuka client baru.

## Cara kerjanya

Ada dua penghalang, dan keduanya dilewati tanpa patch file game:

1. **XIGNCODE3** (proses `xxd-0.xem`) memblokir client kedua dengan
   "Security Error, Code: E0191014, Blocked due to the game client being run multiple times."
   `Game.exe` punya **mode developer bawaan**: kalau argumen ke-5 = `TEST`, parser command line `FUN_0110f000`
   menyetel flag `DAT_039c143c`. Karena flag itu, `FUN_0160f720` melewati init XIGNCODE (`FUN_01121bc0`).
   Jadi client dibuka dengan:

   ```
   Game.exe GSP 127.0.0.1 15001 2026092201 TEST
   ```

   (working directory `D:\MgameGSP\SoulSaverOnline`). **Semua** client yang jalan harus dibuka dengan `TEST`.
   Client tanpa `TEST` tetap menjalankan XIGNCODE dan akan memblokir client lain.

2. **Mutex `SoulSaver`**: `Game.exe` memanggil `CreateMutexA(0, 1, "SoulSaver")` (`FUN_01111200`). Kalau mutex itu
   sudah ada, game keluar dengan pesan "The game is already running." Script mencari handle mutex
   `\SoulSaver` di setiap `Game.exe` yang sedang jalan (`NtQuerySystemInformation` +
   `DuplicateHandle(..., DUPLICATE_CLOSE_SOURCE)`), menutupnya, lalu membuka client baru.

## Aturan

- Pakai hanya dengan emulator lokal (127.0.0.1). Client resmi tetap memakai launcher `SoulSaver.exe` dengan
  XIGNCODE aktif. Jangan pakai mode `TEST`, memscan, atau tool lain ke server resmi.
- Rilis untuk teman-teman harus tetap satu window per PC: jangan kirim `multiclient.ps1`, jangan buka dengan
  `TEST`, dan jangan hapus atau patch cek mutex.
- Detail RE lengkap: `D:\Client Ghost Online\SOULSAVER_RE_NOTES.md` (bagian "Dua client sekaligus").
