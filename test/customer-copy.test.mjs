import assert from 'node:assert/strict'
import test from 'node:test'
import { customerFacingSolution, hasInternalCopy } from '../src/customer-copy.js'
import { renderHtml } from '../src/html.js'
import { renderMarkdown } from '../src/markdown.js'

test('面客话语统一写入源稿，原始引文与来源保持不变', () => {
  const solution = {
    title: 'CallWan 方案初稿', subtitle: '客户增长方案', meta: { company: '示例企业', version: '方案初稿' },
    theme: 'corporate', generatedAt: '2026-10-09T00:00:00.000Z',
    sections: [{ kind: 'capabilities', heading: '产品能力', blocks: [
      { type: 'para', text: '本章尚未形成可核对的客户表述，请根据所列资料复核并补充；原文不会直接作为方案正文。' },
      { type: 'quote', text: '来源：materials/a.md\n原文写着“方案初稿”。' },
    ] }],
    painSolutionLinks: [{ id: 'P1', pain: '资料推断·待确认：协作流程较长', solution: '统一管理资料',
      painEvidence: { path: 'materials/a.md', quote: '原文写着“方案初稿”。' },
      solutionEvidence: { path: 'materials/a.md', quote: '统一管理资料' } }],
  }
  const copy = customerFacingSolution(solution)
  assert.equal(copy.sections[0].blocks[0].text, '')
  assert.ok(copy.copyReview.some(item => item.path === 'blocks/block-0-0/text' && item.placeholder && item.original === solution.sections[0].blocks[0].text))
  assert.equal(copy.sections[0].blocks[1].text, solution.sections[0].blocks[1].text)
  assert.equal(copy.painSolutionLinks[0].painEvidence.quote, solution.painSolutionLinks[0].painEvidence.quote)
  assert.equal(copy.painSolutionLinks[0].pain, '典型挑战：协作流程较长')
  assert.equal(copy.title, 'CallWan 解决方案')
  assert.equal(solution.title, 'CallWan 方案初稿')
  const html = renderHtml(copy, [])
  const markdown = renderMarkdown(copy, [])
  assert.doesNotMatch(html, /待与贵方确认/u)
  assert.doesNotMatch(markdown, /待与贵方确认/u)
  assert.equal(hasInternalCopy(copy.sections[0].blocks[0].text), false)
})
