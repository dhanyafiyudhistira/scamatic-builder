# Runbook rotasi connector master key di Windows

Dokumen ini adalah prosedur operasional untuk merotasi
`SCADA_CONNECTOR_MASTER_KEY` pada instalasi SCAMATIC Builder Local. Rotasi
mengganti key yang membungkus data key milik Data Source dan Chart storage;
credential aslinya tidak ditampilkan atau ditulis ulang sebagai plaintext.

Jangan mengganti primary key secara langsung lalu menghapus key lama. Database
yang sudah berisi encrypted secret harus tetap dapat membuka semua record selama
proses rotasi.

## Kapan prosedur ini digunakan

Lakukan rotasi ketika key diduga terekspos, kebijakan keamanan mewajibkan
pergantian berkala, atau endpoint compatibility melaporkan record masih dibungkus
oleh previous key. Rotasi tidak diperlukan pada instalasi baru yang belum
memiliki encrypted secret.

Arti status compatibility:

- `compatible`: seluruh record dapat dibuka memakai primary key dan tidak perlu
  dirotasi.
- `rotation-required`: seluruh record masih dapat dibuka, tetapi satu atau lebih
  record belum dibungkus oleh primary key saat ini.
- `incompatible`: satu atau lebih record tidak dapat dibuka oleh key ring yang
  dikonfigurasi. Jangan menjalankan `--apply` sampai key yang benar tersedia.
- `empty`: belum ada encrypted record yang perlu diperiksa.

## Prasyarat dan pengamanan

Sebelum maintenance:

1. Gunakan akun Windows yang merupakan anggota local Administrators dan buka
   PowerShell dengan **Run as administrator**.
2. Jadwalkan maintenance window singkat. Service tetap dapat berjalan selama
   dry-run, tetapi harus berhenti saat `--apply` dijalankan. Blokir juga UI,
   API/serverless function, worker, atau deployment SCAMATIC lain yang memakai
   database yang sama agar tidak ada writer credential selama rotasi.
3. Buat snapshot/backup MongoDB yang dapat dipulihkan.
4. Cadangkan `C:\ProgramData\SCAMATIC\runtime.env` dengan ACL yang sama ketatnya.
5. Pastikan key lama masih tersedia dan instalasi sedang sehat.
6. Jangan menempelkan MongoDB URI, master key, JWT, atau password ke tiket,
   source control, chat, screenshot, maupun log operasional.
7. Gunakan MongoDB Atlas atau replica set yang mendukung transaksi. Utility
   rotasi sengaja berhenti tanpa menulis jika transaksi tidak tersedia.

Path default yang digunakan runbook:

```powershell
$ScamaticRoot = 'C:\Program Files\SCAMATIC Builder Local2'
$ScamaticConfig = 'C:\ProgramData\SCAMATIC\runtime.env'
$ScamaticNode = Join-Path $ScamaticRoot 'resources\runtime\node.exe'
$ScamaticRotationScript = Join-Path $ScamaticRoot 'resources\runtime\scripts\rotate-connector-master-key.js'
$ScamaticService = 'SCAMATICRuntime'
```

Jika lokasi instalasi berbeda, ubah hanya `$ScamaticRoot`. Jangan menyalin
`runtime.env` ke direktori pengguna atau lokasi yang dapat dibaca oleh akun
non-administrator.

Konfirmasi sesi PowerShell sudah elevated:

```powershell
([Security.Principal.WindowsPrincipal] [Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole(
  [Security.Principal.WindowsBuiltInRole]::Administrator
)
```

Nilainya harus `True`.

## 1. Catat kondisi awal

Service harus aktif untuk pemeriksaan endpoint:

```powershell
Get-Service -Name $ScamaticService
Invoke-RestMethod 'http://127.0.0.1:3001/health/data-plane/ready' | Format-List
Invoke-RestMethod 'http://127.0.0.1:3001/health/data-plane/key-compatibility' | Format-List
```

Jangan lanjut jika readiness gagal. Jika compatibility menunjukkan
`incompatible` lebih besar dari nol, pulihkan key lama yang tepat terlebih
dahulu.

## 2. Buat backup konfigurasi yang terlindungi

Contoh berikut membuat backup berdampingan dengan konfigurasi dan menyalin ACL
file sumber. Database tetap harus dibackup melalui mekanisme MongoDB yang
berlaku di deployment tersebut.

```powershell
$ScamaticBackup = Join-Path 'C:\ProgramData\SCAMATIC' (
  'runtime.env.pre-rotation-{0}' -f (Get-Date -Format 'yyyyMMdd-HHmmss')
)
Copy-Item -LiteralPath $ScamaticConfig -Destination $ScamaticBackup
Get-Acl -LiteralPath $ScamaticConfig | Set-Acl -LiteralPath $ScamaticBackup
icacls $ScamaticBackup
```

