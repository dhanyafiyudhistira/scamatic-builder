import test from 'node:test'
import assert from 'node:assert/strict'
import { chartExportCsv, chartExportFileName, chartExportWorkbook, createChartExportData } from '../shared/chart-export.js'

const tags = [
  { id: '-level', name: '=Tank Level', unit: '@pct' },
  { id: 'flow', name: 'Flow', unit: 'm3/h' },
]

const histories = {
  '-level': [
    { timestamp: 500, value: 5 },
    { timestamp: 2000, value: 20, min: 18, max: 22, count: 4, resolutionMs: 1000, quality: 'good' },
  ],
  flow: [{ timestamp: 1500, value: 3.25, quality: 'good' }],
}

test('Chart export contains only displayed points in deterministic long-table order', () => {
  const data = createChartExportData({
    title: 'Mixer / Overview',
    rangeLabel: '1 HOUR',
    tags,
    histories,
    properties: { range: { from: 1000, to: 3000 }, historyLimit: 300 },
    exportedAt: Date.parse('2026-08-22T01:02:03.000Z'),
  })

  assert.equal(data.rows.length, 2)
  assert.deepEqual(data.rows.map(row => [row.timestamp, row.tagId, row.value]), [
    [1500, 'flow', 3.25],
    [2000, '-level', 20],
  ])
  assert.deepEqual(data.series.map(series => [series.id, series.sampleCount]), [['-level', 1], ['flow', 1]])
  assert.equal(chartExportFileName(data, 'csv'), 'mixer-overview-1-hour-2026-08-22T01-02-03.csv')
})

test('Chart CSV is UTF-8 Excel-friendly and neutralizes spreadsheet formulas', () => {
  const data = createChartExportData({
    tags,
    histories,
    properties: { range: { from: 1000, to: 3000 } },
    exportedAt: 1,
  })
  const csv = chartExportCsv(data)

  assert.match(csv, /^\uFEFFTimestamp UTC,Timestamp ISO,Series,Tag ID,Unit,Value,Minimum,Maximum,Samples,Resolution ms,Quality\r\n/)
  assert.match(csv, /1970-01-01T00:00:02\.000Z,1970-01-01T00:00:02\.000Z,'=Tank Level,'-level,'@pct,20,18,22,4,1000,good/)
  assert.equal(csv.includes('1970-01-01T00:00:00.500Z'), false)
})

test('Chart Excel export is a styled two-sheet XLSX package', () => {
  const data = createChartExportData({
    title: 'Mixer & Quality',
    rangeLabel: 'LIVE',
    tags,
    histories,
    properties: { range: { from: 1000, to: 3000 } },
    exportedAt: Date.parse('2026-08-22T01:02:03.000Z'),
  })
  const workbook = chartExportWorkbook(data)
  const entries = storedZipEntries(workbook)

  assert.equal(new DataView(workbook.buffer, workbook.byteOffset, workbook.byteLength).getUint32(0, true), 0x04034b50)
  assert.deepEqual([...entries.keys()], [
    '[Content_Types].xml',
    '_rels/.rels',
    'docProps/app.xml',
    'docProps/core.xml',
    'xl/workbook.xml',
    'xl/_rels/workbook.xml.rels',
    'xl/styles.xml',
    'xl/worksheets/sheet1.xml',
    'xl/worksheets/sheet2.xml',
  ])
  assert.match(entries.get('xl/workbook.xml'), /name="Chart Data"/)
  assert.match(entries.get('xl/workbook.xml'), /name="Summary"/)
  assert.match(entries.get('xl/worksheets/sheet1.xml'), /pane ySplit="1"/)
  assert.match(entries.get('xl/worksheets/sheet1.xml'), /autoFilter ref="A1:K3"/)
  assert.match(entries.get('xl/worksheets/sheet2.xml'), /Mixer &amp; Quality/)
  assert.match(entries.get('xl/styles.xml'), /formatCode="yyyy-mm-dd hh:mm:ss\.000"/)
})

function storedZipEntries(bytes) {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  const decoder = new TextDecoder()
  const entries = new Map()
  let offset = 0
  while (offset + 30 <= bytes.length && view.getUint32(offset, true) === 0x04034b50) {
    const compression = view.getUint16(offset + 8, true)
    const size = view.getUint32(offset + 18, true)
    const nameLength = view.getUint16(offset + 26, true)
    const extraLength = view.getUint16(offset + 28, true)
    assert.equal(compression, 0)
    const nameStart = offset + 30
    const dataStart = nameStart + nameLength + extraLength
    const name = decoder.decode(bytes.subarray(nameStart, nameStart + nameLength))
    entries.set(name, decoder.decode(bytes.subarray(dataStart, dataStart + size)))
    offset = dataStart + size
  }
  assert.equal(view.getUint32(offset, true), 0x02014b50)
  return entries
}
