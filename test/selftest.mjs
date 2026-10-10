/**
 * 插件自测:不依赖 harness,直接验证提取器(docx/pdf/pptx/zip)与三种渲染器。
 * 运行:node test/selftest.mjs <临时目录>
 */
import { mkdir, writeFile, readFile } from 'node:fs/promises'
import path from 'node:path'
import JSZip from 'jszip'
import assert from 'node:assert/strict'
import { Document, Packer, Paragraph } from 'docx'
import { renderMarkdown } from '../src/markdown.js'
import { renderHtml } from '../src/html.js'
import { renderDocx } from '../src/docx.js'

const dir = process.argv[2] ?? '/tmp/wlyd-selftest'
await mkdir(path.join(dir, 'materials'), { recursive: true })

// ── 构造样例材料 ──────────────────────────────────────────────
const doc = new Document({ sections: [{ children: [
  new Paragraph({ text: '万联智达是一家专注内容智能的企业。' }),
  new Paragraph({ text: '旗舰产品 InsightFlow 服务 200+ 客户。' }),
] }] })
const docxBuffer = await Packer.toBuffer(doc)
await writeFile(path.join(dir, 'materials', '公司简介.docx'), docxBuffer)

/** 构造带正确 xref 偏移的极简单页 PDF。 */
function makePdf(lines) {
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>',
    null,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ]
  const escapePdf = s => s.replaceAll('(', '\\(').replaceAll(')', '\\)')
  const content = lines.map((line, i) => `BT /F1 ${i === 0 ? 16 : 11} Tf 72 ${720 - i * 20} Td (${escapePdf(line)}) Tj ET`).join('\n')
  objects[3] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`

  let pdf = '%PDF-1.4\n'
  const offsets = [0]
  for (let i = 0; i < objects.length; i++) {
    offsets.push(pdf.length)
    pdf += `${i + 1} 0 obj ${objects[i]} endobj\n`
  }
  const xrefStart = pdf.length
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  for (let i = 1; i <= objects.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`
  }
  pdf += `trailer << /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`
  return pdf
}

const pdf = makePdf([
  'WanlianYida Whitepaper: InsightFlow Platform',
  'Content intelligence for enterprise sales.',
])
await writeFile(path.join(dir, 'materials', '白皮书节选.pdf'), pdf, 'latin1')

const pptx = new JSZip()
pptx.file('[Content_Types].xml', '<?xml version="1.0"?><Types/>')
pptx.file('ppt/slides/slide1.xml', '<p:sld><a:t>InsightFlow 产品概述</a:t><a:t>一站式内容中台</a:t></p:sld>')
pptx.file('ppt/slides/slide2.xml', '<p:sld><a:t>核心价值:快、准、稳</a:t></p:sld>')
await writeFile(path.join(dir, 'materials', '宣讲稿.pptx'), await pptx.generateAsync({ type: 'nodebuffer' }))

