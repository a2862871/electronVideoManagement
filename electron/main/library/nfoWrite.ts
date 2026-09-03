import { XMLBuilder, XMLParser } from 'fast-xml-parser'
import { readFile, rename, writeFile } from 'node:fs/promises'

/**
 * 把库内修改同步写回 Kodi 风格 NFO。
 * 策略：解析现有 XML（保留属性/注释/未知节点），只改动受管理的元素后重新序列化，
 * 避免像「整体重新生成」那样丢掉应用不认识的字段（如 <id>、<art> 等）。
 */

export interface NfoChanges {
  title?: string | null
  originaltitle?: string | null
  num?: string | null
  plot?: string | null
  releasedate?: string | null
  studio?: string | null
  series?: string | null
  rating?: number | null
  runtime?: number | null
  /** set = 整体替换演员列表；add = 仅追加缺失的名字 */
  actors?: { mode: 'set' | 'add'; names: string[] }
  /** set = 整体替换标签列表；add = 仅追加缺失的名字 */
  tags?: { mode: 'set' | 'add'; names: string[] }
}

// 可能重复出现且需保持多个的元素（未列入的重复元素会在往返解析中合并，故尽量列全）
const REPEATED = ['actor', 'tag', 'genre', 'thumb', 'uniqueid', 'credits', 'country']

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  commentPropName: '#comment',
  trimValues: true,
  isArray: (name) => REPEATED.includes(name),
})

const builder = new XMLBuilder({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  commentPropName: '#comment',
  format: true,
  indentBy: '  ',
  suppressEmptyNode: true,
})

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : v === undefined ? [] : [v])

/** 读取元素文本（兼容字符串与带属性的对象形式） */
function textOf(el: unknown): string {
  if (typeof el === 'string' || typeof el === 'number') return String(el).trim()
  if (el && typeof el === 'object') {
    const t = (el as Record<string, unknown>)['#text']
    return t == null ? '' : String(t).trim()
  }
  return ''
}

/** 值为 null/空 → 删除所有候选元素；否则更新第一个已存在的候选，不存在则新建第一个候选。
 *  已有元素是「带属性的对象」（如 <rating max="10">7.5</rating>）时只改其文本，保留属性。 */
function setScalar(m: Record<string, unknown>, candidates: string[], value: string | number | null): void {
  if (value == null || value === '') {
    for (const n of candidates) delete m[n]
    return
  }
  const existing = candidates.find((n) => m[n] !== undefined)
  const cur = existing !== undefined ? m[existing] : undefined
  if (cur && typeof cur === 'object' && !Array.isArray(cur) && '#text' in (cur as Record<string, unknown>)) {
    ;(cur as Record<string, unknown>)['#text'] = value
  } else {
    m[existing ?? candidates[0]] = value
  }
}

/** 解析 → 修改 → 序列化并写回（先写临时文件再改名，避免写一半损坏） */
export async function updateNfoFile(nfoPath: string, changes: NfoChanges): Promise<void> {
  const doc = parser.parse(await readFile(nfoPath, 'utf-8')) as Record<string, any>
  const m = doc?.movie
  if (!m || typeof m !== 'object') throw new Error('NFO 缺少 <movie> 根节点')

  if (changes.title !== undefined) setScalar(m, ['title'], changes.title)
  if (changes.originaltitle !== undefined) setScalar(m, ['originaltitle'], changes.originaltitle)
  if (changes.num !== undefined) setScalar(m, ['num'], changes.num)
  if (changes.plot !== undefined) setScalar(m, ['plot'], changes.plot)
  if (changes.rating !== undefined) setScalar(m, ['rating'], changes.rating)
  if (changes.runtime !== undefined) setScalar(m, ['runtime'], changes.runtime)
  // 读取时兼容 premiered/releasedate/release 三种写法，写回时优先复用已有的那个
  if (changes.releasedate !== undefined) setScalar(m, ['premiered', 'releasedate', 'release'], changes.releasedate)
  if (changes.studio !== undefined) setScalar(m, ['studio', 'maker', 'publisher', 'label'], changes.studio)
  if (changes.series !== undefined) {
    if (changes.series == null || changes.series === '') {
      delete m.series
    } else if (m.series !== undefined) {
      m.series = changes.series
    } else if (typeof m.set === 'string') {
      m.set = changes.series
    } else if (m.set && typeof m.set === 'object' && m.set.name !== undefined) {
      m.set.name = changes.series
    } else {
      m.series = changes.series
    }
  }

  if (changes.actors) {
    const current = asArray(m.actor)
    const names = current.map((a) => textOf((a as Record<string, unknown>)?.name)).filter(Boolean)
    if (changes.actors.mode === 'set') {
      if (changes.actors.names.length === 0) delete m.actor
      else m.actor = changes.actors.names.map((n) => ({ name: n }))
    } else {
      const have = new Set(names)
      const add = changes.actors.names.filter((n) => !have.has(n))
      if (add.length > 0) m.actor = [...current, ...add.map((n) => ({ name: n }))]
    }
  }

  if (changes.tags) {
    const tagEls = asArray(m.tag)
    const genreEls = asArray(m.genre)
    const names = [...tagEls, ...genreEls].map((t) => textOf(t)).filter(Boolean)
    if (changes.tags.mode === 'set') {
      delete m.genre
      if (changes.tags.names.length === 0) delete m.tag
      else m.tag = changes.tags.names
    } else {
      const have = new Set(names)
      const add = changes.tags.names.filter((n) => !have.has(n))
      if (add.length > 0) m.tag = [...tagEls, ...add]
    }
  }

  let xml = builder.build(doc) as string
  if (!xml.startsWith('<?xml')) xml = `<?xml version="1.0" encoding="UTF-8"?>\n${xml}`
  const tmp = `${nfoPath}.tmp`
  await writeFile(tmp, xml, 'utf-8')
  await rename(tmp, nfoPath)
}
