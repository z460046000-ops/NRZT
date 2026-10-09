/** Versioned source of truth for the browser editor. No model call is made on save. */
import { randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, realpath, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { renderMarkdown } from './markdown.js'
import { renderHtml } from './html.js'
import { renderDocx } from './docx.js'
import { deliverKnowledgeProposal } from './knowledge-adapter.js'

const ID = /^[a-f0-9-]{36}$/u
const pending = new Map()
const root = () => path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'wlyd-presales-editor')
const recordFile = id => path.join(root(), 'documents', `${id}.json`)

export class EditorError extends Error {
  constructor(status, message) {
    super(message)
    this.status = status
  }
}

/** New generations receive stable identities; old 0.4.x JSON gets deterministic legacy IDs on first edit. */
export function prepareSolution(solution) {
  solution.editorId ??= randomUUID()
  solution.revision ??= 1
  solution.sections.forEach((section, s) => {
    section.id ??= `section-${s}`
    section.blocks.forEach((block, b) => { block.id ??= `block-${s}-${b}` })
  })
  return solution
}

export async function registerDocument(baseAbs, id) {
  if (!ID.test(id)) throw new EditorError(400, '编辑标识无效')
  const directory = await realpath(path.dirname(baseAbs))
  const resolved = path.join(directory, path.basename(baseAbs))
  await mkdir(path.dirname(recordFile(id)), { recursive: true, mode: 0o700 })
  await writeFile(recordFile(id), JSON.stringify({ id, baseAbs: resolved }) + '\n', { mode: 0o600 })
}

async function locate(id) {
  if (!ID.test(id)) throw new EditorError(400, '编辑标识无效')
  let record
  try { record = JSON.parse(await readFile(recordFile(id), 'utf8')) }
  catch { throw new EditorError(404, '未找到方案，请从 DSH 重新打开编辑链接') }
  if (record.id !== id || typeof record.baseAbs !== 'string') throw new EditorError(404, '方案记录无效')
  const directory = await realpath(path.dirname(record.baseAbs)).catch(() => '')
  if (!directory || path.join(directory, path.basename(record.baseAbs)) !== record.baseAbs) {
    throw new EditorError(404, '方案目录已移动，请重新生成编辑链接')
  }
  return record.baseAbs
}

export async function loadDocument(id) {
  const baseAbs = await locate(id)
  let solution
  try { solution = JSON.parse(await readFile(`${baseAbs}.json`, 'utf8')) }
  catch { throw new EditorError(404, '方案 JSON 不存在或无法读取') }
  if (solution.editorId !== id) throw new EditorError(403, '方案标识与文件不一致')
  return { baseAbs, solution: prepareSolution(solution) }
}

export async function latestKnowledgeStatus(baseAbs, solution) {
  const latest = solution.knowledgeProposals?.at(-1)
  if (!latest || latest.materialRevision !== solution.revision || !ID.test(latest.id)) return { status: 'not_requested' }
  try {
    const record = JSON.parse(await readFile(path.join(`${baseAbs}.knowledge-proposals`, `${latest.id}.json`), 'utf8'))
    return { status: record.status, id: latest.id, materialRevision: latest.materialRevision }
  } catch {
    return { status: 'record_failed', id: latest.id, materialRevision: latest.materialRevision }
  }
}

function required(value, label) {
  if (typeof value !== 'string' || !value.trim() || value.length > 10000) {
    throw new EditorError(400, `${label}必须是非空文字，且不超过 10000 字`)
  }
  return value.trim()
}

function optional(value, label) {
  if (typeof value !== 'string' || value.length > 10000) throw new EditorError(400, `${label}格式无效`)
  return value.trim()
}

