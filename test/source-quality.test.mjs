import assert from 'node:assert/strict'
import test from 'node:test'
import { cleanMaterialText, isReadableProse } from '../src/source-quality.js'
import { composeSections } from '../src/content.js'
import { ingestMaterials } from '../src/ingest.js'
import { mdToBlocks } from '../src/platform.js'
import { apply } from '../src/index.js'
import { mkdir, mkdtemp, readFile, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

test('HTML 样式和 PDF 损坏字符不进入可读语料', () => {
  const html = '<!doctype html><html><head><style>body{display:flex}.card{font-size:18px}</style>'
    + '<script>const secret = 1</script></head><body><h1>CallWan 营销方案</h1>'
    + '<p>提供营销线索管理与客户触达。</p></body></html>'
  assert.equal(cleanMaterialText(html, 'brochure.html'), 'CallWan 营销方案\n提供营销线索管理与客户触达。')
  assert.equal(cleanMaterialText('<html><body><p>从<span>内容生产</span>到<strong>线索转化</strong>，形成增长闭环。</p></body></html>', 'deck.md'),
    '从 内容生产 到 线索转化 ，形成增长闭环。')
  assert.equal(cleanMaterialText('�䄀䈀乱码\nCallWan 提供线索管理。', 'scan.pdf'), 'CallWan 提供线索管理。')
  assert.equal(cleanMaterialText('䄀䈀䌀䐀䔀\nCallWan 提供线索管理。', 'scan.pdf'), 'CallWan 提供线索管理。')
  assert.equal(isReadableProse('body{display:flex;font-size:18px}'), false)
})

test('HTML 文件经过导入后，清单和语料只保留可读正文', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-html-clean-'))
  await writeFile(path.join(cwd, 'brochure.html'),
    '<html><style>.card{display:flex;font-size:18px}</style><body><h1>CallWan 营销方案</h1><p>提供线索管理。</p></body></html>')
  const fs = {
    resolve: async (file, options) => path.resolve(options.cwd, file),
    processPath: target => target,
    stat: async target => { const info = await stat(target); return { type: 'file', size: info.size } },
    readText: target => readFile(target, 'utf8'),
    writeText: async (target, content) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return { version: 'test' } },
  }
  const result = await ingestMaterials({ fs, emit() {} }, { path: 'brochure.html', output_dir: 'analysis' },
    { signal: new AbortController().signal, agent: { session: { header: { cwd } } } })
  assert.equal(result.counts.extracted, 1)
  assert.match(result.files[0].excerpt, /CallWan 营销方案/)
  const corpus = await readFile(path.join(cwd, 'analysis/corpus.md'), 'utf8')
  assert.equal(corpus.includes('display:flex'), false)
  assert.match(corpus, /提供线索管理/)
})

test('长 HTML 先清理样式再截断，保留正文末尾的业务事实', async () => {
  const cwd = await mkdtemp(path.join(os.tmpdir(), 'wlyd-html-long-'))
  const css = '.card{display:flex;font-size:18px;padding:24px}'.repeat(500)
  await writeFile(path.join(cwd, 'brochure.html'),
    `<html><head><style>${css}</style></head><body><h1>CallWan 营销方案</h1><p>支持线索分层、客户触达和转化跟踪。</p></body></html>`)
  const fs = {
    resolve: async (file, options) => path.resolve(options.cwd, file),
    processPath: target => target,
    stat: async target => { const info = await stat(target); return { type: 'file', size: info.size } },
    readText: target => readFile(target, 'utf8'),
    writeText: async (target, content) => { await mkdir(path.dirname(target), { recursive: true }); await writeFile(target, content); return { version: 'test' } },
  }
  const result = await ingestMaterials({ fs, emit() {} }, { path: 'brochure.html', output_dir: 'analysis', max_chars_per_file: 500 },
    { signal: new AbortController().signal, agent: { session: { header: { cwd } } } })
  const corpus = await readFile(path.join(cwd, 'analysis/corpus.md'), 'utf8')
  assert.equal(result.counts.extracted, 1)
  assert.match(corpus, /支持线索分层、客户触达和转化跟踪/)
  assert.equal(corpus.includes('display:flex'), false)
  assert.equal(result.files[0].note, undefined)
})

test('模型回传代码或失败时不把原文摘录塞进方案正文', async () => {
  const manifest = { files: [{ path: 'brochure.html', excerpt: '<style>body{display:flex}</style><p>CallWan 提供线索管理。</p>' }] }
  const outline = [{ heading: '产品价值', topics: ['capabilities'], sourcePaths: ['brochure.html'] }]
  let prompt
  const ctx = { llm: { async *stream(options) {
    prompt = options.messages[0].content[0].text
    yield { type: 'text-delta', text: JSON.stringify({ sections: [{ heading: '产品价值', blocks: [
      { type: 'para', text: 'body{display:flex} CallWan 提供线索管理。',
        path: 'brochure.html', quote: 'CallWan 提供线索管理。' },
    ] }] }) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }
  const result = await composeSections(ctx, { options: { provider: 'mock', model: 'mock' } },
    new AbortController().signal, manifest, outline, [], { sales: true, stage: 'initial' })
  assert.equal(prompt.includes('display:flex'), false)
  assert.equal(JSON.stringify(result).includes('display:flex'), false)
  assert.match(result[0].blocks[0].text, /待与贵方确认：本部分内容将在进一步沟通并核对资料后完善/)
})

test('平台 Markdown 渲染入口剔除样式与损坏字符', () => {
  const blocks = mdToBlocks('CallWan 帮助销售管理线索。\n\n<style>body{display:flex}</style>\n\n�䄀䈀乱码')
  assert.deepEqual(blocks, [{ type: 'para', text: 'CallWan 帮助销售管理线索。' }])
})

test('直接生成工具拒绝代码正文和证据引文', async () => {
  const registered = new Map()
  apply({
    inject() {}, on() {},
    tools: { register(tool) { registered.set(tool.name, tool) } },
  }, {})
  const tool = registered.get('wlyd_solution')
  const base = {
    title: 'CallWan 售前方案',
    sections: [{ kind: 'capabilities', heading: '产品能力', blocks: [{ type: 'para', text: '提供销售线索管理。' }] }],
    pain_solution_links: [],
  }
  const exec = { signal: new AbortController().signal, agent: {} }
  await assert.rejects(tool.execute({ ...base, sections: [{ ...base.sections[0], blocks: [
    { type: 'para', text: 'body{display:flex} 原文' },
  ] }] }, exec), /含代码或不可读字符/)
  await assert.rejects(tool.execute({ ...base, pain_solution_links: [{
    id: 'P1', pain: '销售线索分散', solution: '统一管理线索',
    painEvidence: { path: 'a.html', quote: 'body{display:flex}' },
    solutionEvidence: { path: 'a.md', quote: '统一管理线索' },
  }] }, exec), /quote 含代码或不可读字符/)
  await assert.rejects(tool.execute({ ...base, sections: [{ kind: 'capabilities', heading: '产品能力',
    blocks: [{ type: 'para', text: '待与贵方确认：本部分内容将在进一步沟通并核对资料后完善。' }] }] }, exec),
  /正文只有待确认占位文案/)
})
