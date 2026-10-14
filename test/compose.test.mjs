import assert from 'node:assert/strict'
import test from 'node:test'
import { composeSections, outlineFromMaterials } from '../src/content.js'
import { skillExecutionFor, loadPresalesSkills, useSkillRegistryContext } from '../src/skill-runtime.js'
import { salesOutlineCandidate, salesScenario } from '../src/sales.js'

test('按材料区分增长与协同叙事，公开摘要不能作为产品能力章来源', () => {
  const collaboration = { files: [{ path: 'CallWan AI 企业协同工作台解决方案.pdf', excerpt: '人机协作。' }] }
  assert.equal(salesScenario(collaboration), 'collaboration')
  assert.match(salesOutlineCandidate(collaboration, 'CallWan', 'initial')[3].heading, /协同场景/u)
  const growth = { files: [
    { path: 'CallWan-AI企业增长平台解决方案.html', excerpt: '内容生产与线索承接。' },
    { path: '公开资料（待核实）[1] https://example.com', excerpt: '行业营销趋势。', kind: 'public' },
  ] }
  const outline = salesOutlineCandidate(growth, 'CallWan', 'initial')
  assert.equal(salesScenario(growth), 'growth')
  assert.ok(outline[1].sourcePaths.some(value => value.startsWith('公开资料')))
  assert.ok(outline[2].sourcePaths.every(value => !value.startsWith('公开资料')))
})

test('增长材料覆盖六段售前叙事；趋势和公司来源各自限定', () => {
  const manifest = { files: [
    { path: 'trend.md', excerpt: '增长环境与趋势：营销获客入口变化，内容供给和线索经营需要协同。' },
    { path: 'product.md', excerpt: 'CallWan 支持内容生产和线索管理，回应多渠道信号难统一承接的问题。' },
    { path: 'service.md', excerpt: '实施与服务包括咨询、培训和客户成功。' },
    { path: 'company.md', excerpt: '公司介绍：集团服务网络和业务生态。' },
    { path: 'public', excerpt: '营销行业趋势。', kind: 'public' },
  ] }
  const outline = salesOutlineCandidate(manifest, 'CallWan', 'initial')
  assert.deepEqual(outline.map(section => section.heading), [
    '增长环境与趋势', '现状与挑战', '总体方案', '平台能力', '实施与服务', '公司介绍',
  ])
  assert.ok(outline[0].sourcePaths.includes('trend.md'))
  assert.deepEqual(outline.at(-1).sourcePaths, ['company.md'])
  assert.ok(outline[2].sourcePaths.every(source => source !== 'public'))
})

test('模型漏掉已有依据的趋势章时，自动补足主题和来源', async () => {
  const manifest = { files: [
    { path: 'trend.md', excerpt: '增长环境与趋势：流量竞争和营销内容供给发生变化。' },
    { path: 'product.md', excerpt: '产品提供内容生产与线索管理能力。' },
  ] }
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ outline: [
      { heading: '业务背景', topics: ['context'], sourceIds: ['K2'] },
      { heading: '现状与挑战', topics: ['problem_solution'], sourceIds: ['K1'] },
      { heading: '平台能力', topics: ['capabilities'], sourceIds: ['K2'] },
    ] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const outline = await outlineFromMaterials(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, { sales: true, product: 'CallWan', stage: 'initial' })
  assert.equal(outline[0].heading, '业务背景')
  assert.ok(outline[0].topics.includes('trends'))
  assert.ok(outline[0].sourcePaths.includes('trend.md'))
})

test('模型把公开摘要写成产品能力时由代码拒绝', async () => {
  const sourcePath = '公开资料（待核实）[1] https://example.com'
  const excerpt = '某行业企业采用统一资料管理。'
  const manifest = { files: [{ path: sourcePath, excerpt, kind: 'public' }] }
  const outline = [{ heading: '产品能力', topics: ['capabilities'], sourcePaths: [sourcePath] }]
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '产品能力', blocks: [
      { type: 'para', text: 'CallWan 提供统一资料管理。', path: sourcePath, quote: excerpt },
    ] }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const sections = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [], { sales: true })
  assert.match(sections[0].blocks[0].text, /待与贵方确认/u)
})

