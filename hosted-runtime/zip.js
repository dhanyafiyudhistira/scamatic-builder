import { deflateRawSync } from 'node:zlib'

// Standard ZIP/DEFLATE, UTF-8 paths, no executable installer or dependency required.
const table = Array.from({ length: 256 }, (_, n) => { for (let i = 0; i < 8; i++) n = n & 1 ? 0xedb88320 ^ (n >>> 1) : n >>> 1; return n >>> 0 })
function crc32(bytes) { let crc = 0xffffffff; for (const byte of bytes) crc = table[(crc ^ byte) & 255] ^ (crc >>> 8); return (crc ^ 0xffffffff) >>> 0 }
export function createZip(files) {
  const local = [], central = []
  let offset = 0
  for (const [path, content] of [...files].sort(([a], [b]) => a.localeCompare(b))) {
    if (!/^[a-zA-Z0-9_. /()\[\]-]+$/.test(path) || path.startsWith('/') || path.split('/').includes('..') || path.includes('\\')) throw new Error('Unsafe ZIP entry.')
    const name = Buffer.from(path), data = Buffer.from(content), compressed = deflateRawSync(data), crc = crc32(data)
    const header = Buffer.alloc(30)
    header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4); header.writeUInt16LE(0x800, 6); header.writeUInt16LE(8, 8)
    header.writeUInt16LE(33, 12); header.writeUInt32LE(crc, 14); header.writeUInt32LE(compressed.length, 18); header.writeUInt32LE(data.length, 22); header.writeUInt16LE(name.length, 26)
    const directory = Buffer.alloc(46)
    directory.writeUInt32LE(0x02014b50); directory.writeUInt16LE(20, 4); header.copy(directory, 6, 4, 30)
    directory.writeUInt32LE(offset, 42)
    local.push(header, name, compressed); central.push(directory, name)
    offset += header.length + name.length + compressed.length
  }
  if (files.size > 65535) throw new Error('Too many runtime package files.')
  const index = Buffer.concat(central), end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50); end.writeUInt16LE(files.size, 8); end.writeUInt16LE(files.size, 10); end.writeUInt32LE(index.length, 12); end.writeUInt32LE(offset, 16)
  return Buffer.concat([...local, index, end])
}
