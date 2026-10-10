import { randomUUID } from 'node:crypto'
import { access, readFile } from 'node:fs/promises'
import path from 'node:path'
import { assessMaterials, composeSections, outlineFromMaterials } from './content.js'
import { editOutline, formatOutline, savePending, sectionsFromOutline, suggestOutline } from './outline.js'
import { downloadKnowledgeFile, listKnowledge, listKnowledgeBases, listProjectKnowledgeBases, listProjects, resolvePlatformConfig, safeFileName } from './platform.js'
import { extractBinaryText } from './ingest.js'
import { salesRequest } from './sales.js'

const TRIGGER = '售前解决方案'
const PATH_FIELD = /(?:材料(?:路径)?|path)\s*[:：=]\s*(?:`([^`]+)`|"([^"]+)"|'([^']+)'|([^\s，,。；;]+))/iu
const PATH_LIKE = /^(?:\.{0,2}[\\/]|~[\\/]|[^\s]+[\\/]|[^\s]+\.(?:md|txt|csv|json|html|docx|pdf|pptx|zip))\S*$/iu
const PLATFORM_SOURCE = /材料\s*[:：=]\s*`?(?:平台|内容中台|知识库)`?|内容中台|(?:平台|知识库)(?:上的?|里的?|中的?)?(?:文档|材料|文件)/u
const FLOW_CANCEL = /^(?:取消|停止|算了|不用了|stop|cancel)[\s。!！.]*$/iu

/** 从用户文本中识别明确给出的材料路径；不把普通描述猜成文件名。 */
export function materialPath(text, command = false) {
  const input = text.trim()
  const field = PATH_FIELD.exec(input)
  if (field) return (field[1] ?? field[2] ?? field[3] ?? field[4]).trim()
  if (command && /^(`[^`]+`|"[^"]+"|'[^']+')$/u.test(input)) return input.slice(1, -1).trim()
  if (PATH_LIKE.test(input)) return input
  return undefined
}

/** 普通对话中的触发词；后续材料回复由调用方的会话状态处理。提到内容中台/知识库材料并要做方案时同样触发。 */
export function mentionsPresales(text) {
  return text.includes(TRIGGER) || (PLATFORM_SOURCE.test(text) && /方案|材料/u.test(text))
}

/**
 * 从用户文本识别材料来源：取消词、明确路径或内容中台；识别不出返回 undefined。
 * 取消词优先于一切，明确路径优先于平台词。
 * @param {string} text - 用户消息文本。
 * @param {boolean} [command] - 斜杠命令入参，整段视为路径候选。
 * @returns {{kind: 'cancel'}|{kind: 'path', path: string}|{kind: 'platform'}|{kind:'auto', product:string, stage:string}|undefined} 材料来源。
 */
export function materialSource(text, command = false) {
  const input = text.trim()
  if (FLOW_CANCEL.test(input)) return { kind: 'cancel' }
  if (/材料\s*[:：=]\s*`?(?:平台|内容中台|知识库)`?(?:$|[\s，,。；;])/u.test(input)) return { kind: 'platform' }
  const material = materialPath(text, command)
  if (material) return { kind: 'path', path: material }
  const sales = salesRequest(input)
  if (sales) return sales
  if (PLATFORM_SOURCE.test(input)) return { kind: 'platform' }
  if (command && /^[A-Za-z][A-Za-z0-9._-]{1,39}$/u.test(input)) return { kind: 'auto', product: input, stage: 'initial' }
  return undefined
}

/** 大纲与证据配对保持独立，章节可增删、合并和重排。 */
export function outlineFromManifest(manifest, links = [], outline = suggestOutline(manifest, links)) {
  return sectionsFromOutline(manifest, outline, links)
}

function toolError(result) {
  const first = result.content?.find(block => block.type === 'text')
  return first?.text ?? result.error?.message ?? '工具执行失败'
}