test('DSH Skill 目录读取失败时仍使用随包规则并继续调用模型', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: 'CallWan 支持销售查看线索状态。' }] }
  const outline = [{ heading: '线索管理', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  let calls = 0
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const ctx = { skills: { async get() { throw new Error('registry lookup failed') } },
    llm: { async *stream() {
      calls++
      yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '线索管理', blocks: [
        { type: 'para', text: '销售可以查看线索状态。', path: 'product.md', quote: '支持销售查看线索状态' },
      ] }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    } } }
  const sections = await composeSections(ctx, agent, new AbortController().signal, manifest, outline, [])
  assert.equal(calls, 1)
  assert.equal(sections[0].blocks[0].text, '销售可以查看线索状态。')
  assert.ok(skillExecutionFor(agent).some(run => run.skills.some(skill => skill.loader === 'bundled-after-registry-error')))
})

test('模型服务整稿与单章都失败时只探测一章，不继续重复请求', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: 'CallWan 支持销售查看线索状态。' }] }
  const outline = [
    { heading: '线索管理', topics: ['capabilities'], sourcePaths: ['product.md'] },
    { heading: '使用场景', topics: ['scenarios'], sourcePaths: ['product.md'] },
  ]
  let calls = 0
  const ctx = { llm: { async *stream(options) {
    calls++
    assert.ok(options.signal instanceof AbortSignal)
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UPSTREAM_UNAVAILABLE', status: 503 } } }
  } } }
  const sections = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [])
  assert.equal(calls, 2)
  assert.ok(sections.generationIssues.includes('model_error'))
})

test('通过注入的 DSH skills 上下文读取规则，不访问未声明服务的插件上下文', async () => {
  const ctx = {}
  Object.defineProperty(ctx, 'skills', { get() { throw new Error('cannot get property "skills" without inject') } })
  const agent = { session: { header: { cwd: '/workspace' } } }
  const calls = []
  useSkillRegistryContext(ctx, { skills: { async get(name, options) {
    calls.push({ name, options })
    return { content: `来自 DSH 目录的规则：${name}` }
  } } })
  const body = await loadPresalesSkills(ctx, agent, new AbortController().signal, 'outline')
  assert.match(body, /来自 DSH 目录的规则/u)
  assert.equal(calls.length, 3)
  assert.ok(skillExecutionFor(agent)[0].skills.every(skill => skill.loader === 'dsh-registry'))
})

test('确认大纲后只接受有原文依据且属于该章来源的段落', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: '客户资料分散。产品统一管理资料。' }] }
  const outline = [{ heading: '资料管理方案', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  const answer = { sections: [{ heading: '资料管理方案', paragraphs: [
    { text: '产品把售前资料集中管理。', path: 'product.md', quote: '产品统一管理资料' },
    { text: '可节省 80% 时间。', path: 'product.md', quote: '节省 80% 时间' },
  ] }] }
  const ctx = { fs: { async resolve() { throw new Error('fixture') } }, llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const sections = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } }, new AbortController().signal, manifest, outline, [])
  assert.equal(sections[0].heading, '资料管理方案')
  assert.equal(sections[0].blocks[0].text, '产品把售前资料集中管理。')
  assert.match(sections[0].blocks[1].text, /产品统一管理资料/u)
  assert.equal(JSON.stringify(sections).includes('80%'), false)
})

test('长 chunk 路径用 sourceId 引用，引用原文仍逐字校验', async () => {
  const sourcePath = '内容中台/很长的产品资料.md · 第 143 段 [chunk:example]'
  const quote = '平台支持线索分层与客户触达记录。'
  const manifest = { files: [{ path: sourcePath, excerpt: quote, kind: 'platform-chunk', topics: ['capability'] }] }
  const outline = [{ heading: '线索运营', topics: ['capabilities'], sourcePaths: [sourcePath] }]
  let input
  const ctx = { llm: { async *stream(options) {
    input = JSON.parse(options.messages[0].content[0].text)
    yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '线索运营', blocks: [
      { type: 'para', text: '您可以分层管理线索，并记录客户触达。', sourceId: 'K1', quote },
    ] }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const sections = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [], { sales: true })
  assert.equal(input.sources[0].id, 'K1')
  assert.deepEqual(input.outline[0].sourceIds, ['K1'])
  assert.equal(sections[0].blocks[0].text, '您可以分层管理线索，并记录客户触达。')
  assert.deepEqual(sections.generationIssues, [])
})

test('正文可生成有证据的结构化要点，虚构要点被丢弃', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: '产品提供项目资料库。支持上传文档和按主题检索。' }] }
  const outline = [{ heading: '项目资料管理', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  const answer = { sections: [{ heading: '项目资料管理', lead: '资料在项目内统一管理', blocks: [
    { type: 'bullets', items: ['上传文档', '按主题检索'], path: 'product.md', quote: '支持上传文档和按主题检索' },
    { type: 'para', text: '成本降低九成。', path: 'product.md', quote: '成本降低九成' },
  ] }] }
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const result = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [])
  assert.equal(result[0].lead, '资料在项目内统一管理')
  assert.deepEqual(result[0].blocks[0], { type: 'bullets', items: ['上传文档', '按主题检索'] })
  assert.equal(JSON.stringify(result).includes('九成'), false)
})

