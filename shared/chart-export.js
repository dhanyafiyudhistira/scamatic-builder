import { buildChartModel } from './chart-data.js'

export const CHART_XLSX_MIME_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'

const DATA_COLUMNS = Object.freeze([
  ['Timestamp UTC', 'timestamp', 'date'],
  ['Timestamp ISO', 'timestampIso', 'text'],
  ['Series', 'seriesName', 'text'],
  ['Tag ID', 'tagId', 'text'],
  ['Unit', 'unit', 'text'],
  ['Value', 'value', 'number'],
  ['Minimum', 'min', 'number'],
  ['Maximum', 'max', 'number'],
  ['Samples', 'count', 'integer'],
  ['Resolution ms', 'resolutionMs', 'integer'],
  ['Quality', 'quality', 'text'],
])

export function createChartExportData({ title = 'Telemetry Chart', rangeLabel = 'LIVE', tags = [], histories = {}, properties = {}, exportedAt = Date.now() } = {}) {
  const model = buildChartModel(tags, histories, properties)
  const rows = model.series.flatMap((series, seriesIndex) => series.points.map(point => ({
    timestamp: point.timestamp,
    timestampIso: new Date(point.timestamp).toISOString(),
    seriesIndex,
    seriesName: series.name,
    tagId: series.id,
    unit: series.unit,
    value: point.value,
    min: point.min,
    max: point.max,
    count: point.count,
    resolutionMs: point.resolutionMs,
    quality: point.quality,
  }))).sort((left, right) => left.timestamp - right.timestamp || left.seriesIndex - right.seriesIndex)

  return {
    title: boundedText(title, 'Telemetry Chart', 120),
    rangeLabel: boundedText(rangeLabel, 'LIVE', 40),
    exportedAt: finiteTimestamp(exportedAt, Date.now()),
    xDomain: model.xDomain,
    series: model.series.map(series => ({
      id: series.id,
      name: series.name,
      unit: series.unit,
      sampleCount: series.points.length,
    })),
    rows,
  }
}

export function chartExportCsv(data) {
  const header = DATA_COLUMNS.map(([label]) => csvCell(label)).join(',')
  const rows = data.rows.map(row => DATA_COLUMNS.map(([, key, type]) => {
    if (type === 'date') return csvCell(new Date(row[key]).toISOString())
    return csvCell(row[key])
  }).join(','))
  return `\uFEFF${[header, ...rows].join('\r\n')}\r\n`
}

export function chartExportWorkbook(data) {
  const createdAt = new Date(finiteTimestamp(data.exportedAt, Date.now()))
  const files = [
    ['[Content_Types].xml', contentTypesXml()],
    ['_rels/.rels', packageRelationshipsXml()],
    ['docProps/app.xml', appPropertiesXml()],
    ['docProps/core.xml', corePropertiesXml(data.title, createdAt)],
    ['xl/workbook.xml', workbookXml()],
    ['xl/_rels/workbook.xml.rels', workbookRelationshipsXml()],
    ['xl/styles.xml', stylesXml()],
    ['xl/worksheets/sheet1.xml', dataWorksheetXml(data)],
    ['xl/worksheets/sheet2.xml', summaryWorksheetXml(data)],
  ]
  return createStoredZip(files, createdAt)
}

export function chartExportFileName(data, extension) {
  const safeExtension = extension === 'xlsx' ? 'xlsx' : 'csv'
  const title = slugPart(data?.title) || 'telemetry-chart'
  const range = slugPart(data?.rangeLabel) || 'live'
  const timestamp = new Date(finiteTimestamp(data?.exportedAt, Date.now())).toISOString().replaceAll(':', '-').slice(0, 19)
  return `${title}-${range}-${timestamp}.${safeExtension}`
}