function applyChange(solution, change) {
  if (!change || typeof change.path !== 'string') throw new EditorError(400, '修改位置无效')
  const parts = change.path.split('/')
  const value = change.value
  if (parts.length === 1 && (parts[0] === 'title' || parts[0] === 'subtitle')) {
    solution[parts[0]] = parts[0] === 'title' ? required(value, '标题') : optional(value, '副标题')
    return
  }
  if (parts[0] === 'sections' && parts.length === 3) {
    const section = solution.sections.find(s => s.id === parts[1])
    if (!section || !['heading', 'lead'].includes(parts[2])) throw new EditorError(400, '章节位置无效')
    section[parts[2]] = parts[2] === 'heading' ? required(value, '章节标题') : optional(value, '章节说明')
    return
  }
  if (parts[0] === 'links' && parts.length === 3) {
    const link = solution.painSolutionLinks?.find(item => item.id === parts[1])
    if (!link || !['pain', 'solution'].includes(parts[2])) throw new EditorError(400, '痛点与方案位置无效')
    link[parts[2]] = required(value, '痛点或方案')
    return
  }
  if (parts[0] !== 'blocks') throw new EditorError(400, '修改位置不受支持')
  const block = solution.sections.flatMap(s => s.blocks).find(b => b.id === parts[1])
  if (!block) throw new EditorError(400, '内容块不存在')
  if (solution.painSolutionLinks?.length && solution.sections.some(s =>
    (s.kind === 'pains' || s.kind === 'solution') && s.blocks.some(item => item.id === block.id))) {
    throw new EditorError(400, '请在痛点与解决方案配对区修改此内容')
  }
  if (parts.length === 3 && parts[2] === 'text' && ['para', 'quote'].includes(block.type)) {
    block.text = required(value, '正文')
  } else if (parts.length === 3 && parts[2] === 'caption' && block.type === 'image') {
    block.caption = optional(value, '图片说明')
  } else if (parts.length === 4 && ['items', 'headers'].includes(parts[2])) {
    const list = block[parts[2]]
    const index = Number(parts[3])
    if (!Array.isArray(list) || !Number.isInteger(index) || index < 0 || index >= list.length || typeof list[index] !== 'string') throw new EditorError(400, '列表位置无效')
    list[index] = required(value, '列表内容')
  } else if (parts.length === 5 && parts[2] === 'rows' && block.type === 'table') {
    const row = Number(parts[3]); const col = Number(parts[4])
    if (!Number.isInteger(row) || !Number.isInteger(col) || !Array.isArray(block.rows[row]) || col < 0 || col >= block.rows[row].length) throw new EditorError(400, '表格位置无效')
    block.rows[row][col] = optional(value, '表格单元格')
  } else if (parts.length === 5 && parts[2] === 'metrics' && block.type === 'metrics') {
    const index = Number(parts[3])
    if (!Number.isInteger(index) || !block.items[index] || !['label', 'value'].includes(parts[4])) throw new EditorError(400, '指标位置无效')
    block.items[index][parts[4]] = required(value, '指标')
  } else {
    throw new EditorError(400, '修改位置不受支持')
  }
}

function syncPairs(solution) {
  const links = solution.painSolutionLinks ?? []
  if (!links.length) return
  for (const section of solution.sections) {
    if (section.kind === 'pains') section.blocks = [{
      id: section.blocks[0]?.id ?? randomUUID(), type: 'table', headers: ['编号', '客户痛点', '材料依据'],
      rows: links.map(link => [link.id, link.pain, `${link.painEvidence.path}：${link.painEvidence.quote}`]),
    }]
    if (section.kind === 'solution') section.blocks = [{
      id: section.blocks[0]?.id ?? randomUUID(), type: 'table', headers: ['对应痛点', '解决办法', '材料依据'],
      rows: links.map(link => [link.id, link.solution, `${link.solutionEvidence.path}：${link.solutionEvidence.quote}`]),
    }]
  }
}

async function assetBuffers(solution, baseAbs) {
  const directory = path.dirname(baseAbs)
  const allowedDirectory = `${path.basename(baseAbs)}-assets`
  return Promise.all((solution.assets ?? []).map(async asset => {
    if (typeof asset.fileName !== 'string' || !asset.fileName.startsWith(`${allowedDirectory}/`) || asset.fileName.includes('..')) {
      throw new EditorError(400, '图片素材路径无效')
    }
    const buffer = await readFile(path.join(directory, asset.fileName))
    return { ...asset, buffer }
  }))
}

async function replaceImages(solution, replacements, baseAbs) {
  if (!Array.isArray(replacements) || replacements.length > 8) throw new EditorError(400, '图片替换数量无效')
  const assetDirName = `${path.basename(baseAbs)}-assets`
  const assetDir = path.join(path.dirname(baseAbs), assetDirName)
  for (const item of replacements) {
    const block = solution.sections.flatMap(s => s.blocks).find(b => b.id === item.blockId && b.type === 'image')
    if (!block || typeof item.data !== 'string') throw new EditorError(400, '图片替换位置或内容无效')
    const data = Buffer.from(item.data, 'base64')
    if (!data.length || data.length > 5 * 1024 * 1024) throw new EditorError(400, '单张图片须在 5MB 以内')
    const png = data.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
    const jpg = data[0] === 0xff && data[1] === 0xd8 && data[2] === 0xff
    if (!png && !jpg) throw new EditorError(400, '目前只支持 PNG 或 JPEG 图片')
    const fileName = `${randomUUID()}.${png ? 'png' : 'jpg'}`
    await mkdir(assetDir, { recursive: true })
    await writeFile(path.join(assetDir, fileName), data, { flag: 'wx' })
    const sourcePath = `${assetDirName}/${fileName}`
    block.path = sourcePath
    block.sourcePath = sourcePath
    solution.assets ??= []
    solution.assets.push({ sourcePath, fileName: sourcePath, caption: block.caption })
  }
}

