import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { externalizeSolution } from '../src/external-copy.js'
import { renderHtml } from '../src/html.js'
import { assignVisualDesign } from '../src/visual-plan.js'

const baseSolution = () => ({ title: 'CallWan 售前方案', theme: 'corporate', meta: { product: 'CallWan' },
  sections: [{ kind: 'capabilities', heading: '营销能力', blocks: [
    { type: 'para', text: '内容生产、渠道发布和线索跟进需要衔接。' },
    { type: 'bullets', items: ['整理品牌内容', '编排渠道发布', '承接互动线索'] },
  ] }], painSolutionLinks: [] })

test('整稿风格依据内容选择，新方案配色轮换，保存后稳定且显式主题优先', async () => {
  const first = baseSolution()
  const second = baseSolution()
  const statePath = path.join(await mkdtemp(path.join(os.tmpdir(), 'wlyd-palette-')), 'state.json')
  await assignVisualDesign(first, { statePath })
  await assignVisualDesign(second, { statePath })
  assert.equal(first.visualDesign.direction, 'paper')
  assert.equal(first.theme, 'elegant')
  assert.equal(first.visualDesign.direction, second.visualDesign.direction)
  assert.notEqual(first.visualDesign.palette, second.visualDesign.palette)
  const saved = structuredClone(first.visualDesign)
  await assignVisualDesign(first, { statePath })
  assert.deepEqual(first.visualDesign, saved)
  const medical = baseSolution()
  medical.title = '医院病历质控方案'
  await assignVisualDesign(medical)
  assert.equal(medical.visualDesign.direction, 'signal')
  const technical = baseSolution()
  technical.title = '技术架构与算力方案'
  technical.sections = [{ heading: '系统架构', kind: 'architecture', blocks: [] }]
  await assignVisualDesign(technical)
  assert.equal(technical.visualDesign.direction, 'night')
  const fixed = baseSolution()
  fixed.theme = 'dark'
  await assignVisualDesign(fixed, { themeExplicit: true })
  assert.equal(fixed.theme, 'dark')
  assert.equal(fixed.visualDesign.direction, 'night')
  const before = structuredClone(fixed.visualDesign)
  await assignVisualDesign(fixed)
  assert.deepEqual(fixed.visualDesign, before)
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
