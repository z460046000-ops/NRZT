import { randomUUID } from 'node:crypto'
import { CUSTOMER_STYLE, chapterWritingRule } from './writing-rules.js'
import { sectionsFromOutline, suggestOutline } from './outline.js'
import { salesOutlineCandidate, salesScenario, sourcePriority, technicalHeading } from './sales.js'
import { normalizeChart } from './chart.js'
import { cleanMaterialText, isReadableProse, isSafeDisplayText } from './source-quality.js'
import { hasInternalCopy } from './customer-copy.js'
import { loadPresalesSkills } from './skill-runtime.js'

const MAX_SOURCE_CHARS = 24_000
const MAX_LINKS = 5
const MODEL_TIMEOUT_MS = { 'draft-all': 240_000, 'draft-section': 90_000 }
const DEFAULT_MODEL_TIMEOUT_MS = 90_000
const FALLBACK_QUESTION = '现有材料还不足以确认客户痛点与对应的产品解决办法。可以补充“客户遇到什么问题、产品怎样解决”；也可以说“帮我网上找找公开资料”（即检索公开资料，结果标待核实）、“先按现有材料出大纲”（标待确认继续）或“停止”。'

function sourcesFromCorpus(corpus, manifest) {
  const sources = new Map()
  const pattern = /^## \[[^\]]+\] (.+)\n\n\([^\n]*\)\n\n````text\n([\s\S]*?)\n````/gmu
  for (const match of corpus.matchAll(pattern)) {
    const readable = cleanMaterialText(match[2], match[1])
    if (readable) sources.set(match[1], readable)
  }
  for (const file of manifest.files ?? []) {
    if (file.excerpt?.trim() && !sources.has(file.path)) {
      const readable = cleanMaterialText(file.excerpt, file.path)
      if (readable) sources.set(file.path, readable)
    }
  }
  return new Map([...sources].sort(([a], [b]) => sourcePriority({ path: b }) - sourcePriority({ path: a })))
}

async function readSources(ctx, agent, signal, manifest) {
  const cwd = agent?.session?.header?.cwd ?? process.cwd()
  try {
    const target = await ctx.fs.resolve(manifest.corpusPath, { cwd, signal })
    return sourcesFromCorpus(await ctx.fs.readText(target, signal), manifest)
  } catch {
    return sourcesFromCorpus('', manifest)
  }
}

/** 单章重试优先给相关原文行，保留原句以便模型逐字引用。 */
function sectionSourceExcerpt(content, item) {
  const hints = [item.heading, ...(item.topics ?? [])].join(' ')
  const pattern = /挑战|痛点|问题|客户|典型/u.test(hints) ? /挑战|痛点|问题|客户|线索|协同|负担|割裂|效率/u
    : /场景|实施|落地|路径/u.test(hints) ? /场景|实施|落地|路径|流程|步骤|服务|试点/u
      : /公司|服务|保障/u.test(hints) ? /公司|集团|服务|保障|培训|资质/u
        : /能力|方案|价值/u.test(hints) ? /能力|方案|价值|功能|平台|链路/u : /背景|趋势|机会|现状/u
  const lines = content.split('\n').filter(Boolean)
  const selected = new Set()
  for (let i = 0; i < lines.length; i++) {
    if (!pattern.test(lines[i])) continue
    for (let j = i; j <= Math.min(i + 2, lines.length - 1); j++) selected.add(j)
  }
  const relevant = [...selected].sort((a, b) => a - b).map(index => lines[index]).join('\n').slice(0, 4_500)
  return `${content.slice(0, 2_000)}\n${relevant}`.slice(0, 7_000)
}

function sectionEvidencePaths(item, manifest) {
  const paths = item.sourcePaths ?? []
  if (!(item.topics ?? []).some(topic => ['capabilities', 'scenarios', 'implementation', 'service', 'company', 'architecture'].includes(topic))) return paths
  const publicPaths = new Set((manifest.files ?? []).filter(file => file.kind === 'public').map(file => file.path))
  return paths.filter(sourcePath => !publicPaths.has(sourcePath))
}