Output ACL backup tidak boleh memberi akses kepada `Everyone`, `Users`, atau
`Authenticated Users`.

## 3. Generate primary key baru

```powershell
& (Join-Path $ScamaticRoot 'scamatic-runtime-service.exe') generate-master-key
```

Simpan output sementara di secret manager yang disetujui. Jangan menyimpannya
di source code atau command history.

Buka konfigurasi sebagai administrator:

```powershell
Start-Process notepad.exe -ArgumentList ('"' + $ScamaticConfig + '"') -Verb RunAs -Wait
```

Ubah hanya key ring berikut:

```dotenv
SCADA_CONNECTOR_MASTER_KEY=<KEY_BARU>
SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS=<KEY_LAMA>
```

`SCADA_CONNECTOR_MASTER_KEY` harus berisi key baru. Key yang sebelumnya menjadi
primary dipindahkan ke `SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS`. Beberapa previous
key dapat dipisahkan dengan koma jika memang diperlukan untuk memulihkan record
lama.

Validasi file konfigurasi sebelum menyentuh database:

```powershell
& (Join-Path $ScamaticRoot 'scamatic-runtime-service.exe') validate --config $ScamaticConfig
```

Hentikan proses jika validasi gagal.

## 4. Jalankan dry-run

Dry-run hanya membaca dan mencoba membuka wrapped data key. Service boleh tetap
aktif dan tidak ada record database yang diubah.

```powershell
& $ScamaticNode $ScamaticRotationScript
```

Gate untuk melanjutkan:

```text
"stage":"dry-run"
"ok":true
"incompatible":0
```

`rotationRequired` boleh lebih besar dari nol pada tahap ini; angka tersebut
adalah jumlah record yang akan dirotasi. Jangan lanjut jika `ok` bernilai
`false` atau `incompatible` lebih besar dari nol.

## 5. Terapkan rotasi

Aktifkan maintenance mode pada seluruh deployment yang berbagi database.
Hentikan Windows Service, pastikan statusnya `Stopped`, pastikan tidak ada API
atau worker SCAMATIC lain yang masih dapat mengubah Data Source/Chart secret,
lalu jalankan utility dengan `--apply`:

```powershell
Stop-Service -Name $ScamaticService
(Get-Service -Name $ScamaticService).WaitForStatus('Stopped', [TimeSpan]::FromSeconds(30))
& $ScamaticNode $ScamaticRotationScript --apply
```

Utility melakukan preflight sekali lagi, membaca dan menulis ulang hanya
wrapped data key dalam snapshot transaksi MongoDB yang sama, lalu memverifikasi
hasilnya. Setiap update membawa guard atas wrapping state yang dibaca. Bila ada
writer lain mengubah record, transaksi dibatalkan atau diulang dari snapshot
baru sehingga update tersebut tidak tertimpa diam-diam. Output sukses wajib
memuat:

```text
"stage":"completed"
"ok":true
"status":"compatible"
"incompatible":0
"rotationRequired":0
```

Jika utility gagal atau output `completed` tidak muncul, jangan menghapus
previous key. Pertahankan key baru dan key lama dalam key ring agar kedua jenis
record tetap dapat dibaca, lalu ikuti bagian pemulihan.

## 6. Finalisasi dan verifikasi

Setelah output `completed` memenuhi seluruh gate, kosongkan previous key di
`runtime.env`:

```dotenv
SCADA_CONNECTOR_PREVIOUS_MASTER_KEYS=
```

Validasi konfigurasi, mulai kembali service, dan tunggu hingga statusnya
`Running`:

```powershell
& (Join-Path $ScamaticRoot 'scamatic-runtime-service.exe') validate --config $ScamaticConfig
Start-Service -Name $ScamaticService
(Get-Service -Name $ScamaticService).WaitForStatus('Running', [TimeSpan]::FromSeconds(30))
```

Periksa readiness dan compatibility:

```powershell
Invoke-RestMethod 'http://127.0.0.1:3001/health/data-plane/ready' | Format-List
Invoke-RestMethod 'http://127.0.0.1:3001/health/data-plane/key-compatibility' | Format-List
```

Hasil akhir yang diterima:

```text
ok               : True
status           : compatible
incompatible     : 0
rotationRequired : 0
```

Dari root repository, jalankan verifier instalasi:

```powershell
Set-Location -LiteralPath '<ROOT_REPOSITORY_SCAMATIC>'
npm run desktop:verify-install
```

