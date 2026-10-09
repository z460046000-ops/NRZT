/** 售前大纲：从材料建议章节、接受对话调整，并保存待确认状态。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

// 大纲主题与章节语义类型(wlyd_solution 的 SECTION_KINDS)对齐;pains/solution 由对应关系自动生成不进大纲。
const TOPICS = ['context', 'problem_solution', 'capabilities', 'implementation', 'boundary', 'company',
  'trends', 'architecture', 'scenarios', 'service', 'custom']
const LABELS = {
  context: '背景与目标', problem_solution: '痛点与对应方案', capabilities: '能力与场景',
  implementation: '实施与使用', boundary: '适用边界', company: '公司信息',
  trends: '趋势与背景', architecture: '产品架构', scenarios: '场景支持', service: '服务保障',
  custom: '材料特定',
}
const KEYWORDS = [
  ['implementation', /实施|部署|上线|交付|培训|流程/u],
  ['boundary', /限制|边界|不支持|适用条件|风险/u],
  ['capabilities', /功能|能力|支持|提供|产品|平台/u],
  ['company', /公司|集团|资质|品牌/u],
]

/** 标题猜主题:模型没给有效 topics 时按标题关键词归类,猜不出归入材料特定(custom)。 */
const TOPIC_HINTS = [
  ['implementation', /实施|部署|上线|交付|培训|计划|路径|流程/u],
  ['boundary', /限制|边界|不支持|适用|风险|待确认|条件/u],
  ['problem_solution', /痛点|问题|方案|解决|对应|挑战/u],
  ['company', /公司|集团|资质|品牌|介绍/u],
  ['architecture', /架构|组成|层次|模块/u],
  ['scenarios', /场景|应用/u],
  ['service', /服务|保障|运维|售后/u],
  ['capabilities', /功能|能力|支持|提供|产品|平台|指标/u],
  ['trends', /背景|趋势|政策|现状|时机|目标/u],
]

function guessTopic(heading) {
  for (const [topic, re] of TOPIC_HINTS) {
    if (re.test(heading)) return topic
  }
  return 'custom'
}

function unique(values) { return [...new Set(values)] }
function paths(manifest) { return (manifest.files ?? []).filter(file => file.excerpt?.trim()).map(file => file.path) }
function entry(heading, topics, sourcePaths) { return { id: randomUUID(), heading, topics, sourcePaths: unique(sourcePaths) } }

/**
 * 模型候选按节抢救:标题是材料归纳的结论,一律保留;无效主题按标题归类,
 * 来源只保留材料里真实存在的路径。有对应关系时痛点—方案章不可缺席,缺了自动补;
 * 抢救后不足 3 章才回退到关键词模板。
 */