function sectionFromCandidate(candidate, section, sourcePaths, sources, aliases = new Map(), evidence = new Map()) {
  const proposed = Array.isArray(candidate?.blocks) ? candidate.blocks : candidate?.paragraphs
  if (!Array.isArray(proposed)) return section
  const blocks = proposed.slice(0, 5).flatMap(raw => {
    if (!raw || typeof raw !== 'object') return []
    const block = { ...raw, path: raw.path ?? aliases.get(raw.sourceId) }
    if (raw.evidenceId) {
      const anchor = evidence.get(raw.evidenceId)
      if (!anchor || block.path && anchor.path !== block.path) return []
      block.path = anchor.path
      block.quote = anchor.text
    }
    if (!validEvidence(block, sources) || !sourcePaths.includes(block.path)
      || !isReadableProse(block.quote)) return []
    const type = block.type ?? 'para'
    if (type === 'chart') {
      try {
        const chart = normalizeChart({ ...block, source: { path: block.path, quote: block.quote } },
          { sourceText: sources.get(block.path) })
        return [chart]
      } catch { return [] }
    }
    if (type === 'metrics') {
      const items = block.items
      const quote = block.quote.replace(/\s+/gu, '')
      if (!Array.isArray(items) || items.length < 1 || items.length > 4
        || !items.every(item => {
          const label = String(item?.label ?? '').trim()
          const value = String(item?.value ?? '').trim()
          const labelAt = quote.indexOf(label.replace(/\s+/gu, ''))
          const valueAt = quote.indexOf(value.replace(/\s+/gu, ''))
          return label.length >= 2 && label.length <= 32 && value.length <= 20
            && /\d/u.test(value) && isSafeDisplayText(label) && isSafeDisplayText(value)
            && !/^(?:19|20)\d{2}$/u.test(value) && !hasInternalCopy(label)
            && labelAt >= 0 && valueAt >= 0 && Math.abs(labelAt - valueAt) <= 24
        })) return []
      return [{ type, items: items.map(item => ({ label: item.label.trim(), value: String(item.value).trim() })) },
        { type: 'quote', text: `来源：${block.path}\n${block.quote.trim()}` }]
    }
    let body
    if (type === 'para' && typeof block.text === 'string' && isReadableProse(block.text)
      && !hasInternalCopy(block.text) && block.text.length <= 1200) {
      const title = typeof block.title === 'string' && block.title.trim().length <= 24
        && isReadableProse(block.title) && !hasInternalCopy(block.title) ? block.title.trim() : undefined
      const label = typeof block.label === 'string' && block.label.trim().length <= 12
        && isReadableProse(block.label) && !hasInternalCopy(block.label) ? block.label.trim() : undefined
      const emphasis = Array.isArray(block.emphasis) ? block.emphasis.filter(word =>
        typeof word === 'string' && word.length >= 2 && word.length <= 16 && block.text.includes(word)).slice(0, 3) : []
      body = { type, text: block.text.trim(), ...(title ? { title } : {}), ...(label ? { label } : {}),
        ...(emphasis.length ? { emphasis } : {}) }
    } else if (['bullets', 'steps'].includes(type) && Array.isArray(block.items)
      && block.items.length >= 2 && block.items.length <= 6
      && block.items.every(item => isReadableProse(item) && !hasInternalCopy(item) && item.length <= 180)) {
      body = { type, items: block.items.map(item => item.trim()) }
    }
    return body ? [body, { type: 'quote', text: `来源：${block.path}\n${block.quote.trim()}` }] : []
  })
  const lead = typeof candidate.lead === 'string' && candidate.lead.trim().length <= 120
    && isReadableProse(candidate.lead) && !hasInternalCopy(candidate.lead) && blocks.length
    ? candidate.lead.trim() : undefined
  return blocks.length ? { ...section, ...(lead ? { lead } : {}), blocks } : section
}

/** 只记录结构与校验结果，不把客户材料或模型正文写入日志。 */
function rejectedSectionMeta(candidate, sourcePaths, sources, aliases, evidence) {
  const proposed = Array.isArray(candidate?.blocks) ? candidate.blocks : candidate?.paragraphs
  return { shape: Array.isArray(proposed) ? 'blocks' : typeof proposed,
    count: Array.isArray(proposed) ? proposed.length : 0, allowedSources: sourcePaths.length,
    blocks: (Array.isArray(proposed) ? proposed : []).slice(0, 5).map(raw => {
      const anchor = evidence.get(raw?.evidenceId)
      const path = raw?.path ?? aliases.get(raw?.sourceId) ?? anchor?.path
      const quote = anchor?.text ?? raw?.quote
      return { type: raw?.type, keys: raw && typeof raw === 'object' ? Object.keys(raw) : [],
        evidenceIdFound: !!anchor, pathKnown: !!path && sources.has(path),
        pathAllowed: !!path && sourcePaths.includes(path),
        quoteExact: typeof quote === 'string' && !!path && !!sources.get(path)?.includes(quote.trim()),
        quoteReadable: isReadableProse(quote) }
    }) }
}

const EXTRACT_TERMS = {
  context: /面向|用于|目标|背景|定位|服务|客户|团队/u,
  trends: /变化|趋势|正在|增长|市场|环境/u,
  problem_solution: /问题|困难|难以|分散|漏|重复|割裂|不足|压力|耗时/u,
  capabilities: /提供|支持|实现|汇总|管理|记录|查看|工作台|对应做法/u,
  architecture: /架构|平台|模块|工作台|系统/u,
  scenarios: /场景|销售|客户|使用|业务/u,
  implementation: /上线|试点|导入|部署|实施|核对|扩展|培训/u,
  service: /服务|培训|支持|交付|保障/u,
  company: /公司|集团|团队|资质|介绍/u,
  boundary: /边界|限制|不支持|没有提供|不得|未提供|未覆盖/u,
}