test('关键数字仅在标签和数值紧邻且均来自同一引文时放大', async () => {
  const quote = '平台提供 16 种内容形态、5 个发布平台。'
  const manifest = { files: [{ path: 'product.md', excerpt: quote }] }
  const outline = [{ heading: '内容能力', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  const answer = { sections: [{ heading: '内容能力', blocks: [
    { type: 'metrics', items: [{ label: '内容形态', value: '16' }, { label: '发布平台', value: '5' }], path: 'product.md', quote },
    { type: 'metrics', items: [{ label: '内容形态', value: '80%' }], path: 'product.md', quote },
  ] }] }
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const result = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [])
  assert.deepEqual(result[0].blocks[0], { type: 'metrics', items: [
    { label: '内容形态', value: '16' }, { label: '发布平台', value: '5' },
  ] })
  assert.equal(JSON.stringify(result).includes('80%'), false)
})

test('模型图表只有数值和标签均来自同一原文才进入方案', async () => {
  const quote = '2024年线索 12 条；2025年线索 20 条。'
  const manifest = { files: [{ path: 'trend.md', excerpt: quote }] }
  const outline = [{ heading: '业务趋势', topics: ['trends'], sourcePaths: ['trend.md'] }]
  const answer = { sections: [{ heading: '业务趋势', blocks: [
    { type: 'chart', chartType: 'line', title: '线索变化', unit: '条',
      points: [{ label: '2024年', value: 12 }, { label: '2025年', value: 20 }], path: 'trend.md', quote },
    { type: 'chart', chartType: 'bar', title: '凭空增加', unit: '条',
      points: [{ label: '2024年', value: 12 }, { label: '2025年', value: 80 }], path: 'trend.md', quote },
  ] }] }
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const result = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [])
  assert.equal(result[0].blocks.length, 1)
  assert.equal(result[0].blocks[0].type, 'chart')
  assert.equal(result[0].blocks[0].points[1].value, 20)
})