const pkg = new JSZip()
pkg.file('产品手册.md', '# InsightFlow\n面向售前团队的内容生产平台。')
pkg.file('截图.png', Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
await writeFile(path.join(dir, 'materials', '产品包.zip'), await pkg.generateAsync({ type: 'nodebuffer' }))

// 1x1 PNG 截图
await writeFile(path.join(dir, 'materials', '首页截图.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'))
await writeFile(path.join(dir, 'materials', '产品介绍.md'), '# InsightFlow\n\n面向售前团队的 AI 内容生产平台,支持材料分析与方案生成。\n')

// ── 验证提取器(经 extractBinaryText 的依赖直测) ───────────────
const mammoth = (await import('mammoth')).default
const { PDFParse } = await import('pdf-parse')

const docxText = (await mammoth.extractRawText({ buffer: docxBuffer })).value
assert.ok(docxText.includes('万联智达'), `docx 提取失败:${docxText}`)
console.log('✓ docx 提取:', docxText.replace(/\s+/g, ' ').slice(0, 60))

const pdfParser = new PDFParse({ data: await readFile(path.join(dir, 'materials', '白皮书节选.pdf')) })
const pdfResult = await pdfParser.getText()
pdfParser.destroy()
const pdfText = pdfResult.text ?? ''
assert.ok(pdfText.includes('Whitepaper') || pdfText.includes('Content intelligence'), `pdf 提取失败:${pdfText}`)
console.log('✓ pdf 提取:', pdfText.replace(/\s+/g, ' ').slice(0, 60))

// pptx 提取(与 ingest.extractBinaryText 相同的正则路径)
const pptxBuffer = await readFile(path.join(dir, 'materials', '宣讲稿.pptx'))
const pptxZip = await JSZip.loadAsync(pptxBuffer)
const slideXml = await pptxZip.files['ppt/slides/slide1.xml'].async('string')
assert.ok(slideXml.includes('InsightFlow 产品概述'), 'pptx 夹具异常')
console.log('✓ pptx 夹具就绪:', [...slideXml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1]).join('/'))

// ── 验证渲染器 ────────────────────────────────────────────────
const solution = {
  title: 'InsightFlow 售前解决方案',
  subtitle: '售前内容生产一站式平台',
  meta: { company: '万联智达', product: 'InsightFlow', version: 'V2.1', date: '2026-10', contact: 'solution@wlyd.example' },
  theme: 'corporate',
  generatedAt: new Date().toISOString(),
  sections: [
    { kind: 'trends', heading: '趋势与背景', lead: '内容生产正在被 AI 重塑。', blocks: [
      { type: 'para', text: '生成式 AI 重构内容供给,售前材料生产进入智能供应链时代。' },
      { type: 'metrics', items: [{ label: '方案产出提速', value: '5x' }, { label: '覆盖行业', value: '12' }] },
    ] },
    { kind: 'pains', heading: '客户痛点', lead: '四类结构性问题影响获客效率。', blocks: [
      { type: 'bullets', items: ['材料散落在各处,版本不清', '方案制作周期长'] },
    ] },
    { kind: 'solution', heading: '解决方案', blocks: [
      { type: 'para', text: '以材料知识库为底座,AI 提炼生成标准化销售材料。' },
    ] },
    { kind: 'architecture', heading: '产品架构', blocks: [
      { type: 'table', headers: ['层', '组成'], rows: [['平台层', '内容中台'], ['能力层', 'AI 分析与生成'], ['场景层', '售前方案/折页/海报'], ['集成层', '企业微信/CRM']] },
    ] },
    { kind: 'capabilities', heading: '核心能力', blocks: [
      { type: 'bullets', items: ['自动材料分析', '人机协同修改,人工检查点放行'] },
    ] },
    { kind: 'scenarios', heading: '场景:投标方案', blocks: [
      { type: 'table', headers: ['场景', '痛点', '价值'], rows: [['投标', '材料散乱', '一键成稿']] },
      { type: 'image', path: 'materials/首页截图.png', caption: '平台首页' },
    ] },
    { kind: 'implementation', heading: '实施路径', lead: '周期 4-8 周,先跑通再复制。', blocks: [
      { type: 'steps', items: ['现状诊断(1-2 周)', '试点配置(2-4 周)', '复制扩展(1-2 周)'] },
    ] },
    { kind: 'service', heading: '服务保障', blocks: [
      { type: 'bullets', items: ['交付支持与培训', '运维与版本升级'] },
    ] },
    { kind: 'company', heading: '公司介绍', blocks: [
      { type: 'para', text: '万联智达专注内容智能,服务 200+ 企业客户。' },
    ] },
    { kind: 'boundary', heading: '合作与边界', blocks: [
      { type: 'quote', text: '客户案例数据以实际合同范围为准。' },
    ] },
  ],
}
const assets = [{ sourcePath: 'materials/首页截图.png', fileName: 'solution-assets/首页截图.png', buffer: await readFile(path.join(dir, 'materials', '首页截图.png')), caption: '平台首页' }]