/** 模型主动留空时，从已清洗的真实来源提取短要点；不补造事实。 */
function extractiveSection(section, item, sourcePaths, sources) {
  const terms = (item.topics ?? []).map(topic => EXTRACT_TERMS[topic]).filter(Boolean)
  const candidates = sourcePaths.filter(path => sources.has(path)).flatMap(path =>
    sources.get(path).split('\n').flatMap(line =>
      (line.match(/[^。！？；\n]{8,220}[。！？；]?/gu) ?? []).map(quote => ({ path, quote: quote.trim() }))))
    .filter(({ quote }) => isReadableProse(quote) && !hasInternalCopy(quote))
    .map(candidate => ({ ...candidate, score: terms.reduce((sum, term) => sum + Number(term.test(candidate.quote)), 0) }))
    .filter(candidate => candidate.score > 0)
    .sort((a, b) => b.score - a.score || a.quote.length - b.quote.length)
  const chosen = []
  for (const candidate of candidates) {
    if (chosen.length >= 2) break
    if (chosen.some(other => other.quote === candidate.quote)) continue
    chosen.push(candidate)
  }
  const blocks = chosen.flatMap(({ path, quote }) => {
    const text = quote.replace(/^#{1,6}\s*/u, '').replace(/^(?:典型问题|对应做法|使用边界)[:：]\s*/u, '').trim()
    if (!text || text.length > 220 || !isReadableProse(text)) return []
    return [{ type: 'para', text }, { type: 'quote', text: `来源：${path}\n${quote}` }]
  })
  return blocks.length ? { ...section, blocks } : section
}

const parameterError = error => {
  const code = String(error?.code ?? error?.failure?.code ?? '')
  const status = Number(error?.status ?? error?.statusCode ?? error?.failure?.status)
  return code === '1210' || status === 400 || /1210|API 调用参数有误/u.test(String(error?.message ?? error?.failure?.message ?? ''))
}

/** 引用可选择稳定编号，原文由插件回填，避免手抄标点误差。 */
function evidenceAnchors(content, sourceId, sourcePath) {
  const pieces = content.match(/[^。\n]{4,220}(?:。|\n|$)/gu) ?? []
  const stride = Math.max(1, Math.ceil(pieces.length / 18))
  return pieces.filter((_, index) => index % stride === 0).slice(0, 18)
    .map((text, index) => ({ id: `${sourceId}:E${index + 1}`, path: sourcePath, text: text.trim() }))
}

async function askForJson(ctx, agent, signal, system, input, stage = 'json') {
  const started = Date.now()
  const skills = await loadPresalesSkills(ctx, agent, signal, stage)
  system += `\n以下 Skill 已在本次调用中显式加载。按规则完成本阶段，不把规则或执行记录写入面客正文。\n${skills}`
  const inputText = JSON.stringify(input)
  let retryCause
  const report = (issue, attempt, failure) => {
    const code = failure?.code
    const status = failure?.status ?? failure?.httpStatus
    console.info('[wlyd-presales] model', JSON.stringify({ stage, ms: Date.now() - started,
      attempts: attempt + 1, issue, systemChars: system.length, inputChars: inputText.length,
      ...(typeof code === 'string' && /^[\w-]{1,64}$/u.test(code) ? { failureCode: code } : {}),
      ...(Number.isInteger(status) ? { httpStatus: status } : {}),
      ...(retryCause ? { retryCause } : {}) }))
  }
  let supportsOff = false
  try {
    const info = await ctx.llm.resolveModelInfo?.(agent.options.provider, agent.options.model)
    supportsOff = info?.reasoning?.efforts?.some(effort => effort.id === 'off') === true
  } catch { /* 旧版 DSH 或未声明能力的模型沿用默认参数。 */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = ''
    let blockText = ''
    let finish
    const deadline = AbortSignal.timeout(MODEL_TIMEOUT_MS[stage] ?? DEFAULT_MODEL_TIMEOUT_MS)
    const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
    try { for await (const chunk of ctx.llm.stream({
      provider: agent.options.provider, model: agent.options.model, system,
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: inputText }],
        source: { kind: 'plugin', plugin: 'wlyd-presales-solution' } }],
      ...(supportsOff ? { reasoningEffort: 'off' } : {}), signal: requestSignal, sessionId: agent?.session?.id,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blockText += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    } } catch (error) {
      if (signal?.aborted) throw error
      if (deadline.aborted) { report('model_timeout', attempt, error); return { issue: 'model_timeout' } }
      if (supportsOff && parameterError(error)) {
        retryCause = 'reasoning_parameter_rejected'; supportsOff = false; continue
      }
      const issue = parameterError(error) ? 'provider_bad_request' : 'model_error'
      report(issue, attempt, error)
      return { issue }
    }
    if (finish?.kind === 'error' && supportsOff
      && (finish.failure?.code === 'UNSUPPORTED_REASONING_EFFORT' || parameterError(finish.failure))) {
      retryCause = 'reasoning_parameter_rejected'
      supportsOff = false
      continue
    }
    if (finish?.kind !== 'stop') {
      const issue = finish?.kind === 'error'
        ? parameterError(finish.failure) ? 'provider_bad_request' : 'model_error'
        : finish?.kind ?? 'no_finish'
      report(issue, attempt, finish?.failure)
      return { issue }
    }
    try { const value = parseJson(text || blockText); report('ok', attempt); return { value } }
    catch { report('invalid_json', attempt); return { issue: 'invalid_json' } }
  }
  report('model_error', 1)
  return { issue: 'model_error' }
}

