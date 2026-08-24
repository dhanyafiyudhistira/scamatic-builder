import { useCallback, useMemo, useRef, useState } from 'react'

/* ── Series definitions — mixer-unit analogs from deck-user.md flow ─── */
const SERIES = [
  { tag: 'Level_mix',            label: 'Level_mix             Mixer Tank Level',  color: '#06b6d4', unit: '%', yMin: 0, yMax: 100, alarmHigh: 80, alarmLow: 20 },
  { tag: 'QI_102',               label: 'QI_102                pH Indicator',      color: '#84cc16', unit: 'pH', yMin: 0, yMax: 14, alarmHigh: 8.5, alarmLow: 6.0 },
  { tag: 'Simulasi_OpeningV104', label: 'Simulasi_OpeningV104  V104 Opening %',    color: '#fbbf24', unit: '%', yMin: 0, yMax: 100, alarmHigh: 95, alarmLow: 0  },
]

/* ── Tiny helpers ─────────────────────────────────────────────────────── */
const px = n => `${n}px`

function fmt(v, unit) {
  if (v === null || v === undefined) return `-- ${unit}`
  return `${Number(v).toFixed(2)} ${unit}`
}

/* ── SVG line/area chart (single tag) ────────────────────────────────── */
function MiniChart({ data, tag, color, unit, yMin, yMax, alarmHigh, alarmLow, height = 130 }) {
  const W = 900          // internal SVG width (responsive via viewBox)
  const H = height
  const PAD = { top: 8, right: 8, bottom: 24, left: 46 }
  const chartW = W - PAD.left - PAD.right
  const chartH = H - PAD.top - PAD.bottom

  const [tooltip, setTooltip] = useState(null)
  const svgRef = useRef(null)

  const points = useMemo(() => {
    if (!data || data.length < 2) return []
    return data.map((d, i) => {
      const xFrac = i / (data.length - 1)
      const v = d[tag]
      const yFrac = v !== null && v !== undefined
        ? 1 - (Number(v) - yMin) / (yMax - yMin)
        : null
      return { x: PAD.left + xFrac * chartW, y: yFrac !== null ? PAD.top + yFrac * chartH : null, v, time: d.time }
    })
  }, [data, tag, yMin, yMax, chartW, chartH])

  // Build SVG polyline string (skip null gaps)
  const segments = useMemo(() => {
    const segs = []
    let cur = []
    points.forEach(p => {
      if (p.y === null) { if (cur.length > 1) segs.push(cur); cur = [] }
      else cur.push(p)
    })
    if (cur.length > 1) segs.push(cur)
    return segs
  }, [points])

  // Build filled area paths
  const areas = useMemo(() => segments.map(seg => {
    const baseline = PAD.top + chartH
    const pts = seg.map(p => `${p.x},${p.y}`).join(' ')
    const first = seg[0]; const last = seg[seg.length - 1]
    return `M${first.x},${baseline} L${pts.split(' ').map(p => `L${p}`).join(' ')} L${last.x},${baseline} Z`
      .replace('L L', 'L ')
  }), [segments, chartH])

  // Y-axis ticks
  const yTicks = useMemo(() => {
    const count = 5
    return Array.from({ length: count + 1 }, (_, i) => {
      const frac = i / count
      const val = yMin + frac * (yMax - yMin)
      const y = PAD.top + (1 - frac) * chartH
      return { y, label: Number(val).toFixed(unit === 'm' ? 1 : 0) }
    })
  }, [yMin, yMax, chartH, unit])

  // X-axis ticks (sparse)
  const xTicks = useMemo(() => {
    if (!data || data.length === 0) return []
    const step = Math.max(1, Math.floor(data.length / 6))
    return data.reduce((acc, d, i) => {
      if (i % step === 0 || i === data.length - 1) {
        acc.push({ x: PAD.left + (i / (data.length - 1)) * chartW, label: d.time ?? '' })
      }
      return acc
    }, [])
  }, [data, chartW])

  // Alarm line Y positions
  const alarmHighY = PAD.top + (1 - (alarmHigh - yMin) / (yMax - yMin)) * chartH
  const alarmLowY  = PAD.top + (1 - (alarmLow  - yMin) / (yMax - yMin)) * chartH

  const handleMouseMove = useCallback(e => {
    if (!svgRef.current || points.length === 0) return
    const rect = svgRef.current.getBoundingClientRect()
    const mx   = (e.clientX - rect.left) * (W / rect.width)
    // find nearest point
    let closest = null; let dist = Infinity
    points.forEach(p => {
      const d = Math.abs(p.x - mx)
      if (d < dist && p.y !== null) { dist = d; closest = p }
    })
    if (closest && dist < chartW / points.length + 10) setTooltip(closest)
    else setTooltip(null)
  }, [points, chartW])

  return (
    <svg
      ref={svgRef}
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: '100%', height: H, display: 'block', overflow: 'visible' }}
      onMouseMove={handleMouseMove}
      onMouseLeave={() => setTooltip(null)}
    >
      {/* background */}
      <rect x="0" y="0" width={W} height={H} fill="#111217" />

      {/* grid lines */}
      {yTicks.map((t, i) => (
        <line key={i} x1={PAD.left} y1={t.y} x2={PAD.left + chartW} y2={t.y}
          stroke={i === 0 ? '#2d3a4e' : '#1f2533'} strokeWidth="1" />
      ))}

      {/* y-axis labels */}
      {yTicks.map((t, i) => (
        <text key={i} x={PAD.left - 6} y={t.y} fill="#5c6e82" fontSize="10"
          textAnchor="end" dominantBaseline="middle">{t.label}</text>
      ))}

      {/* x-axis labels */}
      {xTicks.map((t, i) => (
        <text key={i} x={t.x} y={PAD.top + chartH + 14} fill="#5c6e82" fontSize="9"
          textAnchor="middle">{t.label}</text>
      ))}

      {/* alarm HIGH line */}
      {alarmHigh !== undefined && alarmHighY >= PAD.top && alarmHighY <= PAD.top + chartH && (
        <>
          <line x1={PAD.left} y1={alarmHighY} x2={PAD.left + chartW} y2={alarmHighY}
            stroke="#ef4444" strokeWidth="1" strokeDasharray="5 4" strokeOpacity="0.7" />
          <text x={PAD.left + chartW - 2} y={alarmHighY - 3} fill="#ef4444" fontSize="8" textAnchor="end">
            HIGH {alarmHigh}{unit}
          </text>
        </>
      )}

      {/* alarm LOW line */}
      {alarmLow !== undefined && alarmLowY >= PAD.top && alarmLowY <= PAD.top + chartH && (
        <>
          <line x1={PAD.left} y1={alarmLowY} x2={PAD.left + chartW} y2={alarmLowY}
            stroke="#f59e0b" strokeWidth="1" strokeDasharray="5 4" strokeOpacity="0.7" />
          <text x={PAD.left + chartW - 2} y={alarmLowY - 3} fill="#f59e0b" fontSize="8" textAnchor="end">
            LOW {alarmLow}{unit}
          </text>
        </>
      )}

      {/* area fills */}
      <defs>
        <linearGradient id={`grd-${tag}`} x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%"   stopColor={color} stopOpacity="0.25" />
          <stop offset="100%" stopColor={color} stopOpacity="0" />
        </linearGradient>
        <clipPath id={`clip-${tag}`}>
          <rect x={PAD.left} y={PAD.top} width={chartW} height={chartH} />
        </clipPath>
      </defs>

      {areas.map((d, i) => (
        <path key={i} d={d} fill={`url(#grd-${tag})`} clipPath={`url(#clip-${tag})`} />
      ))}

      {/* line segments */}
      {segments.map((seg, i) => (
        <polyline key={i}
          points={seg.map(p => `${p.x},${p.y}`).join(' ')}
          fill="none" stroke={color} strokeWidth="2"
          strokeLinejoin="round" strokeLinecap="round"
          clipPath={`url(#clip-${tag})`}
        />
      ))}

      {/* y-axis border line */}
      <line x1={PAD.left} y1={PAD.top} x2={PAD.left} y2={PAD.top + chartH}
        stroke="#2d3a4e" strokeWidth="1" />

      {/* tooltip crosshair */}
      {tooltip && (
        <>
          <line x1={tooltip.x} y1={PAD.top} x2={tooltip.x} y2={PAD.top + chartH}
            stroke="#ffffff30" strokeWidth="1" strokeDasharray="3 3" />
          <circle cx={tooltip.x} cy={tooltip.y} r="4" fill={color} stroke="#111217" strokeWidth="2" />
          {/* tooltip box */}
          <rect x={Math.min(tooltip.x + 6, W - 120)} y={tooltip.y - 22}
            width="110" height="36" rx="2" fill="#1a1f2e" stroke="#2d3a4e" strokeWidth="1" />
          <text x={Math.min(tooltip.x + 12, W - 114)} y={tooltip.y - 8}
            fill="#8e9daa" fontSize="9">{tooltip.time}</text>
          <text x={Math.min(tooltip.x + 12, W - 114)} y={tooltip.y + 6}
            fill={color} fontSize="12" fontWeight="600" fontFamily="monospace">
            {fmt(tooltip.v, unit)}
          </text>
        </>
      )}
    </svg>
  )
}

