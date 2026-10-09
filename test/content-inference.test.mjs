import assert from 'node:assert/strict'
import test from 'node:test'
import { assessMaterials } from '../src/content.js'

const internal = '产品支持统一素材库，团队可按项目复用已有内容。'
const manifest = { label: '产品资料', files: [{ path: 'internal.md', excerpt: internal }] }
const candidate = { decision: 'infer', links: [{
  pain: '团队可能存在重复制作素材的问题，待验证',
  solution: '按项目复用已有内容',
  painEvidence: { path: 'internal.md', quote: '团队可按项目复用已有内容' },
  solutionEvidence: { path: 'internal.md', quote: '产品支持统一素材库' },
}] }

function context(answers) {
  let count = 0
  return { ctx: { llm: { async *stream() {
    const answer = answers[count++]
    assert.ok(answer, '模型调用次数超出预期')
    yield { type: 'text-delta', text: JSON.stringify(answer) }
    yield { type: 'finish', reason: { kind: 'stop' } }
  } } }, calls: () => count }
}

const agent = { options: { provider: 'mock', model: 'mock' } }
const signal = new AbortController().signal

test('无显式痛点时可基于内部资料形成待确认候选，并做独立对应审查', async () => {
  const { ctx, calls } = context([candidate, { pairs: [{ id: 'P1', matched: true, reason: '素材复用与重复制作处于同一场景' }] }])
  const result = await assessMaterials(ctx, agent, signal, manifest)
  assert.equal(result.kind, 'ready')
  assert.equal(result.links[0].painBasis, 'inferred')
  assert.equal(calls(), 2)
})

test('独立审查发现问题与做法不对应时转为提问', async () => {
  const { ctx } = context([candidate, { pairs: [{ id: 'P1', matched: false, reason: '缺少直接作用机制' }] }])
  const result = await assessMaterials(ctx, agent, signal, manifest)
  assert.equal(result.kind, 'question')
  assert.equal(result.reason, 'mapping_mismatch')
})

test('公开资料不能被当成本公司产品能力依据', async () => {
  const source = { path: '公开资料（待核实）[1] https://example.com', content: '行业材料称客户常遇到内容重复制作，平台可以自动降低成本。' }
  const { ctx, calls } = context([{ decision: 'ready', links: [{
    pain: '客户常遇到内容重复制作', solution: '平台自动降低成本',
    painEvidence: { path: source.path, quote: '客户常遇到内容重复制作' },
    solutionEvidence: { path: source.path, quote: '平台可以自动降低成本' },
  }] }])
  const result = await assessMaterials(ctx, agent, signal, manifest, undefined, undefined, [source])
  assert.equal(result.kind, 'question')
  assert.equal(result.reason, 'invalid_evidence')
  assert.equal(calls(), 1)
})