function dataWorksheetXml(data) {
  const headerCells = DATA_COLUMNS.map(([label], index) => inlineStringCell(`${columnName(index + 1)}1`, label, 1)).join('')
  const bodyRows = data.rows.map((row, rowIndex) => {
    const excelRow = rowIndex + 2
    const cells = DATA_COLUMNS.map(([, key, type], columnIndex) => {
      const reference = `${columnName(columnIndex + 1)}${excelRow}`
      const value = row[key]
      if (value == null || value === '') return ''
      if (type === 'date') return numericCell(reference, excelDate(value), 2)
      if (type === 'number') return numericCell(reference, value, 3)
      if (type === 'integer') return numericCell(reference, value, 4)
      return inlineStringCell(reference, value)
    }).join('')
    return `<row r="${excelRow}">${cells}</row>`
  }).join('')
  const lastRow = Math.max(1, data.rows.length + 1)
  return xmlDocument(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:K${lastRow}"/><sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="24" customWidth="1"/><col min="2" max="2" width="28" customWidth="1"/><col min="3" max="5" width="20" customWidth="1"/><col min="6" max="8" width="16" customWidth="1"/><col min="9" max="11" width="15" customWidth="1"/></cols><sheetData><row r="1" ht="22" customHeight="1">${headerCells}</row>${bodyRows}</sheetData><autoFilter ref="A1:K${lastRow}"/></worksheet>`)
}

function summaryWorksheetXml(data) {
  const from = Number(data.xDomain?.[0])
  const to = Number(data.xDomain?.[1])
  const metadata = [
    ['Chart', data.title, 'text'],
    ['Range', data.rangeLabel, 'text'],
    ['Exported at UTC', data.exportedAt, 'date'],
    ['Displayed from UTC', from, 'date'],
    ['Displayed to UTC', to, 'date'],
    ['Series count', data.series.length, 'integer'],
    ['Data rows', data.rows.length, 'integer'],
  ]
  const metadataRows = metadata.map(([label, value, type], index) => {
    const row = index + 3
    const valueCell = type === 'date'
      ? numericCell(`B${row}`, excelDate(value), 2)
      : type === 'integer'
        ? numericCell(`B${row}`, value, 4)
        : inlineStringCell(`B${row}`, value)
    return `<row r="${row}">${inlineStringCell(`A${row}`, label, 6)}${valueCell}</row>`
  }).join('')
  const seriesHeaderRow = 11
  const seriesRows = data.series.map((series, index) => {
    const row = seriesHeaderRow + index + 1
    return `<row r="${row}">${inlineStringCell(`A${row}`, series.name)}${inlineStringCell(`B${row}`, series.id)}${inlineStringCell(`C${row}`, series.unit)}${numericCell(`D${row}`, series.sampleCount, 4)}</row>`
  }).join('')
  const lastSeriesRow = Math.max(seriesHeaderRow, seriesHeaderRow + data.series.length)
  return xmlDocument(`<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><dimension ref="A1:D${lastSeriesRow}"/><sheetViews><sheetView workbookViewId="0"/></sheetViews><sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="1" width="25" customWidth="1"/><col min="2" max="2" width="32" customWidth="1"/><col min="3" max="3" width="18" customWidth="1"/><col min="4" max="4" width="16" customWidth="1"/></cols><sheetData><row r="1" ht="26" customHeight="1">${inlineStringCell('A1', 'Scamatic Builder Chart Export', 5)}</row>${metadataRows}<row r="${seriesHeaderRow}" ht="22" customHeight="1">${inlineStringCell(`A${seriesHeaderRow}`, 'Series', 1)}${inlineStringCell(`B${seriesHeaderRow}`, 'Tag ID', 1)}${inlineStringCell(`C${seriesHeaderRow}`, 'Unit', 1)}${inlineStringCell(`D${seriesHeaderRow}`, 'Samples', 1)}</row>${seriesRows}</sheetData><mergeCells count="1"><mergeCell ref="A1:D1"/></mergeCells><autoFilter ref="A${seriesHeaderRow}:D${lastSeriesRow}"/></worksheet>`)
}

function contentTypesXml() {
  return xmlDocument('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/><Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/><Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/><Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/><Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/><Override PartName="/xl/worksheets/sheet2.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/></Types>')
}

function packageRelationshipsXml() {
  return xmlDocument('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties" Target="docProps/core.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties" Target="docProps/app.xml"/></Relationships>')
}

function workbookXml() {
  return xmlDocument('<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><bookViews><workbookView xWindow="0" yWindow="0" windowWidth="24000" windowHeight="12000"/></bookViews><sheets><sheet name="Chart Data" sheetId="1" r:id="rId1"/><sheet name="Summary" sheetId="2" r:id="rId2"/></sheets><calcPr calcId="191029" fullCalcOnLoad="1"/></workbook>')
}

function workbookRelationshipsXml() {
  return xmlDocument('<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/><Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet2.xml"/><Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>')
}

function appPropertiesXml() {
  return xmlDocument('<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Scamatic Builder</Application><DocSecurity>0</DocSecurity><ScaleCrop>false</ScaleCrop><HeadingPairs><vt:vector size="2" baseType="variant"><vt:variant><vt:lpstr>Worksheets</vt:lpstr></vt:variant><vt:variant><vt:i4>2</vt:i4></vt:variant></vt:vector></HeadingPairs><TitlesOfParts><vt:vector size="2" baseType="lpstr"><vt:lpstr>Chart Data</vt:lpstr><vt:lpstr>Summary</vt:lpstr></vt:vector></TitlesOfParts><Company></Company><LinksUpToDate>false</LinksUpToDate><SharedDoc>false</SharedDoc><HyperlinksChanged>false</HyperlinksChanged><AppVersion>1.0</AppVersion></Properties>')
}

function corePropertiesXml(title, createdAt) {
  const timestamp = createdAt.toISOString()
  return xmlDocument(`<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:dcmitype="http://purl.org/dc/dcmitype/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${xmlEscape(title)}</dc:title><dc:creator>Scamatic Builder</dc:creator><cp:lastModifiedBy>Scamatic Builder</cp:lastModifiedBy><dcterms:created xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:created><dcterms:modified xsi:type="dcterms:W3CDTF">${timestamp}</dcterms:modified></cp:coreProperties>`)
}

function stylesXml() {
  return xmlDocument('<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><numFmts count="2"><numFmt numFmtId="164" formatCode="yyyy-mm-dd hh:mm:ss.000"/><numFmt numFmtId="165" formatCode="0.############"/></numFmts><fonts count="3"><font><sz val="11"/><color theme="1"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/><family val="2"/></font><font><b/><sz val="11"/><color rgb="FF17232C"/><name val="Calibri"/><family val="2"/></font></fonts><fills count="4"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill><fill><patternFill patternType="solid"><fgColor rgb="FF252A30"/><bgColor indexed="64"/></patternFill></fill><fill><patternFill patternType="solid"><fgColor rgb="FFB87B10"/><bgColor indexed="64"/></patternFill></fill></fills><borders count="2"><border><left/><right/><top/><bottom/><diagonal/></border><border><left/><right/><top/><bottom style="thin"><color rgb="FF8D969C"/></bottom><diagonal/></border></borders><cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs><cellXfs count="7"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/><xf numFmtId="0" fontId="1" fillId="2" borderId="1" xfId="0" applyFont="1" applyFill="1" applyBorder="1" applyAlignment="1"><alignment horizontal="center" vertical="center"/></xf><xf numFmtId="164" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="165" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="1" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/><xf numFmtId="0" fontId="1" fillId="3" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment horizontal="left" vertical="center"/></xf><xf numFmtId="0" fontId="2" fillId="0" borderId="0" xfId="0" applyFont="1"/></cellXfs><cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles></styleSheet>')
}

function inlineStringCell(reference, value, style = 0) {
  const styleAttribute = style ? ` s="${style}"` : ''
  return `<c r="${reference}" t="inlineStr"${styleAttribute}><is><t xml:space="preserve">${xmlEscape(value)}</t></is></c>`
}

function numericCell(reference, value, style = 0) {
  const number = Number(value)
  if (!Number.isFinite(number)) return ''
  const styleAttribute = style ? ` s="${style}"` : ''
  return `<c r="${reference}"${styleAttribute}><v>${number}</v></c>`
}

function excelDate(timestamp) {
  const value = Number(timestamp)
  return Number.isFinite(value) ? value / 86_400_000 + 25_569 : 25_569
}

function xmlDocument(content) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>${content}`
}

function xmlEscape(value) {
  return String(value ?? '').replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&apos;')
}

function csvCell(value) {
  if (value == null) return ''
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  let text = String(value).replaceAll('\0', '')
  if (/^[=+\-@\t\r]/.test(text)) text = `'${text}`
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text
}

