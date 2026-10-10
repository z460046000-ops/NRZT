import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { apply } from '../src/index.js'
import { directReplyIntent, materialPath, materialSource, mentionsPresales, outlineFromManifest, resumePresales, runPresales } from '../src/router.js'

test('口语化确认与公开搜索能识别，否定句不会直接执行', () => {
  for (const reply of ['就按这个生成', '可以，开始吧', '大纲没问题', '好的', '继续']) {
    assert.equal(directReplyIntent('outline', reply), 'confirm', reply)
  }
  for (const reply of ['帮我网上找找公开资料', '你先上网查一下', '搜一下相关信息吧']) {
    assert.equal(directReplyIntent('evidence', reply), 'search', reply)
  }
  assert.equal(directReplyIntent('evidence', '先按现有材料出大纲'), 'continue')
  assert.equal(directReplyIntent('outline', '先别生成，我还想改一下'), undefined)
  assert.equal(directReplyIntent('evidence', '不用搜索，我来补充'), undefined)
})

test('自然语言改大纲由模型转为受检编辑指令，含糊否定不误生成', async () => {
  const pending = { stage: 'outline', runId: 'test', manifest: { label: '资料', files: [] }, links: [], outline: [
    { id: 'a', heading: '背景', topics: ['context'], sourcePaths: [] },
    { id: 'b', heading: '方案', topics: ['problem_solution'], sourcePaths: [] },
  ] }
  const answers = [
    { intent: 'edit', editInstruction: '第2章改为：客户问题与方案' },
    { intent: 'confirm' },
  ]
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answers.shift()) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } }, tools: { async execute() { throw new Error('含糊回复不应触发生成') } } }
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const edited = await resumePresales(ctx, agent, signal, pending, '把方案那一章标题改得更贴合客户问题')
  assert.equal(edited.kind, 'outline')
  assert.equal(edited.pending.outline[1].heading, '客户问题与方案')
  const ambiguous = await resumePresales(ctx, agent, signal, edited.pending, '先别生成，我还想改一下')
  assert.equal(ambiguous.kind, 'outline')
  assert.equal(ambiguous.pending.stage, 'outline')
  assert.match(ambiguous.text, /没确定/u)
})

const originalDshHome = process.env.DSH_HOME
process.env.DSH_HOME = await mkdtemp(path.join(os.tmpdir(), 'wlyd-router-home-'))
process.on('exit', () => {
  if (originalDshHome === undefined) delete process.env.DSH_HOME
  else process.env.DSH_HOME = originalDshHome
})

