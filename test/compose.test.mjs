import assert from 'node:assert/strict'
import test from 'node:test'
import { composeSections, outlineFromMaterials } from '../src/content.js'

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

test('整稿输出被截断时按章重试，保留经过逐字引用校验的正文', async () => {
  const manifest = { files: [{ path: 'product.md', excerpt: 'CallWan 提供线索管理与客户触达。支持销售查看线索状态。' }] }
  const outline = [
    { heading: '产品价值', topics: ['capabilities'], sourcePaths: ['product.md'] },
    { heading: '使用场景', topics: ['scenarios'], sourcePaths: ['product.md'] },
  ]
  let sectionCalls = 0
  const ctx = { llm: { async *stream(options) {
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
  assert.equal(sections.every(section => section.blocks[0].text.includes('CallWan 可帮助销售')), true)
  assert.equal(sections.generationIssues.includes('max-tokens'), true)
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
  const ctx = { llm: { async *stream() {
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
  const sections = await composeSections(ctx, route, new AbortController().signal, manifest,
    [{ heading: 'CallWan 的营销价值', topics: ['capabilities'], sourcePaths: ['CallWan-产品介绍.md'] }],
    [], { sales: true, stage: 'initial' })
  assert.match(sections[0].blocks[0].text, /工作链路/)
  assert.match(sections[0].blocks[1].text, /来源：CallWan-产品介绍.md/)
})