Targetnya `0 failed`. Reboot Windows dan ulangi verifier untuk membuktikan
Automatic (Delayed Start), recovery policy, ACL, listener, dan readiness setelah
boot nyata.

Setelah periode validasi dan retensi organisasi selesai, hapus backup
`runtime.env.pre-rotation-*` yang tepat secara aman. Jangan menyimpan previous
key tanpa batas waktu.

## Pemulihan dan troubleshooting

### `EPERM: operation not permitted, open runtime.env`

PowerShell atau Node tidak memiliki token administrator. Buka PowerShell dengan
**Run as administrator** dan ulangi. Jangan memperlonggar ACL untuk mengatasi
error ini.

Periksa ACL:

```powershell
icacls $ScamaticConfig
```

Konfigurasi normal memberi `SYSTEM` dan `BUILTIN\Administrators` full control,
serta `NT SERVICE\SCAMATICRuntime` read-only. Jalankan verifier atau repair
installer jika ACL berbeda; jangan memberikan akses kepada grup pengguna umum.

### Utility meminta service dihentikan

Dry-run boleh berjalan saat service aktif. Untuk `--apply`, jalankan:

```powershell
Stop-Service -Name $ScamaticService
Get-Service -Name $ScamaticService
```

Lanjutkan hanya jika statusnya `Stopped`.

### MongoDB melaporkan transaction/replica-set tidak tersedia

Rotasi fail-closed dan tidak melakukan fallback non-transaksional. Jangan
mengubah `NODE_ENV` untuk melewati perlindungan ini. Pindahkan database ke
MongoDB Atlas atau konfigurasi replica set yang mendukung transaksi, pastikan
readiness sehat, lalu ulangi dry-run dan `--apply`.

### Dry-run melaporkan record `incompatible`

Jangan menjalankan `--apply`. Artinya key ring belum memuat key yang dapat
membuka seluruh encrypted record. Kembalikan key yang benar sebagai primary
atau tambahkan key historis yang sah ke previous keys, lalu ulangi dry-run.
Jangan menebak atau membuat key pengganti untuk record yang sudah ada.

### `--apply` gagal setelah service dihentikan

Jangan kosongkan previous keys dan jangan langsung mengembalikan konfigurasi ke
old-key-only. Pertahankan key baru sebagai primary dan key lama sebagai previous,
kemudian ulangi dry-run. Konfigurasi dua-key tersebut merupakan posisi pemulihan
yang dapat membaca record sebelum maupun sesudah rotasi. Simpan output error
yang sudah disanitasi dan periksa koneksi MongoDB sebelum mencoba lagi.

Jika service harus tersedia selama investigasi, konfigurasi dua-key dapat tetap
digunakan untuk menyalakan service. Jangan menganggap rotasi selesai sampai
compatibility menunjukkan `incompatible: 0` dan `rotationRequired: 0`.

### Utility melaporkan record berubah selama rotasi

Masih ada writer lain pada database yang sama atau terjadi perubahan credential
di tengah maintenance. Jangan menghapus previous key. Hentikan akses tulis dari
Desktop, API/serverless function, worker, dan deployment SCAMATIC lain, lalu
ulangi dry-run serta `--apply`. Guard transaksi sengaja menggagalkan rotasi
daripada menimpa update yang lebih baru.

### `npm` melaporkan `Missing script: desktop:verify-install`

Perintah dijalankan di luar root repository atau checkout belum memuat verifier.
Masuk ke root repository yang benar terlebih dahulu. Utility rotasi yang berada
di direktori instalasi tidak memerlukan current directory repository.

## Checklist audit

- [ ] PowerShell elevated dan maintenance window aktif.
- [ ] Snapshot/backup MongoDB tersedia.
- [ ] Backup `runtime.env` mempunyai ACL terbatas.
- [ ] Key baru menjadi primary; key lama menjadi previous.
- [ ] Validasi konfigurasi berhasil.
- [ ] Dry-run: `ok=true`, `incompatible=0`.
- [ ] Service berhenti sebelum `--apply`.
- [ ] Semua deployment/API/worker lain yang berbagi database berada dalam
      maintenance mode dan tidak dapat menulis secret.
- [ ] Apply selesai: `status=compatible`, `rotationRequired=0`.
- [ ] Previous keys dikosongkan setelah verifikasi berhasil.
- [ ] Service kembali `Running` dan kedua health endpoint sehat.
- [ ] Verifier menghasilkan `0 failed` sebelum dan setelah reboot.
- [ ] Backup sementara ditangani sesuai kebijakan retensi secret.
