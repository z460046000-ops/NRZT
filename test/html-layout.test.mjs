import assert from 'node:assert/strict'
import test from 'node:test'
import { renderHtml } from '../src/html.js'
import { externalizeSolution } from '../src/external-copy.js'
import { renderMarkdown } from '../src/markdown.js'
import { chapterWritingRule } from '../src/writing-rules.js'

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

test('同一份方案保持统一主题，章节不再各用一种底色，正文和来源保留', () => {
  const solution = { title: '增长方案', theme: 'corporate', meta: {},
    visualDesign: { version: 1, direction: 'redline', seed: 12 }, sections: [
      { kind: 'trends', heading: '市场背景', blocks: [{ type: 'para', text: '背景事实' },
        { type: 'quote', text: '来源：背景.md\n背景依据' }] },
      { kind: 'problem_solution', heading: '挑战与做法', blocks: [{ type: 'para', text: '对应做法' }] },
      { kind: 'capabilities', heading: '产品能力', blocks: [{ type: 'para', text: '能力事实' }] },
      { kind: 'implementation', heading: '实施路径', blocks: [{ type: 'para', text: '实施事实' }] },
    ] }
  const html = renderHtml(solution, [])
  assert.doesNotMatch(html, /tone-(?:amber|coral|sky|sage)/u)
  assert.match(html, /class="design-redline"/u)
  for (const text of ['背景事实', '背景依据', '对应做法', '能力事实', '实施事实']) assert.match(html, new RegExp(text))
  assert.equal(renderHtml(solution, []), html)
})