/** 从全文材料生成逐字引用支撑的段落；整稿失败后按章重试，不交付全占位方案。 */
export async function composeSections(ctx, agent, signal, manifest, outline, links, settings = {}) {
  const fallback = sectionsFromOutline(manifest, outline, links).map((section, index) => {
    const sourceFiles = (outline[index].sourcePaths ?? []).map(sourcePath =>
      (manifest.files ?? []).find(file => file.path === sourcePath)).filter(Boolean)
    const message = !sourceFiles.length
      ? '待与贵方确认：本部分将在双方核对相关资料后补充。'
      : sourceFiles.every(file => file.kind === 'user')
      ? '待与贵方确认：产品能力、适用场景与贵方需求仍需进一步核对。'
      : settings.sales && sourceFiles.length && sourceFiles.every(file => sourcePriority(file) < 0)
        ? '待与贵方确认：我们将结合贵方业务场景，进一步确认方案的适用范围与实施方式。'
        : '待与贵方确认：本部分内容将在进一步沟通并核对资料后完善。'
    return { ...section, blocks: [{ type: 'para', text: message }] }
  })
  const issues = []
  const withIssues = sections => Object.defineProperty(sections, 'generationIssues',
    { value: [...new Set(issues)], enumerable: false })
  const sources = await readSources(ctx, agent, signal, manifest)
  const route = agent?.options
  if (!ctx.llm?.stream || !route?.provider || !route?.model) {
    issues.push('model_unavailable')
    return withIssues(fallback)
  }
  if (sources.size === 0) {
    issues.push('no_readable_source')
    return withIssues(fallback)
  }
  const scenario = salesScenario(manifest)
  const system = `你是面向客户的售前方案撰写员。按大纲把资料提炼为客户能读懂的事实与价值机制，不复制材料原文、HTML/CSS 代码或 PDF 乱码，也不新增企业事实。标题、导语、段落、要点和步骤都写成可直接给客户阅读的正式表达：优先说明业务价值与适用场景，避免“本章”“资料显示”“模型判断”“原文摘录”等内部制作话语；需要核对的状态留给系统校对记录，正文不放制作提示。${settings.sales ? `这是${settings.stage === 'deep' ? '深入接触客户' : '初次接触客户'}的${scenario === 'growth' ? '企业增长/营销' : '企业协同'}售前方案。开篇先让第一次接触产品的读者知道产品是什么、服务谁、回应什么问题。${scenario === 'growth' ? '参考人工方案的阅读顺序：增长环境与趋势→现状与挑战→总体方案→平台能力→实施与服务→公司介绍；根据材料合并或省略无据内容。环境页说清变化、业务影响和当前方案的关联。痛点章深入讲清问题名、工作场景和实际麻烦；后面的方案章只简要回扣痛点，重点讲对应做法、使用者动作和可见结果。示例标签“线索分散、工具割裂、内容负担、协同低效”只有在本轮来源支持时才使用，不能固定四类或照抄示例。' : '按企业协同的背景、场景问题、对应做法与实施边界组织。'}痛点与做法必须前后呼应，不混用不同产品线的能力或数字。技术接口只作为能力或实施依据，不能把 API、参数或文档目录当作客户方案正文。初次接触时用“典型挑战”，不得声称该客户已经遇到问题；深入接触时只把客户资料明确写出的内容称为客户现状。公开资料只能补行业背景或典型问题，不能证明本企业产品能力。用户补充的信息不能冒充已核实事实。` : ''}仅输出 JSON：{"sections":[{"heading":"标题","lead":"本章一句话主张","blocks":[{"type":"para|bullets|steps|chart|metrics","label":"短类别","title":"短主张","text":"50—110字具体说明","emphasis":["正文已有重点词"],"items":["要点"],"chartType":"bar|line","title":"图表标题","unit":"统一单位","points":[{"label":"原文类别或时间","value":1}],"evidenceId":"对应原文锚点 ID（优先）","sourceId":"sources 中的 ID（无锚点时）","quote":"逐字原文片段（无锚点时）"}]}]}。图表仅在同一来源连续原文中同时包含 2—6 个类别或时间、对应数字与统一单位时生成；比较用 bar，时间序列用 line。关键数字可用 metrics{items:[{label,value}]} 做大字卡片，但每个标签和值都须逐字出现在同一段 quote 中，不要从年份、页码或不同口径拼指标。普通章节尽量写 2—4 个有信息量的块；有依据的痛点章可写 3—5 个块，分别解释具体问题。每块只陈述其引用原文可支持的内容，优先选择对应 evidenceId；无合适锚点时 sourceId 必须是输入 sources 的 ID，且该来源须属于本章，quote 必须是该来源连续原文；没有依据的章返回空 blocks。不要伪造收益、案例、价格或承诺。${CUSTOMER_STYLE}`
  const sections = [...fallback]
  const abstained = new Set()
  const draftChapter = async ([index, item]) => {
    const relevant = [...new Set(sectionEvidencePaths(item, manifest))].filter(sourcePath => sources.has(sourcePath))
      .slice(0, 4).map((sourcePath, position) => ({ id: `K${position + 1}`,
        name: sourcePath.split('/').at(-1), content: sectionSourceExcerpt(sources.get(sourcePath), item), path: sourcePath }))
    if (!relevant.length) return { index, section: fallback[index] }
    const chapterAliases = new Map(relevant.map(source => [source.id, source.path]))
    const chapterEvidence = new Map()
    relevant.forEach(source => {
      source.evidence = evidenceAnchors(source.content, source.id, source.path)
      source.evidence.forEach(anchor => chapterEvidence.set(anchor.id, anchor))
    })
    try {
      const reply = await askForJson(ctx, agent, signal,
        `${system}\n本次只写「${item.heading}」一章，不生成其他章节。${chapterWritingRule(item)}只输出包含一章的 sections JSON。${settings.memoryBlock ?? ''}`,
        { outline: [{ heading: item.heading, topics: item.topics, writingTask: chapterWritingRule(item),
          sourcePaths: relevant.map(source => source.path), sourceIds: relevant.map(source => source.id) }],
          sources: relevant.map(({ id, name, content, evidence }) => ({ id, name, path: chapterAliases.get(id), content,
            evidence: evidence.map(({ id, text }) => ({ id, text })) })),
          citationRule: '优先用 evidenceId 选择原文锚点；没有合适锚点才用 sourceId 和逐字 quote。' }, 'draft-section')
      const candidate = reply.value?.sections?.[0] ?? reply.value?.section ?? reply.value
      const empty = Array.isArray(candidate?.blocks) && candidate.blocks.length === 0
      const section = sectionFromCandidate(candidate, fallback[index], sectionEvidencePaths(item, manifest), sources, chapterAliases, chapterEvidence)
      if (section === fallback[index]) console.warn('[wlyd-presales] rejected-section', JSON.stringify({ stage: 'draft-section',
        ...rejectedSectionMeta(candidate, sectionEvidencePaths(item, manifest), sources, chapterAliases, chapterEvidence) }))
      return { index, section, abstained: empty, issue: section === fallback[index] ? reply.issue ?? 'unverified_content' : undefined }
    } catch (error) {
      if (signal?.aborted) throw error
      console.warn('[wlyd-presales] section-exception', JSON.stringify({ error: error?.name ?? 'Error' }))
      return { index, section: fallback[index], issue: 'model_error' }
    }
  }
  // 至多三章同时请求，保持大纲顺序；同批都遇到服务故障时停止后续请求。
  const chapters = [...outline.entries()]
  for (let index = 0; index < chapters.length; index += 3) {
    const results = await Promise.all(chapters.slice(index, index + 3).map(draftChapter))
    for (const result of results) {
      sections[result.index] = result.section
      if (result.abstained) abstained.add(result.index)
      if (result.issue) issues.push(result.issue)
    }
    if (results.every(result =>
      result.section === fallback[result.index]
      && ['model_error', 'model_timeout', 'provider_bad_request'].includes(result.issue))) break
  }
  for (const [index, item] of outline.entries()) {
    if (sections[index] !== fallback[index] || !abstained.has(index)) continue
    const recovered = extractiveSection(fallback[index], item, sectionEvidencePaths(item, manifest), sources)
    if (recovered !== fallback[index]) {
      sections[index] = recovered
      issues.push('source_extract_fallback')
      console.info('[wlyd-presales] extractive-recovery', JSON.stringify({ chapter: index + 1,
        evidenceBlocks: recovered.blocks.filter(block => block.type === 'quote').length }))
    }
  }
  return withIssues(sections)
}

