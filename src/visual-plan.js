/** 先按内容选择整稿统一风格；页面只在该设计语言内变化构图。 */
import { createHash } from 'node:crypto'

export const VISUAL_DIRECTIONS = Object.freeze([
  { id: 'redline', theme: 'corporate' },
  { id: 'paper', theme: 'elegant' },
  { id: 'night', theme: 'dark' },
  { id: 'signal', theme: 'corporate' },
])

export async function assignVisualDesign(solution, { themeExplicit = false, reselect = false } = {}) {
  if (solution.visualDesign && !reselect) return solution
  const text = [solution.title, solution.subtitle, solution.meta?.product,
    ...solution.sections.flatMap(section => [section.heading, section.lead,
      ...section.blocks.filter(block => block.type !== 'quote').flatMap(block => [block.text, ...(block.items ?? [])])])]
    .filter(value => typeof value === 'string').join('\n')
  let id = 'redline'
  let basis = '企业业务方案：清晰网格与克制品牌色'
  if (/医疗|病历|医院|诊疗|政务|教育|金融|银行|保险/u.test(text)) {
    id = 'signal'; basis = '专业服务场景：清晰可信的统一蓝色网格'
  } else if (/营销|增长|品牌|传播|获客|渠道|线索/u.test(text)) {
    id = 'paper'; basis = '营销沟通场景：统一暖纸编辑式排版'
  } else if (/算力|技术架构|系统架构|系统集成|研发平台|开发者|数据安全|API/iu.test(text)) {
    id = 'night'; basis = '技术说明场景：统一深色高对比排版'
  }
  if (themeExplicit) {
    id = { corporate: 'redline', elegant: 'paper', dark: 'night' }[solution.theme] ?? id
    basis = '用户指定整稿主题'
  }
  const direction = VISUAL_DIRECTIONS.find(item => item.id === id)
  solution.visualDesign = { version: 2, direction: id,
    seed: createHash('sha256').update(text).digest().readUInt32BE(0), basis }
  if (!themeExplicit) solution.theme = direction.theme
  return solution
}
