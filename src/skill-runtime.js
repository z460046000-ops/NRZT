/** 确定性路由也显式加载随包 Skill；注册到目录不等于进入模型上下文。 */
import { readFileSync } from 'node:fs'
import { createHash } from 'node:crypto'

export const PRESALES_SKILLS = ['wlyd-presales-copywriting', 'wlyd-presales-html-ppt', 'wlyd-presales-design-master', 'wlyd-presales-huashu-design']
const executions = new WeakMap()
const bundles = new Map()
const registryContexts = new WeakMap()

export function useSkillRegistryContext(pluginCtx, skillCtx) {
  registryContexts.set(pluginCtx, skillCtx)
}

function bundle(name) {
  if (!bundles.has(name)) {
    const raw = readFileSync(new URL(`../skills/${name}/SKILL.md`, import.meta.url), 'utf8')
    const body = raw.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/u, '')
    const references = name === 'wlyd-presales-design-master' ? ['references/presales-design.md']
      : name === 'wlyd-presales-huashu-design' ? ['references/presales-deck.md'] : []
    const resources = references.map(file => ({ file,
      content: readFileSync(new URL(`../skills/${name}/${file}`, import.meta.url), 'utf8') }))
    bundles.set(name, { body, resources })
  }
  return bundles.get(name)
}

export async function loadPresalesSkills(ctx, agent, signal, stage) {
  const records = []
  const contents = []
  const needed = stage === 'evidence' ? PRESALES_SKILLS.slice(0, 1)
    : stage === 'outline' ? [PRESALES_SKILLS[0], PRESALES_SKILLS[2], PRESALES_SKILLS[3]] : PRESALES_SKILLS
  for (const name of needed) {
    if (signal?.aborted) throw signal.reason ?? new Error('生成已取消')
    const local = bundle(name)
    let registered
    let registryFailed = false
    try {
      const registry = registryContexts.get(ctx)?.skills ?? ctx.skills
      registered = registry?.get ? await registry.get(name, {
        cwd: agent?.session?.header?.cwd, scope: agent, signal,
      }) : undefined
    } catch (error) {
      if (signal?.aborted) throw error
      registryFailed = true
      console.warn('[wlyd-presales] skill-registry', JSON.stringify({ name,
        error: error?.name ?? 'Error', message: String(error?.message ?? '').slice(0, 180) }))
    }
    const content = registered?.content || local.body
    if (typeof content !== 'string' || !content.trim()) throw new Error(`Skill ${name} 没有可执行规则`)
    const expanded = [content, ...local.resources.map(resource => `\n资源 ${resource.file}\n${resource.content}`)].join('\n')
    contents.push(`\n<skill name="${name}">\n${expanded}\n</skill>`)
    records.push({ name, hash: createHash('sha256').update(expanded).digest('hex'),
      loader: registered?.content ? 'dsh-registry' : registryFailed ? 'bundled-after-registry-error' : 'bundled',
      resources: local.resources.map(resource => resource.file) })
  }
  const record = { stage, status: 'injected', at: new Date().toISOString(), skills: records }
  if (agent && typeof agent === 'object') {
    const previous = executions.get(agent) ?? []
    executions.set(agent, [...previous.slice(-11), record])
  }
  console.info('[wlyd-presales] skills', JSON.stringify({ stage, status: record.status,
    skills: records.map(({ name, hash, loader }) => ({ name, hash, loader })) }))
  return contents.join('\n')
}

export const skillExecutionFor = agent => structuredClone(executions.get(agent) ?? [])

/** 后台入口通过用户指令携带同包规则；只能证明已提交，不能证明后台模型遵守。 */
export async function backendSkillInstruction() {
  return loadPresalesSkills({}, undefined, undefined, 'backend-instruction')
}
