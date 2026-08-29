import { XMLParser } from 'fast-xml-parser'
import type { ParsedNfo } from './types'

const parser = new XMLParser({
  ignoreAttributes: true,
  trimValues: true,
  isArray: (name) => name === 'actor' || name === 'tag' || name === 'genre',
})

const str = (v: unknown): string | undefined => {
  if (typeof v === 'string') {
    const t = v.trim()
    return t ? t : undefined
  }
  if (typeof v === 'number') return String(v)
  return undefined
}

const num = (v: unknown): number | undefined => {
  const n = Number(v)
  return Number.isFinite(n) ? n : undefined
}

/** 解析 Kodi 风格 NFO；非法或缺少 <movie> 根节点时返回 undefined。 */
export function parseNfo(xml: string): ParsedNfo | undefined {
  let doc: any
  try {
    doc = parser.parse(xml)
  } catch {
    return undefined
  }
  const m = doc?.movie
  if (!m) return undefined

  const set = m.set
  const series = str(m.series) ?? (typeof set === 'string' ? str(set) : str(set?.name))

  const actors: string[] = []
  if (Array.isArray(m.actor)) {
    for (const a of m.actor) {
      const name = str(a?.name)
      if (name) actors.push(name)
    }
  }

  const tagSource = [...(Array.isArray(m.tag) ? m.tag : []), ...(Array.isArray(m.genre) ? m.genre : [])]
  const tags = [...new Set(tagSource.map(str).filter((t): t is string => !!t))]

  return {
    num: str(m.num),
    title: str(m.title),
    originaltitle: str(m.originaltitle),
    plot: str(m.plot),
    releasedate: str(m.premiered) ?? str(m.releasedate) ?? str(m.release),
    year: num(m.year),
    runtime: num(m.runtime),
    studio: str(m.studio) ?? str(m.maker) ?? str(m.publisher) ?? str(m.label),
    series,
    rating: num(m.rating),
    actors,
    tags,
  }
}
