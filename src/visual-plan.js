/** 先按内容选择整稿统一风格；页面只在该设计语言内变化构图。 */
import { createHash } from 'node:crypto'
import { mkdir, readFile, writeFile, rename } from 'node:fs/promises'
import path from 'node:path'
import { homedir } from 'node:os'

export const DESIGN_PALETTES = Object.freeze({
  rust: { accent: '#a34a14', cover: '#613418', tint: '#faf3eb' },
  forest: { accent: '#246849', cover: '#183e30', tint: '#eef5f0' },
  wine: { accent: '#97324f', cover: '#562339', tint: '#fbf0f3' },
  indigo: { accent: '#45449a', cover: '#292956', tint: '#f3f2fa' },
  crimson: { accent: '#bf211b', cover: '#622723', tint: '#fff3f1' },
  ocean: { accent: '#156a79', cover: '#164a55', tint: '#eef6f7' },
  graphite: { accent: '#536072', cover: '#27323d', tint: '#f0f3f6' },
  'night-ocean': { accent: '#69d2dc', cover: '#133d46', tint: '#152b33', dark: true },
  'night-wine': { accent: '#f5a8bf', cover: '#47243a', tint: '#2c2030', dark: true },
  'night-forest': { accent: '#8cddae', cover: '#173e2e', tint: '#182e26', dark: true },
})
const paletteSets = { paper: ['rust', 'forest', 'wine', 'indigo'],
  redline: ['crimson', 'ocean', 'graphite'], signal: ['ocean', 'indigo', 'forest'],
  night: ['night-ocean', 'night-wine', 'night-forest'] }
let selectionQueue = Promise.resolve()
const memoryState = {}

function nextPalette(direction, statePath) {
  const task = selectionQueue.then(async () => {
    let state = memoryState
    if (statePath) {
      try { const parsed = JSON.parse(await readFile(statePath, 'utf8')); if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) state = parsed }
      catch (error) { if (error.code !== 'ENOENT') console.warn('[wlyd-presales] palette history unavailable; using process history') }
    }
    const options = paletteSets[direction]
    const previous = options.indexOf(state[direction])
    const palette = options[(previous + 1) % options.length]
    state[direction] = palette
    memoryState[direction] = palette
    if (statePath) {
      try {
        await mkdir(path.dirname(statePath), { recursive: true, mode: 0o700 })
        const temporary = `${statePath}.${process.pid}.tmp`
        await writeFile(temporary, JSON.stringify(state), { mode: 0o600 })
        await rename(temporary, statePath)
      } catch { console.warn('[wlyd-presales] palette history could not be saved; using process history') }
    }
    return palette
  })
  selectionQueue = task.catch(() => {})
  return task
}

export const VISUAL_DIRECTIONS = Object.freeze([
  { id: 'redline', theme: 'corporate' },
  { id: 'paper', theme: 'elegant' },
  { id: 'night', theme: 'dark' },
  { id: 'signal', theme: 'corporate' },
])

export async function assignVisualDesign(solution, { themeExplicit = false, reselect = false,
  statePath = path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'wlyd-presales-editor', 'design-state.json') } = {}) {
  if (solution.visualDesign && !reselect) return solution
  const text = [solution.title, solution.subtitle, solution.meta?.product,
    ...solution.sections.flatMap(section => [section.heading, section.lead,
      ...section.blocks.filter(block => block.type !== 'quote').flatMap(block => [block.text, ...(block.items ?? [])])])]
    .filter(value => typeof value === 'string').join('\n')
  let id = 'redline'
  let basis = '企业业务方案：清晰网格与克制品牌色'
  if (/医疗|病历|医院|诊疗|政务|教育|金融|银行|保险/u.test(text)) {
    id = 'signal'; basis = '专业服务场景：清晰可信的统一网格'
  } else if (/营销|增长|品牌|传播|获客|渠道|线索/u.test(text)) {
    id = 'paper'; basis = '营销沟通场景：统一编辑式排版'
  } else if (/算力|技术架构|系统架构|系统集成|研发平台|开发者|数据安全|API/iu.test(text)) {
    id = 'night'; basis = '技术说明场景：统一深色高对比排版'
  }
  if (themeExplicit) {
    id = { corporate: 'redline', elegant: 'paper', dark: 'night' }[solution.theme] ?? id
    basis = '用户指定整稿主题'
  }
  const direction = VISUAL_DIRECTIONS.find(item => item.id === id)
  const palette = themeExplicit ? undefined : await nextPalette(id, statePath)
  solution.visualDesign = { version: 3, direction: id, ...(palette ? { palette } : {}),
    seed: createHash('sha256').update(`${text}\n${palette ?? ''}`).digest().readUInt32BE(0), basis,
    pages: solution.sections.map(section => ({ heading: section.heading,
      relationship: section.blocks.some(block => block.type === 'chart') ? 'data'
        : section.blocks.some(block => block.type === 'steps') ? 'sequence'
          : section.blocks.some(block => block.type === 'image') ? 'evidence'
            : section.blocks.some(block => block.title) ? 'parallel-arguments' : 'explanation' })) }
  if (!themeExplicit) solution.theme = direction.theme
  return solution
}