/** 证据不足时仍让模型按已知材料拟具体大纲，不把“待确认”误写成客户事实。 */
export async function outlineFromMaterials(ctx, agent, signal, manifest, settings = {}) {
  const fallback = settings.sales
    ? suggestOutline(manifest, [], salesOutlineCandidate(manifest, settings.product, settings.stage))
    : suggestOutline(manifest, [])
  const sources = await readSources(ctx, agent, signal, manifest)
  const route = agent?.options
  if (!ctx.llm?.stream || !route?.provider || !route?.model || sources.size === 0) return fallback
  const limited = [...sources].slice(0, 12).map(([path, content], index) => ({ id: `K${index + 1}`, path,
    content: content.slice(0, 2600) }))
  const outlineAliases = new Map(limited.map(source => [source.id, source.path]))
  try {
    const reply = await askForJson(ctx, agent, signal,
      settings.sales
        ? `你为${settings.product}设计面向客户的${salesScenario(manifest) === 'growth' ? '企业增长/营销' : '企业协同'}售前方案大纲，接触阶段：${settings.stage === 'deep' ? '深入接触' : '初次接触'}。仅输出 JSON：{"outline":[{"heading":"客户能理解的章节标题","topics":["context|trends|problem_solution|architecture|capabilities|scenarios|implementation|service|company|boundary|custom"],"sourceIds":["输入中的资料 ID"]}]}。建议 3—6 章。增长方案优先按“增长环境与趋势→现状与挑战→总体方案→平台能力→实施与服务→公司介绍”组织，按材料合并或省略无据章节，不固定六章。环境与趋势必须有对应来源，写清具体变化、目标客户受到什么影响；材料仅有产品背景时写业务背景，不凭空编趋势。挑战标题让陌生读者知道问题发生在哪里、造成什么影响；示例“线索分散：多渠道信号难统一承接”“工具割裂：系统较多，业务衔接不足”只是写法，只有本轮材料支持时才采用。总体方案解释问题如何逐项得到回应，平台能力再说明职责边界。协同材料聚焦人机协作、真实场景与当前阶段，不混用两条产品线的能力。初次接触不能把行业问题写成该客户事实，深入接触也只能采用已提供的客户事实。接口文档只用于核对产品能力，绝不能用 API、Swagger、认证、请求响应、文档解析等技术目录当章标题。资料不足的状态由系统记录；章标题不放制作提示，公司介绍无材料可省略。公开资料只能作为背景和典型问题的来源，不能进入产品能力章。sourceIds 只能引用输入 sources 中的 ID。标题以可理解为先，不为了 8—18 字删掉对象或场景；不用“AI 重构”“全链路闭环”等空泛标题。只输出 JSON。${CUSTOMER_STYLE}`
        : `你只为售前方案设计材料驱动的大纲，不判断客户痛点是否已发生。仅输出 JSON：{"outline":[{"heading":"体现材料具体业务或能力的章节标题","topics":["context|trends|capabilities|architecture|scenarios|implementation|service|boundary|company|custom"],"sourceIds":["输入中的资料 ID"]}]}。根据实际信息给 3—6 章，章节标题具体、彼此不重复；不能用“项目背景与目标”“产品能力与适用场景”等通用模板凑数。若资料有可靠的环境变化来源，可设置环境与趋势章；没有客户问题依据时，不建立客户问题与方案章，可在边界章提示尚待确认。sourceIds 只能引用输入 sources 中的 ID。标题以读者能理解为先，保留对象与场景；不用空泛套话。只输出 JSON。${CUSTOMER_STYLE}`,
      { sources: limited.map(({ id, content }) => ({ id, content })) }, 'outline')
    if (!reply.value) return fallback
    const parsed = reply.value
    const proposed = suggestOutline(manifest, [], Array.isArray(parsed.outline) ? parsed.outline.map(item => ({ ...item,
      sourcePaths: [...(item.sourcePaths ?? []), ...(item.sourceIds ?? []).map(id => outlineAliases.get(id))]
        .filter(Boolean),
    })) : parsed.outline)
    if (settings.sales && (proposed.some(section => technicalHeading(section.heading))
      || !proposed.some(section => section.topics.includes('problem_solution'))
      || !proposed.some(section => section.topics.includes('capabilities')))) return fallback
    if (settings.sales && fallback[0]?.topics.includes('trends')
      && !proposed.some(section => section.topics.includes('trends'))) {
      const context = proposed.find(section => section.topics.includes('context'))
      if (!context) return fallback
      context.topics = [...new Set(['trends', ...context.topics])]
      context.sourcePaths = [...new Set([...fallback[0].sourcePaths, ...context.sourcePaths])]
    }
    return proposed
  } catch (error) {
    if (signal?.aborted) throw error
    return fallback
  }
}

