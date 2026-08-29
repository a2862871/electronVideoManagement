import type { ParsedFilename } from './types'

const NUM_PATTERNS = [
  /^fc2-ppv-\d{5,8}/i,
  /^\d{6}-\d{2,5}/i,
  /^[a-z]{2,12}-?\d{2,8}/i,
]

const PART_PATTERN = /^(cd\d+|\d{1,2}|[a-z])$/i

/**
 * 从文件名主干（不含扩展名）提取番号与分集标识。
 * 例："JUFE-188-C" -> { num: "JUFE-188", part: "c" }
 *     "080113-395-cd1" -> { num: "080113-395", part: "cd1" }
 */
export function parseFilename(stem: string): ParsedFilename {
  const cleaned = stem.replace(/^\s*\[([^\]]+)\]/, '$1').trim()

  for (const pattern of NUM_PATTERNS) {
    const match = cleaned.match(pattern)
    if (!match) continue
    const num = match[0]
    const rest = cleaned.slice(num.length)
    const token = rest.split(/\s+/)[0].replace(/^[-_.\s]+/, '').replace(/[-_.]+$/, '')
    const part = PART_PATTERN.test(token) ? token.toLowerCase() : undefined
    return { num, part }
  }
  return {}
}

export function fileStem(filename: string): string {
  const dot = filename.lastIndexOf('.')
  return dot > 0 ? filename.slice(0, dot) : filename
}
