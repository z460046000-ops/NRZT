import assert from 'node:assert/strict'
import test from 'node:test'
import { balanceRetrievalResults, platformQueries, retrievalCoverageText } from '../src/retrieval.js'

const docs = new Map([['doc-1', { id: 'doc-1', title: 'CallWan 产品资料.md' }]])
const topics = platformQueries('CallWan')
const chunk = (id, score, extra = {}) => ({ id, knowledge_id: 'doc-1', content: `证据 ${id}`, score, ...extra })

test('4 个主题各自保留证据，最后用预留名额补充高分片段，总量不超过 20', () => {
  const topicResults = topics.map((topic, topicIndex) => ({
    topic,
    results: Array.from({ length: 6 }, (_, index) => chunk(`${topic.key}-${index}`, 1 - topicIndex * 0.1 - index * 0.001)),
  }))
  const { results, coverage } = balanceRetrievalResults(topicResults, docs)
  assert.equal(results.length, 20)
  assert.ok(coverage.every(item => item.hits >= 4), JSON.stringify(coverage))
  assert.equal(new Set(results.map(item => item.id)).size, 20)
})

test('同一 chunk 只保留一次，并标记支持的多个主题', () => {
  const shared = chunk('shared', 0.95)
  const topicResults = topics.map((topic, index) => ({
    topic,
    results: index < 2 ? [shared, chunk(`${topic.key}-only`, 0.8)] : [],
  }))
  const { results, coverage } = balanceRetrievalResults(topicResults, docs)
  assert.equal(results.filter(item => item.id === 'shared').length, 1)
  assert.deepEqual(results.find(item => item.id === 'shared').topics, ['background', 'pain'])
  assert.equal(coverage[0].hits, 2)
  assert.equal(coverage[1].hits, 2)
})

test('检索覆盖说明标出没有命中的主题', () => {
  const text = retrievalCoverageText([
    { key: 'background', label: '企业背景', hits: 2 },
    { key: 'pain', label: '客户问题', hits: 0 },
  ])
  assert.match(text, /企业背景 2 条/u)
  assert.match(text, /未检索到客户问题资料/u)
})

test('Markdown 中切出的 HTML 片段先提取正文，样式片段不占检索名额', () => {
  const topicResults = [{ topic: topics[0], results: [
    chunk('css', 0.99, { content: '<style>.card{display:flex;padding:24px}</style>' }),
    chunk('html', 0.85, { content: '<div class="card"><h2>客户触达</h2><p>平台支持线索分层与触达记录。</p></div>' }),
  ] }]
  const { results, coverage } = balanceRetrievalResults(topicResults, docs)
  assert.equal(results.length, 1)
  assert.equal(results[0].id, 'html')
  assert.match(results[0].content, /线索分层与触达记录/u)
  assert.doesNotMatch(results[0].content, /<div|display:flex/u)
  assert.equal(coverage[0].hits, 1)
})