function parseJson(text) {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, '')
  return JSON.parse(trimmed)
}

function validEvidence(evidence, sources) {
  return evidence && typeof evidence.path === 'string' && typeof evidence.quote === 'string'
    && evidence.quote.trim().length >= 4
    && sources.get(evidence.path)?.includes(evidence.quote.trim())
}

function validateLinks(candidate, sources, publicPaths = new Set(), userPaths = new Set()) {
  if (!Array.isArray(candidate) || candidate.length === 0 || candidate.length > MAX_LINKS) return undefined
  const links = []
  for (const [index, item] of candidate.entries()) {
    if (!item || typeof item.pain !== 'string' || !item.pain.trim()
      || typeof item.solution !== 'string' || !item.solution.trim()
      || !validEvidence(item.painEvidence, sources)
      || !validEvidence(item.solutionEvidence, sources)
      || ![item.pain, item.solution, item.painEvidence.quote, item.solutionEvidence.quote].every(isReadableProse)
      || publicPaths.has(item.solutionEvidence.path)
      || item.pain.length > 120 || item.solution.length > 160
      || item.painEvidence.quote.length > 140 || item.solutionEvidence.quote.length > 140) return undefined
    links.push({
      id: `P${index + 1}`,
      pain: item.pain.trim(),
      solution: item.solution.trim(),
      painBasis: publicPaths.has(item.painEvidence.path) ? 'public_unverified'
        : userPaths.has(item.painEvidence.path) ? 'user_unverified'
        : item.painBasis === 'inferred' ? 'inferred' : 'explicit',
      painEvidence: { path: item.painEvidence.path, quote: item.painEvidence.quote.trim() },
      solutionEvidence: { path: item.solutionEvidence.path, quote: item.solutionEvidence.quote.trim() },
    })
  }
  return links
}

