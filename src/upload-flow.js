/** 对话附件同步：确定性选择项目与绑定知识库，不先调用模型。 */
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'
import { listProjects, listProjectKnowledgeBases, listKnowledgeBases, resolvePlatformConfig } from './platform.js'

export const isUploadRequest = text => !/不要|不用|先别|暂不|不同步|不上传|别上传|别同步/u.test(text)
  && /(?:同步|上传|存入|导入|添加)[\s\S]*(?:内容中台|知识库)|(?:内容中台|知识库)[\s\S]*(?:同步|上传|存入|导入)/u.test(text)

function cachePath(agent) {
  if (!agent.session?.id) return undefined
  const key = createHash('sha256').update(`${agent.session.header?.cwd ?? ''}:${agent.session.id}`).digest('hex')
  return path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'wlyd-presales-editor', 'upload-attachments', `${key}.json`)
}
const remembered = new WeakMap()
export async function rememberFiles(agent, files) {
  const refs = [...new Map(files.map(file => [file.attachmentId, file])).values()]
  remembered.set(agent, refs)
  const file = cachePath(agent)
  if (file) {
    try {
      await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
      await writeFile(file, JSON.stringify(refs), { mode: 0o600 })
    } catch { /* 本轮仍用内存内的附件；缓存不可写时不阻断当前同步。 */ }
  }
}
export async function recentFiles(agent) {
  if (remembered.has(agent)) return remembered.get(agent)
  const file = cachePath(agent)
  if (file) {
    try {
      const files = JSON.parse(await readFile(file, 'utf8'))
      if (Array.isArray(files) && files.length) return files
    } catch { /* 升级前的会话可能没有缓存，继续查本会话的已保存附件。 */ }
  }
  const history = agent.session?.deriveMessages?.() ?? []
  const last = history.findLast(message => message.source?.kind === 'user'
    && message.content?.some(block => block.type === 'file'))
  const refs = last?.content.filter(block => block.type === 'file').map(block => block.attachment) ?? []
  if (refs.length) await rememberFiles(agent, refs)
  return refs
}

const pick = (options, answer) => {
  const number = /^(\d+)(?:[.．、\s]|$)/u.exec(answer.trim())
  if (number) return options[Number(number[1]) - 1]
  const matches = options.filter(option => option.id === answer.trim() || option.name === answer.trim())
  return matches.length === 1 ? matches[0] : undefined
}
const field = (text, name) => new RegExp(`${name}\\s*[:：=]\\s*([^，,；;\\n]+)`, 'u').exec(text)?.[1]?.trim()
function question(stage, options, state, label) {
  return { kind: 'question', text: `${label}，请选择编号或名称：\n${options.map((item, i) => `${i + 1}. ${item.name}`).join('\n')}\n回复“取消”停止同步。`,
    pending: { ...state, stage, options } }
}

export async function startUpload(ctx, agent, signal, text, attachments, config) {
  if (!attachments.length) return { kind: 'question', text: '请在输入框附上要同步的文件，再发送“同步到内容中台”。',
    pending: { stage: 'upload-files', attachments: [] } }
  if (attachments.length > 10) return { kind: 'error', text: '每次最多同步 10 个附件，请分批上传。' }
  await rememberFiles(agent, attachments)
  try {
    const cfg = resolvePlatformConfig(config ?? {})
    const projects = await listProjects(cfg)
    if (!projects.length) return { kind: 'error', text: '当前账号没有可访问的方案项目，请先在内容中台创建项目。' }
    const state = { attachments, requestedKnowledgeBase: field(text, '知识库') }
    const requested = field(text, '项目')
    const project = requested ? pick(projects, requested) : projects.length === 1 ? projects[0] : undefined
    if (!project) return question('upload-project', projects, state, '选择本次资料的目标项目')
    return await chooseKnowledgeBase(ctx, agent, signal, project, state, config)
  } catch (error) {
    if (signal.aborted) throw error
    return { kind: 'error', text: `资料同步尚未完成：${error.message}` }
  }
}

async function chooseKnowledgeBase(ctx, agent, signal, project, state, config) {
  const cfg = resolvePlatformConfig(config ?? {})
  const [bindings, visible] = await Promise.all([listProjectKnowledgeBases(cfg, project.id), listKnowledgeBases(cfg)])
  const bases = bindings.map(binding => visible.find(item => item.id === binding.id)).filter(Boolean)
  if (!bases.length) return { kind: 'error', text: `项目「${project.name}」没有当前账号可读取的绑定知识库，请先在内容中台绑定。` }
  const base = state.requestedKnowledgeBase ? pick(bases, state.requestedKnowledgeBase) : bases.length === 1 ? bases[0] : undefined
  const next = { ...state, project }
  if (!base) return question('upload-kb', bases, next, `选择项目「${project.name}」的目标知识库`)
  return performUpload(ctx, agent, signal, next, base)
}

async function performUpload(ctx, agent, signal, state, base) {
  const result = await ctx.tools.execute({ callId: randomUUID(), name: 'wlyd_platform_upload', agent, signal,
    arguments: { project_id: state.project.id, knowledge_base_id: base.id, attachment_refs: state.attachments } })
  if (result.isError) {
    const detail = result.content?.find(item => item.type === 'text')?.text ?? '上传工具失败'
    return { kind: 'error', text: `向「${state.project.name} / ${base.name}」同步失败：${detail}` }
  }
  const value = result.value
  const uploads = value.uploads ?? []
  const done = uploads.every(file => file.status === 'completed')
  const accepted = uploads.filter(file => file.status !== 'upload_failed').length
  return { kind: accepted ? 'success' : 'error', text: `目标：${state.project.name} / ${base.name}\n${done ? '资料已上传并解析完成' : `已接收 ${accepted}/${uploads.length} 份，以下为各文件状态`}：\n`
    + uploads.map(file => `- ${file.name}：${({ completed: '解析完成', upload_failed: '上传失败', failed: '解析失败', pending: '等待解析', processing: '解析中' })[file.status] ?? file.status}`).join('\n')
    + ((value.warnings ?? []).length ? `\n提示：${value.warnings.join('；')}` : '') }
}

export async function resumeUpload(ctx, agent, signal, pending, answer, config) {
  if (/^(?:取消|停止|不用了|先别上传|先别同步|不要上传|不要同步)[\s。!！]*$/u.test(answer.trim())) return { kind: 'stopped', text: '已停止本次资料同步。' }
  if (pending.stage === 'upload-files') return startUpload(ctx, agent, signal, answer, await recentFiles(agent), config)
  const item = pick(pending.options ?? [], answer)
  if (!item) return question(pending.stage, pending.options ?? [], pending, '尚未选定上传目标')
  try {
    if (pending.stage === 'upload-project') return await chooseKnowledgeBase(ctx, agent, signal, item, pending, config)
    if (pending.stage === 'upload-kb') return await performUpload(ctx, agent, signal, pending, item)
    return { kind: 'error', text: '同步状态无效，请重新发送“同步到内容中台”。' }
  } catch (error) {
    if (signal.aborted) throw error
    return { kind: 'error', text: `资料同步尚未完成：${error.message}` }
  }
}
