# Grey-Metallic HMI Theme — Design Reference

Dokumen ini merangkum sistem visual yang dipakai di SCADA `pulsator+filter`,
khususnya pada tab **SETTING** (panel HMI + mounting plate lamps) dan
**TREND** (dark chart panel di atas latar metallic). Tujuannya: bisa di-port
langsung ke proyek SCADA lain dengan copy-paste token + komponen.

## 1. Filosofi

| Prinsip | Konsekuensi |
|---|---|
| **Brushed-aluminium panel sebagai container** | Semua card menggunakan satu gradient yang sama → tampak seperti "plat logam" dengan device terpasang di atasnya |
| **Dark instrument di atas metallic** | Element yang menampilkan data hidup (LIVE box, chart, numeric input) memakai latar gelap `#000–#111217` untuk kontras maksimum — analogi dengan layar LCD nyata di atas plat logam |
| **Color accent hanya untuk identitas parameter atau state** | Cyan, lime, amber, red — bukan untuk dekorasi |
| **Engraved text via text-shadow** | Teks pada metallic frame diberi `text-shadow: 0 1px 0 #ecedef` agar terlihat seperti label engraved/etched, bukan printed sticker |
| **Stroke gelap 2px konsisten** | Semua elemen (plate, ring, lamp face) pakai `stroke: #09090b` → garis hitam tegas khas neo-brutalist HMI |

---

## 2. Color Token

Pakai konstanta ini di mana pun. Konsistensi nilai >> readability.

### Metallic palette (gradient panel)

| Token | Hex | Pakai untuk |
|---|---|---|
| `--metal-100` | `#dadcde` | Highlight atas |
| `--metal-200` | `#ecedef` | Inset bevel atas |
| `--metal-300` | `#b3b6ba` / `#9a9da2` | Mid-highlight (35-45%) |
| `--metal-400` | `#8e9197` / `#73767c` | Mid-shadow (55%) |
| `--metal-500` | `#aeb1b6` | Highlight bawah |
| `--metal-600` | `#6f7278` | Border |
| `--metal-700` | `#5d6066` | Inset bevel bawah |
| `--metal-900` | `#3a3c40` | Outer edge (lamp ring) |
| `--ink` | `#09090b` | Stroke / outline universal |

### Silver ring (radial gradient untuk lamp)

| Token | Hex | Posisi di radial |
|---|---|---|
| `--ring-highlight` | `#f4f5f7` | offset 0% (kena cahaya) |
| `--ring-mid` | `#b1b4b9` | 55% |
| `--ring-shadow` | `#6c6f74` | 85% |
| `--ring-edge` | `#3a3c40` | 100% |

### Text & UI

| Token | Hex | Pakai untuk |
|---|---|---|
| `--text-engraved` | `#1f2937` / `#0f172a` | Teks di atas metallic frame (selalu pakai text-shadow) |
| `--text-secondary` | `#374151` / `#475569` | Subtitle, label kecil |
| `--text-muted` | `#94a3b8` | Disabled / placeholder |
| `--accent-cyan` | `#06b6d4` / `#22d3ee` | Identitas analog (mis. Level Air) |
| `--accent-lime` | `#84cc16` | Identitas analog lain (mis. Level filter) |
| `--accent-amber` | `#fbbf24` / `#f59e0b` | Manual mode / low alarm |
| `--accent-red` | `#ef4444` | High alarm / fault |
| `--accent-green` | `#22c55e` / `#16a34a` / `#00e676` | Normal / ON / running |

### Dark instrument (untuk chart panel, LIVE box, numeric input)

| Token | Hex |
|---|---|
| `--inst-bg` | `#111217` |
| `--inst-bg-header` | `#0d1117` |
| `--inst-bg-deep` | `#0b0e13` |
| `--inst-border` | `#1f2533` / `#1e293b` |
| `--inst-text` | `#d8d9da` |

---

## 3. Linear Gradient — Metallic Plate (panel & card)

### CSS

