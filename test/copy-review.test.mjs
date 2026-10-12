import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { customerFacingSolution } from '../src/customer-copy.js'
import { renderHtml } from '../src/html.js'
import { externalizeSolution } from '../src/external-copy.js'
import { prepareSolution, registerDocument, loadDocument, saveDocument } from '../src/editor-store.js'

function sample() {
  return prepareSolution({ title: '客户方案', subtitle: '初次接触版 · 待复核', meta: {}, theme: 'corporate',
    sections: [{ kind: 'capabilities', heading: '统一整理资料', blocks: [
      { type: 'para', text: '待与贵方确认：团队在同一入口查看资料。' },
      { type: 'steps', items: Array.from({ length: 7 }, (_, i) => `${i === 6 ? '待核实：' : ''}步骤 ${i + 1} ${'依据具体业务组织内容。'.repeat(3)}`) },
      { type: 'table', headers: ['内容', '依据'], rows: Array.from({ length: 7 }, (_, i) => [`${i === 6 ? '待核实：' : ''}行 ${i + 1}`, '原文待与贵方确认']) },
      { type: 'quote', text: '来源：a.md\n原文待与贵方确认' },
    ] }], painSolutionLinks: [], generatedAt: new Date().toISOString() })
}

test('正文去除制作提示，校对原文与引证保留，跨页列表和表格定位原字段', () => {
  const source = sample()
  assert.equal(source.subtitle, '初次接触版')
  assert.equal(source.sections[0].blocks[0].text, '团队在同一入口查看资料。')
  assert.ok(source.copyReview.some(item => item.original.startsWith('待与贵方确认')))
  assert.equal(source.sections[0].blocks[2].rows[6][1], '原文待与贵方确认')
  assert.equal(source.sections[0].blocks[3].text, '来源：a.md\n原文待与贵方确认')
  const html = renderHtml(source, [])
  assert.match(html, /data-edit-path="blocks\/block-0-1\/items\/6"/u)
  assert.match(html, /data-edit-path="blocks\/block-0-2\/rows\/6\/0"/u)
  assert.match(html, /role="button" tabindex="0" data-edit-path="subtitle"/u)
  const external = renderHtml(externalizeSolution(source), [])
  assert.doesNotMatch(external, /data-edit-path=|待与贵方确认|待复核|待核实/u)
  const preview = renderHtml(externalizeSolution(source), [], { externalPreview: { editorId: source.editorId, revision: 1, policyVersion: '1' }, copyReview: source.copyReview })
  assert.match(preview, /data-edit-path="blocks\/block-0-0\/text"/u)
  assert.match(preview, /id="editor-panel"/u)
  assert.doesNotMatch(preview, /原文待与贵方确认/u)
})