const sourceText = '客户痛点是资料分散。产品提供统一资料管理。'
const readyLinks = [{
  pain: '售前资料分散，查找费时', solution: '通过统一资料管理集中整理',
  painEvidence: { path: 'materials/a.md', quote: '客户痛点是资料分散' },
  solutionEvidence: { path: 'materials/a.md', quote: '产品提供统一资料管理' },
}]
const model = answer => ({
  async *stream(options) {
    assert.equal(options.provider, 'mock')
    assert.equal(options.model, 'mock')
    let response = answer
    if (options.system.includes('售前方案撰写员')) {
      const input = JSON.parse(options.messages[0].content[0].text)
      const sources = new Map(input.sources.map(source => [source.path, source.content]))
      response = { sections: input.outline.map(item => {
        const sourcePath = item.sourcePaths.find(candidate => sources.has(candidate))
        const sentence = sources.get(sourcePath)?.split('。').find(piece => piece.includes('产品'))?.trim()
        return { heading: item.heading, blocks: sentence
          ? [{ type: 'para', text: `${sentence}。`, path: sourcePath, quote: sentence }] : [] }
      }) }
    }
    yield { type: 'text-delta', index: 0, text: JSON.stringify(response) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  },
})

test('只识别明确的材料路径，关键词不被误当成路径', () => {
  assert.equal(mentionsPresales('帮我做售前解决方案'), true)
  assert.equal(mentionsPresales('帮我做海报'), false)
  assert.equal(mentionsPresales('读取内容中台的文档，基于这个文档来生成方案'), true)
  assert.equal(mentionsPresales('内容中台是什么'), false)
  assert.equal(materialPath('生成售前解决方案，材料=`产品资料/介绍.md`'), '产品资料/介绍.md')
  assert.equal(materialPath('什么是售前解决方案？'), undefined)
  assert.equal(materialPath('"/tmp/产品 资料"', true), '/tmp/产品 资料')
})

test('材料来源识别：取消词、明确路径优先于平台词', () => {
  assert.deepEqual(materialSource('取消'), { kind: 'cancel' })
  assert.deepEqual(materialSource('不用了。'), { kind: 'cancel' })
  assert.deepEqual(materialSource('materials/'), { kind: 'path', path: 'materials/' })
  assert.deepEqual(materialSource('材料=平台'), { kind: 'platform' })
  assert.deepEqual(materialSource('读取内容中台的文档来生成方案'), { kind: 'platform' })
  assert.deepEqual(materialSource('从知识库里的材料生成'), { kind: 'platform' })
  assert.equal(materialSource('生成售前解决方案，材料=materials/')?.path, 'materials/')
  assert.equal(materialSource('今天天气如何'), undefined)
  assert.deepEqual(materialSource('给我一份callwan的产品售前解决方案'),
    { kind: 'auto', product: 'callwan', stage: 'initial' })
  assert.deepEqual(materialSource('深入接触后给我一份CallWan售前解决方案'),
    { kind: 'auto', product: 'CallWan', stage: 'deep' })
  assert.equal(materialSource('确认大纲', true), undefined)
})

test('材料驱动大纲为约 3—6 章，痛点与方案保持同一编号', () => {
  const sections = outlineFromManifest({ files: [{ path: 'materials/a.md', excerpt: sourceText }] }, [{ id: 'P1', ...readyLinks[0] }])
  assert.ok(sections.length >= 3 && sections.length <= 6)
  assert.equal(sections.filter(section => section.kind === 'problem_solution').length, 1)
  assert.match(sections.find(section => section.kind === 'problem_solution').blocks[0].text, /来源：materials\/a\.md/)
  assert.ok(!sections.some(section => section.heading === '趋势与背景'))
})

test('提取数量非零但正文为空时不生成空方案', async () => {
  const calls = []
  const ctx = { tools: { async execute(input) {
    calls.push(input.name)
    return { isError: false, value: { counts: { extracted: 1 }, files: [{ path: 'empty.md', excerpt: '' }] } }
  } } }
  const outcome = await runPresales(ctx, {}, new AbortController().signal, 'empty.md')
  assert.equal(outcome.kind, 'error')
  assert.deepEqual(calls, ['wlyd_ingest'])
})

test('四章只有占位文案时不生成幻灯片，并说明正文生成失败', async () => {
  const calls = []
  const ctx = { llm: { async *stream() { yield { type: 'finish', reason: { kind: 'max-tokens' } } } },
    tools: { async execute(input) {
      calls.push(input.name)
      if (input.name === 'wlyd_ingest') return { isError: false, value: { label: 'CallWan',
        counts: { extracted: 1 }, files: [{ path: 'product.md', excerpt: sourceText }] } }
      throw new Error('空稿不得调用 wlyd_solution')
    } } }
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const question = await runPresales(ctx, agent, signal, 'product.md')
  assert.equal(question.kind, 'question')
  const proposed = await resumePresales(ctx, agent, signal, question.pending, '先按现有材料出大纲')
  assert.equal(proposed.kind, 'outline')
  const result = await resumePresales(ctx, agent, signal, proposed.pending, '确认大纲')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /没有生成空白幻灯片/u)
  assert.deepEqual(calls, ['wlyd_ingest'])
})