/** 推断/公开痛点必须再用独立的一轮判断，核对问题、做法和作用机制。 */
async function reviewMappings(ctx, agent, signal, links, sources) {
  try {
    const reply = await askForJson(ctx, agent, signal,
      '你是独立售前审稿人。逐条核对客户问题与产品做法是否处于同一场景、做法是否直接解决该问题、产品能力是否由内部资料支持。仅输出 JSON：{"pairs":[{"id":"P1","matched":true,"reason":"简短理由"}]}。推断痛点不是已证实的客户事实；公开资料不能证明本公司产品能力。无法判断或不对应时 matched=false。',
      { links, sources: [...sources].map(([path, content]) => ({ path, content: content.slice(0, 1500) })) }, 'pair-review')
    if (!reply.value) return false
    const answer = reply.value
    return Array.isArray(answer.pairs) && answer.pairs.length === links.length
      && links.every(link => answer.pairs.some(pair => pair.id === link.id && pair.matched === true
        && typeof pair.reason === 'string' && pair.reason.trim().length >= 4))
  } catch (error) {
    if (signal?.aborted) throw error
    return false
  }
}

/**
 * 从现有材料中判断是否能形成有证据的痛点—方案对应关系。模型只提出候选，代码核对引用。
 * @param {object} ctx - 插件上下文。
 * @param {object} agent - 目标代理(提供判断模型路由)。
 * @param {AbortSignal} signal - 取消信号。
 * @param {object} manifest - wlyd_ingest 产出的材料清单。
 * @param {string} [userNote] - 追加补充文本(用户补充或公开检索摘要)。
 * @param {string} [noteLabel] - 补充文本在证据来源中的标注名,说明其来源与待核实属性。
 * @returns {Promise<object>} ready(links/outline/userNote)或 question(question)。
 */
