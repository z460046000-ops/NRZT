import assert from 'node:assert/strict'
import test from 'node:test'
import { renderHtml } from '../src/html.js'
import { externalizeSolution } from '../src/external-copy.js'

function contrastRatio(first, second) {
  const luminance = value => value.match(/[\da-f]{2}/giu)
    .map(channel => parseInt(channel, 16) / 255)
    .map(channel => channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4)
    .reduce((sum, channel, index) => sum + channel * [0.2126, 0.7152, 0.0722][index], 0)
  const [lighter, darker] = [luminance(first), luminance(second)].sort((a, b) => b - a)
  return (lighter + 0.05) / (darker + 0.05)
}

test('随包主题的常规文字和强调文字具有可读对比度，翻页控件保留焦点和点击区域', () => {
  for (const theme of ['corporate', 'dark', 'elegant']) {
    const html = renderHtml({ title: '售前方案', theme, meta: {}, sections: [] }, [])
    const token = name => html.match(new RegExp(`--${name}:(#[\\da-f]{6})`, 'iu'))?.[1]
    for (const name of ['ink', 'ink2', 'ink3', 'red', 'blue-dark']) {
      assert.ok(contrastRatio(token(name), token('slide')) >= 4.5, `${theme} ${name} 对比度不足`)
    }
    assert.match(html, /\.deck-controls button\{min-height:44px/u)
    assert.match(html, /\.deck-controls button:focus-visible\{outline:3px/u)
  }
})

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

test('外部稿将已核对的痛点方案绘成关系图，且不显示内部证据', () => {
  const solution = { title: '客户增长方案', theme: 'corporate', meta: { product: '示例产品' }, sections: [
    { kind: 'problem_solution', heading: '问题与做法', blocks: [] },
  ], painSolutionLinks: [
    { id: 'P1', pain: '触达记录分散', solution: '统一记录客户触达', painBasis: 'explicit',
      painEvidence: { path: 'private.md', quote: '触达记录分散' }, solutionEvidence: { path: 'private.md', quote: '统一记录客户触达' } },
    { id: 'P2', pain: '线索跟进不连贯', solution: '按阶段管理线索', painBasis: 'inferred',
      painEvidence: { path: 'private.md', quote: '线索跟进' }, solutionEvidence: { path: 'private.md', quote: '按阶段管理线索' } },
  ] }
  const html = renderHtml(externalizeSolution(solution), [])
  assert.match(html, /class="slide relation-slide/u)
  assert.equal((html.match(/class="relation-row"/gu) ?? []).length, 2)
  assert.match(html, /触达记录分散/u)
  assert.match(html, /统一记录客户触达/u)
  assert.doesNotMatch(html, /private\.md|材料依据：/u)
  assert.equal(renderHtml(externalizeSolution(solution), []), html)
})

test('短步骤成为可读流程图，不同章节使用不同语义图标', () => {
  const solution = { title: '客户增长方案', theme: 'corporate', meta: {}, sections: [
    { kind: 'trends', heading: '业务变化', blocks: [{ type: 'para', text: '营销动作正在变化。' }] },
    { kind: 'implementation', heading: '实施路径', blocks: [
      { type: 'steps', items: ['准备内容', '选择渠道', '记录线索', '复盘数据'] },
    ] },
  ] }
  const html = renderHtml(solution, [])
  assert.match(html, /layout-process-track/u)
  assert.match(html, /class="step-icon"/u)
  assert.match(html, /class="divider-symbol"/u)
  assert.match(html, /M3 18h18/u)
  assert.match(html, /M6 18h6/u)
  assert.equal((html.match(/class="step-icon"/gu) ?? []).length, 4)
})

test('简短能力组绘制能力关系图，长要点保持可读列表', () => {
  const solution = { title: '客户增长方案', theme: 'corporate', meta: {}, sections: [
    { kind: 'capabilities', heading: '能力组合', blocks: [
      { type: 'bullets', items: ['整理内容', '连接渠道', '跟进线索', '分析数据'] },
    ] },
    { kind: 'capabilities', heading: '能力说明', blocks: [
      { type: 'bullets', items: ['这是一条很长的能力说明。'.repeat(12), '另一条说明'] },
    ] },
  ] }
  const html = renderHtml(solution, [])
  assert.match(html, /class="capability-map"/u)
  assert.equal((html.match(/class="map-node"/gu) ?? []).length, 4)
  assert.match(html, /class="bullets"/u)
})

test('常见纯文字材料也形成不同画面，单步骤不再伪装成多步流程', () => {
  const solution = { title: '客户增长方案', theme: 'corporate', meta: {}, sections: [
    { kind: 'trends', heading: '行业变化', blocks: [
      { type: 'para', text: '业务动作需要连续。'.repeat(7) },
      { type: 'bullets', items: ['线索、工具、内容、组织需要衔接', '投入增加、响应放缓和复盘困难是常见后果'] },
    ] },
    { kind: 'problem_solution', heading: '问题与做法', blocks: [
      { type: 'para', text: '常见挑战需要逐一回应。' },
      { type: 'bullets', items: Array.from({ length: 3 }, (_, i) => `第${i + 1}项挑战与对应做法。${'说明'.repeat(35)}`) },
    ] },
    { kind: 'capabilities', heading: '产品说明', blocks: [
      { type: 'para', text: '第一段说明内容和产品关系。' },
      { type: 'para', text: '第二段说明知识环节。' },
      { type: 'para', text: '第三段说明执行环节。' },
    ] },
    { kind: 'implementation', heading: '最后一步', blocks: [
      { type: 'steps', items: ['复盘并更新下一轮计划'] },
    ] },
  ] }
  const html = renderHtml(solution, [])
  assert.match(html, /layout-editorial-feature/u)
  assert.match(html, /layout-editorial-band/u)
  assert.match(html, /layout-editorial-columns/u)
  assert.match(html, /layout-process-milestone/u)
  assert.doesNotMatch(html, /statement-slide[^>]*layout-editorial-band/u)
  assert.match(html, /\.layout-process-track\{background:var\(--feature-bg\)/u)
  assert.match(html, /\.relation-alternate\{background:var\(--feature-bg\)/u)
  assert.equal(renderHtml(solution, []), html)
})