async function generateDraft(ctx, agent, signal, pending, links) {
  const { manifest, runId } = pending
  const sections = await composeSections(ctx, agent, signal, manifest, pending.outline, links,
    pending.auto ? { sales: true, stage: pending.stageType } : {})
  const substantive = value => typeof value === 'string' && value.trim()
    && !/^(?:待与贵方确认|待补充并确认|尚无证据|本部分内容将在)/u.test(value.trim())
  const filled = sections.filter(section => (section.kind === 'problem_solution' && links.length)
    || section.blocks.some(block => {
      const lines = block.type === 'para' ? [block.text]
        : ['bullets', 'steps'].includes(block.type) ? block.items : []
      return lines?.some(substantive)
    })).length
  const required = Math.ceil(sections.length / 2)
  if (filled < required) {
    const issues = sections.generationIssues ?? []
    const reason = issues.includes('model_unavailable') ? '当前会话没有可用的生成模型'
      : issues.includes('no_readable_source') ? '导入资料中没有可用正文'
        : issues.includes('max-tokens') ? '模型输出被截断'
          : issues.includes('model_error') ? '模型调用失败'
            : '模型正文或引用未通过校验'
    return { kind: 'error', text: `已读取 ${manifest.counts?.extracted ?? 0} 篇资料，但只有 ${filled}/${sections.length} 章生成了有依据的正文，未达到交付要求，因此没有生成空白幻灯片。原因：${reason}。请检查当前模型后重试，或补充更清晰的产品与客户资料。` }
  }
  const solution = await ctx.tools.execute({
    callId: randomUUID(), name: 'wlyd_solution',
    arguments: {
      // composeSections 的数组带有仅供诊断的非枚举属性；DSH 工具参数要求纯 JSON。
      title: `${manifest.label}售前解决方案`, sections: [...sections],
      ...(pending.auto ? { subtitle: pending.stageType === 'deep' ? '深入沟通版 · 待复核' : '初次接触版 · 待复核',
        meta: { product: manifest.label } } : {}),
      pain_solution_links: links,
      output_base: `${runId}/solution`,
    }, agent, signal,
  })
  if (solution.isError) {
    const detail = toolError(solution)
    // 会话目录跨服务工作区时写入被沙箱拒绝;这是环境错位,只有新会话能解决。
    const hint = /FS_SANDBOX_DENIED|workspace-write/u.test(detail)
      ? '当前会话的工作目录在服务工作区之外，无法写入方案文件。请新建一个会话再试（材料也要在新会话中重新提供：本地路径或“读取内容中台”）。'
      : ''
    return { kind: 'error', text: `材料已导入，方案生成失败：${detail}${hint ? `\n${hint}` : ''}` }
  }
  const value = solution.value
  const webBase = value.editUrl?.endsWith('/solution.html')
    ? value.editUrl.slice(0, -'solution.html'.length) : undefined
  const delivery = webBase
    ? `![方案结构预览](${webBase}preview.svg)\n\n[打开内部稿并编辑](${value.editUrl}) · [内部稿 Word](${webBase}solution.docx) · [内部稿 Markdown](${webBase}solution.md) · [内部 JSON 源稿](${webBase}solution.json)\n\n外发请在内部稿右下角选择“查看外部稿”，完成检查后下载独立的外发文件。`
    : `内部稿 HTML：${value.editUrl}；内部稿 Markdown：${value.markdownPath}；内部稿 Word：${value.docxPath}`
  return {
    kind: 'success',
    text: `## ${manifest.label}售前解决方案\n\n${pending.auto ? `已自动检索资料，按${pending.stageType === 'deep' ? '深入接触' : '初次接触'}场景生成初稿；可继续补充客户信息或直接编辑。${pending.sourceSummary ? `\n\n**资料来源**：${pending.sourceSummary}` : ''}` : '已按确认大纲生成初稿，请先预览和复核。'}\n\n${delivery}\n\n**内容结构** · ${sections.length} 章\n\n${sections.map((section, index) => `- **${String(index + 1).padStart(2, '0')}** · ${section.heading}`).join('\n')}\n\n`
      + (links.length ? `**证据状态**：${links.length} 组问题与做法已逐项对应，仍需人工复核后使用。`
        : '**证据状态**：客户问题与做法尚无可靠对应关系，相关内容待确认，暂不作为完整方案对外使用。'),
  }
}

function propose(pending, links, outline) {
  pending.stage = 'outline'
  pending.links = links
  pending.outline = outline ?? suggestOutline(pending.manifest, links)
  return { kind: 'outline', text: formatOutline(pending.outline), pending }
}

