import assert from 'node:assert/strict'
import test from 'node:test'
import { renderHtml } from '../src/html.js'

test('长内容拆页且保留文字，标题层级与视口安全规则存在', () => {
  const solution = {
    title: '售前解决方案'.repeat(12), subtitle: '方案说明', theme: 'corporate',
    meta: { company: '示例企业', product: '示例产品' },
    sections: [{ kind: 'overview', heading: '项目背景', blocks: [
      { type: 'para', text: Array.from({ length: 15 }, (_, i) => `段落标记${i}。${'正文'.repeat(35)}`).join('') },
      { type: 'table', headers: ['编号', '痛点', '依据'], rows: Array.from({ length: 8 }, (_, i) => [`P${i}`, `痛点标记${i}`, `依据标记${i}${'路径'.repeat(80)}`]) },
    ] }],
  }
  const html = renderHtml(solution, [])
  assert.ok((html.match(/class="slide /g) ?? []).length > 5)
  for (let i = 0; i < 15; i++) assert.match(html, new RegExp(`段落标记${i}`))
  for (let i = 0; i < 8; i++) {
    assert.match(html, new RegExp(`痛点标记${i}`))
    assert.match(html, new RegExp(`依据标记${i}`))
  }
  assert.match(html, /\.slide\{[^}]*overflow:hidden/)
  assert.match(html, /\.table\{[^}]*table-layout:fixed/)
  assert.match(html, /\.divider h2\{[^}]*font-size:44px/)
  assert.match(html, /\.head h2\{[^}]*font-size:30px/)
  const cover = html.match(/<section class="slide cover">[\s\S]*?<\/section>/u)?.[0]
  assert.ok(cover)
  assert.doesNotMatch(cover, /内容结构|待人工复核|<ol>/u)
  assert.match(html, /<section class="slide toc-slide">/u)
  assert.match(html, /cover-geometry/u)
})

test('长段落不走大字主张页，渲染器提供有区别的稳定构图', () => {
  const solution = { title: '客户增长方案', theme: 'corporate', meta: {}, sections: [
    { kind: 'trends', heading: '增长链路的变化正在影响客户触达与销售跟进', blocks: [
      { type: 'para', text: '企业需要把内容投放、客户互动、销售线索和后续跟进放在同一条业务流程中观察。'.repeat(2) },
      { type: 'quote', text: '来源：growth.md\\n渠道触点与线索跟进记录应当可追溯' },
    ] },
    { kind: 'implementation', heading: '从内容到线索的业务流程', blocks: [
      { type: 'steps', items: ['整理内容', '选择渠道', '记录互动', '跟进线索'] },
    ] },
  ] }
  const html = renderHtml(solution, [])
  assert.doesNotMatch(html, /statement-slide[^>]*增长链路/u)
  assert.match(html, /layout-editorial-(?:left|right|led)/u)
  assert.match(html, /layout-process-(?:horizontal|right|staggered)/u)
  assert.match(html, /statement-center/u)
  assert.match(html, /editorial-led \.body/u)
})