test('整稿输出被截断时按章重试，保留经过逐字引用校验的正文', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: 'CallWan 提供线索管理与客户触达。支持销售查看线索状态。' }] }
  const outline = [
    { heading: '产品价值', topics: ['capabilities'], sourcePaths: ['product.md'] },
    { heading: '使用场景', topics: ['scenarios'], sourcePaths: ['product.md'] },
  ]
  let sectionCalls = 0
  const requests = []
  const ctx = { llm: { async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }] } } }, async *stream(options) {
    requests.push(options)
    if (options.system.includes('售前方案撰写员')) {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    sectionCalls++
    yield { type: 'text-delta', text: JSON.stringify({ blocks: [{ type: 'para',
      text: 'CallWan 可帮助销售管理线索并查看状态。', sourceId: 'S1', quote: '支持销售查看线索状态' }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const sections = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [], { sales: true, stage: 'initial' })
  assert.equal(sectionCalls, 2)
  assert.ok(requests.every(request => !Object.hasOwn(request, 'maxTokens')))
  assert.ok(requests.slice(1).every(request => request.reasoningEffort === 'off'))
  assert.equal(sections.every(section => section.blocks[0].text.includes('CallWan 可帮助销售')), true)
  assert.equal(sections.generationIssues.includes('max-tokens'), true)
})

test('六章长语料整稿调用关闭思考且不设置输出上限', async () => {
  const source = 'CallWan 支持销售查看线索状态，并把客户触达记录保存在同一项目。'.repeat(120)
  const manifest = { files: [{ path: 'product.md', excerpt: source }] }
  const outline = Array.from({ length: 6 }, (_, index) => ({
    heading: `营销方案第 ${index + 1} 章`, topics: ['capabilities'], sourcePaths: ['product.md'],
  }))
  const calls = []
  const ctx = { llm: { async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }] } } }, async *stream(options) {
    calls.push(options)
    if (options.reasoningEffort !== 'off' || Object.hasOwn(options, 'maxTokens')) {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    yield { type: 'text-delta', text: JSON.stringify({ sections: outline.map(item => ({
      heading: item.heading, blocks: [{ type: 'para',
        text: '销售可以查看线索状态，跟进客户触达记录。', path: 'product.md',
        quote: 'CallWan 支持销售查看线索状态，并把客户触达记录保存在同一项目。' }],
    })) }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const sections = await composeSections(ctx, { options: { provider: 'mock', model: 'glm-5.3-flash' } },
    new AbortController().signal, manifest, outline, [], { sales: true })
  assert.equal(calls.length, 1)
  assert.equal(sections.filter(section => section.blocks[0]?.text?.includes('查看线索状态')).length, 6)
  assert.deepEqual(sections.generationIssues, [])
})

test('模型未声明关闭思考时不强传参数，仍能生成正文', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: '产品提供统一资料管理。' }] }
  const outline = [{ heading: '产品价值', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  const requests = []
  const ctx = { llm: {
    async resolveModelInfo() { return { id: 'qifu/deepseek-v4-flash' } },
    async *stream(options) {
      requests.push(options)
      yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '产品价值', blocks: [
        { type: 'para', text: '产品帮助团队统一管理资料。', path: 'product.md', quote: '产品提供统一资料管理' },
      ] }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } }
  const result = await composeSections(ctx, { options: { provider: 'qifu', model: 'qifu/deepseek-v4-flash' } },
    new AbortController().signal, manifest, outline, [])
  assert.equal(requests.length, 1)
  assert.equal('reasoningEffort' in requests[0], false)
  assert.match(result[0].blocks[0].text, /统一管理资料/u)
})

test('路由误报关闭思考能力时只重试一次默认参数', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: '产品提供统一资料管理。' }] }
  const outline = [{ heading: '产品价值', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  const requests = []
  const ctx = { llm: {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }] } } },
    async *stream(options) {
      requests.push(options)
      if (options.reasoningEffort === 'off') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: 'UNSUPPORTED_REASONING_EFFORT' } } }
      } else {
        yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '产品价值', blocks: [
          { type: 'para', text: '产品帮助团队统一管理资料。', path: 'product.md', quote: '产品提供统一资料管理' },
        ] }] }) }
        yield { type: 'finish', reason: { kind: 'stop' } }
      }
    },
  } }
  const result = await composeSections(ctx, { options: { provider: 'qifu', model: 'qifu/deepseek-v4-flash' } },
    new AbortController().signal, manifest, outline, [])
  assert.equal(requests.length, 2)
  assert.equal(requests[0].reasoningEffort, 'off')
  assert.equal('reasoningEffort' in requests[1], false)
  assert.match(result[0].blocks[0].text, /统一管理资料/u)
})

test('服务商以 400/1210 拒绝关闭思考参数时，只撤去该参数重试', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: '产品提供统一资料管理。' }] }
  const outline = [{ heading: '产品价值', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  const calls = []
  const ctx = { llm: {
    async resolveModelInfo() { return { reasoning: { efforts: [{ id: 'off' }] } } },
    async *stream(options) {
      calls.push(options)
      if (options.reasoningEffort === 'off') {
        yield { type: 'finish', reason: { kind: 'error', failure: { code: '1210', status: 400 } } }
        return
      }
      yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '产品价值', blocks: [
        { type: 'para', text: '团队可统一管理资料。', path: 'product.md', quote: '产品提供统一资料管理' },
      ] }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } }
  const result = await composeSections(ctx, { options: { provider: 'qifu', model: 'mock' } },
    new AbortController().signal, manifest, outline, [])
  assert.equal(calls.length, 2)
  assert.equal(calls[0].reasoningEffort, 'off')
  assert.equal('reasoningEffort' in calls[1], false)
  assert.match(result[0].blocks[0].text, /统一管理资料/u)
})

