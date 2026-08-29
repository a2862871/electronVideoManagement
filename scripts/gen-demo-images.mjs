import { deflateSync } from 'node:zlib'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    t[n] = c >>> 0
  }
  return t
})()

function crc32(buf) {
  let c = 0xffffffff
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8)
  return (c ^ 0xffffffff) >>> 0
}

function chunk(type, data) {
  const len = Buffer.alloc(4)
  len.writeUInt32BE(data.length)
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data])
  const crc = Buffer.alloc(4)
  crc.writeUInt32BE(crc32(body))
  return Buffer.concat([len, body, crc])
}

function encodePng(width, height, pixelAt) {
  const raw = Buffer.alloc(height * (1 + width * 3))
  for (let y = 0; y < height; y++) {
    raw[y * (1 + width * 3)] = 0
    for (let x = 0; x < width; x++) {
      const [r, g, b] = pixelAt(x, y)
      const o = y * (1 + width * 3) + 1 + x * 3
      raw[o] = r; raw[o + 1] = g; raw[o + 2] = b
    }
  }
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0)
  ihdr.writeUInt32BE(height, 4)
  ihdr[8] = 8; ihdr[9] = 2
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', Buffer.alloc(0)),
  ])
}

function mix(a, b, t) {
  return [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t].map(Math.round)
}

// 简易海报：对角渐变 + 中部横向光带 + 底部深色标题区
function poster(w, h, top, bottom, band) {
  return encodePng(w, h, (x, y) => {
    const t = (x / w + y / h) / 2
    let c = mix(top, bottom, t)
    const bandDist = Math.abs(y - h * 0.38) / (h * 0.06)
    if (bandDist < 1) c = mix(c, band, (1 - bandDist) * 0.55)
    if (y > h * 0.82) c = mix(c, [10, 12, 18], (y - h * 0.82) / (h * 0.18))
    return c
  })
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..', 'demo-lib')

const targets = [
  { file: join(root, '佐山爱', 'JUFE-188', 'poster.png'), w: 600, h: 900, top: [120, 30, 40], bottom: [30, 15, 35], band: [240, 180, 120] },
  { file: join(root, '三上悠亜', 'MIDE-770', 'poster.png'), w: 600, h: 900, top: [20, 90, 110], bottom: [60, 20, 90], band: [255, 220, 100] },
  { file: join(root, 'くるみひな', '080113-395', 'fanart.png'), w: 960, h: 540, top: [240, 140, 60], bottom: [90, 40, 80], band: [255, 240, 200] },
]

for (const t of targets) {
  mkdirSync(dirname(t.file), { recursive: true })
  writeFileSync(t.file, poster(t.w, t.h, t.top, t.bottom, t.band))
  console.log('written', t.file, `${t.w}x${t.h}`)
}
