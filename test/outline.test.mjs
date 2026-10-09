import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { editOutline, formatOutline, loadPending, savePending, sectionsFromOutline, suggestOutline } from '../src/outline.js'
import { renderHtml } from '../src/html.js'
import { renderMarkdown } from '../src/markdown.js'
import { renderDocx } from '../src/docx.js'
import { apply } from '../src/index.js'
import { documentToSolution } from '../src/platform.js'

const manifest = { files: [
  { path: 'a.md', excerpt: '客户痛点是资料分散。产品提供统一资料管理。' },
  { path: 'b.md', excerpt: '实施阶段提供培训和上线支持。' },
] }
const links = [{ id: 'P1', pain: '资料分散', solution: '统一资料管理',
  painEvidence: { path: 'a.md', quote: '客户痛点是资料分散' },
  solutionEvidence: { path: 'a.md', quote: '产品提供统一资料管理' } }]

test('大纲按材料选择章节，编辑后合并、排序仍保留痛点与方案对应', () => {
  const proposal = suggestOutline(manifest, links)
  assert.ok(proposal.length >= 3 && proposal.length <= 6)
  assert.equal(proposal.filter(section => section.topics.includes('problem_solution')).length, 1)
  assert.match(formatOutline(proposal), /尚未生成正式方案/)
  const renamed = editOutline(proposal, '第2章改为：业务问题与解决路径')
  assert.equal(renamed.outline[1].heading, '业务问题与解决路径')
  const merged = editOutline(renamed.outline, '合并第2章和第3章为：方案与能力')
  assert.equal(merged.outline.length, proposal.length - 1)
  assert.ok(merged.outline[1].topics.includes('problem_solution'))
  assert.ok(merged.outline[1].topics.includes('capabilities'))
  assert.match(editOutline(merged.outline, '删除第2章').error, /先合并/)
  const order = [2, 1, ...Array.from({ length: merged.outline.length - 2 }, (_, i) => i + 3)]
  const sorted = editOutline(merged.outline, `顺序：${order.join(',')}`)
  assert.equal(sorted.outline[0].heading, '方案与能力')
  assert.equal(editOutline(sorted.outline, '新增章节：采购建议').outline.at(-1).heading, '采购建议')
  assert.match(editOutline(sorted.outline, '顺序：2,2').error, /各一次/)
  assert.equal(proposal[1].heading, '客户问题与对应方案', '编辑不能修改原草案')
})

test('模型大纲按节抢救：标题保留、无效来源只过滤路径、缺失主题按标题归类', () => {
  const candidate = [
    { heading: '业务背景', topics: ['context'], sourcePaths: ['a.md'] },
    { heading: '问题与做法', topics: ['problem_solution'], sourcePaths: ['a.md'] },
    { heading: '交付步骤', topics: ['implementation'], sourcePaths: ['b.md'] },
  ]
  assert.deepEqual(suggestOutline(manifest, links, candidate).map(s => s.heading), candidate.map(s => s.heading))
  const salvaged = suggestOutline(manifest, links, candidate.map((s, i) => i === 1 ? { ...s, sourcePaths: ['不存在.md'] } : s))
  assert.equal(salvaged.find(s => s.heading === '问题与做法').sourcePaths.length, 0)
  const guessed = suggestOutline(manifest, links, [
    { heading: '业务背景', topics: ['context'], sourcePaths: ['a.md'] },
    { heading: '问题与做法', topics: ['problem_solution'], sourcePaths: ['a.md'] },
    { heading: '风险与限制说明', topics: ['不存在的主题'], sourcePaths: [] },
  ])
  assert.ok(guessed.find(s => s.heading === '风险与限制说明').topics.includes('boundary'))
  assert.ok(suggestOutline(manifest, links, candidate.slice(0, 1)).length >= 3)
  assert.deepEqual(suggestOutline(manifest, links, candidate.map((s, i) => ({ ...s, heading: `${i + 1}. ${s.heading}` }))).map(s => s.heading), candidate.map(s => s.heading))
})

test('候选大纲缺痛点方案章时自动补齐，材料化标题不被模板覆盖', () => {
  const candidate = [
    { heading: '通话质检的现状与挑战', topics: ['problem_solution'], sourcePaths: ['a.md'] },
    { heading: '统一工作台能力', topics: ['capabilities'], sourcePaths: ['a.md'] },
    { heading: '分阶段上线计划', topics: ['implementation'], sourcePaths: ['b.md'] },
  ]
  assert.deepEqual(suggestOutline(manifest, links, candidate).map(s => s.heading), candidate.map(s => s.heading))
  const withoutPaired = suggestOutline(manifest, links, candidate.map(s => ({
    ...s, topics: [s.topics[0] === 'problem_solution' ? 'capabilities' : s.topics[0]],
  })))
  assert.ok(withoutPaired.some(s => s.topics.includes('problem_solution')))
  assert.equal(withoutPaired[1].heading, '客户问题与对应方案')
})

test('同一会话重建 Agent 后仍能读取待确认大纲，完成后不再待确认', async () => {
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(path.join(os.tmpdir(), 'wlyd-outline-state-'))
  try {
    const pending = { stage: 'outline', runId: 'presales-runs/test', manifest, links, outline: suggestOutline(manifest, links) }
    await savePending({ session: { id: 'session-1' } }, pending)
    assert.deepEqual(await loadPending({ session: { id: 'session-1' } }), pending)
    assert.equal(await loadPending({ session: { id: 'session-2' } }), undefined)
    await savePending({ session: { id: 'session-1' } }, undefined)
    assert.equal(await loadPending({ session: { id: 'session-1' } }), undefined)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('合并章节的 P1 对应关系同时进入 HTML、Markdown 和 DOCX', async () => {
  const outline = suggestOutline(manifest, links)
  const solution = { title: '示例方案', meta: { company: '示例企业' }, theme: 'corporate',
    sections: sectionsFromOutline(manifest, outline, links), painSolutionLinks: links,
    generatedAt: '2026-10-09T00:00:00.000Z' }
  const html = renderHtml(solution, [])
  const markdown = renderMarkdown(solution, [])
  const docx = await renderDocx(solution, [])
  assert.match(html, /class="pair-map"/)
  assert.match(html, /资料分散/)
  assert.match(markdown, /\| P1 \| 资料分散 \| 统一资料管理 \|/)
  assert.equal(docx.subarray(0, 2).toString(), 'PK')
})

test('平台生成工具缺少确认大纲时拒绝启动', async () => {
  const definitions = new Map()
  apply({ tools: { register(definition) { definitions.set(definition.name, definition) } }, on() {}, inject() {} })
  const generate = definitions.get('wlyd_platform_generate')
  await assert.rejects(generate.execute({ project_id: 'project-1' }, { signal: new AbortController().signal }), /先让用户确认/)
  await assert.rejects(generate.execute({ project_id: 'project-1', outline_headings: ['背景', '背景'] }, { signal: new AbortController().signal }), /不重复/)
})

test('平台空章节保留确认的标题和位置，并标明缺少依据', () => {
  const solution = documentToSolution({ title: '方案', sections: [
    { position: 1, heading: '业务背景', body: '现状说明' },
    { position: 2, heading: '交付边界', body: '' },
  ] })
  assert.deepEqual(solution.sections.map(section => section.heading), ['业务背景', '交付边界'])
  assert.match(solution.sections[1].blocks[0].text, /待补充依据/)
})