export function suggestOutline(manifest, links = [], candidate) {
  const available = paths(manifest)
  if (Array.isArray(candidate) && candidate.length >= 2) {
    const seen = new Set()
    const sections = []
    for (const item of candidate) {
      if (!item || typeof item.heading !== 'string' || !item.heading.trim()
        || item.heading.trim().length > 48 || seen.has(item.heading.trim())) continue
      const heading = item.heading.trim().replace(/^(?:\d+[.．、]\s+|第[一二三四五六七八九十\d]+章\s*)/u, '').trim()
      if (!heading || seen.has(heading)) continue
      const topics = unique((Array.isArray(item.topics) ? item.topics : []).filter(topic => TOPICS.includes(topic)))
      if (topics.length === 0) topics.push(guessTopic(heading))
      const sourcePaths = unique((Array.isArray(item.sourcePaths) ? item.sourcePaths : [])
        .filter(source => available.includes(source)))
      sections.push(entry(heading, topics, sourcePaths))
      seen.add(heading)
    }
    if (links.length && !sections.some(section => section.topics.includes('problem_solution'))) {
      const evidence = unique(links.flatMap(link => [link.painEvidence.path, link.solutionEvidence.path]))
        .filter(sourcePath => available.includes(sourcePath))
      sections.splice(Math.min(1, sections.length), 0, entry('客户问题与对应方案', ['problem_solution'], evidence))
    }
    if (sections.length >= 3) return sections.slice(0, 8)
  }
  const text = (manifest.files ?? []).map(file => file.excerpt ?? '').join('\n')
  const matched = topic => KEYWORDS.find(([key]) => key === topic)?.[1].test(text) ?? false
  const relevant = topic => (manifest.files ?? []).filter(file => {
    const re = KEYWORDS.find(([key]) => key === topic)?.[1]
    return file.excerpt?.trim() && (!re || re.test(file.excerpt))
  }).map(file => file.path).slice(0, 2)
  const sections = [entry('项目背景与目标', ['context'], available.slice(0, 2))]
  sections.push(entry(links.length ? '客户问题与对应方案' : '客户问题与方案（待确认）', ['problem_solution'],
    unique(links.flatMap(link => [link.painEvidence.path, link.solutionEvidence.path])).filter(p => available.includes(p))))
  if (matched('capabilities')) sections.push(entry('产品能力与适用场景', ['capabilities'], relevant('capabilities')))
  if (matched('implementation')) sections.push(entry('实施与使用路径', ['implementation'], relevant('implementation')))
  const lastTopics = ['boundary', ...(matched('company') && sections.length < 5 ? ['company'] : [])]
  sections.push(entry('适用条件与待确认事项', lastTopics, relevant('boundary')))
  return sections
}

export function formatOutline(outline) {
  const lines = outline.map((section, index) => {
    const coverage = section.topics.map(topic => LABELS[topic]).join('、')
    const sources = section.sourcePaths.length ? section.sourcePaths.map(p => path.basename(p)).join('、') : '待补充依据'
    return `${index + 1}. ${section.heading}（${coverage}；依据：${sources}）`
  })
  const orderExample = outline.length > 1 ? [2, 1, ...Array.from({ length: outline.length - 2 }, (_, i) => i + 3)].join(',') : '1'
  return `建议大纲（${outline.length} 章，尚未生成正式方案）：\n${lines.join('\n')}\n\n觉得可以就说“就按这个生成”“可以，开始吧”或“确认大纲”；想修改也可直接说，例如“第2章改为：新标题”“合并第2章和第3章为：新标题”“删除第3章”“新增章节：标题”或“顺序：${orderExample}”。调整后会再次预览。`
}

function number(text) {
  if (/^\d+$/u.test(text)) return Number(text)
  return '一二三四五六七八九十'.indexOf(text) + 1
}

