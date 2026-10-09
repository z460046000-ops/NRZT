/**
 * 万联智达内容中台 · 售前解决方案插件(路线B外挂,零 harness 运行时依赖)。
 *
 * 提供两个模型工具:
 * - wlyd_ingest:导入材料(产品/公司/部门资料、截图、产品包),提取文本,
 *   产出 analysis/materials.json 与 analysis/corpus.md。
 * - wlyd_solution:按用户确认的大纲生成售前解决方案;同时产出 .md(可编辑源)、.html(集团模板幻灯片风格,
 *   可打印导出 PDF)、.docx(Word 交付物)。
 *
 * @module @wlyd/dsh-presales-solution
 */

import { readFileSync } from 'node:fs'
import { lstat, mkdir, realpath, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { classify, extractBinaryText, ingestMaterials } from './ingest.js'
import { renderMarkdown } from './markdown.js'
import { renderHtml } from './html.js'
import { renderDocx } from './docx.js'
import { materialSource, mentionsPresales, resultMessage, resumePresales, runPresales } from './router.js'
import { prepareSolution, registerDocument, snapshotInitial } from './editor-store.js'
import { registerEditorRoutes } from './editor-routes.js'
import { documentToSolution, fetchDocument, generateSolution, knowledgeStatus, resolvePlatformConfig, setupProject, uploadProjectFile } from './platform.js'
import { loadPending, savePending } from './outline.js'
import { painWithBasis } from './pain-basis.js'
import { isSafeDisplayText } from './source-quality.js'
import { customerFacingSolution } from './customer-copy.js'

/** Cordis Loader 身份。 */
export const name = 'wlyd-presales-solution'

/** 依赖工具、文件系统与当前会话已配置的模型。 */
export const inject = ['tools', 'fs', 'llm']

/**
 * 章节语义类型；章数和顺序由材料及用户确认的大纲决定。
 */
export const SECTION_KINDS = [
  'trends', 'pains', 'solution', 'architecture', 'capabilities',
  'scenarios', 'implementation', 'service', 'company', 'boundary',
  'problem_solution', 'custom',
]

/** 章节内容的块类型。 */
export const BLOCK_TYPES = ['para', 'bullets', 'steps', 'table', 'image', 'quote', 'metrics']

function isStr(v) {
  return typeof v === 'string'
}

function nonEmpty(v) {
  return isStr(v) && v.trim().length > 0
}

function bad(tool, msg) {
  return new Error(`${tool}: ${msg}`)
}

/**
 * 校验并规范化 wlyd_solution 参数。
 * @param {object} args - 模型参数。
 * @returns {object} 规范化后的 solution 对象。
 */
function normalizeSolution(args) {
  if (!nonEmpty(args.title)) throw bad('wlyd_solution', 'title 必须是非空字符串')
  const rawSections = args.sections
  if (!Array.isArray(rawSections) || rawSections.length === 0) {
    throw bad('wlyd_solution', 'sections 必须是至少一个章节的数组')
  }
  if (rawSections.length > 8) throw bad('wlyd_solution', 'sections 最多 8 章；建议 3—6 章')
  const sections = rawSections.map((section, sIdx) => {
    if (!section || typeof section !== 'object') throw bad('wlyd_solution', `sections[${sIdx}] 不是对象`)
    if (!SECTION_KINDS.includes(section.kind)) {
      throw bad('wlyd_solution', `sections[${sIdx}].kind 必须是 ${SECTION_KINDS.join('/')},收到 ${JSON.stringify(section.kind)}`)
    }
    if (!nonEmpty(section.heading)) throw bad('wlyd_solution', `sections[${sIdx}].heading 必须是非空字符串`)
    if (!Array.isArray(section.blocks) || section.blocks.length === 0) {
      throw bad('wlyd_solution', `sections[${sIdx}].blocks 必须是至少一个内容块的数组`)
    }
    return {
      kind: section.kind,
      heading: section.heading.trim(),
      lead: optStr(section.lead, `sections[${sIdx}].lead`),
      blocks: section.blocks.map((b, bIdx) => normalizeBlock(b, sIdx, bIdx)),
    }
  })

  const links = normalizeLinks(args.pain_solution_links)
  const pains = sections.find(section => section.kind === 'pains')
  const solution = sections.find(section => section.kind === 'solution')
  const combined = sections.find(section => section.kind === 'problem_solution')
  if (combined && (pains || solution)) throw bad('wlyd_solution', '合并的痛点—方案章不能与独立痛点/方案章重复')
  if ((pains === undefined) !== (solution === undefined)) {
    throw bad('wlyd_solution', '客户痛点与解决方案两章必须同时提供')
  }
  if (links.length && !combined && (!pains || !solution)) {
    throw bad('wlyd_solution', '有痛点—方案对应关系时须包含合并章，或同时包含独立痛点与方案章')
  }
  if (pains && solution) {
    pains.blocks = links.length ? [{
      type: 'table', headers: ['编号', '客户痛点', '材料依据'],
      rows: links.map(link => [link.id, painWithBasis(link), `${link.painEvidence.path}：${link.painEvidence.quote}`]),
    }] : [{ type: 'para', text: '待补充并确认：尚无证据支持的客户痛点。' }]
    solution.blocks = links.length ? [{
      type: 'table', headers: ['对应痛点', '解决办法', '材料依据'],
      rows: links.map(link => [link.id, link.solution, `${link.solutionEvidence.path}：${link.solutionEvidence.quote}`]),
    }] : [{ type: 'para', text: '待补充并确认：尚无与客户痛点对应、且有依据的解决办法。' }]
  }

  const metaIn = args.meta ?? {}
  const meta = {
    company: optStr(metaIn.company, 'meta.company'),
    product: optStr(metaIn.product, 'meta.product'),
    version: optStr(metaIn.version, 'meta.version'),
    date: optStr(metaIn.date, 'meta.date'),
    contact: optStr(metaIn.contact, 'meta.contact'),
  }
  const theme = args.theme === undefined ? 'corporate' : args.theme
  if (!['corporate', 'dark', 'elegant'].includes(theme)) {
    throw bad('wlyd_solution', `theme 必须是 corporate/dark/elegant,收到 ${JSON.stringify(args.theme)}`)
  }
  return {
    title: args.title.trim(),
    subtitle: optStr(args.subtitle, 'subtitle'),
    meta,
    theme,
    sections,
    painSolutionLinks: links,
    generatedAt: new Date().toISOString(),
  }
}

function normalizeLinks(value) {
  if (!Array.isArray(value)) throw bad('wlyd_solution', 'pain_solution_links 必须是数组；无可靠对应关系时传空数组')
  if (value.length > 5) throw bad('wlyd_solution', 'pain_solution_links 最多 5 条')
  const ids = new Set()
  return value.map((link, index) => {
    const where = `pain_solution_links[${index}]`
    if (!link || !nonEmpty(link.id) || !/^P[1-9]\d*$/u.test(link.id) || ids.has(link.id)) {
      throw bad('wlyd_solution', `${where}.id 必须是唯一的 P1、P2 等编号`)
    }
    ids.add(link.id)
    if (!nonEmpty(link.pain) || !nonEmpty(link.solution)) {
      throw bad('wlyd_solution', `${where} 必须同时填写痛点和对应方案`)
    }
    if (!isSafeDisplayText(link.pain) || !isSafeDisplayText(link.solution)) {
      throw bad('wlyd_solution', `${where} 的痛点或方案含代码或不可读字符`)
    }
    const evidence = field => {
      const item = link[field]
      if (!item || !nonEmpty(item.path) || !nonEmpty(item.quote)) {
        throw bad('wlyd_solution', `${where}.${field} 必须包含材料路径与原文摘录`)
      }
      if (!isSafeDisplayText(item.quote)) {
        throw bad('wlyd_solution', `${where}.${field}.quote 含代码或不可读字符，请提炼为可读证据`)
      }
      return { path: item.path.trim(), quote: item.quote.trim() }
    }
    return {
      id: link.id, pain: link.pain.trim(), solution: link.solution.trim(),
      painBasis: ['explicit', 'inferred', 'public_unverified', 'user_unverified'].includes(link.painBasis)
        ? link.painBasis : 'explicit',
      painEvidence: evidence('painEvidence'), solutionEvidence: evidence('solutionEvidence'),
    }
  })
}

/** DSH WebUI 会把问题放进输入区；其他客户端仍可用普通文本继续。 */
function composerDetail(outcome) {
  const pending = outcome.pending
  if (pending?.stage === 'outline') {
    const rows = (pending.outline ?? []).map((section, index) => {
      const names = section.sourcePaths.map(source => path.basename(source)
        .replace(/^[a-f0-9]{8}-[a-f0-9-]{27,}-/iu, '')).slice(0, 2)
      return `${index + 1}. **${section.heading}**${names.length ? `\n   依据：${names.join('、')}` : '\n   依据待补充'}`
    })
    return `**建议结构 · ${rows.length} 章**\n\n${rows.join('\n\n')}\n\n可以选择生成，或在输入框说明要改哪一章。`
  }
  if (pending?.stage === 'evidence') {
    return `**需要你判断**\n\n${(pending.gapQuestion ?? outcome.text).split('\n')[0]}\n\n公开资料只作行业参考，不能证明当前客户的问题或本公司的能力。`
  }
  return '只会读取当前账号有权限访问的内容。'
}

async function askInComposer(ctx, agent, signal, initial, config) {
  const questions = ctx.get?.('userQuestions')
  if (!questions?.ask) return initial
  let outcome = initial
  for (let step = 0; step < 4 && outcome.pending && ['question', 'outline'].includes(outcome.kind); step++) {
    const pending = outcome.pending
    const stage = pending.stage
    const options = stage === 'outline'
      ? [{ label: '按此大纲生成' }]
      : stage === 'evidence'
        ? [{ label: '搜索公开资料' }, { label: '先看待确认大纲' }]
        : (pending.options ?? []).map((option, index) => ({ label: `${index + 1}. ${option.name}` }))
    if (!options.length) return outcome
    let answer
    try {
      const response = await questions.ask({ agent, signal, questions: [{
        id: `presales-${stage}-${step}`, header: '售前方案',
        question: stage === 'outline' ? '按这个大纲生成，还是在下方输入修改意见？'
          : stage === 'evidence' ? '资料仍有缺口。请选择下一步，或输入补充信息。'
            : '请选择要读取的项目或知识库。',
        detail: composerDetail(outcome), options,
      }] })
      answer = response?.answers?.[0]?.custom?.trim() || response?.answers?.[0]?.selected?.[0]
    } catch (error) {
      if (signal?.aborted) throw error
      return outcome
    }
    if (!answer) return outcome
    outcome = await resumePresales(ctx, agent, signal, pending, answer, config)
    await savePending(agent, outcome.pending)
  }
  return outcome
}

function optStr(v, field) {
  if (v === undefined || v === null) return undefined
  if (!isStr(v)) throw bad('wlyd_solution', `${field} 必须是字符串`)
  const t = v.trim()
  return t.length > 0 ? t : undefined
}

function normalizeBlock(block, sIdx, bIdx) {
  const where = `sections[${sIdx}].blocks[${bIdx}]`
  if (!block || typeof block !== 'object') throw bad('wlyd_solution', `${where} 不是对象`)
  const type = block.type
  if (!BLOCK_TYPES.includes(type)) {
    throw bad('wlyd_solution', `${where}.type 必须是 ${BLOCK_TYPES.join('/')},收到 ${JSON.stringify(type)}`)
  }
  switch (type) {
    case 'para':
    case 'quote':
      if (!nonEmpty(block.text)) throw bad('wlyd_solution', `${where}.text 必须是非空字符串`)
      if (!isSafeDisplayText(block.text)) throw bad('wlyd_solution', `${where}.text 含代码或不可读字符，请提炼为可读文字`)
      return { type, text: block.text.trim() }
    case 'bullets':
    case 'steps': {
      const items = strArray(block.items, `${where}.items`)
      if (items.length === 0) throw bad('wlyd_solution', `${where}.items 不能为空`)
      if (items.some(item => !isSafeDisplayText(item))) throw bad('wlyd_solution', `${where}.items 含代码或不可读字符`)
      return { type, items }
    }
    case 'table': {
      const headers = strArray(block.headers, `${where}.headers`)
      if (headers.length === 0) throw bad('wlyd_solution', `${where}.headers 不能为空`)
      if (headers.some(header => !isSafeDisplayText(header))) throw bad('wlyd_solution', `${where}.headers 含代码或不可读字符`)
      if (!Array.isArray(block.rows) || block.rows.length === 0) {
        throw bad('wlyd_solution', `${where}.rows 必须是非空二维字符串数组`)
      }
      const rows = block.rows.map((row, r) => {
        const cells = strArray(row, `${where}.rows[${r}]`)
        if (cells.length > headers.length) {
          throw bad('wlyd_solution', `${where}.rows[${r}] 有 ${cells.length} 列,超过表头 ${headers.length} 列`)
        }
        while (cells.length < headers.length) cells.push('')
        if (cells.some(cell => cell && !isSafeDisplayText(cell))) throw bad('wlyd_solution', `${where}.rows[${r}] 含代码或不可读字符`)
        return cells
      })
      return { type, headers, rows }
    }
    case 'image': {
      if (!nonEmpty(block.path)) throw bad('wlyd_solution', `${where}.path 必须是非空字符串`)
      return { type, path: block.path.trim(), caption: optStr(block.caption, `${where}.caption`) }
    }
    case 'metrics': {
      const itemsIn = block.items
      if (!Array.isArray(itemsIn) || itemsIn.length === 0) {
        throw bad('wlyd_solution', `${where}.items 必须是 {label,value} 数组`)
      }
      const items = itemsIn.map((m, i) => {
        if (!m || !nonEmpty(m.label) || !nonEmpty(m.value)) {
          throw bad('wlyd_solution', `${where}.items[${i}].label/value 必须是非空字符串`)
        }
        return { label: m.label.trim(), value: m.value.trim() }
      })
      return { type, items }
    }
    default:
      throw bad('wlyd_solution', `${where}.type 未支持`)
  }
}

function strArray(v, field) {
  if (!Array.isArray(v)) throw bad('wlyd_solution', `${field} 必须是字符串数组`)
  return v.map((item, i) => {
    if (!nonEmpty(item)) throw bad('wlyd_solution', `${field}[${i}] 必须是非空字符串`)
    return item.trim()
  })
}

/**
 * 复制方案引用的图片素材到 <base>-assets/,返回素材描述与警告。
 */
async function collectAssets(ctx, imageBlocks, cwd, signal) {
  const assets = []
  const warnings = []
  const seen = new Map()
  for (const block of imageBlocks) {
    if (seen.has(block.path)) {
      block.sourcePath = seen.get(block.path).sourcePath
      continue
    }
    try {
      const target = await ctx.fs.resolve(block.path, { cwd, signal })
      const buffer = Buffer.from(await ctx.fs.readBytes(target, signal, 20 * 1024 * 1024))
      const base = path.basename(block.path)
      const fileName = assets.length === 0 ? base : `${assets.length}-${base}`
      const asset = { sourcePath: block.path, fileName, buffer, caption: block.caption }
      assets.push(asset)
      seen.set(block.path, asset)
      block.sourcePath = block.path
    } catch (err) {
      warnings.push(`图片读取失败,已跳过 ${block.path}:${err instanceof Error ? err.message : String(err)}`)
    }
  }
  return { assets, warnings }
}

const KIND_GUIDE = [
  ['trends', '趋势与背景:行业变化、政策驱动、技术演进,说明为什么现在是做这件事的时机'],
  ['pains', '客户痛点:目标客户在哪些环节遇到什么问题、后果是什么,用业务语言'],
  ['solution', '解决方案:总体思路、方案主张、与痛点的对应关系'],
  ['architecture', '产品架构:平台层、能力层、场景层、集成层,说清系统由什么组成'],
  ['capabilities', '核心能力:关键功能、人机协作方式、人工检查点'],
  ['scenarios', '场景支持:产品支撑的具体场景包;可按场景重复出现本节,每个场景一节'],
  ['implementation', '实施路径:阶段划分、关键活动、交付物、参与角色;周期用区间表达'],
  ['service', '服务保障:交付支持、培训、运维、升级'],
  ['company', '公司介绍:集团背景、业务线、资质,建立信任'],
  ['boundary', '合作与边界:合作模式框架、责任分工、风险和限制'],
]

const OUTLINE_INSTRUCTION = '请根据下方用户已确认的大纲生成售前解决方案；章节可以合并，但须保留客户问题与对应做法、能力依据和适用边界。'
  + '每节给出 heading、lead 和有来源的正文；标题、正文和结尾使用可直接给客户阅读的正式话语，不出现“本章”“模型生成”“请复核原文”等内部制作话语。'
  + '没有依据的内容标“待与贵方确认”，不要机械补齐十章，不要虚构事实。'

/**
 * 落盘方案的三份交付物与 .json 源,注册编辑器并返回统一输出结构。
 * wlyd_solution 与 wlyd_platform_render 共用。
 */
async function persistSolution(ctx, exec, solution, { base, cwd, signal, assets, assetViews, warnings, extraOutput }) {
  if (path.isAbsolute(base) || base.split(/[\\/]/u).includes('..') || base === '.' || base === '') {
    throw bad('wlyd_solution', 'output_base 必须是当前工作区内的相对路径')
  }
  const baseAbs = path.resolve(cwd, base)
  const assetsDirName = `${path.basename(base)}-assets`

  const markdown = renderMarkdown(solution, assetViews)
  const html = renderHtml(solution, assetViews)
  const docx = await renderDocx(solution, assets)

  const mdTarget = await ctx.fs.resolve(`${base}.md`, { cwd, signal })
  const htmlTarget = await ctx.fs.resolve(`${base}.html`, { cwd, signal })
  const jsonTarget = await ctx.fs.resolve(`${base}.json`, { cwd, signal })
  const mdOutcome = await ctx.fs.writeText(mdTarget, markdown, undefined, signal)
  const htmlOutcome = await ctx.fs.writeText(htmlTarget, html, undefined, signal)
  const jsonOutcome = await ctx.fs.writeText(jsonTarget, JSON.stringify({ ...solution, assets: assetViews.map(({ sourcePath, fileName, caption }) => ({ sourcePath, fileName, caption })) }, null, 2) + '\n', undefined, signal)
  ctx.emit('fs/observed', mdTarget, { kind: 'present', version: mdOutcome.version }, exec)
  ctx.emit('fs/observed', htmlTarget, { kind: 'present', version: htmlOutcome.version }, exec)
  ctx.emit('fs/observed', jsonTarget, { kind: 'present', version: jsonOutcome.version }, exec)

  const docxPath = `${base}.docx`
  await mkdir(path.dirname(baseAbs), { recursive: true })
  const workspace = await realpath(cwd)
  const outputDir = await realpath(path.dirname(baseAbs))
  if (outputDir !== workspace && !outputDir.startsWith(`${workspace}${path.sep}`)) throw bad('wlyd_solution', '输出目录超出当前工作区')
  const assertRegularOrAbsent = async target => {
    const info = await lstat(target).catch(err => { if (err?.code === 'ENOENT') return null; throw err })
    if (info && !info.isFile()) throw bad('wlyd_solution', '输出目标不是普通文件')
  }
  if (assets.length > 0) {
    const assetsDir = path.join(outputDir, assetsDirName)
    await mkdir(assetsDir, { recursive: true })
    if (await realpath(assetsDir) !== assetsDir) throw bad('wlyd_solution', '图片目录不能是符号链接')
    for (const asset of assets) {
      const target = path.join(assetsDir, asset.fileName)
      await assertRegularOrAbsent(target)
      await writeFile(target, asset.buffer)
    }
  }
  await assertRegularOrAbsent(`${baseAbs}.docx`)
  await writeFile(`${baseAbs}.docx`, docx)
  await registerDocument(baseAbs, solution.editorId)
  await snapshotInitial(baseAbs)

  const editPath = `/wlyd-presales/doc/${solution.editorId}/solution.html`
  const webServer = ctx.get?.('webServer')
  const editUrl = webServer?.port ? `http://127.0.0.1:${webServer.port}${editPath}` : editPath

  return {
    base,
    markdownPath: `${base}.md`,
    htmlPath: `${base}.html`,
    docxPath,
    jsonPath: `${base}.json`,
    editUrl,
    sectionCount: solution.sections.length,
    imageCount: assets.length,
    warnings,
    ...extraOutput,
  }
}

/** 插件注册体:挂载两个工具。 */
async function preparePlatformFiles(ctx, exec, filesIn, tool) {
  const signal = exec.signal
  const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
  if (!Array.isArray(filesIn) || filesIn.length === 0 || filesIn.length > 10) {
    throw bad(tool, 'files 必须包含 1—10 个工作区内材料路径')
  }
  const warnings = []
  const files = []
  for (const input of filesIn) {
    if (!nonEmpty(input)) throw bad(tool, 'files 中的路径必须是非空字符串')
    const name = path.basename(input.trim())
    try {
      const target = await ctx.fs.resolve(input.trim(), { cwd, signal })
      const buffer = Buffer.from(await ctx.fs.readBytes(target, signal, 20 * 1024 * 1024))
      const kind = classify(name)
      let content
      if (kind === 'text') content = buffer.toString('utf8')
      else if (['docx', 'pdf', 'pptx'].includes(kind)) {
        content = (await extractBinaryText(kind, buffer)).text
        warnings.push(`${name}(${kind})已提取为文本上传`)
      } else {
        warnings.push(`${name}(${kind})平台不支持，已跳过`)
        continue
      }
      if (!content.trim()) { warnings.push(`${name} 无可提取文本，已跳过`); continue }
      const base = name.replace(/\.[^.]+$/, '')
      const ext = /\.(md|markdown|txt|json|csv|log|xml|ya?ml)$/iu.test(name) ? name.slice(base.length) : '.md'
      files.push({ name: `${base}${ext}`, content })
    } catch (err) {
      if (signal?.aborted) throw err
      warnings.push(`读取失败，已跳过 ${name}：${err instanceof Error ? err.message : String(err)}`)
    }
  }
  if (files.length === 0) throw bad(tool, '没有可上传的文本材料')
  return { files, warnings }
}

export function apply(ctx, config) {
  // 同包提供原创售前幻灯片设计 Skill；确定性渲染仍由 renderHtml 执行。
  ctx.inject(['skills'], skillCtx => {
    const raw = readFileSync(new URL('../skills/wlyd-presales-html-ppt/SKILL.md', import.meta.url), 'utf8')
    const content = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')
    skillCtx.skills.register({
      name: 'wlyd-presales-html-ppt',
      description: '设计或复核万联智达售前解决方案的 HTML 幻灯片时使用；保持事实来源、痛点与做法对应，以及可编辑源稿同步。',
      source: 'runtime', content,
    })
  })
  const awaitingMaterial = new WeakSet()
  const pendingDecision = new WeakMap()
  const processed = new WeakMap()
  const routedReplies = new Map()

  // 确定性路由已经执行工具并给出结果时，本轮由插件直接答复，避免模型再次导入或编造内容。
  ctx.on('llm/stream', (options, next) => {
    const sessionId = options.sessionId === undefined ? undefined : String(options.sessionId)
    const reply = sessionId === undefined ? undefined : routedReplies.get(sessionId)
    if (reply === undefined) return next()
    routedReplies.delete(sessionId)
    return (async function* () {
      yield { type: 'text-delta', index: 0, text: reply }
      yield { type: 'finish', reason: { kind: 'stop' } }
    })()
  })

  ctx.on('agent/pre-step', async ({ agent, signal }, next) => {
    const decision = await next()
    if (decision.kind !== 'enter' || signal.aborted) return decision
    const userMessage = decision.messages.find(message => message.source.kind === 'user')
    if (!userMessage) return decision
    const text = userMessage.content.filter(block => block.type === 'text').map(block => block.text).join('\n')
    if (agent.session?.id !== undefined) routedReplies.delete(String(agent.session.id))
    let pending = pendingDecision.get(agent)
    if (!pending) {
      pending = await loadPending(agent)
      if (pending) pendingDecision.set(agent, pending)
    }
    if (!mentionsPresales(text) && !awaitingMaterial.has(agent) && !pending) return decision

    let agentRuns = processed.get(agent)
    if (!agentRuns) {
      agentRuns = new Map()
      processed.set(agent, agentRuns)
    }
    let run = agentRuns.get(userMessage.id)
    if (!run) {
      const source = materialSource(text)
      const initial = source?.kind === 'cancel' ? runPresales(ctx, agent, signal, source, config)
        : pending && !['path', 'auto'].includes(source?.kind) ? resumePresales(ctx, agent, signal, pending, text, config)
          : runPresales(ctx, agent, signal, source, config)
      run = Promise.resolve(initial).then(outcome => askInComposer(ctx, agent, signal, outcome, config))
      agentRuns.set(userMessage.id, run)
    }
    const outcome = await run
    if (outcome.kind === 'missing') awaitingMaterial.add(agent)
    else awaitingMaterial.delete(agent)
    if (outcome.pending) pendingDecision.set(agent, outcome.pending)
    else pendingDecision.delete(agent)
    if (outcome.pending || pending) await savePending(agent, outcome.pending)
    if (agent.session?.id !== undefined) routedReplies.set(String(agent.session.id), outcome.text)
    return { ...decision, messages: [...decision.messages, resultMessage(outcome)] }
  })

  // Web/CLI 提供 commands 时显示直接入口；材料判断仍使用当前会话模型。
  ctx.inject(['commands'], commandCtx => {
    commandCtx.commands.register({
      name: 'presales',
      description: '给出产品名称即可自动检索知识库并生成售前方案，也可指定材料路径',
      input: { hint: '<产品名称|材料路径|读取内容中台>' },
      async handler({ agent, rawInput, signal }) {
        const source = materialSource(rawInput, true)
        const pending = pendingDecision.get(agent) ?? await loadPending(agent)
        const initial = source?.kind === 'cancel'
          ? await runPresales(ctx, agent, signal, source, config)
          : pending && !['path', 'auto'].includes(source?.kind)
            ? await resumePresales(ctx, agent, signal, pending, rawInput, config)
            : await runPresales(ctx, agent, signal, source, config)
        const outcome = await askInComposer(ctx, agent, signal, initial, config)
        if (outcome.pending) pendingDecision.set(agent, outcome.pending)
        else pendingDecision.delete(agent)
        if (outcome.pending || pending) await savePending(agent, outcome.pending)
        return { kind: outcome.kind === 'error' ? 'error' : 'success', text: outcome.text }
      },
    })
  })

  // Web profile 提供连接服务时挂载同源编辑入口；CLI/headless 仍可生成文件。
  ctx.inject(['connection', 'webServer'], webCtx => registerEditorRoutes(webCtx))

  ctx.tools.register({
    name: 'wlyd_ingest',
    description: '导入并分析售前材料包(产品/公司/部门资料、产品截图、zip 产品包)。'
      + '接受一个文件或目录路径,自动提取文本(md/txt/csv/json/html、docx、pdf、pptx,zip 内文件同样处理),'
      + '图片登记为素材;生成 analysis/materials.json(结构化清单)与 analysis/corpus.md(全文语料)。'
      + '生成售前解决方案之前,必须先用它导入材料,再读取 analysis/corpus.md 提炼内容。',
    parameters: {
      path: {
        type: 'string', required: true,
        description: '材料文件或目录的工作区相对/绝对路径,例如 materials/',
      },
      label: { type: 'string', description: '材料包标签,如"XX产品 Q4 资料包",默认取目录名' },
      max_chars_per_file: {
        type: 'number',
        description: '单文件提取文本入库上限(默认 12000),超长截断并备注',
      },
      output_dir: { type: 'string', description: '分析产物目录,默认 analysis' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          dir: { type: 'string' },
          label: { type: 'string' },
          manifestPath: { type: 'string' },
          corpusPath: { type: 'string' },
          counts: {
            type: 'object', additionalProperties: false,
            properties: {
              total: { type: 'integer' },
              extracted: { type: 'integer' },
              images: { type: 'integer' },
              archives: { type: 'integer' },
              other: { type: 'integer' },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
          files: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                path: { type: 'string' },
                kind: { type: 'string' },
                bytes: { type: 'integer' },
                chars: { type: 'integer' },
                excerpt: { type: 'string' },
                note: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `已导入材料包「${value.label}」:${value.counts.total} 个文件`
          + `(提取文本 ${value.counts.extracted}、图片 ${value.counts.images}、压缩包 ${value.counts.archives}、其他 ${value.counts.other})。`
          + `清单 ${value.manifestPath},全文语料 ${value.corpusPath}。`
          + (value.warnings.length > 0 ? `警告:${value.warnings.join(';')}` : ''),
      }],
    },
    async execute(args, exec) {
      if (!nonEmpty(args.path)) throw bad('wlyd_ingest', 'path 必须是非空字符串')
      return ingestMaterials(ctx, args, exec)
    },
    presentCall: args => ({
      card: 'generic',
      title: '导入并分析材料',
      kind: 'read',
      rawInput: { path: args?.path, label: args?.label },
    }),
  })

  ctx.tools.register({
    name: 'wlyd_solution',
    description: '生成售前解决方案(标准化销售材料)。先向用户展示约 3—6 章大纲，接受修改并确认，再按确认顺序传入 sections；可参考的主题:'
      + KIND_GUIDE.map(([k, g]) => `${k}=${g}`).join(';')
      + '。主题可合并/省略。每节提供 heading(页面标题)、lead(一页导语)与 blocks 内容；'
      + '合并客户问题和方案时 kind=problem_solution，分别呈现时用 pains/solution。内容块类型:para{text}段落、bullets{items[]}要点卡、'
      + 'steps{items[]}流程步骤、table{headers[],rows[][]}表格(实施路径/对比首选)、'
      + 'image{path,caption}配图(path 为材料中的图片路径)、quote{text}金句/提示、'
      + 'metrics{items:[{label,value}]}数值亮点。趋势数据须来自导入材料,不得虚构;'
      + '必须提供 pain_solution_links,每条痛点有唯一编号、对应解决办法和两侧的材料原文依据；'
      + '工具会按该映射重建独立 pains/solution 章或在合并章中呈现对应关系，防止前后不一致。证据不足时传空数组，相关内容标待确认。'
      + '材料未覆盖的信息用保守表述,并放入 boundary 的限制中。'
      + '同时输出三份文件:.md(可编辑事实源)、.html(集团模板幻灯片风格,浏览器查看、'
      + '打印可导出 PDF)、.docx(Word 交付物);修改需求到达时调整对应 section 重新调用本工具。',
    parameters: {
      title: { type: 'string', required: true, description: '方案标题,如「XX AI 企业增长平台解决方案」' },
      subtitle: { type: 'string', description: '封面副标题' },
      meta: {
        type: 'object', additionalProperties: false,
        description: '抬头信息',
        properties: {
          company: { type: 'string', description: '公司/集团名' },
          product: { type: 'string', description: '产品名' },
          version: { type: 'string', description: '版本/模板标识' },
          date: { type: 'string', description: '日期,如 2026 年 10 月' },
          contact: { type: 'string', description: '联系方式/团队' },
        },
      },
      sections: {
        type: 'array', required: true,
        description: '已获用户确认的章节列表，建议 3—6 章；可合并和调整顺序',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            kind: { type: 'string', required: true, enum: SECTION_KINDS, description: '章节语义类型；合并痛点与做法时用 problem_solution' },
            heading: { type: 'string', required: true, description: '页面标题' },
            lead: { type: 'string', description: '一页导语,概括本节主张,用于篇章页' },
            blocks: {
              type: 'array', required: true,
              description: '内容块列表,建议每节 2-5 块',
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  type: { type: 'string', required: true, enum: BLOCK_TYPES },
                  text: { type: 'string' },
                  items: { type: 'array', items: {} },
                  headers: { type: 'array', items: { type: 'string' } },
                  rows: { type: 'array', items: { type: 'array', items: { type: 'string' } } },
                  path: { type: 'string' },
                  caption: { type: 'string' },
                },
              },
            },
          },
        },
      },
      pain_solution_links: {
        type: 'array', required: true,
        description: '痛点—方案—证据对应表；无可靠对应关系时传空数组',
        items: {
          type: 'object', additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: '唯一编号，例如 P1' },
            pain: { type: 'string', required: true },
            solution: { type: 'string', required: true },
            painBasis: { type: 'string', enum: ['explicit', 'inferred', 'public_unverified', 'user_unverified'],
              description: '痛点依据类型；推断、公开资料和用户补充均须保留待确认状态' },
            painEvidence: { type: 'object', required: true, properties: {
              path: { type: 'string', required: true }, quote: { type: 'string', required: true },
            } },
            solutionEvidence: { type: 'object', required: true, properties: {
              path: { type: 'string', required: true }, quote: { type: 'string', required: true },
            } },
          },
        },
      },
      theme: { type: 'string', enum: ['corporate', 'dark', 'elegant'], description: '视觉主题,默认 corporate(集团模板红蓝风格)' },
      output_base: { type: 'string', description: '输出文件名基底(不含扩展名),默认 solution' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          base: { type: 'string' },
          markdownPath: { type: 'string' },
          htmlPath: { type: 'string' },
          docxPath: { type: 'string' },
          jsonPath: { type: 'string' },
          editUrl: { type: 'string' },
          sectionCount: { type: 'integer' },
          imageCount: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `售前解决方案已生成(${value.sectionCount} 节,图片 ${value.imageCount} 张):`
          + `${value.editUrl}(HTML 编辑)、${value.markdownPath}(同步 Markdown)、${value.htmlPath}(幻灯片/打印)、${value.docxPath}(Word 交付)。`
          + (value.warnings.length > 0 ? `警告:${value.warnings.join(';')}` : ''),
      }],
    },
    async execute(args, exec) {
      const signal = exec.signal
      const solution = prepareSolution(customerFacingSolution(normalizeSolution(args)))
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
      const base = (nonEmpty(args.output_base) ? args.output_base.trim() : 'solution').replace(/\.(md|html|docx)$/i, '')

      const imageBlocks = solution.sections.flatMap(s => s.blocks.filter(b => b.type === 'image'))
      const { assets, warnings } = await collectAssets(ctx, imageBlocks, cwd, signal)
      signal.throwIfAborted()

      const assetViews = assets.map(a => ({ sourcePath: a.sourcePath, fileName: `${`${path.basename(base)}-assets`}/${a.fileName}`, caption: a.caption }))
      return persistSolution(ctx, exec, solution, { base, cwd, signal, assets, assetViews, warnings, extraOutput: {} })
    },
    presentCall: args => ({
      card: 'generic',
      title: '生成售前解决方案',
      rawInput: { title: args?.title, sections: Array.isArray(args?.sections) ? args.sections.length : undefined },
    }),
  })

  // ── 平台集成工具(配置经环境变量 WLYD_PLATFORM_*,见 platform.js)──

  ctx.tools.register({
    name: 'wlyd_platform_setup',
    description: '在内容中台平台创建方案项目与知识库,并上传材料文本。'
      + 'files 为工作区内材料路径;md/txt/json/csv/xml/yaml 直接上传,'
      + 'docx/pdf/pptx 自动提取为文本后以 .md 上传(平台只收文本格式),'
      + 'zip/图片跳过并提示改用 wlyd_ingest。上传后等待解析完成并返回就绪汇总。'
      + '需要环境变量 WLYD_PLATFORM_EMAIL/PASSWORD/TENANT_ID(可选 BASE_URL)。',
    parameters: {
      files: {
        type: 'array', required: true,
        description: '要上传的材料文件路径(工作区相对/绝对),最多 10 个',
        items: { type: 'string' },
      },
      project_name: { type: 'string', description: '平台项目名,默认「DSH-售前联调-<日期>」' },
      product_name: { type: 'string', description: '产品名,写入项目元数据' },
      description: { type: 'string', description: '项目描述' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          projectId: { type: 'string' },
          kbId: { type: 'string' },
          ready: { type: 'string' },
          uploads: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                name: { type: 'string' },
                knowledgeId: { type: 'string' },
                status: { type: 'string' },
              },
            },
          },
          warnings: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `平台项目 ${value.projectId} 已就绪(知识库 ${value.kbId},就绪 ${value.ready})。`
          + `上传:${value.uploads.map(u => `${u.name}=${u.status}`).join('、')}。`
          + `后续用 wlyd_platform_generate(project_id=${value.projectId})生成,再用 wlyd_platform_render 渲染交付物。`
          + (value.warnings.length > 0 ? `警告:${value.warnings.join(';')}` : ''),
      }],
    },
    async execute(args, exec) {
      const cfg = resolvePlatformConfig(config || {})
      const signal = exec.signal
      const { files, warnings } = await preparePlatformFiles(ctx, exec, args.files, 'wlyd_platform_setup')
      const result = await setupProject(cfg, {
        projectName: nonEmpty(args.project_name) ? args.project_name.trim() : `DSH-售前联调-${new Date().toISOString().slice(0, 10)}`,
        description: nonEmpty(args.description) ? args.description.trim() : undefined,
        productName: nonEmpty(args.product_name) ? args.product_name.trim() : undefined,
        files,
        signal,
      })
      const summary = result.readiness || {}
      return {
        projectId: result.projectId,
        kbId: result.kbId,
        ready: `就绪 ${summary.ready_count ?? '?'} / 共 ${summary.total_count ?? files.length}`,
        uploads: result.uploads,
        warnings,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: '平台建项目并上传材料',
      rawInput: { files: Array.isArray(args?.files) ? args.files.length : undefined, project: args?.project_name },
    }),
  })

  ctx.tools.register({
    name: 'wlyd_platform_upload',
    description: '向已有方案项目绑定的知识库上传工作区资料；先核验项目与知识库绑定，上传后查询解析状态。',
    parameters: {
      project_id: { type: 'string', required: true, description: '已有方案项目 ID' },
      knowledge_base_id: { type: 'string', required: true, description: '该项目已绑定的知识库 ID' },
      files: { type: 'array', required: true, items: { type: 'string' }, description: '工作区内文件路径，最多 10 个' },
    },
    output: {
      schema: { type: 'object', additionalProperties: false, properties: {
        projectId: { type: 'string' }, kbId: { type: 'string' },
        uploads: { type: 'array', items: { type: 'object', additionalProperties: false, properties: {
          name: { type: 'string' }, knowledgeId: { type: 'string' }, status: { type: 'string' },
        } } },
        warnings: { type: 'array', items: { type: 'string' } },
      } },
      render: (_args, value) => [{ type: 'text', text: `已向项目 ${value.projectId} 的知识库 ${value.kbId} 上传 ${value.uploads.length} 份资料：`
        + value.uploads.map(item => `${item.name}=${item.status}`).join('、')
        + (value.warnings.length ? `。提示：${value.warnings.join('；')}` : '') }],
    },
    async execute(args, exec) {
      if (!nonEmpty(args.project_id) || !nonEmpty(args.knowledge_base_id)) throw bad('wlyd_platform_upload', 'project_id 和 knowledge_base_id 必填')
      const cfg = resolvePlatformConfig(config || {})
      const { files, warnings } = await preparePlatformFiles(ctx, exec, args.files, 'wlyd_platform_upload')
      const uploads = []
      for (const file of files) {
        uploads.push(await uploadProjectFile(cfg, { projectId: args.project_id.trim(), kbId: args.knowledge_base_id.trim(),
          ...file, signal: exec.signal }))
      }
      const deadline = Date.now() + 120_000
      while (Date.now() < deadline && uploads.some(item => ['pending', 'processing'].includes(item.status))) {
        exec.signal?.throwIfAborted()
        await new Promise(resolve => setTimeout(resolve, 3000))
        for (const item of uploads) {
          if (['pending', 'processing'].includes(item.status)) item.status = await knowledgeStatus(cfg, item.knowledgeId)
        }
      }
      if (uploads.some(item => ['pending', 'processing'].includes(item.status))) warnings.push('仍有资料在解析中，请稍后查看平台状态')
      return { projectId: args.project_id.trim(), kbId: args.knowledge_base_id.trim(), uploads, warnings }
    },
    presentCall: args => ({ card: 'generic', title: '上传资料到已有项目知识库',
      rawInput: { project: args?.project_id, knowledgeBase: args?.knowledge_base_id, files: args?.files?.length } }),
  })

  ctx.tools.register({
    name: 'wlyd_platform_generate',
    description: '在内容中台平台触发 LLM/RAG 生成章节化方案(平台侧有引用溯源与协同)。'
      + '先向用户展示大纲并取得确认，传入 outline_headings；平台按确认的标题和顺序生成，'
      + '只对有知识库依据的章节写正文,'
      + '缺依据章节为「待补充依据」占位——这是平台的诚实行为,应先补传材料。'
      + '生成耗时几十秒。完成后用 wlyd_platform_render 渲染成本插件的集团模板交付物。',
    parameters: {
      project_id: { type: 'string', required: true, description: '平台项目 ID(wlyd_platform_setup 返回)' },
      outline_headings: { type: 'array', required: true, items: { type: 'string' }, description: '已向用户展示并获确认的章节标题，建议 3—6 章，顺序即生成顺序' },
      instruction: { type: 'string', description: '其他生成要求；不能改变 outline_headings 的标题和顺序' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          conversationId: { type: 'string' },
          documentId: { type: 'string' },
          title: { type: 'string' },
          sectionCount: { type: 'integer' },
          sections: {
            type: 'array',
            items: {
              type: 'object', additionalProperties: false,
              properties: {
                position: { type: 'integer' },
                heading: { type: 'string' },
                bodyChars: { type: 'integer' },
                citations: { type: 'integer' },
                review: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `平台方案已生成:${value.title}(document ${value.documentId},${value.sectionCount} 节)。`
          + `章节概览:${value.sections.map(s => `${s.heading}(${s.bodyChars}字/引${s.citations})`).join('、')}。`
          + `下一步用 wlyd_platform_render(项目同本工具的 project_id,document_id=${value.documentId})渲染交付物。`,
      }],
    },
    async execute(args, exec) {
      if (!nonEmpty(args.project_id)) throw bad('wlyd_platform_generate', 'project_id 必须是非空字符串')
      const headings = args.outline_headings
      if (!Array.isArray(headings) || headings.length < 2 || headings.length > 8
        || headings.some(heading => !nonEmpty(heading) || heading.trim().length > 48)
        || new Set(headings.map(heading => heading.trim())).size !== headings.length) {
        throw bad('wlyd_platform_generate', '请先让用户确认 2—8 个不重复的章节标题，建议 3—6 个')
      }
      const cfg = resolvePlatformConfig(config || {})
      const approved = headings.map((heading, i) => `${i + 1}. ${heading.trim()}`).join('\n')
      const result = await generateSolution(cfg, {
        projectId: args.project_id.trim(),
        instruction: `${OUTLINE_INSTRUCTION}\n严格按以下章节标题和顺序输出，不增加或删除章节：\n${approved}`
          + (nonEmpty(args.instruction) ? `\n其他要求：${args.instruction.trim()}` : ''),
        signal: exec.signal,
      })
      if (result.sections.length !== headings.length
        || result.sections.some((section, i) => section.heading.trim() !== headings[i].trim())) {
        throw bad('wlyd_platform_generate', `平台返回章节与确认大纲不一致，文档 ${result.documentId} 已保存但未通过结构验收；请检查平台结果后重试`)
      }
      return result
    },
    presentCall: args => ({
      card: 'generic',
      title: '平台生成方案',
      rawInput: { project: args?.project_id },
    }),
  })

  ctx.tools.register({
    name: 'wlyd_platform_render',
    description: '把平台生成的方案文档拉回本地,映射为本插件的 solution 结构,'
      + '渲染成集团模板三件套(.md 可编辑源/.html 幻灯片/.docx Word 交付)并注册 HTML 编辑入口。'
      + '平台正文为 Markdown,自动拆为段落/要点/步骤/表格块;章节 kind 按标题关键词归类。'
      + '「待补充依据」章节原样保留,渲染后仍需人工补充。',
    parameters: {
      project_id: { type: 'string', required: true, description: '平台项目 ID' },
      document_id: { type: 'string', required: true, description: '平台文档 ID(wlyd_platform_generate 返回)' },
      output_base: { type: 'string', description: '输出文件名基底,默认 platform-solution' },
      theme: { type: 'string', enum: ['corporate', 'dark', 'elegant'], description: '视觉主题,默认 corporate' },
    },
    output: {
      schema: {
        type: 'object', additionalProperties: false,
        properties: {
          base: { type: 'string' },
          markdownPath: { type: 'string' },
          htmlPath: { type: 'string' },
          docxPath: { type: 'string' },
          jsonPath: { type: 'string' },
          editUrl: { type: 'string' },
          sectionCount: { type: 'integer' },
          imageCount: { type: 'integer' },
          warnings: { type: 'array', items: { type: 'string' } },
          platformDocumentId: { type: 'string' },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `平台方案已渲染(${value.sectionCount} 节,platform document ${value.platformDocumentId}):`
          + `${value.editUrl}(HTML 编辑)、${value.markdownPath}(同步 Markdown)、${value.htmlPath}(幻灯片/打印)、${value.docxPath}(Word 交付)。`
          + (value.warnings.length > 0 ? `警告:${value.warnings.join(';')}` : ''),
      }],
    },
    async execute(args, exec) {
      if (!nonEmpty(args.project_id) || !nonEmpty(args.document_id)) {
        throw bad('wlyd_platform_render', 'project_id 与 document_id 必须是非空字符串')
      }
      const cfg = resolvePlatformConfig(config || {})
      const signal = exec.signal
      const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
      const doc = await fetchDocument(cfg, { projectId: args.project_id.trim(), documentId: args.document_id.trim() })
      const solution = prepareSolution(customerFacingSolution(documentToSolution(doc, {
        theme: nonEmpty(args.theme) ? args.theme : 'corporate',
      })))
      const base = (nonEmpty(args.output_base) ? args.output_base.trim() : 'platform-solution').replace(/\.(md|html|docx)$/i, '')
      return persistSolution(ctx, exec, solution, {
        base, cwd, signal, assets: [], assetViews: [], warnings: [],
        extraOutput: { platformDocumentId: doc.id },
      })
    },
    presentCall: args => ({
      card: 'generic',
      title: '渲染平台方案为交付物',
      rawInput: { project: args?.project_id, document: args?.document_id },
    }),
  })
}