/* ── Grafana-style panel (one per tag) ────────────────────────────────── */
function GrafanaPanel({ series, data, currentValue, timeRange, onTimeRangeChange }) {
  const { tag, label, color, unit, yMin, yMax, alarmHigh, alarmLow } = series

  const latest  = currentValue !== undefined ? currentValue : (data.length > 0 ? data[data.length - 1]?.[tag] : null)
  const isAlarmH = latest !== null && latest >= alarmHigh
  const isAlarmL = latest !== null && latest <= alarmLow
  const valueColor = isAlarmH ? '#ef4444' : isAlarmL ? '#f59e0b' : color

  return (
    <div style={{
      background: '#111217', border: '1px solid #1f2533',
      borderRadius: 3, marginBottom: 8, overflow: 'hidden'
    }}>
      {/* Panel header */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '7px 14px', borderBottom: '1px solid #1f2533', background: '#0d1117'
      }}>
        <div>
          <span style={{ color: '#d8d9da', fontSize: 13, fontWeight: 500, letterSpacing: 0.3 }}>
            {label}
          </span>
          <div style={{ display: 'flex', gap: 14, marginTop: 3 }}>
            <span style={{ color: '#ef4444', fontSize: 9, letterSpacing: 0.5 }}>
              ▬ HIGH {alarmHigh} {unit}
            </span>
            <span style={{ color: '#f59e0b', fontSize: 9, letterSpacing: 0.5 }}>
              ▬ LOW {alarmLow} {unit}
            </span>
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div style={{ color: valueColor, fontSize: 26, fontWeight: 700, fontFamily: 'monospace', lineHeight: 1 }}>
            {latest !== null && latest !== undefined ? Number(latest).toFixed(2) : '--'}
          </div>
          <div style={{ color: '#4a5568', fontSize: 10, marginTop: 1 }}>{unit}</div>
        </div>
      </div>

      {/* Chart area */}
      <div style={{ padding: '4px 0 0 0', background: '#111217' }}>
        {data.length < 2
          ? <div style={{ color: '#4a5568', fontSize: 12, textAlign: 'center', padding: '40px 0' }}>
              Waiting for telemetry data…
            </div>
          : <MiniChart data={data} tag={tag} color={color} unit={unit}
              yMin={yMin} yMax={yMax} alarmHigh={alarmHigh} alarmLow={alarmLow} height={140} />
        }
      </div>
    </div>
  )
}