```css
.card {
  background: linear-gradient(180deg,
    #dadcde 0%,
    #b3b6ba 35%,
    #8e9197 55%,
    #aeb1b6 100%);
  border: 2px solid #6f7278;
  box-shadow:
    inset 0  1px 0 #ecedef,   /* highlight bevel atas */
    inset 0 -1px 0 #5d6066;   /* shadow bevel bawah */
  padding: 10px 12px;
  margin-bottom: 10px;
}
```

**Catatan posisi stop**: 4-stop bukan 2-stop. Stop `45%` dan `55%` saling
berdekatan untuk menciptakan band "shadow horizontal" tipis di tengah plat
— efek brushed-aluminium yang khas. Kalau diganti 2-stop, plat terlihat
seperti gradient gradien grafis biasa, bukan logam.

### SVG (kalau plat-nya digambar di Inkscape / SVG inline)

```svg
<defs>
  <linearGradient id="panelMetallic" x1="0%" y1="0%" x2="0%" y2="100%">
    <stop offset="0%"   stop-color="#dadcde"/>
    <stop offset="45%"  stop-color="#9a9da2"/>
    <stop offset="55%"  stop-color="#73767c"/>
    <stop offset="100%" stop-color="#aeb1b6"/>
  </linearGradient>
</defs>

<!-- Drop-shadow di belakang plate -->
<rect x="5" y="5" width="184" height="64" fill="#09090b"/>
<!-- Plate utama dengan gradient -->
<rect x="3" y="3" width="184" height="64"
      fill="url(#panelMetallic)" stroke="#09090b" stroke-width="3"/>
```

Hex SVG **sedikit beda** dari CSS (`#9a9da2` / `#73767c` di SVG vs
`#b3b6ba` / `#8e9197` di CSS) — itu disengaja: SVG plat dirender lebih
besar dan butuh kontras lebih tinggi agar shadow band-nya terlihat. Kalau
ditiru ke proyek lain, **ikuti perbedaan ini**.

---

## 4. Radial Gradient — Silver Ring (lamp)

Cincin metalik di sekitar lamp face. Bagian highlight diposisikan di
**kiri-atas** (`fx="35%" fy="30%"`) seolah-olah kena cahaya dari atas-kiri.

```svg
<defs>
  <radialGradient id="lampRing" cx="50%" cy="50%" r="50%" fx="35%" fy="30%">
    <stop offset="0%"   stop-color="#f4f5f7"/>
    <stop offset="55%"  stop-color="#b1b4b9"/>
    <stop offset="85%"  stop-color="#6c6f74"/>
    <stop offset="100%" stop-color="#3a3c40"/>
  </radialGradient>
</defs>
```

---

## 5. Komponen — Lamp Button (industrial style)

4 lapis SVG yang menghasilkan tombol indikator HMI bergaya industrial:

```
┌──────────────────┐
│   ╭──────╮       │  ← rect plate (mounting, blue-steel, rounded 20%)
│  │  ╶──╴  │     │  ← silver ring (radial gradient)
│   ╰──────╯       │  ← lamp face (BOUND ke telemetry — swap warna)
└──────────────────┘
       ↑
       ellipse highlight kiri-atas (glossy)
```

```svg
<g style="cursor:pointer">
  <!-- 1. Mounting plate (rect rounded, decorative) -->
  <rect x="${cx - 19}" y="${cy - 19}" width="38" height="38"
        rx="7.6" ry="7.6"
        fill="#2c4f7c" stroke="#09090b" stroke-width="1.6"/>

  <!-- 2. Silver outer ring -->
  <circle cx="${cx}" cy="${cy}" r="15.6"
          fill="url(#lampRing)" stroke="#09090b" stroke-width="0.8"/>

  <!-- 3. Lamp face — BOUND. Telemetry mengganti fill antara on/off. -->
  <circle data-scada-type="lamp" data-tag="${tag}"
          data-on-fill="#00e676" data-off-fill="#ff1744"
          cx="${cx}" cy="${cy}" r="11.2"
          fill="#00e676" stroke="#09090b" stroke-width="0.8"/>

  <!-- 4. Glossy highlight (kena cahaya kiri-atas) -->
  <ellipse cx="${cx - 3.2}" cy="${cy - 4.4}" rx="5.2" ry="3.2"
           fill="#ffffff88" style="pointer-events:none"/>

  <!-- Caption di atas plate -->
  <text x="${cx}" y="${cy - 26}"
        fill="#09090b" font-family="Arial" font-size="9" font-weight="900"
        text-anchor="middle" dominant-baseline="middle"
        letter-spacing="0.8">${label}</text>
</g>
```

