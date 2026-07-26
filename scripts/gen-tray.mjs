// Generates the menu-bar icon as a macOS template image (black + alpha, so the
// system tints it for light/dark menu bars). Written as a build step rather than
// a checked-in binary so the shape stays editable and there is no asset to lose.
//
// Minimal PNG encoder — zlib is in the Node standard library, so this needs no
// image dependency.

import { deflateSync } from 'node:zlib'
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const OUT = join(HERE, '..', 'dist-electron', 'assets')

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    table[n] = c
  }
  return table
})()

function crc32(buf) {
  let c = -1
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8)
  return (c ^ -1) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, rgba) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8 // bit depth
  ihdr[9] = 6 // colour type: RGBA
  // 10..12 are compression, filter and interlace methods — all zero.

  // Each scanline is prefixed with filter type 0 (none).
  const raw = Buffer.alloc(height * (width * 4 + 1))
  for (let y = 0; y < height; y++) {
    const rowStart = y * (width * 4 + 1)
    raw[rowStart] = 0
    rgba.copy(raw, rowStart + 1, y * width * 4, (y + 1) * width * 4)
  }

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

// Cat head in normalised coordinates: a circle for the skull, two triangles for
// ears. Supersampled 4x4 per pixel so the alpha edge is smooth at 16px.
const HEAD = { cx: 0.5, cy: 0.62, r: 0.32 }
const EARS = [
  [
    [0.23, 0.52],
    [0.29, 0.13],
    [0.52, 0.4],
  ],
  [
    [0.77, 0.52],
    [0.71, 0.13],
    [0.48, 0.4],
  ],
]

function sign(px, py, ax, ay, bx, by) {
  return (px - bx) * (ay - by) - (ax - bx) * (py - by)
}

function inTriangle(px, py, tri) {
  const d1 = sign(px, py, tri[0][0], tri[0][1], tri[1][0], tri[1][1])
  const d2 = sign(px, py, tri[1][0], tri[1][1], tri[2][0], tri[2][1])
  const d3 = sign(px, py, tri[2][0], tri[2][1], tri[0][0], tri[0][1])
  const hasNeg = d1 < 0 || d2 < 0 || d3 < 0
  const hasPos = d1 > 0 || d2 > 0 || d3 > 0
  return !(hasNeg && hasPos)
}

function covered(px, py) {
  const dx = px - HEAD.cx
  const dy = py - HEAD.cy
  if (dx * dx + dy * dy <= HEAD.r * HEAD.r) return true
  return EARS.some((tri) => inTriangle(px, py, tri))
}

function render(size) {
  const rgba = Buffer.alloc(size * size * 4)
  const SS = 4
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let hits = 0
      for (let sy = 0; sy < SS; sy++) {
        for (let sx = 0; sx < SS; sx++) {
          const px = (x + (sx + 0.5) / SS) / size
          const py = (y + (sy + 0.5) / SS) / size
          if (covered(px, py)) hits++
        }
      }
      const i = (y * size + x) * 4
      // Template images are pure black; only alpha carries the shape.
      rgba[i] = 0
      rgba[i + 1] = 0
      rgba[i + 2] = 0
      rgba[i + 3] = Math.round((hits / (SS * SS)) * 255)
    }
  }
  return encodePng(size, size, rgba)
}

mkdirSync(OUT, { recursive: true })
writeFileSync(join(OUT, 'trayTemplate.png'), render(16))
writeFileSync(join(OUT, 'trayTemplate@2x.png'), render(32))
console.log(`wrote ${join(OUT, 'trayTemplate.png')} (+@2x)`)