async function publishOutputs(baseAbs, solution, assets) {
  const rendered = {
    json: JSON.stringify(solution, null, 2) + '\n',
    md: renderMarkdown(solution, assets),
    html: renderHtml(solution, assets),
    docx: await renderDocx(solution, assets),
  }
  const snapshot = `${baseAbs}.versions/${solution.revision}`
  await mkdir(snapshot, { recursive: true })
  for (const [ext, data] of Object.entries(rendered)) {
    await writeFile(path.join(snapshot, `solution.${ext}`), data)
  }
  // JSON is committed last; a later load can re-render derivatives from this source.
  for (const ext of ['md', 'html', 'docx', 'json']) {
    const target = `${baseAbs}.${ext}`
    const temporary = `${target}.${randomUUID()}.tmp`
    await writeFile(temporary, rendered[ext])
    await rename(temporary, target)
  }
}

async function queueKnowledgeProposal(baseAbs, before, after, changes, request, id) {
  if (request?.factChange !== true) return { status: 'not_requested' }
  const proposal = {
    id, status: 'awaiting_knowledge_api', createdAt: new Date().toISOString(),
    material: { editorId: after.editorId, baseRevision: before.revision, revision: after.revision },
    scope: request.scope === 'enterprise' ? 'enterprise' : 'project',
    targetId: typeof request.targetId === 'string' ? request.targetId.trim() : '',
    reason: typeof request.reason === 'string' ? request.reason.trim() : '',
    changes: changes.map(({ path: field, value }) => ({ path: field, value })),
    evidence: (after.painSolutionLinks ?? []).flatMap(link => [link.painEvidence, link.solutionEvidence]),
  }
  const folder = `${baseAbs}.knowledge-proposals`
  await mkdir(folder, { recursive: true })
  const file = path.join(folder, `${proposal.id}.json`)
  await writeFile(file, JSON.stringify(proposal, null, 2) + '\n', { flag: 'wx' })
  const delivered = await deliverKnowledgeProposal(file)
  return { status: delivered.status, id: proposal.id }
}

export async function saveDocument(id, request) {
  const previous = pending.get(id) ?? Promise.resolve()
  const run = previous.catch(() => {}).then(async () => {
    const { baseAbs, solution: current } = await loadDocument(id)
    if (!Number.isInteger(request?.baseRevision) || request.baseRevision !== current.revision) {
      throw new EditorError(409, `方案已更新到第 ${current.revision} 版，请刷新后再编辑`)
    }
    if (!Array.isArray(request.changes) || request.changes.length + (request.replacements?.length ?? 0) === 0) {
      throw new EditorError(400, '没有可保存的修改')
    }
    if (request.changes.length > 200) throw new EditorError(400, '单次修改过多')
    const next = structuredClone(current)
    for (const change of request.changes) applyChange(next, change)
    await replaceImages(next, request.replacements ?? [], baseAbs)
    syncPairs(next)
    next.revision = current.revision + 1
    next.lastEditedAt = new Date().toISOString()
    const proposalId = request.knowledge?.factChange === true ? randomUUID() : undefined
    if (proposalId) next.knowledgeProposals = [
      ...(current.knowledgeProposals ?? []), { id: proposalId, materialRevision: next.revision },
    ]
    const assets = await assetBuffers(next, baseAbs)
    await publishOutputs(baseAbs, next, assets)
    let knowledge
    try { knowledge = await queueKnowledgeProposal(baseAbs, current, next, request.changes, request.knowledge, proposalId) }
    catch { knowledge = { status: 'record_failed' } }
    return { revision: next.revision, knowledge }
  })
  pending.set(id, run)
  try { return await run }
  finally { if (pending.get(id) === run) pending.delete(id) }
}

export async function snapshotInitial(baseAbs) {
  const folder = `${baseAbs}.versions/1`
  await mkdir(folder, { recursive: true })
  for (const ext of ['json', 'md', 'html', 'docx']) {
    await copyFile(`${baseAbs}.${ext}`, path.join(folder, `solution.${ext}`))
  }
}