export async function assessMaterials(ctx, agent, signal, manifest, userNote, noteLabel = '用户本轮补充（待核实）', extraSources = []) {
  const sources = await readSources(ctx, agent, signal, manifest)
  const userPaths = new Set()
  if (userNote?.trim()) {
    const earlier = [...sources]
    sources.clear()
    sources.set(noteLabel, userNote.trim())
    userPaths.add(noteLabel)
    for (const [path, content] of earlier) sources.set(path, content)
  }
  const publicPaths = new Set((manifest.files ?? []).filter(file => file.kind === 'public').map(file => file.path))
  for (const source of extraSources) {
    if (typeof source.path === 'string' && typeof source.content === 'string' && source.content.trim()) {
      sources.set(source.path, source.content)
      publicPaths.add(source.path)
    }
  }
  if (sources.size === 0) return { kind: 'question', reason: 'insufficient', question: FALLBACK_QUESTION }
  const route = agent?.options
  if (!ctx.llm?.stream || !route?.provider || !route?.model) {
    return { kind: 'question', reason: 'model_unavailable', question: `当前会话没有可用的判断模型。${FALLBACK_QUESTION}` }
  }
  let remaining = MAX_SOURCE_CHARS
  const limited = []
  for (const [path, content] of sources) {
    if (remaining <= 0) break
    const excerpt = content.slice(0, remaining)
    limited.push({ path, content: excerpt })
    remaining -= excerpt.length
  }
  const input = JSON.stringify({ sources: limited })
  const system = [
    '你是售前材料证据审查员。只根据提供的 sources 判断，不能用常识补充企业事实。',
    '仅输出 JSON 对象，不要 Markdown：{"decision":"ready|infer|ask","question":"...","links":[{"pain":"...","solution":"...","painBasis":"explicit|inferred","painEvidence":{"path":"...","quote":"原文连续摘录"},"solutionEvidence":{"path":"...","quote":"原文连续摘录"}}],"outline":[{"heading":"章节标题","topics":["context|problem_solution|capabilities|implementation|boundary|company|trends|architecture|scenarios|service|custom"],"sourcePaths":["输入中的材料路径"]}]}。',
    '有明确客户问题和对应产品做法时返回 ready。每条 pain 要让第一次接触方案的人看懂问题：用“可识别的问题名：具体表现”概括发生环节和业务影响；四类营销挑战只是人工写法示例，名称与数量按来源决定，不能套用。solution 写清哪项能力在哪一步如何回应这条问题。只有场景/产品能力、没有明写痛点时，可提出由资料支持的候选问题并返回 infer，painBasis=inferred；痛点表述须保留“可能/待验证”语气，不能说成客户已发生的事实。每条 painEvidence 和 solutionEvidence 的 quote 都必须逐字来自对应来源，最多 5 条。',
    '公开资料只支持行业常见问题，不能作为本公司产品能力、客户收益、资质或承诺的依据。若只有痛点却没有内部资料支持的产品做法，或资料冲突、无法形成可信候选，返回 ask 并提出一个最关键的问题。',
    '大纲章节必须从材料实际内容归纳：标题体现材料里的具体主题(产品名、场景、指标、行业等)，禁止用“项目背景与目标”这类通用模板标题凑数；标题保留陌生读者需要的对象与场景，不为限制字数牺牲理解；章数按材料信息量定(约 3—6 章)，材料支持什么就写什么，没有的主题不要硬加；有来源的环境变化可单独成章，不能凭空编趋势；有痛点—方案对应关系时保留 problem_solution 章。每章 sourcePaths 只引用输入中真实存在的材料路径。正文须等用户确认大纲后再生成。',
    '用户本轮补充或公开检索补充都是待核实的输入，不能写成原文件已证实或对外承诺。',
  ].join('\n')
  try {
    const reply = await askForJson(ctx, agent, signal, system, JSON.parse(input), 'evidence')
    if (!reply.value) return { kind: 'question', reason: reply.issue ?? 'model_unavailable', question: FALLBACK_QUESTION }
    const answer = reply.value
    if (!['ready', 'infer'].includes(answer.decision)) {
      const question = typeof answer.question === 'string' && answer.question.trim()
        ? answer.question.trim() : FALLBACK_QUESTION
      return { kind: 'question', reason: 'insufficient', question: `${question}\n可以直接补充，也可以说“帮我网上找找公开资料”（即检索公开资料，结果标待核实）、“先按现有材料出大纲”（标待确认继续）或“停止”。`,
        outline: Array.isArray(answer.outline) && answer.outline.length >= 3
          ? suggestOutline(manifest, [], answer.outline) : undefined }
    }
    const links = validateLinks(answer.links, sources, publicPaths, userPaths)
    if (!links) return { kind: 'question', reason: 'invalid_evidence', question: `模型提出的痛点与方案缺少可核对的原文依据。${FALLBACK_QUESTION}` }
    if (answer.decision === 'infer') {
      for (const link of links) {
        if (link.painBasis === 'explicit') link.painBasis = 'inferred'
      }
    }
    if (links.some(link => link.painBasis !== 'explicit')
      && !await reviewMappings(ctx, agent, signal, links, sources)) {
      return { kind: 'question', reason: 'mapping_mismatch', question: `候选痛点与产品做法还不能确认逐项对应。${FALLBACK_QUESTION}` }
    }
    return { kind: 'ready', links, outline: suggestOutline(manifest, links, answer.outline),
      userNote: userNote?.trim() ? noteLabel : undefined }
  } catch (error) {
    if (signal?.aborted) throw error
    console.warn('[wlyd-presales] evidence-exception', JSON.stringify({ error: error?.name ?? 'Error',
      message: String(error?.message ?? '').slice(0, 180) }))
    return { kind: 'question', reason: 'model_unavailable', question: `材料判断暂未完成。${FALLBACK_QUESTION}` }
  }
}
