import assert from 'node:assert/strict'
import { mkdtemp, readFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import { externalizeSolution } from '../src/external-copy.js'
import { renderHtml } from '../src/html.js'
import { assignVisualDesign } from '../src/visual-plan.js'

const baseSolution = () => ({ title: 'CallWan 售前方案', theme: 'corporate', meta: { product: 'CallWan' },
  sections: [{ kind: 'capabilities', heading: '营销能力', blocks: [
    { type: 'para', text: '内容生产、渠道发布和线索跟进需要衔接。' },
    { type: 'bullets', items: ['整理品牌内容', '编排渠道发布', '承接互动线索'] },
  ] }], painSolutionLinks: [] })

test('新方案轮换视觉方向，显式主题不被改写，状态不记录客户资料', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-visual-plan-'))
  const stateFile = path.join(dir, 'state.json')
  const results = []
  for (let index = 0; index < 5; index++) {
    const solution = baseSolution()
    await assignVisualDesign(solution, { stateFile })
    results.push(solution)
  }
  assert.deepEqual(results.map(item => item.visualDesign.direction),
    ['redline', 'paper', 'night', 'signal', 'redline'])
  assert.deepEqual(results.map(item => item.theme),
    ['corporate', 'elegant', 'dark', 'corporate', 'corporate'])
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).sequence, 4)
  assert.doesNotMatch(await readFile(stateFile, 'utf8'), /CallWan|营销/u)

  const fixed = baseSolution()
  fixed.theme = 'dark'
  await assignVisualDesign(fixed, { stateFile, themeExplicit: true })
  assert.equal(fixed.theme, 'dark')
  assert.equal(fixed.visualDesign.direction, 'paper')
  const before = structuredClone(fixed.visualDesign)
  await assignVisualDesign(fixed, { stateFile })
  assert.deepEqual(fixed.visualDesign, before)
  assert.equal(JSON.parse(await readFile(stateFile, 'utf8')).sequence, 5)
})

test('同一源稿重渲染稳定，外部稿继承视觉方向；不同方向呈现不同画面', () => {
  const source = baseSolution()
  source.visualDesign = { version: 1, direction: 'paper', seed: 123 }
  source.theme = 'elegant'
  const html = renderHtml(source, [])
  assert.equal(renderHtml(source, []), html)
  assert.match(html, /class="design-paper"/u)
  assert.match(renderHtml(externalizeSolution(source), []), /class="design-paper"/u)
  const next = structuredClone(source)
  next.visualDesign = { version: 1, direction: 'night', seed: 456 }
  next.theme = 'dark'
  assert.match(renderHtml(next, []), /class="design-night"/u)
  assert.notEqual(renderHtml(next, []), html)
  assert.match(html, /整理品牌内容/u)
  assert.match(renderHtml(next, []), /整理品牌内容/u)
})