test('五个短步骤保持一页，长流程跨页样式与编号连续', () => {
  const base = { title: '营销动作', theme: 'elegant', meta: {},
    visualDesign: { version: 2, direction: 'paper', seed: 9 }, sections: [{ kind: 'implementation',
      heading: '营销动作与记录集中在同一现场', blocks: [{ type: 'steps',
        items: ['建词：确定关键词', '产出：形成解释内容', '审核：确认事实与合规', '分发：按渠道发布', '回流：返回内容库'] }] }] }
  const short = renderHtml(base, [])
  assert.equal((short.match(/class="flow"/gu) ?? []).length, 1)
  assert.match(short, /--step-count:5/u)
  assert.match(short, /<i>05<\/i>/u)
  const long = structuredClone(base)
  long.sections[0].blocks[0].items = Array.from({ length: 6 }, (_, i) => `第${i + 1}步：${'处理内容并核对资料。'.repeat(8)}`)
  const html = renderHtml(long, [])
  assert.ok((html.match(/layout-process-horizontal"/gu) ?? []).length >= 2)
  assert.doesNotMatch(html, /class="slide [^"]*layout-process-milestone/u)
  assert.match(html, /营销动作与记录集中在同一现场（续）/u)
  assert.match(html, /<i>06<\/i>/u)
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

test('长叙述提炼短标题和较小正文，来源隐藏后内容仍占满固定版心', () => {
  const solution = { title: 'CallWan 售前方案', theme: 'elegant', meta: {}, sections: [{
    kind: 'trends', heading: '增长环境与趋势：营销获客的变化', lead: '这一章说明背景。', blocks: [
      { type: 'para', text: 'CallWan 所处的获客环境正在整体变化：AI 改变客户发现品牌、内容供给和营销执行的方式。企业需要把内容、渠道、线索与数据连接起来。' },
      { type: 'quote', text: '来源：资料.md\nAI 改变客户发现品牌、内容供给和营销执行的方式。' },
      { type: 'para', text: '这些变化还要放在流量竞争与合规治理的背景里看：企业要在新入口被发现，也要让内容与执行满足治理要求。' },
      { type: 'quote', text: '来源：资料.md\n流量竞争与合规治理' },
    ],
  }] }
  const html = renderHtml(solution, [])
  const page = html.match(/<section class="slide content-slide layout-narrative">[\s\S]*?<\/section>/u)?.[0]
  assert.ok(page)
  assert.equal((page.match(/class="narrative-card"/gu) ?? []).length, 2)
  assert.match(page, /<h2 style="font-size:40px">增长环境与趋势<\/h2>/u)
  assert.match(page, /<h3>获客环境正在整体变化<\/h3>/u)
  assert.match(page, /<h3>流量竞争与合规治理<\/h3>/u)
  assert.match(page, /class="narrative-detail">AI 改变客户发现品牌/u)
  assert.equal((page.match(/class="source-note"/gu) ?? []).length, 2)
  assert.match(html, /\.layout-narrative \.narrative-card h3\{font-size:29px/u)
  assert.match(html, /\.layout-narrative \.narrative-detail\{margin-top:20px;max-width:920px;font-size:18px/u)
  assert.match(html, /\.sources-hidden \.layout-editorial-led \.body:has\(>\.source-note\)\{grid-template-columns:minmax\(0,1fr\)\}/u)
  assert.doesNotMatch(html, /margin:0 64px 76px/u)
  const external = renderHtml(externalizeSolution(solution), [])
  assert.match(external, /class="slide content-slide layout-narrative"/u)
  assert.doesNotMatch(external, /来源：资料\.md/u)
})

test('四处衔接问题展示为关键词和小字影响，隐藏来源后两侧版心一致', () => {
  const solution = { title: 'CallWan 售前方案', theme: 'elegant', meta: {}, sections: [{
    kind: 'problem_solution', heading: '典型结构性挑战：内容断层、发布割裂与线索跟进滞后',
    lead: '营销获客需要动作之间保持连续。线索、工具、内容和组织四个层面的衔接不足，通常会带来投入增加、响应放缓和复盘困难。',
    blocks: [
      { type: 'para', text: '这些问题背后是线索、工具、内容和组织四个层面的衔接不足，最终表现为投入增加、响应放缓和复盘困难。' },
      { type: 'quote', text: '来源：资料.md\n线索、工具、内容和组织四个层面的衔接不足' },
    ],
  }] }
  const html = renderHtml(solution, [])
  const page = html.match(/<section class="slide content-slide layout-challenge-summary">[\s\S]*?<\/section>/u)?.[0]
  assert.ok(page)
  assert.doesNotMatch(page, /class="lead"|class="para"/u)
  assert.match(page, /<strong role="listitem">线索<\/strong><strong role="listitem">工具<\/strong><strong role="listitem">内容<\/strong><strong role="listitem">组织<\/strong>/u)
  assert.match(page, /<p class="challenge-impact"><span>衔接不足带来的影响<\/span>投入增加、响应放缓和复盘困难<\/p>/u)
  assert.match(page, /class="source-note"/u)
  assert.match(html, /\.layout-challenge-summary \.body\{[^}]*padding-left:64px;padding-right:64px/u)
  assert.match(html, /\.sources-hidden \.layout-challenge-summary \.body\{grid-template-rows:minmax\(0,1fr\)\}/u)
  assert.match(html, /\.layout-challenge-summary \.challenge-terms strong\{[^}]*color:var\(--red\)/u)
})

test('长于一行的单句不再进入大字主张页', () => {
  const html = renderHtml({ title: '方案', theme: 'corporate', meta: {}, sections: [{
    kind: 'overview', heading: '说明', blocks: [
      { type: 'para', text: '团队需要在同一处查看需求、内容和发布记录，减少反复切换工具的时间，让后续交接能查到上一轮处理结果。' },
    ],
  }] }, [])
  assert.doesNotMatch(html, /class="slide content-slide statement-slide/u)
})

test('痛点深入讲解，方案章节才放一次对应做法', () => {
  const solution = { title: '售前方案', theme: 'corporate', meta: {}, sections: [
    { kind: 'problem_solution', heading: '现状与挑战', lead: '两个常见问题', blocks: [
      { type: 'para', text: '线索分散：评论和表单的互动记录落在不同位置，销售同事需要分别查看才能知道上次是谁跟进。' },
      { type: 'para', text: '内容重复：同一产品介绍每次发布都重新整理，版本和适用范围难以核对，容易重复劳动。' },
    ] },
    { kind: 'architecture', heading: '总体方案', blocks: [
      { type: 'para', text: '将互动统一记录，再按负责人分配跟进；内容统一维护版本，供渠道发布时选用。' },
    ] },
  ], painSolutionLinks: [{ id: 'P1', pain: '线索分散', solution: '统一记录互动并分配跟进', painBasis: 'explicit',
    painEvidence: { path: '资料.md', quote: '线索分散' }, solutionEvidence: { path: '资料.md', quote: '统一记录互动' } }] }
  const html = renderHtml(solution, [])
  const painStart = html.indexOf('现状与挑战')
  const answer = html.indexOf('统一记录互动并分配跟进')
  assert.ok(painStart >= 0 && answer > painStart)
  assert.equal((html.match(/统一记录互动并分配跟进/gu) ?? []).length, 1)
  assert.match(html, /<h3>线索分散<\/h3>/u)
  assert.match(html, /class="narrative-detail"/u)
  const markdown = renderMarkdown(solution, [])
  assert.ok(markdown.indexOf('## 2. 总体方案') < markdown.indexOf('| P1 |'))
  assert.equal((markdown.match(/\| P1 \|/gu) ?? []).length, 1)
  assert.match(chapterWritingRule({ heading: '现状与挑战', topics: ['problem_solution'] }), /只讲有依据的问题/u)
  assert.match(chapterWritingRule({ heading: '总体方案', topics: ['architecture'] }), /主要篇幅/u)
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