/* ── Main export ──────────────────────────────────────────────────────── */
export default function GrafanaChart({ history, telemetry, loadHistory }) {
  const [timeRange, setTimeRange] = useState('live')

  const handleRangeChange = async (val) => {
    setTimeRange(val)
    if (val !== 'live') {
      const minutes = val === '30m' ? 30 : val === '1h' ? 60 : val === '6h' ? 360 : 1440
      await loadHistory(minutes)
    }
  }

  return (
    <div style={{ background: '#0b0e13', padding: '0 0 8px 0' }}>

      {/* ── Grafana-like toolbar ───────────────────────────────────────── */}
      <div style={{
        display: 'flex', justifyContent: 'space-between', alignItems: 'center',
        padding: '10px 14px 10px', borderBottom: '1px solid #1f2533',
        background: '#0d1117', marginBottom: 8
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span style={{ color: '#e85d04', fontSize: 13, fontWeight: 700, letterSpacing: 1 }}>
            ◈ LEVEL TELEMETRY
          </span>
          <span style={{ color: '#4a5568', fontSize: 10 }}>ThingsBoard → MongoDB</span>
        </div>

        {/* Time-range picker */}
        <div style={{ display: 'flex', gap: 4 }}>
          {[
            { v: 'live', l: 'LIVE' },
            { v: '30m',  l: '30m'  },
            { v: '1h',   l: '1h'   },
            { v: '6h',   l: '6h'   },
            { v: '24h',  l: '24h'  },
          ].map(({ v, l }) => (
            <button key={v} onClick={() => handleRangeChange(v)} style={{
              padding: '3px 10px', fontSize: 11, fontWeight: 600, cursor: 'pointer',
              border: '1px solid',
              borderColor: timeRange === v ? '#4a8fa8' : '#1f2533',
              background:  timeRange === v ? '#1a3a4e' : 'transparent',
              color:       timeRange === v ? '#06b6d4' : '#5c6e82',
              borderRadius: 2
            }}>
              {l}{v === 'live' && <span style={{ color: '#22c55e', marginLeft: 4 }}>●</span>}
            </button>
          ))}
        </div>
      </div>

      {/* ── One panel per mixer-unit analog tag ──────────────────────── */}
      <div style={{ padding: '0 8px' }}>
        {SERIES.map(series => (
          <GrafanaPanel
            key={series.tag}
            series={series}
            data={history}
            currentValue={telemetry?.[series.tag]}
            timeRange={timeRange}
            onTimeRangeChange={handleRangeChange}
          />
        ))}
      </div>

      {/* ── Footer: data info ──────────────────────────────────────────── */}
      <div style={{ padding: '4px 14px 0', display: 'flex', justifyContent: 'space-between' }}>
        <span style={{ color: '#2d3a4e', fontSize: 10 }}>
          {history.length} point{history.length !== 1 ? 's' : ''} in buffer
        </span>
        <span style={{ color: '#2d3a4e', fontSize: 10 }}>
          Refresh: ThingsBoard WebSocket (10 s)  ·  Persist: MongoDB (30 s batch)
        </span>
      </div>
    </div>
  )
}
