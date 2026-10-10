import assert from 'node:assert/strict'
import test from 'node:test'
import JSZip from 'jszip'
import { normalizeChart } from '../src/chart.js'
import { renderHtml } from '../src/html.js'
import { renderMarkdown } from '../src/markdown.js'
import { renderDocx } from '../src/docx.js'
import { externalizeSolution, visibleExternalText } from '../src/external-copy.js'

const sourceText = '2024年线索 12 条；2025年线索 20 条。'
const chart = normalizeChart({ type: 'chart', chartType: 'line', title: '线索变化', unit: '条',
  points: [{ label: '2024年', value: 12 }, { label: '2025年', value: 20 }],
  source: { path: 'a.md', quote: sourceText } }, { sourceText })

test('图表只接受同一材料原文中的类别与数值，趋势图须有时间', () => {
  assert.equal(chart.evidenceStatus, 'verified')
  assert.throws(() => normalizeChart({ ...chart, points: [{ label: '2024年', value: 12 }, { label: '2025年', value: 80 }] }, { sourceText }), /未出现在引文/u)
  assert.throws(() => normalizeChart({ ...chart, points: [{ label: '2024年', value: 20 }, { label: '2025年', value: 12 }] }, { sourceText }), /未出现在引文/u)
  assert.throws(() => normalizeChart({ ...chart, source: { path: 'a.md', quote: '2024年线索 12 条；2025年线索 80 条。' } }, { sourceText }), /不在对应材料/u)
  assert.throws(() => normalizeChart({ ...chart, points: [{ label: 'A', value: 12 }, { label: 'B', value: 20 }] }, { sourceText }), /未出现在引文|时间标识/u)
  assert.throws(() => normalizeChart({ ...chart, unit: '万元' }, { sourceText }), /未出现在引文/u)
  assert.throws(() => normalizeChart({ ...chart, points: [...chart.points].reverse() }, { sourceText }), /按顺序排列/u)
  assert.equal(normalizeChart({ ...chart,
    points: [{ label: '2024年1月', value: 12 }, { label: '2024年2月', value: 20 }],
    source: { path: 'a.md', quote: '2024年1月线索 12 条；2024年2月线索 20 条。' },
  }).points.length, 2)
})

test('图表在 HTML、Markdown、Word 保留相同数值与来源', async () => {
  const solution = { title: '线索方案', theme: 'corporate', meta: { company: '示例企业' },
    sections: [{ kind: 'trends', heading: '业务趋势', blocks: [chart] }] }
  const html = renderHtml(solution, [])
  const md = renderMarkdown(solution, [])
  const zip = await JSZip.loadAsync(await renderDocx(solution, []))
  const word = await zip.file('word/document.xml').async('string')
  for (const content of [html, md, word]) {
    assert.match(content, /线索变化/u)
    assert.match(content, /2024年/u)
    assert.match(content, /2025年/u)
    assert.match(content, /a\.md/u)
  }
  assert.match(html, /<svg[^>]+role="img"/u)
  assert.match(html, /layout-chart-wide/u)
})

test('外部稿保留图表数值但不泄露内部文件路径和引文', async () => {
  const solution = { title: '线索方案', theme: 'corporate', meta: { company: '示例企业' },
    sections: [{ kind: 'trends', heading: '业务趋势', blocks: [chart] }] }
  const external = externalizeSolution(solution)
  assert.equal(external.sections[0].blocks[0].source, undefined)
  const html = renderHtml(external, [])
  const md = renderMarkdown(external, [])
  const zip = await JSZip.loadAsync(await renderDocx(external, []))
  const word = await zip.file('word/document.xml').async('string')
  for (const content of [html, md, word, visibleExternalText(external)]) {
    assert.match(content, /2024年/u)
    assert.match(content, /2025年/u)
    assert.doesNotMatch(content, /a\.md|2024年线索 12 条/u)
  }
})

test('同类能力页使用多种构图且重渲染保持稳定', () => {
  const solution = { title: '售前业务方案', theme: 'corporate', meta: {},
    sections: Array.from({ length: 8 }, (_, index) => ({ kind: 'capabilities', heading: `能力 ${index + 1}`,
      blocks: [{ type: 'bullets', items: ['资料管理', '协作交付'] }] })) }
  const html = renderHtml(solution, [])
  const layouts = [...html.matchAll(/class="slide content-slide[^"\n]*layout-(capability-left|capability-right|capability-band)"/gu)]
    .map(match => match[1])
  assert.equal(layouts.length, 8)
  assert.ok(new Set(layouts).size >= 3)
  assert.ok(layouts.every((layout, index) => index === 0 || layout !== layouts[index - 1]))
  assert.equal(renderHtml(solution, []), html)
})