/** 返回 { outline } 或 { error }；不改变传入的大纲。 */
export function editOutline(outline, instruction) {
  const input = instruction.trim()
  const next = outline.map(section => ({ ...section, topics: [...section.topics], sourcePaths: [...section.sourcePaths] }))
  const numeral = '([一二三四五六七八九十\\d]+)'
  let match
  if ((match = new RegExp(`^(?:把|将)?第?${numeral}(?:章|节)?(?:的标题)?(?:改为|改成|重命名为)[:：\\s]*(.+)$`, 'u').exec(input))) {
    const index = number(match[1]) - 1
    if (!next[index] || !match[2].trim() || match[2].trim().length > 48) return { error: '章节编号或新标题无效。' }
    next[index].heading = match[2].trim()
  } else if ((match = new RegExp(`^(?:把|将)?(?:合并)?第?${numeral}(?:章|节)?(?:和|与|、)第?${numeral}(?:章|节)?(?:合并)?(?:为|成)?[:：\\s]*(.*)$`, 'u').exec(input))) {
    const a = number(match[1]) - 1; const b = number(match[2]) - 1
    if (!next[a] || !next[b] || a === b) return { error: '请指定两个不同的有效章节编号。' }
    const first = Math.min(a, b); const second = Math.max(a, b)
    const title = match[3].trim() || `${next[first].heading}与${next[second].heading}`
    if (title.length > 48) return { error: '合并后的标题请控制在 48 字以内。' }
    next[first] = { ...next[first], heading: title,
      topics: unique([...next[first].topics, ...next[second].topics]),
      sourcePaths: unique([...next[first].sourcePaths, ...next[second].sourcePaths]) }
    next.splice(second, 1)
  } else if ((match = new RegExp(`^删除第?${numeral}(?:章|节)?$`, 'u').exec(input))) {
    const index = number(match[1]) - 1
    if (!next[index]) return { error: '章节编号无效。' }
    if (next[index].topics.includes('problem_solution')) return { error: '这章承载痛点与对应做法，请先合并到另一章，再删除。' }
    if (next.length <= 2) return { error: '至少保留 2 章。' }
    next.splice(index, 1)
  } else if ((match = /^新增(?:一)?章(?:节)?[:：\s]*(.+)$/u.exec(input))) {
    const title = match[1].trim()
    if (!title || title.length > 48) return { error: '新标题须在 48 字以内。' }
    next.push(entry(title, ['context'], []))
  } else if ((match = /^(?:调整)?顺序[:：\s]*([\d\s,，、]+)$/u.exec(input))) {
    const indices = match[1].split(/[,，、\s]+/u).filter(Boolean).map(Number)
    if (indices.length !== next.length || new Set(indices).size !== next.length
      || indices.some(i => !Number.isInteger(i) || i < 1 || i > next.length)) return { error: '顺序请列出每章编号各一次，例如“顺序：2,1,3”。' }
    return { outline: indices.map(i => next[i - 1]) }
  } else return { error: '请按示例修改章节，或回复“确认大纲”。' }
  if (next.length > 8) return { error: '最多支持 8 章；建议控制在 3—6 章。' }
  if (new Set(next.map(section => section.heading)).size !== next.length) return { error: '章节标题不能重复。' }
  return { outline: next }
}

function evidenceBlocks(manifest, sourcePaths) {
  return sourcePaths.slice(0, 3).flatMap(source => {
    const file = (manifest.files ?? []).find(item => item.path === source && item.excerpt?.trim())
    return file ? [{ type: 'quote', text: `来源：${source}\n${file.excerpt.slice(0, 900)}` }] : []
  })
}

export function sectionsFromOutline(manifest, outline, links) {
  return outline.map(item => {
    const paired = item.topics.includes('problem_solution')
    const blocks = evidenceBlocks(manifest, item.sourcePaths)
    if (item.topics.includes('boundary')) blocks.unshift({ type: 'para', text: '本稿以所列资料为依据；未覆盖的信息与用户补充内容均待业务负责人确认，不作为对外承诺。' })
    if (!blocks.length) blocks.push({ type: 'para', text: paired && links.length
      ? '客户问题与对应做法按 P 编号列示，具体依据见同章对照。'
      : '待补充并确认：当前资料尚无本章可核实的详细内容。' })
    // wlyd_solution 参数必须能无损 JSON 序列化,不允许出现 lead: undefined 之类的字段。
    return { kind: paired ? 'problem_solution' : item.topics[0] === 'context' ? 'trends' : item.topics[0],
      heading: item.heading, blocks }
  })
}

function stateFile(agent) {
  const id = agent?.session?.id
  if (id === undefined) return undefined
  const key = createHash('sha256').update(String(id)).digest('hex')
  return path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'wlyd-presales-outlines', `${key}.json`)
}

export async function loadPending(agent) {
  const file = stateFile(agent)
  if (!file) return undefined
  try {
    const state = JSON.parse(await readFile(file, 'utf8'))
    return state.status === 'pending' ? state.pending : undefined
  } catch { return undefined }
}

export async function savePending(agent, pending) {
  const file = stateFile(agent)
  if (!file) return
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await writeFile(file, JSON.stringify({ status: pending ? 'pending' : 'complete', pending: pending ?? null }) + '\n', { mode: 0o600 })
}