test('整稿失败后只对缺失章节做最多两路并行补写', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: '产品支持按项目管理客户线索。' }] }
  const outline = Array.from({ length: 4 }, (_, index) => ({
    heading: `第${index + 1}章`, topics: ['capabilities'], sourcePaths: ['product.md'],
  }))
  let active = 0
  let maximum = 0
  let retried = 0
  const ctx = { llm: { async *stream(options) {
    if (options.system.includes('售前方案撰写员')) {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    active++
    maximum = Math.max(maximum, active)
    retried++
    await new Promise(resolve => setTimeout(resolve, 8))
    active--
    yield { type: 'text-delta', text: JSON.stringify({ blocks: [{ type: 'para',
      text: '团队可以按项目查看并管理线索。', sourceId: 'S1', quote: '产品支持按项目管理客户线索' }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const sections = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [])
  assert.equal(retried, 4)
  assert.equal(maximum, 2)
  assert.equal(sections.filter(section => section.blocks[0].text.includes('按项目查看')).length, 4)
})

test('单章重试能读取长材料靠后的场景依据', async () => {
  const late = '典型场景：销售在项目内查看线索来源，并按负责人完成跟进。'
  const manifest = { files: [{ path: 'CallWan-产品介绍.md', excerpt: `${'增长趋势描述。'.repeat(1700)}\n${late}` }] }
  const outline = [{ heading: '营销场景与落地方式', topics: ['scenarios'], sourcePaths: ['CallWan-产品介绍.md'] }]
  let sawLate = false
  const ctx = { llm: { async *stream(options) {
    if (options.system.includes('售前方案撰写员')) {
      yield { type: 'finish', reason: { kind: 'max-tokens' } }
      return
    }
    const input = JSON.parse(options.messages[0].content[0].text)
    sawLate = input.sources[0].content.includes(late)
    yield { type: 'text-delta', text: JSON.stringify({ blocks: [{ type: 'para',
      text: '销售可以按来源和负责人跟进项目线索。', sourceId: 'S1', quote: late }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const result = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [], { sales: true })
  assert.equal(sawLate, true)
  assert.match(result[0].blocks[0].text, /项目线索/u)
})

test('证据未能确认痛点时仍可由模型提出材料化大纲', async () => {
  const manifest = { files: [{ path: 'api.md', excerpt: '项目创建、文档上传、知识检索、方案审核接口。' }] }
  const answer = { outline: [
    { heading: '从项目创建到资料上传', topics: ['implementation'], sourcePaths: ['api.md'] },
    { heading: '知识检索与内容使用', topics: ['capabilities'], sourcePaths: ['api.md'] },
    { heading: '方案审核与交付边界', topics: ['boundary'], sourcePaths: ['api.md'] },
  ] }
  const ctx = { llm: { async *stream() {
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const outline = await outlineFromMaterials(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest)
  assert.deepEqual(outline.map(item => item.heading), answer.outline.map(item => item.heading))
  assert.equal(outline.some(item => item.topics.includes('problem_solution')), false)
})

test('售前营销正文由模型归纳，技术接口目录不能覆盖客户版结构', async () => {
  const manifest = { label: 'CallWan', files: [
    { path: 'CallWan-产品介绍.md', excerpt: 'CallWan 提供营销线索管理与客户触达，销售可查看线索状态。' },
    { path: '08-核心业务接口.md', excerpt: 'POST /api/lead，返回线索状态码。' },
  ] }
  const route = { options: { provider: 'mock', model: 'mock' } }
  let calls = 0
  const prompts = []
  const ctx = { llm: { async *stream(options) {
    prompts.push(options.system)
    const answer = calls++ === 0 ? { outline: [
      { heading: 'API 接口鉴权', topics: ['context'], sourcePaths: ['08-核心业务接口.md'] },
      { heading: '请求响应参数', topics: ['problem_solution'], sourcePaths: ['08-核心业务接口.md'] },
      { heading: '产品接口列表', topics: ['capabilities'], sourcePaths: ['08-核心业务接口.md'] },
    ] } : { sections: [{ heading: 'CallWan 的营销价值', blocks: [
      { type: 'para', text: 'CallWan 将线索管理和客户触达放在同一工作链路，销售可查看线索状态。',
        path: 'CallWan-产品介绍.md', quote: '提供营销线索管理与客户触达，销售可查看线索状态' },
    ] }] }
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const outline = await outlineFromMaterials(ctx, route, new AbortController().signal, manifest,
    { sales: true, product: 'CallWan', stage: 'initial' })
  assert.equal(outline.length >= 4, true)
  assert.ok(outline.every(item => !/接口|参数|API/iu.test(item.heading)))
  assert.ok(outline.some(item => item.topics.includes('problem_solution')))
  assert.match(prompts[0], /标题以可理解为先/u)
  assert.match(prompts[0], /增长环境与趋势→现状与挑战→总体方案/u)
  const sections = await composeSections(ctx, route, new AbortController().signal, manifest,
    [{ heading: 'CallWan 的营销价值', topics: ['capabilities'], sourcePaths: ['CallWan-产品介绍.md'] }],
    [], { sales: true, stage: 'initial' })
  assert.match(sections[0].blocks[0].text, /工作链路/)
  assert.match(sections[0].blocks[1].text, /来源：CallWan-产品介绍.md/)
  assert.match(prompts[1], /正文多用短句.*场景、对象和因果/u)
  assert.match(prompts[1], /第一次接触产品的读者知道产品是什么/u)
  assert.match(prompts[1], /避免.*全链路闭环/u)
  assert.match(prompts[0], /每句话增加信息/u)
  assert.match(prompts[1], /不固定章节或强制四字对仗/u)
  assert.match(prompts[1], /制作提示/u)
})

test('确定性组稿显式注入四份 Skill，并用锚点回填逐字来源', async () => {
  const source = '多渠道线索散在评论与表单，销售难以判断谁在跟进。CallWan 将互动统一记为线索，并保留来源和处理状态。'
  const manifest = { files: [{ path: 'product.md', excerpt: source }] }
  const outline = [{ heading: '线索承接', topics: ['capabilities'], sourcePaths: ['product.md'] }]
  const seen = []
  const loaded = []
  const agent = { options: { provider: 'mock', model: 'mock' } }
  const ctx = { skills: { async get(name) { loaded.push(name); return undefined } }, llm: {
    async *stream(options) {
      seen.push(options)
      const input = JSON.parse(options.messages[0].content[0].text)
      const anchor = input.sources[0].evidence.find(item => item.text.includes('CallWan'))
      assert.ok(anchor)
      yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '线索承接', blocks: [
        { type: 'para', label: '线索分散', title: '跟进状态看得见', text: 'CallWan 统一记录互动线索。销售可以查看线索来源与处理状态。',
          emphasis: ['线索来源'], evidenceId: anchor.id },
        { type: 'para', text: '凭空增加百分之九十收入。', evidenceId: 'K1:E999' },
      ] }] }) }
      yield { type: 'finish', reason: { kind: 'stop' } }
    },
  } }
  const result = await composeSections(ctx, agent, new AbortController().signal, manifest, outline, [])
  assert.equal(result[0].blocks[0].title, '跟进状态看得见')
  assert.deepEqual(result[0].blocks[0].emphasis, ['线索来源'])
  assert.match(result[0].blocks[1].text, /CallWan 将互动统一记为线索/u)
  assert.equal(JSON.stringify(result).includes('百分之九十'), false)
  assert.deepEqual([...new Set(loaded)].sort(), [
    'wlyd-presales-copywriting', 'wlyd-presales-design-master', 'wlyd-presales-html-ppt',
    'wlyd-presales-huashu-design',
  ])
  assert.ok(seen[0].system.includes('<skill name="wlyd-presales-design-master">'))
  assert.ok(seen[0].system.includes('references/presales-design.md'))
  assert.ok(seen[0].system.includes('<skill name="wlyd-presales-huashu-design">'))
  assert.ok(seen[0].system.includes('references/presales-deck.md'))
  assert.equal(skillExecutionFor(agent)[0].status, 'injected')
})

test('模型返回空章节时仍可从单份已清洗材料恢复有出处的内部初稿', async () => {
  const excerpt = '星桥协作台面向销售团队，用于集中管理客户咨询。\n典型问题：咨询分散在多个入口，负责人难以判断谁在跟进。\n对应做法：工作台汇总咨询来源，并记录负责人和下一步动作。\n上线时先导入试点团队的线索，再核对字段和责任人。'
  const manifest = { files: [{ path: 'product.md', excerpt, kind: 'user' }] }
  const outline = [
    { heading: '产品背景', topics: ['context'], sourcePaths: ['product.md'] },
    { heading: '典型挑战', topics: ['problem_solution'], sourcePaths: ['product.md'] },
    { heading: '工作台能力', topics: ['capabilities'], sourcePaths: ['product.md'] },
    { heading: '试点实施', topics: ['implementation'], sourcePaths: ['product.md'] },
  ]
  let calls = 0
  const ctx = { llm: { async *stream() {
    calls++
    yield { type: 'text-delta', text: JSON.stringify(calls === 1
      ? { sections: outline.map(item => ({ heading: item.heading, blocks: [] })) }
      : { blocks: [] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const result = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [], { sales: true })
  assert.equal(result.length, 4)
  assert.ok(result.every(section => section.blocks.some(block => block.type === 'para')))
  assert.ok(result.every(section => section.blocks.some(block => block.type === 'quote')))
  assert.ok(result.flatMap(section => section.blocks).every(block => block.type !== 'quote'
    || excerpt.includes(block.text.split('\n').at(-1))))
  assert.ok(result.generationIssues.includes('source_extract_fallback'))
})