### Proporsi penting (jangan ubah rasionya)

| Element | Radius / Ukuran | Rasio terhadap plate |
|---|---|---|
| Plate width/height | 38 | 1.00 |
| Plate `rx`/`ry` | 7.6 | 0.20 (border-radius 20%) |
| Silver ring `r` | 15.6 | 0.41 |
| Lamp face `r` | 11.2 | 0.29 |
| Highlight ellipse `rx,ry` | 5.2 × 3.2 | 0.14 × 0.08 |
| Highlight offset | `−3.2, −4.4` | ~30% radius |

Kalau ingin lamp 2× lebih besar, kalikan SEMUA angka di atas dengan 2.

### Warna plate menurut konteks

| Sistem | Plate hex | Mood |
|---|---|---|
| Water treatment (pakai kami) | `#2c4f7c` | Steel blue, kalem |
| Power / electrical | `#1f2937` | Charcoal, serius |
| Safety / E-stop | `#7f1d1d` | Dark red |
| Generic process | `#374151` | Slate netral |

---

## 6. Komponen — State Pill (OPEN/CLOSE, RUN/STOP)

Pill kecil di bawah lamp menampilkan teks state. Lebar pill 16, tinggi 5.6
unit viewBox.

```svg
<rect x="${cx - 8}" y="${cy + 10 - 2.8}" width="16" height="5.6"
      rx="1.2" ry="1.2" fill="#09090b" stroke="#ffffff" stroke-width="0.4"/>
<text data-scada-type="state" data-tag="${tag}"
      data-on-text="OPEN"  data-off-text="CLOSE"
      data-on-fill="#22c55e" data-off-fill="#94a3b8"
      x="${cx}" y="${cy + 10}"
      fill="#94a3b8" font-family="Arial" font-size="3.2" font-weight="900"
      text-anchor="middle" dominant-baseline="middle"
      letter-spacing="0.4">CLOSE</text>
```

Convention teks:
- **Valve** → `OPEN` / `CLOSE`
- **Motor / Pump** → `RUN` / `STOP`
- Indonesian variant → `BUKA` / `TUTUP`, `JALAN` / `BERHENTI`

---

## 7. Komponen — Modal / Popup di atas Metallic Frame

Modal (mis. TuningPopup) menggunakan **frame metallic + sub-elemen gelap**.
Layoutnya: gradient frame jadi "casing", sub-element dark instrument
(LIVE box, numeric input) di-overlay sebagai "instrumen yang terpasang di
plat".

```jsx
<div style={{
  width: 280,
  background: 'linear-gradient(180deg, #dadcde 0%, #b3b6ba 35%, #8e9197 55%, #aeb1b6 100%)',
  border: '2px solid #6f7278',
  boxShadow: '4px 4px 0 #09090b, inset 0 1px 0 #ecedef, inset 0 -1px 0 #5d6066',
  borderLeft: `4px solid ${accent}`,   // identitas warna parameter
  padding: 10,
  fontFamily: 'system-ui'
}}>
  {/* Title — engraved look */}
  <strong style={{
    color: '#0f172a',
    fontSize: '.88rem',
    letterSpacing: '0.5px',
    textShadow: '0 1px 0 #ecedef'
  }}>
    {label}
  </strong>

  {/* Dark sub-element — kontras tinggi untuk angka LIVE */}
  <div style={{
    background: '#000',
    border: '1px solid #1e293b',
    padding: '4px 8px',
    color: '#94a3b8',
    display: 'flex', justifyContent: 'space-between'
  }}>
    <span>LIVE</span>
    <strong style={{ color: '#22d3ee', fontFamily: 'monospace' }}>
      45.3 %
    </strong>
  </div>

  {/* Slider numeric input — juga dark instrument */}
  <input style={{
    background: '#000',
    color: accent,
    border: `2px solid ${accent}`,
    fontFamily: 'monospace', fontWeight: 800, textAlign: 'right'
  }}/>
</div>
```

