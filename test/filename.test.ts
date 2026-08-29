import { describe, expect, it } from 'vitest'
import { parseFilename } from '../electron/main/library/filename'

describe('parseFilename', () => {
  it('提取番号和单字母分集', () => {
    expect(parseFilename('JUFE-188-C')).toEqual({ num: 'JUFE-188', part: 'c' })
  })

  it('提取数字番号和 cd 分集', () => {
    expect(parseFilename('080113-395-cd1')).toEqual({ num: '080113-395', part: 'cd1' })
  })

  it('无分集时 part 为 undefined', () => {
    expect(parseFilename('JUFE-188')).toEqual({ num: 'JUFE-188', part: undefined })
  })

  it('分集后带分辨率等杂项仍正确', () => {
    expect(parseFilename('JUFE-188-C 1080p x264')).toEqual({ num: 'JUFE-188', part: 'c' })
  })

  it('支持方括号前缀', () => {
    expect(parseFilename('[JUFE-188]夜袭妻 献身')).toEqual({ num: 'JUFE-188', part: undefined })
  })

  it('支持 fc2 番号', () => {
    expect(parseFilename('FC2-PPV-1234567')).toEqual({ num: 'FC2-PPV-1234567', part: undefined })
  })

  it('无法识别时返回空对象', () => {
    expect(parseFilename('随手拍的视频')).toEqual({})
  })
})