const md = renderMarkdown(solution, assets)
assert.ok(md.includes('# InsightFlow 售前解决方案') && md.includes('| 场景 | 痛点 | 价值 |') && md.includes('> 内容生产正在被 AI 重塑。'))
await writeFile(path.join(dir, 'selftest.md'), md)
console.log('✓ markdown 渲染:', `${md.length} 字符`)

const html = renderHtml(solution, assets)
assert.ok(html.includes('<!DOCTYPE html>') && html.includes('solution-assets/'), 'html 基本结构')
assert.ok(html.includes('class="slide cover"') && html.includes('class="toc"'), '封面+目录页')
assert.ok((html.match(/class="slide divider(?: divider-light)?"/g) ?? []).length === 10, '10 个篇章页')
assert.ok(html.includes('期待与您共同推进下一步'), '结尾页')
assert.ok(html.includes('@page{size:1280px 720px'), '打印页面尺寸')
assert.ok(!html.includes('待人工复核'))
await writeFile(path.join(dir, 'selftest.html'), html)
const slideCount = (html.match(/<section class="slide/g) ?? []).length
console.log('✓ html 渲染:', `${html.length} 字符,${slideCount} 页幻灯片`)

const docxOut = await renderDocx(solution, assets)
assert.ok(docxOut.length > 5000 && docxOut[0] === 0x50 && docxOut[1] === 0x4b)
await writeFile(path.join(dir, 'selftest.docx'), docxOut)
console.log('✓ docx 渲染:', `${docxOut.length} 字节 (PK 头正确)`)

console.log('\n全部自测通过。样例材料在', path.join(dir, 'materials'))

// ── 平台映射(platform.js) ────────────────────────────────────
const { mdToBlocks, guessKind, documentToSolution } = await import('../src/platform.js')

const blocks = mdToBlocks('产品定位：InsightFlow 是 AI 平台 [1]。\n\n- **要点一**：有依据\n- 要点二：也有依据\n\n1. 先诊断\n2. 再实施\n\n| 层 | 组成 |\n| --- | --- |\n| 平台层 | 中台 |')
assert.equal(blocks.length, 4, `应拆出 4 块,实际 ${blocks.length}`)
assert.equal(blocks[0].type, 'para')
assert.ok(!blocks[1].items[0].includes('**'), '应去掉 ** 加粗记号')
assert.equal(blocks[2].type, 'steps')
assert.deepEqual(blocks[3].headers, ['层', '组成'])
console.log('✓ mdToBlocks:', blocks.map(b => b.type).join('/'))

assert.equal(guessKind('客户痛点分析'), 'pains')
assert.equal(guessKind('实施路径：四阶段'), 'implementation')
assert.equal(guessKind('完全无关'), 'custom')
console.log('✓ guessKind: pains/implementation/custom')

const sol = documentToSolution({
  title: '平台方案', sections: [
    { position: 1, heading: '趋势与背景', body: '行业在变。\n\n- 依据A\n- 依据B' },
    { position: 2, heading: '合作与边界', body: '待补充依据' },
  ],
}, { theme: 'corporate' })
assert.equal(sol.sections.length, 2)
assert.equal(sol.sections[0].kind, 'trends')
assert.equal(sol.sections[1].blocks[0].text, '待补充依据', '占位章节原样保留')
const md2 = renderMarkdown(sol, [])
assert.ok(md2.includes('# 平台方案') && md2.includes('待补充依据'))
const html2 = renderHtml(sol, [])
assert.ok(html2.includes('class="slide cover"'))
const docx2 = await renderDocx(sol, [])
assert.ok(docx2[0] === 0x50 && docx2[1] === 0x4b)
console.log('✓ documentToSolution → 三渲染器直通:md/html/docx 均可渲染')