### Rule kontras

| Element pada metallic frame | Warna teks |
|---|---|
| Title primer | `#0f172a` + text-shadow `0 1px 0 #ecedef` |
| Subtitle / metadata | `#374151` bold |
| Min/max label slider | `#1f2937` bold |
| Button transparan | bg `rgba(255,255,255,0.25)`, border `#6f7278`, text `#1f2937` |
| Element gelap (instrument) | bg `#000` atau `#111217`, text accent / `#94a3b8` |

---

## 8. Komponen — Chart Panel (TREND-style)

Panel chart memakai pendekatan **inverse**: bg dominan dark (`#111217`)
sebagai "monitor", header sedikit lebih gelap (`#0d1117`) sebagai bezel.
Letakkan panel ini di section dengan background dark (`#0b0e13`) sehingga
overall menjadi "ruang kontrol" dengan beberapa screen LCD.

```jsx
<section style={{ background: '#0b0e13', padding: 0 }}>
  <div style={{
    background: '#111217',
    border: '1px solid #1f2533',
    borderRadius: 3,
    marginBottom: 8,
    overflow: 'hidden'
  }}>
    {/* Header bezel */}
    <div style={{
      background: '#0d1117',
      borderBottom: '1px solid #1f2533',
      padding: '7px 14px',
      display: 'flex',
      justifyContent: 'space-between'
    }}>
      <div>
        <span style={{ color: '#d8d9da', fontSize: 13, fontWeight: 500 }}>
          Level_Air Pulsator Tank Level
        </span>
        <div style={{ display: 'flex', gap: 14, marginTop: 3 }}>
          <span style={{ color: '#ef4444', fontSize: 9 }}>▬ HIGH 90 %</span>
          <span style={{ color: '#f59e0b', fontSize: 9 }}>▬ LOW 10 %</span>
        </div>
      </div>
      {/* Big numeric on the right — color shifts on alarm */}
      <div style={{ textAlign: 'right' }}>
        <div style={{
          color: '#06b6d4',           // accent normal; '#ef4444' if HIGH; '#f59e0b' if LOW
          fontSize: 26,
          fontWeight: 700,
          fontFamily: 'monospace',
          lineHeight: 1
        }}>45.30</div>
        <div style={{ color: '#4a5568', fontSize: 10 }}>%</div>
      </div>
    </div>

    {/* Chart canvas (SVG) */}
    <div style={{ background: '#111217', maxHeight: '60vh' }}>
      {/* MiniChart SVG di sini */}
    </div>
  </div>
</section>
```

### MiniChart internal palette

| Element chart | Warna |
|---|---|
| Background SVG | `#111217` |
| Grid lines | `#1f2533` (1 px) |
| Y-axis label | `#5c6e82`, font 10 |
| X-axis label | `#5c6e82`, font 9 |
| Data line | accent parameter (mis. `#06b6d4`) |
| Filled area | accent + opacity 0.15-0.3 |
| Alarm HIGH line | `#ef4444` (dashed) |
| Alarm LOW line | `#f59e0b` (dashed) |
| Tooltip box | bg `#1a1f2e`, border `#2d3a4e`, text `#8e9daa` |
| Empty-state text | `#4a5568`, text-shadow `0 0 6px #111217` |

### Aspect ratio chart

