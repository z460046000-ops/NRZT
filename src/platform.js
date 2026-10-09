/**
 * 内容中台平台(WeKnora 底座)HTTP 客户端与数据映射。
 * 仅用 node 内置模块;token 在进程内缓存,401 时自动重登一次。
 * @module @wlyd/dsh-presales-solution/platform
 */

// ── 配置解析 ──────────────────────────────────────────────────────

import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { cleanMaterialText } from './source-quality.js'

/**
 * 从 $DSH_HOME/.env 读取平台配置(兜底,process.env 未注入时使用)。
 * 仅第一次调用时读。
 * @returns {{baseUrl: string, email: string, password: string, tenantId: string}}
 */
let dshEnvCache = null
function loadDshEnv() {
  if (dshEnvCache) return dshEnvCache
  dshEnvCache = {}
  try {
    const home = process.env.DSH_HOME || homedir() + '/.dsh'
    const text = readFileSync(home + '/.env', 'utf8')
    for (const line of text.split('\n')) {
      const m = line.match(/^\s*(WLYD_PLATFORM_\w+)\s*=\s*(.*?)\s*$/)
      if (m) dshEnvCache[m[1]] = m[2].replace(/^["']|["']$/g, '')
    }
  } catch {
    // 用户层 .env 不存在或不可读:按空配置处理,部署方配置应经 process.env 注入。
  }
  return dshEnvCache
}

/**
 * 汇总插件 Config、环境变量与 $DSH_HOME/.env 兜底,得到可用的平台配置。
 * 环境变量:WLYD_PLATFORM_BASE_URL / WLYD_PLATFORM_EMAIL /
 * WLYD_PLATFORM_PASSWORD / WLYD_PLATFORM_TENANT_ID。
 * @param {object} config - 插件 Config(可全空)。
 * @returns {{baseUrl: string, email: string, password: string, tenantId: string}}
 */
export function resolvePlatformConfig(config) {
  const env = process.env
  const dsh = loadDshEnv()
  return {
    baseUrl: (config.baseUrl || env.WLYD_PLATFORM_BASE_URL || dsh.WLYD_PLATFORM_BASE_URL || 'https://agentwan.stelladream.cn').replace(/\/+$/, ''),
    email: config.email || env.WLYD_PLATFORM_EMAIL || dsh.WLYD_PLATFORM_EMAIL || '',
    password: config.password || env.WLYD_PLATFORM_PASSWORD || dsh.WLYD_PLATFORM_PASSWORD || '',
    tenantId: String(config.tenantId || env.WLYD_PLATFORM_TENANT_ID || dsh.WLYD_PLATFORM_TENANT_ID || ''),
  }
}

// ── HTTP 客户端 ───────────────────────────────────────────────────

/** 进程内会话:token 缓存与自动重登。 */
const session = { token: '', refresh: '', tenantId: '', cfg: null }

function fail(msg) {
  return new Error(`wlyd_platform: ${msg}`)
}

/**
 * 登录并缓存 token。配置缺项在此处显式报错。
 * @param {object} cfg - resolvePlatformConfig 产物。
 */
export async function ensureLogin(cfg) {
  if (session.token && session.cfg && JSON.stringify(session.cfg) === JSON.stringify(cfg)) return
  if (!cfg.email || !cfg.password || !cfg.tenantId) {
    throw fail(`平台配置不完整:需要在 profile patch 的插件 config(或环境变量 WLYD_PLATFORM_*)提供 email/password/tenantId,当前 email=${cfg.email ? '已填' : '缺'} password=${cfg.password ? '已填' : '缺'} tenantId=${cfg.tenantId || '缺'}`)
  }
  const response = await fetch(`${cfg.baseUrl}/api/v1/auth/login`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: cfg.email, password: cfg.password }),
    signal: AbortSignal.timeout(30000),
  })
  const r = await response.json().catch(() => ({}))
  if (!response.ok || !r.token) throw fail(`登录失败 HTTP ${response.status}`)
  const activeTenant = String(r.active_tenant?.id ?? '')
  if (activeTenant && activeTenant !== cfg.tenantId) {
    throw fail(`当前账号的活跃租户与配置不一致；配置 ${cfg.tenantId}，登录返回 ${activeTenant}`)
  }
  session.token = r.token
  session.refresh = r.refresh_token || ''
  session.tenantId = activeTenant || cfg.tenantId
  session.cfg = { ...cfg }
}

