import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { runPresales, resumePresales } from '../src/router.js'

/** 与真实 dsh 相同的 fs 面:resolve 相对路径 + 受检写入。 */
function fsShim() {
  return {
    resolve: async (file, options) => path.resolve(options.cwd, file),
    processPath: target => target,
    async stat(target) {
      try { const info = await stat(target); return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size } } catch { return undefined }
    },
    async listDir(target) {
      const entries = await readdir(target, { withFileTypes: true })
      return entries.map(entry => ({ name: entry.name, target: path.join(target, entry.name), type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other', size: 0 }))
    },
    readText: target => readFile(target, 'utf8'),
    async writeText(target, content) {
      await mkdir(path.dirname(target), { recursive: true })
      await writeFile(target, content)
      return { version: 'test' }
    },
  }
}

const sourceText = '客户痛点是资料分散。产品提供统一资料管理。'

/** 按观察到的调用顺序断言,并返回登记的工具定义便于真实执行。 */
function toolRecorder(handlers) {
  const calls = []
  return {
    calls,
    register() {},
    async execute(input) {
      calls.push(input.name)
      const handler = handlers[input.name]
      assert.ok(handler, `未预期的工具调用 ${input.name}`)
      return handler(input)
    },
  }
}

const judge = answers => ({
  async *stream(options) {
    assert.equal(options.provider, 'mock')
    const candidate = answers.shift()
    const answer = typeof candidate === 'function' ? candidate(options) : candidate
    assert.ok(answer, '判断模型调用次数超出预期')
    yield { type: 'text-delta', index: 0, text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

const salesDraftModel = {
  async *stream(options) {
    let answer = { decision: 'ask', question: '客户场景待确认' }
    if (options.system.includes('售前方案撰写员')) {
      const input = JSON.parse(options.messages[0].content[0].text)
      const sources = new Map(input.sources.map(source => [source.path, source.content]))
      answer = { sections: input.outline.map(item => {
        const sourcePath = item.sourcePaths.find(candidate => sources.has(candidate))
        const quote = sources.get(sourcePath)?.split('。')[0]?.trim()
        return { heading: item.heading, blocks: quote ? [{ type: 'para',
          text: `${sourcePath.startsWith('公开资料') ? '公开资料显示（待核实）：' : ''}${quote}。`,
          path: sourcePath, quote }] : [] }
      }) }
    }
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
}

/** fetch 桩:按 URL 前缀匹配(更具体的前缀放前面),返回 Response。 */
async function withFetch(routes, fn) {
  const original = globalThis.fetch
  globalThis.fetch = async input => {
    const url = typeof input === 'string' ? input : input.url
    const route = routes.find(([prefix]) => url.startsWith(prefix))
    assert.ok(route, `未预期的请求 ${url}`)
    return route[1](url, input)
  }
  try { return await fn() } finally { globalThis.fetch = original }
}

const jsonResponse = body => new Response(JSON.stringify(body), { status: 200, headers: { 'Content-Type': 'application/json' } })

const CONFIG = { baseUrl: 'http://platform.test', email: 'a@b.c', password: 'p', tenantId: '1' }

function platformRoutes({ bases, knowledge, projects = [{ id: 'p1', name: '售前项目' }], bindings = [{ knowledge_base_id: 'kb' }] }) {
  return [
    ['http://platform.test/api/v1/auth/login', () => jsonResponse({ token: 't', refresh_token: '' })],
    ['http://platform.test/api/v1/solutions/projects/p1/knowledge-bases', () => jsonResponse({ success: true, data: bindings })],
    ['http://platform.test/api/v1/solutions/projects', () => jsonResponse({ success: true, data: projects })],
    ['http://platform.test/api/v1/knowledge-bases/kb/knowledge', () => jsonResponse({ success: true, data: knowledge, total: knowledge.length })],
    ['http://platform.test/api/v1/knowledge-bases/kb2/knowledge', () => jsonResponse({ success: true, data: knowledge, total: knowledge.length })],
    ['http://platform.test/api/v1/knowledge-bases?', () => jsonResponse({ success: true, data: bases })],
    ['http://platform.test/api/v1/knowledge/k1/download', () => new Response(`# 产品介绍\n${sourceText}\n`, { status: 200 })],
  ]
}

test('内容中台来源：拉取唯一知识库的已完成文档并进入统一导入链路', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-platform-pull-'))
  let stagedPath
  const tools = toolRecorder({
    wlyd_ingest: input => {
      stagedPath = input.arguments.path
      assert.match(input.arguments.path, /^presales-runs\/[^/]+\/platform-materials\/kb$/)
      assert.equal(input.arguments.label, '内容中台·联调资料库')
      return { isError: false, value: { label: input.arguments.label, counts: { extracted: 1 }, files: [{ path: `${input.arguments.path}/k1-产品介绍.md`, excerpt: sourceText }] } }
    },
  })
  const ctx = {
    llm: judge([() => ({ decision: 'ready', links: [{
      pain: '资料分散查找费时', solution: '统一资料管理集中沉淀',
      painEvidence: { path: `${stagedPath}/k1-产品介绍.md`, quote: '客户痛点是资料分散' },
      solutionEvidence: { path: `${stagedPath}/k1-产品介绍.md`, quote: '产品提供统一资料管理' },
    }] })]),
    tools,
    fs: fsShim(),
  }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const routes = platformRoutes({
    bases: [{ id: 'kb', name: '联调资料库' }],
    knowledge: [{ id: 'k1', title: '产品介绍.md', file_type: 'md', parse_status: 'completed' }],
  })
  const outcome = await withFetch(routes, () => runPresales(ctx, agent, new AbortController().signal, { kind: 'platform' }, CONFIG))
  assert.equal(outcome.kind, 'outline', outcome.text)
  assert.equal(await readFile(path.join(cwd, stagedPath, 'k1-产品介绍.md'), 'utf8'), `# 产品介绍\n${sourceText}\n`)
  assert.deepEqual(tools.calls, ['wlyd_ingest'])
})

test('内容中台来源：多个知识库先出编号问题，回复编号后继续拉取', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-platform-pick-'))
  let stagedPath
  const tools = toolRecorder({
    wlyd_ingest: input => { stagedPath = input.arguments.path; return { isError: false, value: { label: input.arguments.label, counts: { extracted: 1 }, files: [{ path: `${stagedPath}/k1-产品介绍.md`, excerpt: sourceText }] } } },
  })
  const ctx = {
    llm: judge([() => ({ decision: 'ready', links: [{
      pain: '资料分散查找费时', solution: '统一资料管理集中沉淀',
      painEvidence: { path: `${stagedPath}/k1-产品介绍.md`, quote: '客户痛点是资料分散' },
      solutionEvidence: { path: `${stagedPath}/k1-产品介绍.md`, quote: '产品提供统一资料管理' },
    }] })]),
    tools,
    fs: fsShim(),
  }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const routes = platformRoutes({
    bases: [{ id: 'kb', name: '产品库' }, { id: 'kb2', name: '公司库' }],
    bindings: [{ knowledge_base_id: 'kb' }, { knowledge_base_id: 'kb2' }],
    knowledge: [{ id: 'k1', title: '产品介绍.md', file_type: 'md', parse_status: 'completed' }],
  })
  const signal = new AbortController().signal
  await withFetch(routes, async () => {
    const question = await runPresales(ctx, agent, signal, { kind: 'platform' }, CONFIG)
    assert.equal(question.kind, 'question')
    assert.match(question.text, /1\. 产品库/)
    assert.match(question.text, /2\. 公司库/)
    const invalid = await resumePresales(ctx, agent, signal, question.pending, '随便', CONFIG)
    assert.equal(invalid.kind, 'question')
    const outcome = await resumePresales(ctx, agent, signal, question.pending, '1', CONFIG)
    assert.equal(outcome.kind, 'outline', outcome.text)
  })
  assert.equal(await readFile(path.join(cwd, stagedPath, 'k1-产品介绍.md'), 'utf8'), `# 产品介绍\n${sourceText}\n`)
  assert.deepEqual(tools.calls, ['wlyd_ingest'])
})

test('内容中台来源：没有解析完成的文档时明确报错，不进入生成', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-platform-empty-'))
  const tools = toolRecorder({})
  const ctx = { llm: judge([]), tools }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const routes = platformRoutes({
    bases: [{ id: 'kb', name: '联调资料库' }],
    knowledge: [{ id: 'k1', title: '扫描件.md', file_type: 'md', parse_status: 'processing' }],
  })
  const outcome = await withFetch(routes, () => runPresales(ctx, agent, new AbortController().signal, { kind: 'platform' }, CONFIG))
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.text, /没有解析完成/)
  assert.deepEqual(tools.calls, [])
  assert.equal((await readdir(cwd)).includes('presales-runs'), false)
})

test('只说 CallWan 售前方案：自动读取匹配知识库并直接生成营销大纲', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-auto-kb-'))
  let generated
  const tools = toolRecorder({
    wlyd_ingest: input => ({ isError: false, value: { label: input.arguments.label,
      counts: { extracted: 1 }, files: [{ path: `${input.arguments.path}/k1-产品介绍.md`, excerpt: sourceText }] } }),
    wlyd_solution: input => { generated = input.arguments; return { isError: false, value: {
      markdownPath: 'solution.md', docxPath: 'solution.docx', editUrl: 'http://localhost/solution.html',
    } } },
  })
  const ctx = { tools, fs: fsShim(), llm: salesDraftModel }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const routes = platformRoutes({
    bases: [{ id: 'kb', name: 'CallWan 产品库' }],
    knowledge: [{ id: 'k1', title: '产品介绍.md', file_type: 'md', parse_status: 'completed' }],
  })
  const outcome = await withFetch(routes, () => runPresales(ctx, agent, new AbortController().signal,
    { kind: 'auto', product: 'CallWan', stage: 'initial' }, CONFIG))
  assert.equal(outcome.kind, 'success', outcome.text)
  assert.deepEqual(tools.calls, ['wlyd_ingest', 'wlyd_solution'])
  assert.match(outcome.text, /内容中台/)
  assert.ok(generated.sections.some(section => /挑战|问题/u.test(section.heading)))
  assert.ok(generated.sections.every(section => !/接口|Swagger|API/iu.test(section.heading)))
})

test('匹配知识库暂不可读时自动查公开资料并直接生成待核实初稿', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-auto-public-'))
  let generated
  const tools = toolRecorder({
    web_search: () => ({ isError: false, value: { sources: [{ url: 'https://example.com/callwan',
      title: 'CallWan 产品介绍', snippet: 'CallWan 提供营销线索管理与客户触达。' }] } }),
    wlyd_solution: input => { generated = input.arguments; return { isError: false, value: {
      markdownPath: 'solution.md', docxPath: 'solution.docx', editUrl: 'http://localhost/solution.html',
    } } },
  })
  const ctx = { tools, fs: fsShim(), llm: salesDraftModel }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const routes = platformRoutes({
    bases: [{ id: 'kb', name: 'CallWan 产品库' }],
    knowledge: [{ id: 'k1', title: '尚在解析.md', file_type: 'md', parse_status: 'processing' }],
  })
  const outcome = await withFetch(routes, () => runPresales(ctx, agent, new AbortController().signal,
    { kind: 'auto', product: 'CallWan', stage: 'initial' }, CONFIG))
  assert.equal(outcome.kind, 'success', outcome.text)
  assert.deepEqual(tools.calls, ['web_search', 'wlyd_solution'])
  assert.match(outcome.text, /公开网页摘要（待核实）/)
  assert.equal(generated.pain_solution_links.length, 0)
  assert.ok(generated.sections.some(section => /挑战|问题/u.test(section.heading)))
})

test('知识库已读到材料但组稿失败时保留原错误，不改用单条公开摘要', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-auto-model-error-'))
  const tools = toolRecorder({
    wlyd_ingest: input => ({ isError: false, value: { label: 'CallWan', counts: { extracted: 6 },
      files: [{ path: `${input.arguments.path}/k1-产品介绍.md`, excerpt: sourceText }] } }),
  })
  const ctx = { tools, fs: fsShim(), llm: { async *stream() {
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'MODEL_FAILED' } } }
  } } }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const routes = platformRoutes({
    bases: [{ id: 'kb', name: 'CallWan 产品库' }],
    knowledge: [{ id: 'k1', title: '产品介绍.md', file_type: 'md', parse_status: 'completed' }],
  })
  const outcome = await withFetch(routes, () => runPresales(ctx, agent, new AbortController().signal,
    { kind: 'auto', product: 'CallWan', stage: 'initial' }, CONFIG))
  assert.equal(outcome.kind, 'error')
  assert.match(outcome.text, /已读取 6 篇资料/u)
  assert.match(outcome.text, /模型调用失败/u)
  assert.deepEqual(tools.calls, ['wlyd_ingest'])
})
