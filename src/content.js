import { randomUUID } from 'node:crypto'
import { sectionsFromOutline, suggestOutline } from './outline.js'
import { salesOutlineCandidate, sourcePriority, technicalHeading } from './sales.js'
import { normalizeChart } from './chart.js'
import { cleanMaterialText, isReadableProse } from './source-quality.js'
import { hasInternalCopy } from './customer-copy.js'

const MAX_SOURCE_CHARS = 24_000
const MAX_LINKS = 5
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

function sectionFromCandidate(candidate, section, sourcePaths, sources, aliases = new Map()) {
  const proposed = Array.isArray(candidate?.blocks) ? candidate.blocks : candidate?.paragraphs
  if (!Array.isArray(proposed)) return section
  const blocks = proposed.slice(0, 5).flatMap(raw => {
    if (!raw || typeof raw !== 'object') return []
    const block = { ...raw, path: raw.path ?? aliases.get(raw.sourceId) }
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
    let body
    if (type === 'para' && typeof block.text === 'string' && isReadableProse(block.text)
      && !hasInternalCopy(block.text) && block.text.length <= 1200) {
      body = { type, text: block.text.trim() }
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

async function askForJson(ctx, agent, signal, system, input, maxTokens) {
  let supportsOff = false
  try {
    const info = await ctx.llm.resolveModelInfo?.(agent.options.provider, agent.options.model)
    supportsOff = info?.reasoning?.efforts?.some(effort => effort.id === 'off') === true
  } catch { /* 旧版 DSH 或未声明能力的模型沿用默认参数。 */ }
  for (let attempt = 0; attempt < 2; attempt++) {
    let text = ''
    let blockText = ''
    let finish
    for await (const chunk of ctx.llm.stream({
      provider: agent.options.provider, model: agent.options.model, system,
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: JSON.stringify(input) }],
        source: { kind: 'plugin', plugin: 'wlyd-presales-solution' } }],
      ...(supportsOff ? { reasoningEffort: 'off' } : {}), maxTokens, signal, sessionId: agent?.session?.id,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blockText += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind === 'error' && finish.failure?.code === 'UNSUPPORTED_REASONING_EFFORT' && supportsOff) {
      supportsOff = false
      continue
    }
    if (finish?.kind !== 'stop') return { issue: finish?.kind === 'error' ? 'model_error' : finish?.kind ?? 'no_finish' }
    try { return { value: parseJson(text || blockText) } }
    catch { return { issue: 'invalid_json' } }
  }
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
  let budget = 40_000
  const limited = []
  for (const [sourcePath, content] of sources) {
    if (budget <= 0) break
    limited.push({ path: sourcePath, content: content.slice(0, budget) })
    budget -= content.length
  }
  const system = `你是面向客户的售前方案撰写员。按大纲把资料提炼为客户能读懂的事实与价值机制，不复制材料原文、HTML/CSS 代码或 PDF 乱码，也不新增企业事实。标题、导语、段落、要点和步骤都写成可直接给客户阅读的正式表达：优先说明业务价值与适用场景，避免“本章”“资料显示”“模型判断”“原文摘录”等内部制作话语；需要客户确认的内容用“待与贵方确认”说明，不向客户布置内部复核任务。${settings.sales ? `这是${settings.stage === 'deep' ? '深入接触客户' : '初次接触客户'}的营销场景售前方案：围绕业务背景、目标客户的典型挑战、产品如何回应、营销场景、企业与服务证明展开。技术接口只作为能力或实施依据，不能把 API、参数或文档目录当作客户方案正文。初次接触时用“典型挑战/待确认”，不得声称该客户已经遇到问题；深入接触时只把客户资料明确写出的内容称为客户现状。公开来源中的产品表述须写“公开资料显示（待核实）”。` : ''}仅输出 JSON：{"sections":[{"heading":"标题","lead":"本章一句话主张","blocks":[{"type":"para|bullets|steps|chart","text":"段落","items":["要点"],"chartType":"bar|line","title":"图表标题","unit":"统一单位","points":[{"label":"原文类别或时间","value":1}],"path":"sources 中的路径","quote":"逐字原文片段"}]}]}。图表仅在同一来源连续原文中同时包含 2—6 个类别或时间、对应数字与统一单位时生成；比较用 bar，时间序列用 line。每章尽量写 2—4 个有信息量的块；每块只陈述其引用原文可支持的内容，path 必须属于本章 sourcePaths，quote 必须是该来源连续原文；没有依据的章返回空 blocks。不要伪造收益、案例、价格或承诺。`
  const sections = [...fallback]
  try {
    const reply = await askForJson(ctx, agent, signal, system,
      { outline: outline.map(item => ({ heading: item.heading, sourcePaths: item.sourcePaths })), sources: limited }, 20_000)
    if (Array.isArray(reply.value?.sections) && reply.value.sections.length === outline.length) {
      for (const [index, candidate] of reply.value.sections.entries()) {
        sections[index] = sectionFromCandidate(candidate, fallback[index], outline[index].sourcePaths ?? [], sources)
      }
    } else issues.push(reply.issue ?? 'invalid_sections')
  } catch (error) {
    if (signal?.aborted) throw error
    issues.push('model_error')
  }
  for (const [index, item] of outline.entries()) {
    if (sections[index] !== fallback[index]) continue
    const relevant = [...new Set(item.sourcePaths ?? [])].filter(sourcePath => sources.has(sourcePath))
      .slice(0, 4).map((sourcePath, position) => ({ id: `S${position + 1}`,
        name: sourcePath.split('/').at(-1), content: sources.get(sourcePath).slice(0, 7000), path: sourcePath }))
    if (!relevant.length) continue
    const aliases = new Map(relevant.map(source => [source.id, source.path]))
    try {
      const reply = await askForJson(ctx, agent, signal,
        `只写售前方案中的「${item.heading}」这一章，面向客户表达，提炼 1—3 个有信息量的段落或要点；原文确有同单位的 2—6 组数字时可用 chart{chartType:"bar|line",title,unit,points:[{label,value}]}，比较用 bar、按时间递增的序列用 line。没有依据就返回空 blocks。仅输出 JSON：{"heading":"${item.heading}","lead":"一句话主张","blocks":[{"type":"para|bullets|steps|chart","text":"段落","items":["要点"],"sourceId":"S1","quote":"对应来源中的连续原文"}]}。每块 sourceId 必须是输入资料的 ID，quote 逐字复制；图表每个标签、数值和单位均须出现在同一段 quote；不要编造产品能力、客户事实、收益或承诺。`,
        { sources: relevant.map(({ id, name, content }) => ({ id, name, content })) }, 6_000)
      const candidate = reply.value?.section ?? reply.value
      sections[index] = sectionFromCandidate(candidate, fallback[index], item.sourcePaths ?? [], sources, aliases)
      if (sections[index] === fallback[index]) issues.push(reply.issue ?? 'unverified_content')
    } catch (error) {
      if (signal?.aborted) throw error
      issues.push('model_error')
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
  const limited = [...sources].slice(0, 12).map(([path, content]) => ({ path, content: content.slice(0, 2600) }))
  let text = ''
  let blockText = ''
  let finish
  try {
    for await (const chunk of ctx.llm.stream({
      provider: route.provider, model: route.model,
      system: settings.sales
        ? `你为${settings.product}设计面向客户的营销场景售前方案大纲，接触阶段：${settings.stage === 'deep' ? '深入接触' : '初次接触'}。仅输出 JSON：{"outline":[{"heading":"客户能理解的章节标题","topics":["context|problem_solution|capabilities|scenarios|implementation|service|company|boundary|custom"],"sourcePaths":["输入中的材料路径"]}]}。建议 3—6 章，叙事主线是业务背景→目标客户或已知客户的问题→逐项回应的产品方案→场景/实施→有依据的企业介绍；可按材料增减、合并，不固定章数。初次接触不能把行业问题写成该客户事实，深入接触也只能采用已提供的客户事实。接口文档只用于核对产品能力，绝不能用 API、Swagger、认证、请求响应、文档解析等技术目录当章标题。资料不足的章标待确认；公司介绍无材料可省略。sourcePaths 只能引用输入中的路径。只输出 JSON。`
        : '你只为售前方案设计材料驱动的大纲，不判断客户痛点是否已发生。仅输出 JSON：{"outline":[{"heading":"体现材料具体业务或能力的章节标题","topics":["context|capabilities|architecture|scenarios|implementation|service|boundary|company|custom"],"sourcePaths":["输入中的材料路径"]}]}。根据实际信息给 3—6 章，章节标题具体、彼此不重复；不能用“项目背景与目标”“产品能力与适用场景”等通用模板凑数。没有客户问题依据时，不建立客户问题与方案章，可在边界章提示尚待确认。sourcePaths 只能引用输入中的路径。只输出 JSON。',
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: JSON.stringify({ sources: limited }) }],
        source: { kind: 'plugin', plugin: 'wlyd-presales-solution' } }],
      maxTokens: 1400, signal, sessionId: agent?.session?.id,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blockText += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind !== 'stop') return fallback
    const parsed = parseJson(text || blockText)
    const proposed = suggestOutline(manifest, [], parsed.outline)
    if (settings.sales && (proposed.some(section => technicalHeading(section.heading))
      || !proposed.some(section => section.topics.includes('problem_solution'))
      || !proposed.some(section => section.topics.includes('capabilities')))) return fallback
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
  const route = agent?.options
  let text = ''
  let blockText = ''
  let finish
  try {
    for await (const chunk of ctx.llm.stream({
      provider: route.provider, model: route.model,
      system: '你是独立售前审稿人。逐条核对客户问题与产品做法是否处于同一场景、做法是否直接解决该问题、产品能力是否由内部资料支持。仅输出 JSON：{"pairs":[{"id":"P1","matched":true,"reason":"简短理由"}]}。推断痛点不是已证实的客户事实；公开资料不能证明本公司产品能力。无法判断或不对应时 matched=false。',
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: JSON.stringify({ links, sources: [...sources].map(([path, content]) => ({ path, content: content.slice(0, 1500) })) }) }],
        source: { kind: 'plugin', plugin: 'wlyd-presales-solution' } }],
      maxTokens: 900, signal, sessionId: agent?.session?.id,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blockText += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind !== 'stop') return false
    const answer = parseJson(text || blockText)
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
    '有明确客户问题和对应产品做法时返回 ready。只有场景/产品能力、没有明写痛点时，可提出由资料支持的候选问题并返回 infer，painBasis=inferred；痛点表述须保留“可能/待验证”语气，不能说成客户已发生的事实。每条 painEvidence 和 solutionEvidence 的 quote 都必须逐字来自对应来源，最多 5 条。',
    '公开资料只支持行业常见问题，不能作为本公司产品能力、客户收益、资质或承诺的依据。若只有痛点却没有内部资料支持的产品做法，或资料冲突、无法形成可信候选，返回 ask 并提出一个最关键的问题。',
    '大纲章节必须从材料实际内容归纳：标题体现材料里的具体主题(产品名、场景、指标、行业等)，禁止用“项目背景与目标”这类通用模板标题凑数；章数按材料信息量定(约 3—6 章)，材料支持什么就写什么，没有的主题不要硬加；有痛点—方案对应关系时保留 problem_solution 章。每章 sourcePaths 只引用输入中真实存在的材料路径。正文须等用户确认大纲后再生成。',
    '用户本轮补充或公开检索补充都是待核实的输入，不能写成原文件已证实或对外承诺。',
  ].join('\n')
  let text = ''
  let blockText = ''
  let finish
  try {
    for await (const chunk of ctx.llm.stream({
      provider: route.provider, model: route.model, system,
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: input }],
        source: { kind: 'plugin', plugin: 'wlyd-presales-solution' } }],
      maxTokens: 2600, signal, sessionId: agent?.session?.id,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blockText += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind !== 'stop') return { kind: 'question', reason: 'model_unavailable', question: FALLBACK_QUESTION }
    const answer = parseJson(text || blockText)
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
    return { kind: 'question', reason: 'model_unavailable', question: `材料判断暂未完成。${FALLBACK_QUESTION}` }
  }
}