async function authorizedFetch(cfg, makeRequest, timeoutMs = 30000, signal) {
  await ensureLogin(cfg)
  const requestSignal = signal ? AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]) : AbortSignal.timeout(timeoutMs)
  let response = await fetch(makeRequest(session.token, session.tenantId), { signal: requestSignal })
  if (response.status === 401) {
    session.token = ''
    await ensureLogin(cfg)
    response = await fetch(makeRequest(session.token, session.tenantId), { signal: requestSignal })
  }
  return response
}

async function request(cfg, method, path, body, timeoutMs) {
  const response = await authorizedFetch(cfg, (token, tenantId) => new Request(cfg.baseUrl + path, {
    method,
    headers: { 'Content-Type': 'application/json', 'X-Tenant-ID': tenantId, Authorization: `Bearer ${token}` },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), timeoutMs)
  const json = await response.json().catch(() => ({}))
  if (!response.ok || json.success === false) {
    const code = typeof json.code === 'string' ? ` (${json.code})` : ''
    const requestId = response.headers.get('x-request-id')
    throw fail(`${method} ${path} -> HTTP ${response.status}${code}${requestId ? `，请求 ID ${requestId}` : ''}`)
  }
  return json
}

// ── 业务动作 ──────────────────────────────────────────────────────

/** 返回当前账号可见的方案项目，不能把全局知识库列表当成项目授权。 */
export async function listProjects(cfg) {
  const response = await request(cfg, 'GET', '/api/v1/solutions/projects')
  if (!Array.isArray(response.data)) throw fail('方案项目列表响应异常')
  return response.data.map(item => ({ id: String(item.id), name: String(item.name ?? '') }))
}

/** 返回项目实际绑定的知识库 ID；服务端仍负责最终权限校验。 */
export async function listProjectKnowledgeBases(cfg, projectId) {
  const response = await request(cfg, 'GET', `/api/v1/solutions/projects/${encodeURIComponent(projectId)}/knowledge-bases`)
  if (!Array.isArray(response.data)) throw fail('项目知识库绑定响应异常')
  return response.data.map(item => ({ id: String(item.knowledge_base_id), scope: String(item.scope_type ?? '') }))
    .filter(item => item.id && item.id !== 'undefined')
}

/** 向已绑定的项目知识库上传文本资料；401 仅在服务端明确拒绝时重登一次。 */
export async function uploadProjectFile(cfg, opts) {
  if (opts.verifyBinding !== false) {
    const bindings = await listProjectKnowledgeBases(cfg, opts.projectId)
    if (!bindings.some(item => item.id === opts.kbId)) throw fail('目标知识库未绑定到所选项目，已停止上传')
  }
  const endpoint = `/api/v1/solutions/projects/${encodeURIComponent(opts.projectId)}/knowledge-bases/${encodeURIComponent(opts.kbId)}/files`
  const response = await authorizedFetch(cfg, (token, tenantId) => {
    const boundary = `----wlyd-${Math.random().toString(36).slice(2)}`
    const disposition = `form-data; name="file"; filename="upload.md"; filename*=UTF-8''${encodeURIComponent(opts.name)}`
    const part = `--${boundary}\r\nContent-Disposition: ${disposition}\r\nContent-Type: text/markdown\r\n\r\n`
    return new Request(cfg.baseUrl + endpoint, {
      method: 'POST',
      headers: { Authorization: `Bearer ${token}`, 'X-Tenant-ID': tenantId,
        'Content-Type': `multipart/form-data; boundary=${boundary}` },
      body: Buffer.concat([Buffer.from(part), Buffer.from(opts.content, 'utf8'), Buffer.from(`\r\n--${boundary}--\r\n`)]),
    })
  }, 60000, opts.signal)
  const result = await response.json().catch(() => ({}))
  if (!response.ok || result.success === false || !result.data?.id) {
    const requestId = response.headers.get('x-request-id')
    throw fail(`上传 ${opts.name} -> HTTP ${response.status}${requestId ? `，请求 ID ${requestId}` : ''}`)
  }
  return { name: opts.name, knowledgeId: String(result.data.id), status: String(result.data.parse_status ?? 'pending') }
}

export async function knowledgeStatus(cfg, id) {
  const response = await request(cfg, 'GET', `/api/v1/knowledge/${encodeURIComponent(id)}`)
  return String(response.data?.parse_status ?? 'unknown')
}

/**
 * 创建项目并绑定知识库,上传材料(文本内容),轮询到解析完成,返回就绪汇总。
 * @param {object} cfg - 平台配置。
 * @param {{projectName: string, description?: string, productName?: string,
 *   files: Array<{name: string, content: string}>, signal: AbortSignal}} opts - 参数。
 * @returns {Promise<object>} {projectId, kbId, readiness, uploads:[{name, knowledgeId, status}]}
 */
export async function setupProject(cfg, opts) {
  const call = (m, p, b, t) => request(cfg, m, p, b, t)
  const created = await call('POST', '/api/v1/solutions/projects', {
    name: opts.projectName,
    description: opts.description || '由 dsh 售前解决方案插件创建',
    product_name: opts.productName || '',
    target_role: '业务负责人',
    scenario: '客户方案编制',
    output_purpose: '生成并审核方案初稿',
  })
  const projectId = created.data?.id || created.id
  if (!projectId) throw fail(`创建项目失败:${JSON.stringify(created).slice(0, 200)}`)

  const kbResp = await call('POST', `/api/v1/solutions/projects/${projectId}/knowledge-base`, {
    name: `${opts.projectName}-资料库`, description: '插件上传的材料',
  })
  const kbId = kbResp.data?.knowledge_base?.id || kbResp.data?.binding?.knowledge_base_id
  if (!kbId) throw fail(`创建知识库失败:${JSON.stringify(kbResp).slice(0, 200)}`)

  const uploads = []
  for (const file of opts.files) {
    uploads.push(await uploadProjectFile(cfg, { projectId, kbId, ...file, signal: opts.signal, verifyBinding: false }))
  }

  // 轮询解析状态(上限 120s)
  const deadline = Date.now() + 120_000
  while (Date.now() < deadline) {
    if (opts.signal?.aborted) throw opts.signal.reason
    let allSettled = true
    for (const up of uploads) {
      if (up.status === 'pending') {
        up.status = await knowledgeStatus(cfg, up.knowledgeId)
        if (up.status === 'pending' || up.status === 'processing') allSettled = false
      }
    }
    if (allSettled) break
    await new Promise(resolve => setTimeout(resolve, 3000))
  }

  const readiness = await call('GET', `/api/v1/solutions/projects/${projectId}/knowledge-readiness`)
  return { projectId, kbId, uploads, readiness: readiness.data?.summary || readiness.data || {} }
}

/**
 * 创建对话、写入指令消息并触发生成,返回文档概要。
 * @param {object} cfg - 平台配置。
 * @param {{projectId: string, instruction: string, signal: AbortSignal}} opts - 参数。
 * @returns {Promise<object>} {conversationId, documentId, title, sections:[{position,heading,bodyChars,citations,review}]}
 */
export async function generateSolution(cfg, opts) {
  const call = (m, p, b, t) => request(cfg, m, p, b, t)
  const conv = await call('POST', `/api/v1/solutions/projects/${opts.projectId}/conversations`, {})
  const conversationId = conv.data?.id || conv.id
  if (!conversationId) throw fail(`创建对话失败:${JSON.stringify(conv).slice(0, 200)}`)
  await call('POST', `/api/v1/solutions/projects/${opts.projectId}/conversations/${conversationId}/messages`,
    { role: 'user', content: opts.instruction, attachment_ids: [] })
  const gen = await call('POST',
    `/api/v1/solutions/projects/${opts.projectId}/conversations/${conversationId}/generate`,
    undefined, 420_000)
  const doc = gen.data?.document || {}
  const sections = (doc.sections || []).map(s => ({
    position: s.position,
    heading: s.heading,
    bodyChars: (s.body || '').length,
    citations: (s.sources || []).length,
    review: s.review,
  }))
  return { conversationId, documentId: doc.id, title: doc.title, sections }
}

/**
 * 拉取文档完整章节。
 * @param {object} cfg - 平台配置。
 * @param {{projectId: string, documentId: string}} opts - 参数。
 * @returns {Promise<object>} 平台 document DTO。
 */
export async function fetchDocument(cfg, opts) {
  const r = await request(cfg, 'GET', `/api/v1/solutions/projects/${opts.projectId}/documents/${opts.documentId}`)
  const doc = r.data || r
  if (!doc.sections) throw fail(`拉取文档失败:${JSON.stringify(r).slice(0, 200)}`)
  return doc
}

// ── 知识库拉取(平台文档作为材料源) ─────────────────────────────

/**
 * 列出当前账号可访问的知识库。
 * @param {object} cfg - resolvePlatformConfig 产物。
 * @returns {Promise<Array<{id: string, name: string}>>} 知识库列表。
 */
export async function listKnowledgeBases(cfg) {
  const rows = await pagedList(cfg, '/api/v1/knowledge-bases')
  return rows.map(kb => ({ id: String(kb.id), name: String(kb.name ?? '') })).filter(kb => kb.id)
}

/**
 * 列出知识库内的知识文档(含解析状态)。
 * @param {object} cfg - resolvePlatformConfig 产物。
 * @param {string} kbId - 知识库 ID。
 * @returns {Promise<Array<{id: string, title: string, fileType: string, parseStatus: string}>>} 文档列表。
 */
export async function listKnowledge(cfg, kbId) {
  const rows = await pagedList(cfg, `/api/v1/knowledge-bases/${encodeURIComponent(kbId)}/knowledge`)
  return rows.map(item => ({
    id: String(item.id),
    title: String(item.title ?? item.name ?? '未命名'),
    fileType: String(item.file_type ?? ''),
    parseStatus: String(item.parse_status ?? ''),
  }))
}

async function pagedList(cfg, endpoint) {
  const rows = []
  for (let page = 1; page <= 20; page++) {
    const result = await request(cfg, 'GET', `${endpoint}?page=${page}&page_size=50`)
    if (!Array.isArray(result.data)) throw fail(`${endpoint} 列表响应异常`)
    rows.push(...result.data)
    if (result.data.length < 50 || (Number.isFinite(result.total) && rows.length >= result.total)) return rows
  }
  throw fail(`${endpoint} 超过 1000 条，请先在平台缩小范围，避免静默漏读`)
}

/**
 * 下载知识文档原文。平台知识库只收文本格式,响应体即正文文本。
 * @param {object} cfg - resolvePlatformConfig 产物。
 * @param {string} knowledgeId - 知识文档 ID。
 * @param {AbortSignal} [signal] - 取消信号。
 * @returns {Promise<string>} 文档正文。
 */
export async function downloadKnowledge(cfg, knowledgeId, signal) {
  const file = await downloadKnowledgeFile(cfg, knowledgeId, signal)
  return file.bytes.toString('utf8')
}

/** 下载原件字节，支持文本与二进制；调用方须按 file_type 提取后再写入会话工作区。 */
export async function downloadKnowledgeFile(cfg, knowledgeId, signal) {
  const url = `${cfg.baseUrl}/api/v1/knowledge/${encodeURIComponent(knowledgeId)}/download`
  const response = await authorizedFetch(cfg, (token, tenantId) => new Request(url, {
    headers: { Authorization: `Bearer ${token}`, 'X-Tenant-ID': tenantId },
  }), 60000, signal)
  if (!response.ok) {
    const requestId = response.headers.get('x-request-id')
    throw fail(`下载知识文档失败 ${knowledgeId} -> HTTP ${response.status}${requestId ? `，请求 ID ${requestId}` : ''}`)
  }
  const limit = 20 * 1024 * 1024
  if (Number(response.headers.get('content-length')) > limit) throw fail(`知识文档 ${knowledgeId} 超过 20MB 下载上限`)
  const chunks = []
  let size = 0
  for await (const chunk of response.body ?? []) {
    size += chunk.length
    if (size > limit) throw fail(`知识文档 ${knowledgeId} 超过 20MB 下载上限`)
    chunks.push(Buffer.from(chunk))
  }
  return { bytes: Buffer.concat(chunks), contentType: response.headers.get('content-type') ?? '' }
}

/** 平台标题转安全文件名;无扩展名时补平台文件类型。 */
export function safeFileName(title, fileType = 'md') {
  const base = String(title).replace(/[\\/:*?"<>|\r\n]+/gu, '_').trim().slice(0, 80) || '未命名'
  const ext = /^[A-Za-z0-9]{1,6}$/u.test(fileType) ? fileType : 'md'
  return /\.[A-Za-z0-9]{1,6}$/u.test(base) ? base : `${base}.${ext}`
}

// ── 平台章节 → 插件 solution 结构映射 ────────────────────────────

const KIND_RULES = [
  ['trends', /趋势|背景|时机/],
  ['pains', /痛点|挑战|困境/],
  ['solution', /解决方案|方案主张/],
  ['architecture', /架构|组成/],
  ['capabilities', /能力|功能/],
  ['scenarios', /场景/],
  ['implementation', /实施|路径|阶段/],
  ['service', /服务保障|保障|运维/],
  ['company', /公司|集团|介绍/],
  ['boundary', /边界|合作|风险|限制/],
]

/**
 * 按标题关键词猜测章节 kind(渲染层不校验 kind,仅用于组织)。
 * @param {string} heading - 章节标题。
 * @returns {string} 章节语义 kind 之一或 'custom'。
 */
export function guessKind(heading) {
  for (const [kind, re] of KIND_RULES) {
    if (re.test(heading)) return kind
  }
  return 'custom'
}

/**
 * 把平台章节的 Markdown 正文拆成插件的 blocks。
 * 支持:-/* 要点、数字编号步骤、| 表格、引用行、其余为段落;去掉 ** 加粗记号。
 * @param {string} body - 平台章节 Markdown 正文。
 * @returns {Array<object>} blocks 数组。
 */
export function mdToBlocks(body) {
  const clean = cleanMaterialText(String(body || '').replaceAll('**', ''))
  if (!clean) return []
  const blocks = []
  const chunks = clean.split(/\n\s*\n/)
  for (const chunk of chunks) {
    const lines = chunk.split('\n').map(l => l.trim()).filter(Boolean)
    if (lines.length === 0) continue
    if (lines.every(l => /^[-*]\s+/.test(l))) {
      blocks.push({ type: 'bullets', items: lines.map(l => l.replace(/^[-*]\s+/, '').trim()) })
    } else if (lines.every(l => /^\d+[.、)]\s*/.test(l))) {
      blocks.push({ type: 'steps', items: lines.map(l => l.replace(/^\d+[.、)]\s*/, '').trim()) })
    } else if (lines.every(l => l.startsWith('|')) && lines.length >= 2) {
      const rows = lines.filter(l => !/^\|[\s:|-]+\|$/.test(l)).map(l =>
        l.split('|').slice(1, -1).map(c => c.trim()))
      if (rows.length >= 2) {
        blocks.push({ type: 'table', headers: rows[0], rows: rows.slice(1) })
        continue
      }
      blocks.push({ type: 'para', text: lines.join(' ') })
    } else if (lines.length === 1 && /^>\s?/.test(lines[0])) {
      blocks.push({ type: 'quote', text: lines[0].replace(/^>\s?/, '').trim() })
    } else {
      blocks.push({ type: 'para', text: lines.join(' ') })
    }
  }
  return blocks.length > 0 ? blocks : [{ type: 'para', text: clean }]
}

/**
 * 平台 document DTO → 插件 solution 对象(可直接写 <base>.json 供渲染)。
 * @param {object} doc - 平台 document。
 * @param {{theme?: string, company?: string}} [opts] - 渲染选项。
 * @returns {object} solution 对象(与 wlyd_solution 的 .json 源同构)。
 */
export function documentToSolution(doc, opts = {}) {
  const sections = (doc.sections || []).map(s => {
    const blocks = mdToBlocks(s.body)
    return {
      kind: guessKind(s.heading || ''),
      heading: s.heading || `第 ${s.position} 节`,
      blocks: blocks.length ? blocks : [{ type: 'para', text: '待补充依据：本章正文尚无可核实内容。' }],
    }
  })
  return {
    title: doc.title || '售前解决方案',
    subtitle: '平台生成 · 插件渲染',
    meta: { company: opts.company || undefined, date: new Date().toISOString().slice(0, 7).replace('-', ' 年 ').padEnd(8, ' 月') },
    theme: opts.theme || 'corporate',
    generatedAt: new Date().toISOString(),
    sections,
    assets: [],
  }
}
