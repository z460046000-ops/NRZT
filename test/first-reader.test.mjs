import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { addImageSuggestions, firstReaderWarnings } from '../src/first-reader.js'
import { externalizeSolution } from '../src/external-copy.js'
import { renderHtml } from '../src/html.js'
import { renderMarkdown } from '../src/markdown.js'
import { renderDocx } from '../src/docx.js'
import { loadDocument, prepareSolution, registerDocument, saveDocument } from '../src/editor-store.js'

const source = () => ({ title: 'CallWan 售前方案', subtitle: '围绕业务形成持续运营。',
  theme: 'elegant', meta: { product: 'CallWan' }, painSolutionLinks: [], sections: [
    { id: 'architecture', kind: 'architecture', heading: '从内容到线索的工作流程',
      lead: '团队先整理内容，再记录线索。', blocks: [
        { id: 'a1', type: 'para', text: '市场团队整理产品资料和客户问题。' },
        { id: 'a2', type: 'quote', text: '来源：产品.md\n市场团队整理产品资料和客户问题。' },
        { id: 'a3', type: 'steps', items: ['整理产品资料', '记录客户互动'] },
      ] },
    { id: 'capabilities', kind: 'capabilities', heading: '线索跟进能力',
      lead: '销售查看线索来源和处理状态。', blocks: [
        { id: 'c1', type: 'para', text: '销售查看线索来源和处理状态。' },
        { id: 'c2', type: 'quote', text: '来源：能力.md\n销售查看线索来源和处理状态。' },
      ] },
    { id: 'service', kind: 'service', heading: '实施支持', blocks: [
      { id: 's1', type: 'para', text: '项目团队配置流程。' },
    ] },
  ] })

test('按已写内容给内部稿两个不同用途的图片位置，重复处理不增页', async () => {
  const draft = addImageSuggestions(source())
  addImageSuggestions(draft)
  const slots = draft.sections.flatMap(section => section.blocks.filter(block => block.visualSuggestion))
  assert.equal(slots.length, 2)
  assert.deepEqual(slots.map(block => block.visualSuggestion.kind), ['diagram', 'screenshot'])
  assert.match(slots[1].visualSuggestion.focus, /线索/u)
  const html = renderHtml(draft, [])
  const markdown = renderMarkdown(draft, [])
  const word = await JSZip.loadAsync(await renderDocx(draft, []))
  const xml = await word.file('word/document.xml').async('string')
  for (const output of [html, markdown, xml]) assert.match(output, /内部配图位置/u)
  assert.match(html, /市场团队整理产品资料和客户问题/u)
  assert.match(html, /线索跟进能力/u)
})

test('无真实图片时客户版省略占位，已有图片或无正文时不加占位', () => {
  const draft = addImageSuggestions(source())
  const external = externalizeSolution(draft)
  assert.equal(external.sections.flatMap(section => section.blocks).some(block => block.type === 'image'), false)
  for (const output of [renderHtml(external, []), renderMarkdown(external, [])]) {
    assert.doesNotMatch(output, /内部配图位置|请上传真实/u)
  }
  const existing = source()
  existing.sections[1].blocks.push({ id: 'real', type: 'image', path: 'assets/real.png', caption: '产品截图' })
  existing.sections[0].blocks = []
  addImageSuggestions(existing)
  assert.equal(existing.sections.flatMap(section => section.blocks).some(block => block.visualSuggestion), false)
})

test('编辑器能把建议位置替换为真实图片，并同步四种格式', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-image-suggestion-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(dir, 'dsh')
  try {
    const base = path.join(dir, 'solution')
    const solution = prepareSolution(addImageSuggestions(source()))
    await writeFile(`${base}.json`, JSON.stringify(solution))
    await registerDocument(base, solution.editorId)
    const slot = solution.sections.flatMap(section => section.blocks).find(block => block.visualSuggestion)
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    const result = await saveDocument(solution.editorId, {
      baseRevision: 1, changes: [], replacements: [{ blockId: slot.id, data: image.toString('base64') }],
      knowledge: { factChange: false },
    })
    assert.equal(result.revision, 2)
    const saved = (await loadDocument(solution.editorId)).solution
    const actual = saved.sections.flatMap(section => section.blocks).find(block => block.id === slot.id)
    assert.match(actual.path, /solution-assets\/.+\.png$/u)
    assert.deepEqual(await readFile(path.join(dir, actual.path)), image)
    assert.match(await readFile(`${base}.html`, 'utf8'), /<img src="\.\/solution-assets\//u)
    assert.equal((await readFile(`${base}.html`, 'utf8')).match(/内部配图位置/gmu)?.length, 1)
    assert.match(await readFile(`${base}.md`, 'utf8'), /!\[/u)
    assert.equal((await readFile(`${base}.docx`))[0], 0x50)
    const publicName = 'assets/customer-screen.png'
    const external = externalizeSolution(saved, new Map([[actual.path, publicName]]))
    assert.equal(external.sections.flatMap(section => section.blocks).find(block => block.id === slot.id)?.path, publicName)
    assert.equal(external.sections.flatMap(section => section.blocks).filter(block => block.type === 'image').length, 1)
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('陌生读者检查定位抽象封面和章节导语，但不阻断正文交付', () => {
  const draft = source()
  draft.sections[0].lead = '增长系统帮助企业形成持续运营。'
  assert.equal(firstReaderWarnings(draft).length, 2)
  draft.subtitle = 'CallWan 是供营销团队整理内容并查看线索的工作台。'
  draft.sections[0].lead = '团队整理内容后可查看互动线索。'
  assert.deepEqual(firstReaderWarnings(draft), [])
})