test('保存文字、单独确认、再次修改三种状态正确，四格式同步且不自动发布知识', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wlyd-copy-review-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(directory, 'dsh')
  try {
    const source = sample()
    const base = path.join(directory, 'solution')
    await writeFile(`${base}.json`, JSON.stringify(source))
    await registerDocument(base, source.editorId)
    const fieldPath = 'blocks/block-0-0/text'
    await saveDocument(source.editorId, { baseRevision: 1, changes: [{ path: fieldPath, value: '团队可按项目查看资料。' }] })
    const edited = (await loadDocument(source.editorId)).solution
    assert.equal(edited.copyReview.find(item => item.path === fieldPath).status, 'pending')
    assert.match(await readFile(`${base}.html`, 'utf8'), /data-edit-path="blocks\/block-0-0\/text"/u)
    const confirmed = await saveDocument(source.editorId, { baseRevision: 2, changes: [], reviewedPaths: [fieldPath] })
    assert.equal(confirmed.knowledge.status, 'not_requested')
    const after = (await loadDocument(source.editorId)).solution
    assert.equal(after.copyReview.find(item => item.path === fieldPath).status, 'confirmed')
    assert.equal(after.copyReview.find(item => item.path === fieldPath).confirmedRevision, 3)
    assert.doesNotMatch(await readFile(`${base}.html`, 'utf8'), /data-edit-path="blocks\/block-0-0\/text"/u)
    assert.match(await readFile(`${base}.md`, 'utf8'), /团队可按项目查看资料。/u)
    const xml = await JSZip.loadAsync(await readFile(`${base}.docx`)).then(zip => zip.file('word/document.xml').async('string'))
    assert.match(xml, /团队可按项目查看资料。/u)
    await saveDocument(source.editorId, { baseRevision: 3, changes: [{ path: fieldPath, value: '团队可按项目和日期查看资料。' }] })
    const changed = (await loadDocument(source.editorId)).solution
    assert.equal(changed.copyReview.find(item => item.path === fieldPath).status, 'pending')
    assert.equal(changed.copyReview.find(item => item.path === fieldPath).confirmedAt, undefined)
    assert.equal(changed.sections[0].blocks[3].text, source.sections[0].blocks[3].text)
    await assert.rejects(saveDocument(source.editorId, { baseRevision: 3, changes: [], reviewedPaths: [fieldPath] }), { status: 409 })
    await assert.rejects(saveDocument(source.editorId, { baseRevision: 4, changes: [], reviewedPaths: ['blocks/missing/text'] }), { status: 400 })
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('纯占位只保存在校对记录，不能直接确认成完整正文', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'wlyd-copy-empty-'))
  const previousHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(directory, 'dsh')
  try {
    const source = prepareSolution({ title: '方案', meta: {}, theme: 'corporate', sections: [{ kind: 'boundary', heading: '实施', blocks: [
      { type: 'para', text: '待与贵方确认：本部分内容将在进一步沟通并核对资料后完善。' },
    ] }] })
    const base = path.join(directory, 'solution')
    await writeFile(`${base}.json`, JSON.stringify(source))
    await registerDocument(base, source.editorId)
    assert.equal(source.sections[0].blocks[0].text, '')
    assert.equal(customerFacingSolution(source).copyReview[0].placeholder, true)
    assert.match(renderHtml(source, []), /copy-review-empty/u)
    await assert.rejects(saveDocument(source.editorId, { baseRevision: 1, changes: [], reviewedPaths: ['blocks/block-0-0/text'] }), /先补充/u)
    await saveDocument(source.editorId, { baseRevision: 1, changes: [{ path: 'blocks/block-0-0/text', value: '先在一个业务团队开展试点。' }], reviewedPaths: ['blocks/block-0-0/text'] })
    const changed = (await loadDocument(source.editorId)).solution
    assert.equal(changed.copyReview[0].status, 'confirmed')
    assert.equal(changed.copyReview[0].placeholder, false)
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
  }
})

test('文案与样式是独立运行时 Skill，随插件注册', async () => {
  const { apply } = await import('../src/index.js')
  const skills = []
  apply({ on() {}, tools: { register() {} }, inject(names, setup) {
    if (names.includes('skills')) setup({ skills: { register(skill) { skills.push(skill) } } })
  } })
  assert.deepEqual(skills.map(skill => skill.name), ['wlyd-presales-copywriting', 'wlyd-presales-html-ppt'])
  assert.match(skills[0].content, /去.*|机械排比/u)
  assert.match(skills[0].content, /字段级校对/u)
  assert.match(skills[1].content, /设计/u)
})

test('图表数字的人工修改直接关联对应数据表单，原始证据不变', () => {
  const source = prepareSolution({ title: '数据示例', meta: {}, theme: 'corporate', sections: [{ kind: 'capabilities', heading: '季度数量', blocks: [
    { type: 'chart', chartType: 'bar', title: '季度数量', unit: '条', points: [{ label: '第一季度', value: 12 }, { label: '第二季度', value: 20 }],
      source: { path: 'a.md', quote: '第一季度 12 条，第二季度 20 条。' }, evidenceStatus: 'user_unverified' },
  ] }], copyReview: [{ path: 'blocks/block-0-0/chart/1/value', status: 'pending', value: '20', original: '18', reason: '人工修改，需要核对' }] })
  const html = renderHtml(source, [])
  assert.match(html, /data-edit-path="blocks\/block-0-0\/chart\/1\/value"/u)
  assert.equal(source.sections[0].blocks[0].source.quote, '第一季度 12 条，第二季度 20 条。')
  assert.match(html, /\[data-edit-path\]/u)
})
