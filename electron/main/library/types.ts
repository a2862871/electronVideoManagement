export interface ParsedNfo {
  num?: string
  title?: string
  originaltitle?: string
  plot?: string
  releasedate?: string
  year?: number
  runtime?: number
  studio?: string
  series?: string
  rating?: number
  actors: string[]
  tags: string[]
}

export interface ParsedFilename {
  num?: string
  part?: string
}