test('列表项都是待确认文案时不把章节误判为有效正文', async () => {
  const source = '产品提供统一资料管理。'
  const outline = [
    { heading: '产品能力', topics: ['capabilities'], sourcePaths: ['product.md'] },
    { heading: '使用场景', topics: ['scenarios'], sourcePaths: ['product.md'] },
  ]
  const ctx = {
    llm: { async *stream() {
      yield { type: 'text-delta', text: JSON.stringify({ sections: outline.map(item => ({ heading: item.heading,
        blocks: [{ type: 'bullets', items: [
          '待与贵方确认：本部分内容将在进一步沟通后完善。',
          '待补充并确认：当前没有可核实的具体内容。',
        ], path: 'product.md', quote: source }] })) }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    tools: { async execute() { throw new Error('占位列表不得调用 wlyd_solution') } },
  }
  const pending = { stage: 'outline', manifest: { label: 'CallWan', counts: { extracted: 1 },
    files: [{ path: 'product.md', excerpt: source }] }, outline, links: [], runId: 'test-placeholder-bullets' }
  const result = await resumePresales(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, pending, '确认大纲')
  assert.equal(result.kind, 'error')
  assert.match(result.text, /只有 0\/2 章生成了有依据的正文/u)
})

test('自然语言路由和命令均经插件按导入、方案顺序执行', async () => {
  const calls = []
  const events = new Map()
  const commands = new Map()
  let designSkill
  let generated = 0
  const ctx = {
    llm: model({ decision: 'ready', links: readyLinks }),
    tools: {
      register(definition) { calls.push(`register:${definition.name}`) },
      async execute(input) {
        calls.push(input.name)
        if (input.name === 'wlyd_ingest') return {
          isError: false,
          value: { label: '样例资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: sourceText }] },
        }
        assert.ok(input.arguments.sections.length >= 3 && input.arguments.sections.length <= 6)
        assert.deepEqual(Reflect.ownKeys(input.arguments.sections),
          [...input.arguments.sections.keys()].map(String).concat('length'))
        assert.equal(input.arguments.pain_solution_links[0].id, 'P1')
        assert.equal(input.arguments.sections[1].heading, generated++ === 0 ? '问题与对应方案' : '客户问题与对应方案')
        return { isError: false, value: { markdownPath: 'solution.md', htmlPath: 'solution.html', docxPath: 'solution.docx' } }
      },
    },
    on(name, handler) { events.set(name, handler) },
    inject(names, setup) {
      if (names.includes('connection')) return // Headless mock has no Web editing transport.
      if (names.includes('skills')) {
        setup({ skills: { register(definition) { designSkill = definition } } })
        return
      }
      assert.deepEqual(names, ['commands'])
      setup({ commands: { register(definition) { commands.set(definition.name, definition) } } })
    },
  }
  apply(ctx)
  assert.equal(designSkill.name, 'wlyd-presales-html-ppt')
  assert.match(designSkill.content, /痛点与解决办法沿用同一 P 编号/)
  assert.deepEqual(calls.slice(0, 2), ['register:wlyd_ingest', 'register:wlyd_solution'])
  const registeredCount = calls.length
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { id: 'session-test', header: { cwd: '/tmp' } } }
  const signal = new AbortController().signal
  const decision = { kind: 'enter', messages: [{ id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: '用材料=materials/ 生成售前解决方案' }] }] }
  const listener = events.get('agent/pre-step')
  const entered = await listener({ agent, signal }, async () => decision)
  assert.deepEqual(calls.slice(registeredCount), ['wlyd_ingest'])
  assert.equal(entered.messages.length, 2)
  assert.match(entered.messages[1].content[0].text, /建议大纲/)
  assert.match(entered.messages[1].content[0].text, /确认大纲/)
  const restoredAgent = { options: agent.options, session: { ...agent.session } }
  await listener({ agent: restoredAgent, signal }, async () => ({ kind: 'enter', messages: [{ id: 'm2', source: { kind: 'user' }, content: [{ type: 'text', text: '第2章改为：问题与对应方案' }] }] }))
  assert.deepEqual(calls.slice(registeredCount), ['wlyd_ingest'])
  await listener({ agent: restoredAgent, signal }, async () => ({ kind: 'enter', messages: [{ id: 'm3', source: { kind: 'user' }, content: [{ type: 'text', text: '可以，开始吧' }] }] }))
  assert.deepEqual(calls.slice(registeredCount), ['wlyd_ingest', 'wlyd_solution'])
  let ordinaryModelCalled = false
  const chunks = []
  for await (const chunk of events.get('llm/stream')({ sessionId: 'session-test' }, () => {
    ordinaryModelCalled = true
    return (async function* () {})()
  })) chunks.push(chunk)
  assert.equal(ordinaryModelCalled, false, '售前路由完成后不再让模型二次生成')
  assert.match(chunks[0].text, /已按确认大纲生成/)
  await listener({ agent, signal }, async () => decision)
  assert.equal(calls.length, registeredCount + 2, '同一消息重试不能再次写文件')

  const command = await commands.get('presales').handler({ agent, rawInput: ' materials/', signal })
  assert.equal(command.kind, 'success')
  assert.deepEqual(calls.slice(registeredCount + 2), ['wlyd_ingest'])
  const confirmed = await commands.get('presales').handler({ agent, rawInput: '确认大纲', signal })
  assert.equal(confirmed.kind, 'success')
  assert.deepEqual(calls.slice(registeredCount + 2), ['wlyd_ingest', 'wlyd_solution'])
})

test('只给方案目标时询问产品名，后续仍可改用材料路径', async () => {
  const calls = []
  const events = new Map()
  const ctx = {
    llm: model({ decision: 'ready', links: readyLinks }),
    tools: {
      register() {},
      async execute(input) {
        calls.push(input.name)
        if (input.name === 'wlyd_ingest') return { isError: false, value: { label: '资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: sourceText }] } }
        return { isError: false, value: { markdownPath: 'a.md', htmlPath: 'a.html', docxPath: 'a.docx' } }
      },
    },
    on(name, handler) { events.set(name, handler) },
    inject() {},
  }
  apply(ctx)
  const listener = events.get('agent/pre-step')
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const enter = (id, text) => ({ kind: 'enter', messages: [{ id, source: { kind: 'user' }, content: [{ type: 'text', text }] }] })
  const missing = await listener({ agent, signal }, async () => enter('m1', '请生成售前解决方案'))
  assert.match(missing.messages[1].content[0].text, /哪个产品/)
  assert.deepEqual(calls, [])
  await listener({ agent, signal }, async () => enter('m2', 'materials/'))
  assert.deepEqual(calls, ['wlyd_ingest'])
  await listener({ agent, signal }, async () => enter('m3', '确认大纲'))
  assert.deepEqual(calls, ['wlyd_ingest', 'wlyd_solution'])
  const unrelated = await listener({ agent, signal }, async () => enter('m4', '今天天气'))
  assert.equal(unrelated.messages.length, 1)
})

test('等待产品名时回复取消即释放会话，普通消息回到模型', async () => {
  const events = new Map()
  const ctx = {
    llm: model({ decision: 'ready', links: readyLinks }),
    tools: { register() {}, async execute() { throw new Error('取消后不应调用工具') } },
    on(name, handler) { events.set(name, handler) },
    inject() {},
  }
  apply(ctx)
  const listener = events.get('agent/pre-step')
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const enter = (id, text) => ({ kind: 'enter', messages: [{ id, source: { kind: 'user' }, content: [{ type: 'text', text }] }] })
  const missing = await listener({ agent, signal }, async () => enter('m1', '请生成售前解决方案'))
  assert.match(missing.messages[1].content[0].text, /哪个产品/)
  const cancelled = await listener({ agent, signal }, async () => enter('m2', '取消'))
  assert.match(cancelled.messages[1].content[0].text, /已退出/)
  const freed = await listener({ agent, signal }, async () => enter('m3', '今天天气'))
  assert.equal(freed.messages.length, 1)
})

test('真实工具执行后得到可编辑源稿、预览和 Word 文件', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-presales-route-'))
  await mkdir(path.join(cwd, 'materials'))
  await writeFile(path.join(cwd, 'materials', '产品介绍.md'), `# 产品介绍\n${sourceText}\n`)
  const definitions = new Map()
  const ctx = {
    llm: model({ decision: 'ready', links: [{ ...readyLinks[0],
      painEvidence: { path: 'materials/产品介绍.md', quote: '客户痛点是资料分散' },
      solutionEvidence: { path: 'materials/产品介绍.md', quote: '产品提供统一资料管理' },
    }] }),
    fs: {
      resolve: async (file, options) => path.resolve(options.cwd, file),
      processPath: target => target,
      async stat(target) {
        try {
          const info = await stat(target)
          return { type: info.isDirectory() ? 'directory' : info.isFile() ? 'file' : 'other', size: info.size }
        } catch { return undefined }
      },
      async listDir(target) {
        const entries = await readdir(target, { withFileTypes: true })
        return entries.map(entry => ({
          name: entry.name,
          target: path.join(target, entry.name),
          type: entry.isDirectory() ? 'directory' : entry.isFile() ? 'file' : 'other',
          size: 0,
        }))
      },
      readText: target => readFile(target, 'utf8'),
      async writeText(target, content) {
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content)
        return { version: 'test' }
      },
    },
    tools: {
      register(definition) { definitions.set(definition.name, definition) },
      async execute(input) {
        assert.deepEqual(JSON.parse(JSON.stringify(input.arguments)), input.arguments, '工具参数必须能无损 JSON 序列化')
        try { return { isError: false, value: await definitions.get(input.name).execute(input.arguments, input) } }
        catch (error) { return { isError: true, content: [{ type: 'text', text: String(error) }] } }
      },
    },
    emit() {}, on() {}, inject() {},
  }
  apply(ctx)
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(cwd, 'dsh')
  let result
  try {
    const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
    const proposed = await runPresales(ctx, agent, new AbortController().signal, 'materials/')
    assert.equal(proposed.kind, 'outline')
    assert.equal((await readdir(cwd)).includes('presales-runs'), true)
    const merged = await resumePresales(ctx, agent, new AbortController().signal, proposed.pending, '合并第2章和第3章为：方案与能力')
    assert.equal(merged.kind, 'outline')
    const reordered = await resumePresales(ctx, agent, new AbortController().signal, merged.pending, '顺序：2,1,3')
    assert.equal(reordered.pending.outline[0].heading, '方案与能力')
    result = await resumePresales(ctx, agent, new AbortController().signal, reordered.pending, '确认大纲')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
  assert.equal(result.kind, 'success', result.text)
  assert.match(result.text, /\[内部稿 Word\]\([^)]*solution\.docx\)/)
  const run = (await readdir(path.join(cwd, 'presales-runs')))[0]
  const base = `presales-runs/${run}/solution`
  assert.match(await readFile(path.join(cwd, `${base}.md`), 'utf8'), /materials\/产品介绍\.md：客户痛点是资料分散/)
  assert.match(await readFile(path.join(cwd, `${base}.md`), 'utf8'), /\| P1 \| 售前资料分散/)
  const html = await readFile(path.join(cwd, `${base}.html`), 'utf8')
  assert.match(html, /<!DOCTYPE html>/)
  assert.match(html, /class="pair-map"/)
  assert.match(html, /P1 · 对应方案/)
  const structure = JSON.parse(await readFile(path.join(cwd, `${base}.json`), 'utf8'))
  assert.equal(structure.painSolutionLinks[0].id, 'P1')
  assert.equal(structure.sections.filter(section => section.kind === 'problem_solution').length, 1)
  assert.equal(structure.sections.length, 3)
  assert.equal(structure.sections[0].heading, '方案与能力')
  assert.equal((await readFile(path.join(cwd, `${base}.docx`))).subarray(0, 2).toString(), 'PK')
})

test('资料不足先提问，用户可选择待确认结构稿或停止', async () => {
  const calls = []
  const ctx = {
    llm: model({ decision: 'ask', question: '客户具体遇到什么问题？', links: [] }),
    tools: { async execute(input) {
      calls.push(input.name)
      if (input.name === 'wlyd_ingest') return { isError: false, value: {
        label: '资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: '产品支持资料管理。' }],
      } }
      assert.deepEqual(input.arguments.pain_solution_links, [])
      return { isError: false, value: { markdownPath: 'a.md', htmlPath: 'a.html', docxPath: 'a.docx' } }
    } },
  }
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const question = await runPresales(ctx, agent, signal, 'materials/')
  assert.equal(question.kind, 'question')
  assert.match(question.text, /客户具体遇到什么问题/)
  assert.deepEqual(calls, ['wlyd_ingest'])
  assert.equal((await resumePresales(ctx, agent, signal, question.pending, '停止')).kind, 'stopped')
  const draft = await resumePresales(ctx, agent, signal, question.pending, '标待确认继续')
  assert.equal(draft.kind, 'outline')
  assert.deepEqual(calls, ['wlyd_ingest'])
  const approved = await resumePresales(ctx, agent, signal, draft.pending, '确认大纲')
  assert.equal(approved.kind, 'success')
  assert.deepEqual(calls, ['wlyd_ingest', 'wlyd_solution'])
})

test('缺口提问处回复裸“继续”等同于标待确认继续', async () => {
  const ctx = {
    llm: model({ decision: 'ask', question: '客户具体遇到什么问题？', links: [] }),
    tools: { register() {}, async execute(input) {
      if (input.name !== 'wlyd_ingest') throw new Error('不应生成正式方案')
      return { isError: false, value: { label: '资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: '产品支持资料管理。' }] } }
    } },
  }
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const question = await runPresales(ctx, agent, signal, 'materials/')
  const continued = await resumePresales(ctx, agent, signal, question.pending, '继续')
  assert.equal(continued.kind, 'outline')
})

test('连发合并的相同指令按单行处理，生成被沙箱拒绝时提示新建会话', async () => {
  const calls = []
  const ctx = {
    llm: model({ decision: 'ready', links: readyLinks }),
    tools: { register() {}, async execute(input) {
      calls.push(input.name)
      if (input.name === 'wlyd_ingest') return { isError: false, value: { label: '资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: sourceText }] } }
      return { isError: true, content: [{ type: 'text', text: 'Error: cannot write "/repo/presales-runs/a/solution.md": file access denied under workspace-write mode' }] }
    } },
  }
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const question = await runPresales(ctx, agent, signal, 'materials/')
  const confirmed = await resumePresales(ctx, agent, signal, question.pending, '确认大纲\n\n确认大纲\n\n确认大纲')
  assert.equal(confirmed.kind, 'error')
  assert.deepEqual(calls, ['wlyd_ingest', 'wlyd_solution'])
  assert.match(confirmed.text, /新建一个会话/)
})

test('回复检索公开资料时经 web_search 补充，检索结果标待核实并可成稿', async () => {
  const calls = []
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-presales-search-'))
  const snippet = '物流行业素材制作耗时、获客成本高是常见问题。'
  const publicPath = '公开资料（待核实）[1] https://example.com/report'
  const answers = [
    { decision: 'ask', question: '客户在素材制作与获客上遇到什么具体问题？' },
    { decision: 'infer', links: [{
      pain: '客户可能存在素材制作耗时问题，待验证', solution: '统一素材库支持复用',
      painEvidence: { path: publicPath, quote: '素材制作耗时、获客成本高' },
      solutionEvidence: { path: 'materials/a.md', quote: '统一素材库支持复用' },
    }] },
    { pairs: [{ id: 'P1', matched: true, reason: '同一素材复用场景且内部材料支持产品做法' }] },
  ]
  const ctx = {
    fs: {
      resolve: async (file, options) => path.resolve(options.cwd, file),
      async writeText(target, content) {
        await mkdir(path.dirname(target), { recursive: true })
        await writeFile(target, content)
        return { version: 'test' }
      },
    },
    llm: { async *stream(options) {
      assert.equal(options.provider, 'mock')
      const answer = answers.shift()
      assert.ok(answer, '判断模型调用次数超出预期')
      yield { type: 'text-delta', index: 0, text: JSON.stringify(answer) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    tools: { register() {}, async execute(input) {
      calls.push(input.name)
      if (input.name === 'wlyd_ingest') return { isError: false, value: { label: '产品资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: '物流产品的统一素材库支持复用。' }] } }
      assert.equal(input.name, 'web_search')
      assert.equal(input.arguments.queries.length, 1)
      assert.equal(input.arguments.queries[0], '物流 业务流程 常见问题 行业公开资料')
      return { isError: false, value: { sources: [{ url: 'https://example.com/report', title: '行业报告', snippet }], truncated: false } }
    } },
  }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const signal = new AbortController().signal
  const question = await runPresales(ctx, agent, signal, 'materials/')
  assert.equal(question.kind, 'question')
  assert.match(question.text, /检索公开资料/)
  const outcome = await resumePresales(ctx, agent, signal, question.pending, '帮我网上找找公开资料。')
  assert.equal(outcome.kind, 'outline', outcome.text)
  assert.match(outcome.text, /公开检索/)
  assert.match(outcome.text, /research\/public-sources\.md/)
  assert.equal(outcome.pending.links[0].painBasis, 'public_unverified')
  assert.equal(outcome.pending.manifest.files.at(-1).kind, 'public')
  assert.equal((await readdir(cwd)).includes('presales-runs'), true)
  assert.deepEqual(calls, ['wlyd_ingest', 'web_search'])
})

test('材料不足时自动查公开资料，搜索词不包含企业机密原句', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-presales-auto-search-'))
  const sourcePath = '公开资料（待核实）[1] https://example.com/logistics'
  const answers = [
    { decision: 'ask', question: '缺少客户痛点' },
    { decision: 'infer', links: [{ pain: '客户可能遇到仓储协作问题，待验证', solution: '统一库存看板展示库存',
      painEvidence: { path: sourcePath, quote: '仓储协作问题' },
      solutionEvidence: { path: 'materials/private.md', quote: '统一库存看板展示库存' } }] },
    { pairs: [{ id: 'P1', matched: true, reason: '库存看板与仓储协作属于同一问题场景' }] },
  ]
  let searchedQuery
  const ctx = {
    fs: { resolve: async (file, options) => path.resolve(options.cwd, file), async writeText(target, content) {
      await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return { version: 'test' }
    } },
    llm: { async *stream() {
      yield { type: 'text-delta', text: JSON.stringify(answers.shift()) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } },
    tools: { get(name) { return name === 'web_search' ? {} : undefined }, async execute(input) {
      if (input.name === 'wlyd_ingest') return { isError: false, value: { label: '保密产品', counts: { extracted: 1 }, files: [
        { path: 'materials/private.md', excerpt: '星河集团内部代号X9。物流仓储产品提供统一库存看板展示库存。' },
      ] } }
      searchedQuery = input.arguments.queries[0]
      return { isError: false, value: { sources: [{ url: 'https://example.com/logistics', snippet: '行业常见仓储协作问题。' }] } }
    } },
  }
  const agent = { options: { provider: 'mock', model: 'mock' }, session: { header: { cwd } } }
  const outcome = await runPresales(ctx, agent, new AbortController().signal, 'materials/')
  assert.equal(outcome.kind, 'outline', outcome.text)
  assert.match(outcome.text, /自动补查/)
  assert.equal(outcome.pending.links[0].painBasis, 'public_unverified')
  assert.equal(searchedQuery, '物流 仓储 常见问题 行业公开资料')
  assert.doesNotMatch(searchedQuery, /星河集团|X9|统一库存看板/)
})

test('DSH 输入区可直接选择确认大纲并继续生成', async () => {
  const commands = new Map()
  const events = new Map()
  const asked = []
  const executed = []
  const ctx = {
    get(name) { return name === 'userQuestions' ? { async ask(request) {
      asked.push(request.questions[0])
      return { answers: [{ id: request.questions[0].id, selected: ['按此大纲生成'] }] }
    } } : undefined },
    llm: model({ decision: 'ready', links: readyLinks }),
    tools: { register() {}, async execute(input) {
      executed.push(input.name)
      if (input.name === 'wlyd_ingest') return { isError: false, value: { label: '资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: sourceText }] } }
      return { isError: false, value: { markdownPath: 'a.md', htmlPath: 'a.html', docxPath: 'a.docx' } }
    } },
    on(name, handler) { events.set(name, handler) }, inject(names, setup) {
      if (names.includes('commands')) setup({ commands: { register(command) { commands.set(command.name, command) } } })
    },
  }
  apply(ctx)
  const result = await commands.get('presales').handler({ agent: { options: { provider: 'mock', model: 'mock' } },
    rawInput: 'materials/', signal: new AbortController().signal })
  assert.match(result.text, /生成初稿/)
  assert.equal(asked.length, 1)
  assert.match(asked[0].detail, /建议结构/)
  assert.doesNotMatch(asked[0].detail, /确认大纲|顺序：|新增章节：/)
  assert.deepEqual(executed, ['wlyd_ingest', 'wlyd_solution'])
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const decision = { kind: 'enter', messages: [{ id: 'same-message', source: { kind: 'user' },
    content: [{ type: 'text', text: '用材料=materials/生成售前解决方案' }] }] }
  const listener = events.get('agent/pre-step')
  await listener({ agent, signal }, async () => decision)
  await listener({ agent, signal }, async () => decision)
  assert.equal(asked.length, 2, '同一消息重试不得重复显示选择框')
  assert.deepEqual(executed, ['wlyd_ingest', 'wlyd_solution', 'wlyd_ingest', 'wlyd_solution'])
})

test('web_search 不可用时保持提问状态，用户仍可补充或停止', async () => {
  const ctx = {
    llm: model({ decision: 'ask', question: '客户具体遇到什么问题？' }),
    tools: { register() {}, async execute(input) {
      if (input.name === 'wlyd_ingest') return { isError: false, value: { label: '资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: '产品功能。' }] } }
      return { isError: true, content: [{ type: 'text', text: 'web_search: 未配置检索提供方' }] }
    } },
  }
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const signal = new AbortController().signal
  const question = await runPresales(ctx, agent, signal, 'materials/')
  const retry = await resumePresales(ctx, agent, signal, question.pending, '检索公开资料')
  assert.equal(retry.kind, 'question')
  assert.match(retry.text, /公开检索暂不可用/)
  assert.equal((await resumePresales(ctx, agent, signal, retry.pending, '停止')).kind, 'stopped')
})

test('模型引用并非材料原文时追问，不生成方案', async () => {
  const ctx = {
    llm: model({ decision: 'ready', links: readyLinks }),
    tools: { async execute(input) {
      if (input.name !== 'wlyd_ingest') throw new Error('不应生成方案')
      return { isError: false, value: { label: '资料', counts: { extracted: 1 }, files: [{ path: 'materials/a.md', excerpt: '仅有公司名称。' }] } }
    } },
  }
  const result = await runPresales(ctx, { options: { provider: 'mock', model: 'mock' } }, new AbortController().signal, 'materials/')
  assert.equal(result.kind, 'question')
  assert.match(result.text, /缺少可核对的原文依据/)
})
