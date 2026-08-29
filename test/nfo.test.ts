import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseNfo } from '../electron/main/library/nfo'

const fixture = (name: string) => readFileSync(join(__dirname, 'fixtures', name), 'utf-8')

describe('parseNfo', () => {
  it('解析 JUFE-188-C.nfo', () => {
    const nfo = parseNfo(fixture('JUFE-188-C.nfo'))
    expect(nfo).toBeDefined()
    expect(nfo!.num).toBe('JUFE-188')
    expect(nfo!.title).toContain('JUFE-188')
    expect(nfo!.actors).toEqual(['佐山爱'])
    expect(nfo!.studio).toBe('Fitch')
    expect(nfo!.series).toBe('夜●い妻')
    expect(nfo!.releasedate).toBe('2020-07-01')
    expect(nfo!.runtime).toBe(130)
    expect(nfo!.rating).toBe(4.5)
    expect(nfo!.tags).toContain('巨乳')
    expect(nfo!.tags).toContain('中文字幕')
    expect(nfo!.tags.length).toBeGreaterThanOrEqual(10)
  })

  it('解析 080113-395-cd1.nfo', () => {
    const nfo = parseNfo(fixture('080113-395-cd1.nfo'))
    expect(nfo).toBeDefined()
    expect(nfo!.num).toBe('080113-395')
    expect(nfo!.actors).toEqual(['くるみひな'])
    expect(nfo!.studio).toBe('加勒比')
    expect(nfo!.series).toBe('加勒比')
    expect(nfo!.releasedate).toBe('2013-08-01')
    expect(nfo!.runtime).toBe(73)
    expect(nfo!.plot).toBeUndefined()
    expect(nfo!.tags).toContain('无码')
    expect(nfo!.tags).not.toContain('')
  })

  it('非法内容返回 undefined', () => {
    expect(parseNfo('这不是xml')).toBeUndefined()
    expect(parseNfo('<movie2></movie2>')).toBeUndefined()
  })

  it('tag 与 genre 合并去重', () => {
    const nfo = parseNfo(fixture('JUFE-188-C.nfo'))
    const unique = new Set(nfo!.tags)
    expect(unique.size).toBe(nfo!.tags.length)
  })
})