ViewBox `900 × 400` (rasio 16:7) cocok untuk container `width:100%; max-height:60vh`. Kalau ubah salah satu, sesuaikan yang lain agar `preserveAspectRatio="none"` tidak menghasilkan stretching ekstrim:

```
container_aspect = container_width_px / container_height_px
viewBox_aspect   = 900 / H

Selisih aspect < 10% → distorsi tidak terlihat.
```

Rule of thumb:
| `displayHeight` | ViewBox `H` |
|---|---|
| `40vh` | 250 |
| `60vh` | 400 |
| `76vh` | 500 |
| `95vh` | 600 |

---

## 9. Komponen — Indicator Lamp Kecil (pada skematik)

Lamp kecil yang ditempel di pipa / valve schematic. Dibedakan dari lamp
button (#5) karena tidak punya plate / ring — hanya 2 lingkaran:

```svg
<g style="pointer-events:none">
  <!-- White outer ring -->
  <circle cx="${cx}" cy="${cy}" r="6.2"
          fill="#ffffff" stroke="#09090b" stroke-width="1"/>
  <!-- Inner indicator (BOUND) -->
  <circle data-scada-type="indicator" data-tag="${tag}"
          data-on-fill="#22c55e" data-off-fill="#94a3b8"
          cx="${cx}" cy="${cy}" r="4.6"
          fill="#94a3b8" stroke="#09090b" stroke-width="0.8"/>
  <!-- Tag caption di atas -->
  <text x="${cx}" y="${cy - 9}"
        fill="#09090b" font-family="Arial" font-size="3.6" font-weight="900"
        text-anchor="middle" dominant-baseline="middle">V106</text>
</g>
```

Pakai ini ketika menempel indikator pada pipa/valve di P&ID/SCADA
schematic — lebih ringkas dari lamp button.

---

## 10. Spacing & Typography Tokens

### Spacing scale (rapat → renggang)

| Token | Nilai | Pakai |
|---|---|---|
| `--space-xs` | `2px` | Margin antar text dalam satu group |
| `--space-sm` | `6px` | Gap antar elemen sejajar |
| `--space-md` | `10px` | Padding card, gap antar card |
| `--space-lg` | `14px` | Padding card besar |
| `--space-xl` | `20px` | Section padding |

### Font size scale (compact HMI)

| Token | Nilai | Pakai |
|---|---|---|
| `--font-xs` | `.7rem` (~10px) | Subtitle, badge, button kecil |
| `--font-sm` | `.85rem` (~12px) | Tag identifier, label sekunder |
| `--font-md` | `1.1rem` (~16px) | Label parameter |
| `--font-lg` | `1.3rem` (~19px) | State text (OPEN/CLOSE) |
| `--font-xl` | `1.9rem` (~27px) | Value numeric monospace |

### Font family

- **Display & label**: `Arial` (di SVG) atau `system-ui` (di HTML)
- **Numeric / data**: `monospace` — pas digit-grouping tetap rata kolom

### Stroke / border

- **Universal stroke** outline lamp/plate/ring: `#09090b`, width `0.5–1.8`
  tergantung ukuran element
- **Card border**: `2px solid #6f7278`
- **Dark instrument border**: `1px solid #1f2533` atau `#1e293b`

---

## 11. Behavior — State swap via `data-` attributes

Pattern binding pakai data attributes — frontend framework-agnostic
(bisa React, Vue, Vanilla):

| `data-scada-type` | Behavior |
|---|---|
| `lamp` | Boolean → swap fill ON↔OFF + glow drop-shadow opsional |
| `indicator` | Boolean → swap fill (tanpa glow) |
| `toggle` | Klik → kirim RPC ke device, wait telemetry untuk confirm |
| `state` | Boolean → swap textContent (mis. "OPEN"↔"CLOSE") + fill |
| `value` | Number → `value.toFixed(decimals) + unit` + warna berdasar alarm threshold |

Atribut yang biasa dipakai:

```
data-tag           = nama tag PLC (e.g. "Valve_106")
data-on-fill       = warna fill saat true
data-off-fill      = warna fill saat false
data-on-text       = textContent saat true
data-off-text      = textContent saat false
data-on-glow       = "true" untuk drop-shadow glow saat on
data-decimals      = jumlah digit pecahan (value)
data-unit          = satuan ditampilkan setelah angka
data-alarm-high    = threshold high → fill berubah ke #ef4444
data-alarm-low     = threshold low → fill berubah ke #f59e0b
data-rpc-method    = method name RPC saat toggle diklik
data-readonly      = "true" → skip event binding (display-only)
```

Contoh binding loop (vanilla):

```js
telemetry.forEach((val, tag) => {
  container.querySelectorAll(`[data-scada-type="lamp"][data-tag="${tag}"]`)
    .forEach(el => {
      el.setAttribute('fill', val
        ? (el.dataset.onFill || '#22c55e')
        : (el.dataset.offFill || '#1e293b'))
      if (el.dataset.onGlow === 'true') {
        const c = el.dataset.onFill || '#22c55e'
        el.style.filter = val ? `drop-shadow(0 0 8px ${c})` : 'none'
      }
    })
  // … and similar for indicator / state / value / toggle
})
```

---

## 12. Anti-pattern (jangan dilakukan)

| Jangan | Kenapa |
|---|---|
| Pakai gradient 2-stop saja | Plat tidak terlihat "logam", lebih seperti web gradient generik |
| Pakai `border-radius: 50%` untuk lamp face | Sudah default circle, tidak perlu CSS; pakai `<circle>` SVG |
| Pakai warna accent untuk dekorasi (bukan state) | Mengurangi makna warna saat alarm aktif |
| `text-shadow` pada teks di dark instrument | Hanya untuk metallic frame; di dark bg cukup color saja |
| Mix `preserveAspectRatio="none"` + viewBox aspect ekstrim | Teks SVG akan ter-stretch, lihat aturan di §8 |
| Tinggal `box-shadow: 5px 5px 0 #000` tanpa border | Neo-brutalist butuh outline juga, bukan shadow saja |

---

## 13. Checklist port ke proyek SCADA lain

- [ ] Copy 4 token gradient (`panelMetallic` SVG + `.card` CSS) — identik
- [ ] Copy radial gradient `lampRing`
- [ ] Copy 4-layer lamp button construct (rect + ring + face + highlight)
- [ ] Setup binding loop via `data-scada-type` (§11)
- [ ] Audit semua text yang muncul di atas metallic frame — pakai
      `text-shadow: 0 1px 0 #ecedef` + warna `#0f172a` / `#1f2937`
- [ ] Audit semua "instrument" data (chart, LIVE box, numeric input) →
      pakai dark bg `#111217` + border `#1f2533`
- [ ] Spacing & font ikut tokenisasi di §10
- [ ] State pill text disesuaikan dengan device type (valve / motor)
- [ ] Plate color (`#2c4f7c`) bisa diganti per sistem (lihat §5 tabel
      "Warna plate menurut konteks")

---

## 14. File yang relevan di repo ini

| File | Apa yang ada |
|---|---|
| [src/styles.css](src/styles.css) | `.card` gradient + `.monitor-card` opacity override |
| [src/App.jsx](src/App.jsx) — `buildPanelStandaloneSvg` | Panel HMI lengkap: `<defs>` gradient, lamp button, AUTO/MANUAL/RESET |
| [src/App.jsx](src/App.jsx) — `buildSchematicIndicators` | Indikator kecil pada skematik (§9) |
| [src/App.jsx](src/App.jsx) — `TuningPopup` | Modal metallic frame (§7) |
| [src/components/GrafanaChart.jsx](src/components/GrafanaChart.jsx) | Chart panel TREND (§8) |
| [src/hooks/useScadaBinding.js](src/hooks/useScadaBinding.js) | Binding loop data-attributes (§11) |