function boundedText(value, fallback, maxLength) {
  const text = String(value || '').trim()
  return (text || fallback).slice(0, maxLength)
}

function finiteTimestamp(value, fallback) {
  const timestamp = Number(value)
  return Number.isFinite(timestamp) ? timestamp : fallback
}

function slugPart(value) {
  return String(value || '')
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
}

function columnName(index) {
  let value = index
  let name = ''
  while (value > 0) {
    value -= 1
    name = String.fromCharCode(65 + value % 26) + name
    value = Math.floor(value / 26)
  }
  return name
}

function createStoredZip(files, timestamp) {
  const encoder = new TextEncoder()
  const entries = files.map(([name, content]) => {
    const nameBytes = encoder.encode(name)
    const data = typeof content === 'string' ? encoder.encode(content) : content
    return { nameBytes, data, crc: crc32(data) }
  })
  const { time, date } = dosTimestamp(timestamp)
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const localHeader = new Uint8Array(30 + entry.nameBytes.length)
    const localView = new DataView(localHeader.buffer)
    localView.setUint32(0, 0x04034b50, true)
    localView.setUint16(4, 20, true)
    localView.setUint16(6, 0x0800, true)
    localView.setUint16(8, 0, true)
    localView.setUint16(10, time, true)
    localView.setUint16(12, date, true)
    localView.setUint32(14, entry.crc, true)
    localView.setUint32(18, entry.data.length, true)
    localView.setUint32(22, entry.data.length, true)
    localView.setUint16(26, entry.nameBytes.length, true)
    localHeader.set(entry.nameBytes, 30)
    localParts.push(localHeader, entry.data)

    const centralHeader = new Uint8Array(46 + entry.nameBytes.length)
    const centralView = new DataView(centralHeader.buffer)
    centralView.setUint32(0, 0x02014b50, true)
    centralView.setUint16(4, 20, true)
    centralView.setUint16(6, 20, true)
    centralView.setUint16(8, 0x0800, true)
    centralView.setUint16(10, 0, true)
    centralView.setUint16(12, time, true)
    centralView.setUint16(14, date, true)
    centralView.setUint32(16, entry.crc, true)
    centralView.setUint32(20, entry.data.length, true)
    centralView.setUint32(24, entry.data.length, true)
    centralView.setUint16(28, entry.nameBytes.length, true)
    centralView.setUint32(42, offset, true)
    centralHeader.set(entry.nameBytes, 46)
    centralParts.push(centralHeader)
    offset += localHeader.length + entry.data.length
  }
  const centralSize = centralParts.reduce((size, part) => size + part.length, 0)
  const end = new Uint8Array(22)
  const endView = new DataView(end.buffer)
  endView.setUint32(0, 0x06054b50, true)
  endView.setUint16(8, entries.length, true)
  endView.setUint16(10, entries.length, true)
  endView.setUint32(12, centralSize, true)
  endView.setUint32(16, offset, true)
  return concatBytes([...localParts, ...centralParts, end])
}

function concatBytes(parts) {
  const output = new Uint8Array(parts.reduce((length, part) => length + part.length, 0))
  let offset = 0
  for (const part of parts) {
    output.set(part, offset)
    offset += part.length
  }
  return output
}

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, index) => {
  let value = index
  for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ value >>> 1 : value >>> 1
  return value >>> 0
})

function crc32(bytes) {
  let crc = 0xffffffff
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ crc >>> 8
  return (crc ^ 0xffffffff) >>> 0
}

function dosTimestamp(value) {
  const dateValue = value instanceof Date ? value : new Date(value)
  const year = Math.max(1980, Math.min(2107, dateValue.getUTCFullYear()))
  return {
    time: dateValue.getUTCHours() << 11 | dateValue.getUTCMinutes() << 5 | Math.floor(dateValue.getUTCSeconds() / 2),
    date: year - 1980 << 9 | dateValue.getUTCMonth() + 1 << 5 | dateValue.getUTCDate(),
  }
}