/** 平台材料入口:先选项目，再从项目已绑定知识库中选资料。 */
async function pullPlatformMaterials(ctx, agent, signal, config, runId) {
  const cfg = resolvePlatformConfig(config ?? {})
  let projects
  try {
    projects = await listProjects(cfg)
  } catch (err) {
    return { kind: 'error', text: `读取内容中台项目失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (projects.length === 0) {
    return { kind: 'error', text: '内容中台当前没有你可访问的方案项目。请先在平台确认项目权限，或改用本地路径（材料=materials/）。' }
  }
  if (projects.length > 1) {
    const menu = projects.map((project, index) => `${index + 1}. ${project.name}`).join('\n')
    return {
      kind: 'question',
      text: `内容中台有 ${projects.length} 个可访问项目，回复编号选择：\n${menu}\n回复“取消”退出。`,
      pending: { stage: 'platform-project', runId, options: projects },
    }
  }
  return pullProjectKnowledgeBases(ctx, agent, signal, config, projects[0], runId)
}

async function pullProjectKnowledgeBases(ctx, agent, signal, config, project, runId) {
  const cfg = resolvePlatformConfig(config ?? {})
  let bases
  try {
    const [bindings, visible] = await Promise.all([
      listProjectKnowledgeBases(cfg, project.id), listKnowledgeBases(cfg),
    ])
    bases = bindings.map(binding => visible.find(item => item.id === binding.id)).filter(Boolean)
  } catch (err) {
    return { kind: 'error', text: `读取项目「${project.name}」的知识库权限失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (bases.length === 0) return { kind: 'error', text: `项目「${project.name}」没有当前账号可读取的绑定知识库。` }
  if (bases.length > 1) {
    const menu = bases.map((kb, index) => `${index + 1}. ${kb.name}`).join('\n')
    return { kind: 'question', text: `项目「${project.name}」有 ${bases.length} 个可读取知识库，回复编号选择：\n${menu}\n回复“取消”退出。`,
      pending: { stage: 'platform-kb', runId, options: bases } }
  }
  return pullFromKnowledgeBase(ctx, agent, signal, config, bases[0], runId)
}

/** 每轮独立暂存已解析文档，避免旧资料与同名文档进入本轮方案。 */
async function pullFromKnowledgeBase(ctx, agent, signal, config, kb, runId, sales) {
  const cfg = resolvePlatformConfig(config ?? {})
  const cwd = agent?.session?.header?.cwd ?? process.cwd()
  let docs
  try {
    docs = await listKnowledge(cfg, kb.id)
  } catch (err) {
    return { kind: 'error', text: `读取知识库「${kb.name}」文档列表失败：${err instanceof Error ? err.message : String(err)}` }
  }
  const ready = docs.filter(doc => doc.parseStatus === 'completed')
  if (ready.length === 0) {
    return { kind: 'error', text: `知识库「${kb.name}」共有 ${docs.length} 条文档，但没有解析完成的。请先在平台等待解析完成，或改用本地路径。` }
  }
  if (ready.length > 400) return { kind: 'error', text: `知识库「${kb.name}」有 ${ready.length} 篇已解析文档，超过单次读取 400 篇上限；请先在平台缩小资料范围。` }
  const dirName = `${runId}/platform-materials/${kb.id.replace(/[^a-zA-Z0-9-]/gu, '_')}`
  const warnings = []
  const saved = []
  let totalBytes = 0
  try {
    for (const doc of ready) {
      const file = await downloadKnowledgeFile(cfg, doc.id, signal)
      totalBytes += file.bytes.length
      if (totalBytes > 100 * 1024 * 1024) throw new Error('本轮知识文档总量超过 100MB，请缩小资料范围')
      const originalType = (doc.fileType || path.extname(doc.title).slice(1)).toLowerCase()
      let content
      let name = safeFileName(doc.title, originalType)
      if (['pdf', 'docx', 'pptx'].includes(originalType)) {
        content = (await extractBinaryText(originalType, file.bytes)).text
        name = `${path.parse(name).name}.md`
      } else if (['md', 'markdown', 'txt', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'log'].includes(originalType)) {
        content = file.bytes.toString('utf8')
      } else {
        warnings.push(`${doc.title} 格式 ${originalType || '未知'} 暂不支持，已跳过`)
        continue
      }
      if (!content.trim()) {
        warnings.push(`${doc.title} 内容为空，已跳过`)
        continue
      }
      const relative = `${dirName}/${doc.id.replace(/[^a-zA-Z0-9-]/gu, '_')}-${name}`
      // 经 ctx.fs 写入,统一受 workspace-write 沙箱约束;绕开它会静默写进会话工作区之外。
      const target = await ctx.fs.resolve(relative, { cwd, signal })
      await ctx.fs.writeText(target, content, undefined, signal)
      saved.push(relative)
    }
  } catch (err) {
    if (signal.aborted) throw err
    return { kind: 'error', text: `下载知识文档失败：${err instanceof Error ? err.message : String(err)}` }
  }
  if (saved.length === 0) {
    return { kind: 'error', text: `知识库「${kb.name}」的文档均无可拉取正文。请检查平台文档内容，或改用本地路径。` }
  }
  const outcome = await ingestAndAssess(ctx, agent, signal, dirName, sales?.product ?? `内容中台·${kb.name}`, runId, sales)
  if (warnings.length > 0 && (outcome.kind === 'outline' || outcome.kind === 'question')) {
    outcome.text = `已拉取 ${saved.length} 篇文档（${warnings.join('；')}）。\n${outcome.text}`
  }
  return outcome
}

/** 导入材料并判断证据是否充足;本地路径与平台拉取共用这一条下游链路。 */
async function ingestAndAssess(ctx, agent, signal, inputPath, label, runId, sales) {
  const call = (name, args) => ctx.tools.execute({
    callId: randomUUID(), name, arguments: args, agent, signal,
  })
  const ingested = await call('wlyd_ingest', {
    path: inputPath,
    output_dir: `${runId}/analysis`,
    ...(label ? { label } : {}),
  })
  if (ingested.isError) return { kind: 'error', text: `材料导入失败：${toolError(ingested)}` }
  const manifest = ingested.value
  if (!manifest?.counts?.extracted) {
    return { kind: 'error', text: '材料已登记，但没有可提取的正文。请提供包含文字的文件后重试。' }
  }
  if (!(manifest.files ?? []).some(file => file.excerpt?.trim())) {
    return { kind: 'error', text: '材料已登记，但正文为空。请提供包含文字的文件后重试。' }
  }
  if (sales) return generateSalesDraft(ctx, agent, signal, manifest, runId, sales)
  const pending = { stage: 'evidence', manifest, runId, inputPath }
  const assessment = await assessMaterials(ctx, agent, signal, manifest)
  if (assessment.kind === 'question') {
    pending.gapQuestion = assessment.question
    pending.outlineCandidate = assessment.outline
    if (assessment.reason !== 'model_unavailable' && ctx.tools.get?.('web_search')) {
      return searchPublicMaterials(ctx, agent, signal, pending, true)
    }
    return { kind: 'question', text: assessment.question, pending }
  }
  return propose(pending, assessment.links, assessment.outline)
}

async function generateSalesDraft(ctx, agent, signal, manifest, runId, sales) {
  let links = []
  if ((manifest.files ?? []).some(file => file.kind !== 'public' && file.kind !== 'user')) {
    const assessment = await assessMaterials(ctx, agent, signal, manifest)
    if (assessment.kind === 'ready') links = assessment.links
  }
  const outline = await outlineFromMaterials(ctx, agent, signal, manifest,
    { sales: true, product: sales.product, stage: sales.stage })
  return generateDraft(ctx, agent, signal, {
    manifest, runId, outline, auto: true, stageType: sales.stage,
    sourceSummary: sales.sourceSummary,
  }, links)
}

function productMatchScore(name, product) {
  const value = String(name ?? '').toLocaleLowerCase().replace(/\s+/gu, '')
  const query = product.toLocaleLowerCase().replace(/\s+/gu, '')
  return value === query ? 100 : value.includes(query) ? 60 : 0
}

async function autoKnowledgeBase(config, product) {
  const cfg = resolvePlatformConfig(config ?? {})
  if (!cfg.email || !cfg.password || !cfg.tenantId) return []
  const [projects, visible] = await Promise.all([listProjects(cfg), listKnowledgeBases(cfg)])
  const allowed = new Map(visible.map(kb => [kb.id, kb]))
  const bound = await Promise.allSettled(projects.map(async project => ({
    project, bindings: await listProjectKnowledgeBases(cfg, project.id),
  })))
  return bound.flatMap(result => result.status === 'fulfilled'
    ? result.value.bindings.flatMap(binding => {
      const kb = allowed.get(binding.id)
      if (!kb) return []
      const score = 2 * productMatchScore(kb.name, product) + productMatchScore(result.value.project.name, product)
      return score ? [{ kb, project: result.value.project, score,
        name: `${result.value.project.name} / ${kb.name}` }] : []
    }) : []).sort((a, b) => b.score - a.score)
}

async function publicProductManifest(ctx, agent, signal, product, runId) {
  let searched
  try {
    searched = await ctx.tools.execute({ callId: randomUUID(), name: 'web_search',
      arguments: { queries: [`${product} 产品 营销 解决方案 官网`] }, agent, signal })
  } catch (error) {
    if (signal?.aborted) throw error
    return undefined
  }
  if (searched?.isError) return undefined
  const hits = (Array.isArray(searched?.value?.sources) ? searched.value.sources : [])
    .filter(source => /^https:\/\//iu.test(source.url ?? '') && String(source.snippet ?? '').trim()).slice(0, 5)
  if (!hits.length) return undefined
  const retrievedAt = new Date().toISOString()
  const files = hits.map((source, index) => ({
    path: `公开资料（待核实）[${index + 1}] ${source.url}`,
    excerpt: String(source.snippet).trim().slice(0, 1200), kind: 'public',
    sourceUrl: source.url, retrievedAt,
  }))
  const target = await ctx.fs.resolve(`${runId}/research/public-sources.md`,
    { cwd: agent?.session?.header?.cwd ?? process.cwd(), signal })
  await ctx.fs.writeText(target,
    `# ${product} 公开资料（待核实）\n\n检索时间：${retrievedAt}\n\n${files.map(file => `${file.path}\n${file.excerpt}`).join('\n\n')}\n`,
    undefined, signal)
  return { label: product, files, counts: { extracted: files.length } }
}

async function autoPresales(ctx, agent, signal, source, config, runId) {
  let choices = []
  try { choices = await autoKnowledgeBase(config, source.product) }
  catch (error) { if (signal?.aborted) throw error }
  if (choices.length) {
    const tied = choices.filter(item => item.score === choices[0].score)
    if (tied.length > 1 && new Set(tied.map(item => item.kb.id)).size > 1) {
      return { kind: 'question', text: `找到多个与「${source.product}」同名的项目知识库，请选择本次要使用的项目：\n${tied.map((item, i) => `${i + 1}. ${item.name}`).join('\n')}`,
        pending: { stage: 'auto-kb', runId, options: tied, sales: source } }
    }
    const outcome = await pullFromKnowledgeBase(ctx, agent, signal, config, choices[0].kb, runId,
      { product: source.product, stage: source.stage, sourceSummary: `内容中台「${choices[0].name}」` })
    if (outcome.kind !== 'error') return outcome
  }
  const publicManifest = await publicProductManifest(ctx, agent, signal, source.product, runId)
  const manifest = publicManifest ?? { label: source.product, counts: { extracted: 1 },
    files: [{ path: '用户请求（产品资料待补充）', excerpt: `用户要求生成${source.product}售前解决方案；尚无可读取的产品材料，产品能力和客户事实均待补充。`, kind: 'user' }] }
  return generateSalesDraft(ctx, agent, signal, manifest, runId,
    { ...source, sourceSummary: publicManifest ? '公开网页摘要（待核实）' : '仅有产品名称，产品事实待补充' })
}

/**
 * 确定性执行入口：内容中台拉取或本地导入，再判断材料是否足以建立对应关系。
 * @param {object} ctx - 插件上下文。
 * @param {object} agent - 目标代理。
 * @param {AbortSignal} signal - 取消信号。
 * @param {{kind: 'cancel'}|{kind: 'path', path: string}|{kind: 'platform'}|string|undefined} source - materialSource 结果;字符串按本地路径处理。
 * @param {object} [config] - 插件 Config,供内容中台拉取解析平台账号。
 */
export async function runPresales(ctx, agent, signal, source, config) {
  if (typeof source === 'string') source = { kind: 'path', path: source }
  if (!source) {
    return { kind: 'question', text: '想为哪个产品生成售前解决方案？直接回复产品名称即可；有客户资料也可以一起提供。',
      pending: { stage: 'product' } }
  }
  if (source.kind === 'cancel') {
    return { kind: 'stopped', text: '已退出售前解决方案流程；需要时再次提到“售前解决方案”即可重新开始。' }
  }
  const runId = `presales-runs/${Date.now()}-${randomUUID().slice(0, 8)}`
  if (source.kind === 'auto') return autoPresales(ctx, agent, signal, source, config, runId)
  if (source.kind === 'platform') return pullPlatformMaterials(ctx, agent, signal, config, runId)
  return ingestAndAssess(ctx, agent, signal, source.path, undefined, runId)
}

/** 按编号或唯一名称子串选择项目/知识库;选不出返回 undefined。 */
function pickKnowledgeBase(options, text) {
  const numbered = /^(?:第)?(\d+)(?:[.、个]|\s|$)/u.exec(text)
  if (numbered) {
    const index = Number(numbered[1]) - 1
    return index >= 0 && index < options.length ? options[index] : undefined
  }
  const hit = options.filter(kb => kb.name.includes(text))
  return hit.length === 1 ? hit[0] : undefined
}

const REPLY_END = /[\s。！？!?.，,；;～~]+$/gu
const NEGATION = /(?:不要|不用|别|暂不|先不|先别|还没|尚未|不想|不能)/u
const EDIT_HINT = /(?:改|调整|修改|删|增|加一章|合并|拆|顺序|换|重排|标题|挪)/u
const SEARCH_HINT = /(?:搜索|检索|查找|查一查|查一下|搜一搜|搜一下|找一找|找一下|上网|联网|网上|公开资料|公开信息|AI补全|自动补全)/iu

/** 先识别明确口语；不清楚的回复再交给当前模型判断意图。 */
export function directReplyIntent(stage, answer) {
  const text = answer.trim().replace(REPLY_END, '').replace(/[\s，,、]+/gu, '')
  if (!text) return 'clarify'
  if (FLOW_CANCEL.test(text)) return 'cancel'
  if (stage === 'outline') {
    if (NEGATION.test(text) || EDIT_HINT.test(text)) return undefined
    if (/^(?:确认大纲|大纲确认|按此大纲生成|确认|确定|同意|通过|可以|好的?|好嘞|行|没问题|就这样|(?:就)?按这个来|(?:就)?按这个(?:大纲|结构)?(?:来|生成)?|开始(?:生成|写)?|直接(?:生成|写)|继续(?:生成|吧)?)(?:吧|了|就行|开始(?:生成|吧)|生成方案|出方案|写方案)?$/u.test(text)) return 'confirm'
    if (/^(?:大纲|结构)(?:没问题|可以|确认|就这样)(?:了|吧)?$/u.test(text)) return 'confirm'
    return undefined
  }
  if (stage === 'evidence') {
    if (SEARCH_HINT.test(text)) return NEGATION.test(text) ? undefined : 'search'
    if (/^(?:标待确认继续|待确认继续|继续生成结构稿|继续(?:吧|生成)?|先(?:出|给|看)(?:个|一版)?(?:大纲|结构稿)|(?:先)?按(?:现有|已有)材料(?:先)?(?:给|出)(?:个|一版)?(?:大纲|结构稿))$/u.test(text)) return 'continue'
    if (/^(?:补充|说明|客户痛点|产品做法)\s*[:：]/u.test(text)) return 'note'
    if (text.length >= 12 && !/[？?]$/u.test(text) && /(?:客户|用户|产品|系统|功能|目前|现状)/u.test(text)) return 'note'
  }
  return undefined
}

async function inferReplyIntent(ctx, agent, signal, stage, answer, outline) {
  const route = agent?.options
  if (!ctx.llm?.stream || !route?.provider || !route?.model) return { intent: 'clarify' }
  const allowed = stage === 'outline' ? ['confirm', 'edit', 'clarify'] : ['search', 'continue', 'note', 'clarify']
  const context = stage === 'outline'
    ? `当前等待用户确认或调整大纲。章节：${(outline ?? []).map((item, i) => `${i + 1}.${item.heading}`).join('；')}。若用户要求修改，editInstruction 必须转换成一次现有格式：第2章改为：标题 / 合并第2章和第3章为：标题 / 删除第3章 / 新增章节：标题 / 顺序：2,1,3。多项修改或不确定时用 clarify。`
    : '当前在资料缺口提问。search=用户明确要查公开资料；continue=用户明确要求在缺依据情况下先看待确认大纲；note=用户提供新的事实资料；其余或否定/含糊回复用 clarify。'
  let text = ''
  let blockText = ''
  let finish
  try {
    for await (const chunk of ctx.llm.stream({
      provider: route.provider, model: route.model,
      system: `你只判断当前用户回复的操作意图，不执行操作。${context} 只输出 JSON：{"intent":"${allowed.join('|')}","editInstruction":""}。用户说“不要/先别/还没”时不能判为 confirm 或 search；提到命令名称不等于要求执行。无法确定就用 clarify。`,
      messages: [{ id: randomUUID(), role: 'user', content: [{ type: 'text', text: answer.slice(0, 800) }],
        source: { kind: 'plugin', plugin: 'wlyd-presales-solution' } }],
      maxTokens: 240, signal, sessionId: agent?.session?.id,
    })) {
      if (chunk.type === 'text-delta') text += chunk.text
      if (chunk.type === 'block-end' && chunk.block.type === 'text') blockText += chunk.block.text
      if (chunk.type === 'finish') finish = chunk.reason
    }
    if (finish?.kind !== 'stop') return { intent: 'clarify' }
    const parsed = JSON.parse((text || blockText).trim().replace(/^```(?:json)?\s*/iu, '').replace(/\s*```$/u, ''))
    if (!allowed.includes(parsed.intent)) return { intent: 'clarify' }
    if (NEGATION.test(answer) && ['confirm', 'search'].includes(parsed.intent)) return { intent: 'clarify' }
    if (parsed.intent === 'edit' && (typeof parsed.editInstruction !== 'string' || parsed.editInstruction.length > 150)) return { intent: 'clarify' }
    return { intent: parsed.intent, editInstruction: parsed.editInstruction }
  } catch (error) {
    if (signal?.aborted) throw error
    return { intent: 'clarify' }
  }
}

/** 只使用预设行业和主题词组成外部查询，不发送知识库原句、客户名或产品名。 */
function safePublicQuery(manifest) {
  const material = (manifest.files ?? []).map(file => file.excerpt ?? '').join(' ').slice(0, 12000)
  const industry = ['物流', '零售', '制造', '金融', '教育', '医疗', '政务', '电商']
    .find(word => material.includes(word)) ?? '企业'
  const topic = ['供应链', '仓储', '运输', '销售', '营销', '客服', '采购', '协作', '知识管理', '内容生产']
    .find(word => material.includes(word)) ?? '业务流程'
  return `${industry} ${topic} 常见问题 行业公开资料`
}

/** 公开资料只补候选痛点；每条来源单独留痕，不能证明本企业产品能力。 */
async function searchPublicMaterials(ctx, agent, signal, pending, automatic = false) {
  const query = safePublicQuery(pending.manifest)
  const retryHint = '可直接补充信息，或回复“标待确认继续”查看待确认大纲，或回复“停止”。'
  let searched
  try {
    searched = await ctx.tools.execute({
      callId: randomUUID(), name: 'web_search',
      arguments: { queries: [query] }, agent, signal,
    })
  } catch (error) {
    if (signal?.aborted) throw error
    return { kind: 'question', text: `公开检索暂不可用。${pending.gapQuestion}\n${retryHint}`, pending }
  }
  if (searched.isError) {
    return { kind: 'question', text: `公开检索暂不可用：${toolError(searched)}\n${pending.gapQuestion}\n${retryHint}`, pending }
  }
  const hits = (Array.isArray(searched.value?.sources) ? searched.value.sources : [])
    .filter(source => /^https:\/\//iu.test(source.url ?? '') && String(source.snippet ?? '').trim())
    .slice(0, 5)
  if (hits.length === 0) {
    return { kind: 'question', text: `公开检索没有返回可用内容。\n${retryHint}`, pending }
  }
  const retrievedAt = new Date().toISOString()
  const publicSources = hits.map((source, index) => ({
    path: `公开资料（待核实）[${index + 1}] ${source.url}`,
    content: String(source.snippet).trim().slice(0, 1200),
    title: String(source.title ?? '无标题').slice(0, 150),
    url: source.url,
  }))
  const note = publicSources
    .map(source => `${source.path}\n标题：${source.title}\n${source.content}`)
    .join('\n\n')
  const researchRelative = `${pending.runId}/research/public-sources.md`
  const researchTarget = await ctx.fs.resolve(researchRelative, { cwd: agent?.session?.header?.cwd ?? process.cwd(), signal })
  await ctx.fs.writeText(researchTarget,
    `# 公开资料检索（AI 补充，待核实）\n\n检索问题：${query}\n时间：${retrievedAt}\n\n${note}\n`, undefined, signal)
  const enrichedManifest = { ...pending.manifest, files: [
    ...(pending.manifest.files ?? []),
    ...publicSources.map(source => ({
      path: source.path, excerpt: source.content, kind: 'public', sourceUrl: source.url, retrievedAt,
    })),
  ] }
  const assessment = await assessMaterials(ctx, agent, signal, enrichedManifest)
  if (assessment.kind === 'question') {
    pending.gapQuestion = assessment.question
    pending.outlineCandidate = assessment.outline
    return { kind: 'question', text: `公开检索结果已存 ${researchRelative}，但仍不足以建立有依据的对应关系。\n${assessment.question}`, pending }
  }
  pending.manifest = enrichedManifest
  const outcome = propose(pending, assessment.links, assessment.outline)
  return { ...outcome, text: `${automatic ? '已自动补查' : '已参考'} ${hits.length} 条公开检索结果（存于 ${researchRelative}，标待核实）。\n${outcome.text}` }
}

/**
 * 用户对资料缺口、大纲或知识库选择作决定后继续；补充内容只标为待核实的用户来源。
 * @param {object} ctx - 插件上下文。
 * @param {object} agent - 目标代理。
 * @param {AbortSignal} signal - 取消信号。
 * @param {object} pending - 上次流程挂起状态。
 * @param {string} answer - 用户回复文本。
 * @param {object} [config] - 插件 Config,供内容中台拉取解析平台账号。
 */
export async function resumePresales(ctx, agent, signal, pending, answer, config) {
  // 客户端会把连发的相同消息合并成一条(如三行"确认大纲");去重后按单行指令处理。
  const lines = [...new Set(answer.split(/[\n\r]+/u).map(line => line.trim()).filter(Boolean))]
  const text = lines.length === 1 ? lines[0] : answer.trim()
  if (/^(?:停止|取消|stop)$/iu.test(text)) return { kind: 'stopped', text: '已停止本次售前方案生成。' }
  if (pending.stage === 'product') {
    const product = text.replace(/^(?:产品|名称)\s*[:：]\s*/u, '').trim()
    if (!product || product.length > 40) return { kind: 'question', text: '请告诉我产品名称，例如“CallWan”。', pending }
    return runPresales(ctx, agent, signal, { kind: 'auto', product,
      stage: /深入接触|已沟通|复访/u.test(text) ? 'deep' : 'initial' }, config)
  }
  if (pending.stage === 'auto-kb') {
    const picked = pickKnowledgeBase(pending.options ?? [], text)
    if (!picked) return { kind: 'question', text: `请选择编号：\n${pending.options.map((item, i) => `${i + 1}. ${item.name}`).join('\n')}`, pending }
    return pullFromKnowledgeBase(ctx, agent, signal, config, picked.kb, pending.runId,
      { ...pending.sales, sourceSummary: `内容中台「${picked.name}」` })
  }
  if (pending.stage === 'platform-project') {
    const picked = pickKnowledgeBase(pending.options ?? [], text)
    if (!picked) {
      const menu = (pending.options ?? []).map((project, index) => `${index + 1}. ${project.name}`).join('\n')
      return { kind: 'question', text: `请回复编号选择项目：\n${menu}\n回复“取消”退出。`, pending }
    }
    return pullProjectKnowledgeBases(ctx, agent, signal, config, picked, pending.runId)
  }
  if (pending.stage === 'platform-kb') {
    const picked = pickKnowledgeBase(pending.options ?? [], text)
    if (!picked) {
      const menu = (pending.options ?? []).map((kb, index) => `${index + 1}. ${kb.name}`).join('\n')
      return { kind: 'question', text: `请回复编号选择知识库：\n${menu}\n回复“取消”退出。`, pending }
    }
    return pullFromKnowledgeBase(ctx, agent, signal, config, picked, pending.runId)
  }
  if (pending.stage === 'generating') {
    if (text !== '重试生成') return { kind: 'question', text: '上次确认后正在生成或因重启中断。请先检查该次输出目录；如需恢复，回复“重试生成”。', pending }
    const base = path.resolve(agent?.session?.header?.cwd ?? process.cwd(), pending.runId, 'solution')
    try {
      await Promise.all(['json', 'md', 'html', 'docx'].map(ext => access(`${base}.${ext}`)))
      const existing = JSON.parse(await readFile(`${base}.json`, 'utf8'))
      return { kind: 'success', text: `检测到上次生成已完成，未重复运行。Markdown：${pending.runId}/solution.md；HTML：${pending.runId}/solution.html；Word：${pending.runId}/solution.docx。`
        + (existing.editorId ? `HTML 编辑入口：/wlyd-presales/doc/${existing.editorId}/solution.html。` : '') }
    } catch {
      pending.stage = 'outline'
      return resumePresales(ctx, agent, signal, pending, '确认大纲')
    }
  }
  if (pending.stage === 'outline') {
    const directEdit = editOutline(pending.outline, text)
    const direct = directReplyIntent('outline', text)
    const interpreted = !direct && directEdit.error
      ? await inferReplyIntent(ctx, agent, signal, 'outline', text, pending.outline)
      : { intent: direct }
    if (interpreted.intent === 'confirm') {
      pending.stage = 'generating'
      await savePending(agent, pending)
      const outcome = await generateDraft(ctx, agent, signal, pending, pending.links)
      if (outcome.kind === 'error') { pending.stage = 'outline'; return { ...outcome, pending } }
      return outcome
    }
    const changed = directEdit.error && interpreted.intent === 'edit'
      ? editOutline(pending.outline, interpreted.editInstruction)
      : directEdit
    if (changed.error) {
      const hint = interpreted.intent === 'clarify' || interpreted.intent === 'edit'
        ? '我没确定你是要修改哪一章，还是按当前大纲生成。可以直接说“就按这个生成”，或说要改的章节和内容。'
        : changed.error
      return { kind: 'outline', text: `${hint}\n\n${formatOutline(pending.outline)}`, pending }
    }
    pending.outline = changed.outline
    return { kind: 'outline', text: formatOutline(pending.outline), pending }
  }
  const direct = directReplyIntent('evidence', text)
  const interpreted = direct ? { intent: direct } : await inferReplyIntent(ctx, agent, signal, 'evidence', text)
  if (interpreted.intent === 'search') return searchPublicMaterials(ctx, agent, signal, pending)
  if (interpreted.intent === 'continue') {
    const outline = pending.outlineCandidate ?? await outlineFromMaterials(ctx, agent, signal, pending.manifest)
    return propose(pending, [], outline)
  }
  if (interpreted.intent === 'clarify') return { kind: 'question', text: '我没确定你是希望我上网找公开资料、补充你的信息，还是先看待确认大纲。可以用平常说法告诉我想做哪一步。', pending }
  const note = text.replace(/^(?:补充|说明)\s*[:：]\s*/u, '').trim()
  if (!note) return { kind: 'question', text: '请补充客户问题与产品做法，或回复“检索公开资料”由 AI 补充（标待核实），或回复“标待确认继续”查看待确认大纲，或回复“停止”。', pending }
  const assessment = await assessMaterials(ctx, agent, signal, pending.manifest, note)
  if (assessment.kind === 'question') {
    pending.gapQuestion = assessment.question
    pending.outlineCandidate = assessment.outline
    return { kind: 'question', text: assessment.question, pending }
  }
  return propose(pending, assessment.links, assessment.outline)
}

/** 给模型一条已记录、可回放的插件结果，不让它重复触发生成。 */
export function resultMessage(result) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: `${result.text}\n请直接向用户说明上述结果；不要再次调用 wlyd_ingest 或 wlyd_solution。` }],
    source: { kind: 'plugin', plugin: 'wlyd-presales-solution', form: 'notice', summary: '售前插件路由结果' },
  })
}
