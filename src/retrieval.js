/** 售前知识库检索主题与结果覆盖策略。 */
import { cleanMaterialText, isReadableProse } from './source-quality.js'

export function platformQueries(product, scenario = 'general') {
  const subject = String(product || '产品').trim().slice(0, 80)
  const growth = scenario === 'sales' && !/协同|工作台|数字员工/u.test(subject)
  return [
    { key: 'background', label: '企业背景', query: growth
      ? `${subject} 增长环境 营销趋势 产品定位 目标客户`
      : `${subject} 企业背景 产品定位 目标客户`, retryQuery: growth
      ? `${subject} 流量变化 内容供给 线索经营 合规 公司介绍`
      : `${subject} 公司介绍 品牌业务 服务对象`, },
    { key: 'pain', label: '客户问题', query: `${subject} 客户痛点 业务挑战 对应解决方案`, retryQuery: `${subject} 客户遇到的问题 经营难题 业务需求`, },
    { key: 'capability', label: '产品能力', query: `${subject} 产品能力 功能 营销场景 使用方式`, retryQuery: `${subject} 产品功能 核心模块 能解决什么问题`, },
    { key: 'implementation', label: '实施场景', query: `${subject} 实施部署 服务保障 适用边界`, retryQuery: `${subject} 如何落地 实施流程 服务范围 适用条件`, },
  ]
}

/** 检索命中须同时属于已授权文档，且清洗后仍有可引用的正文。 */
export function readableSearchResult(result, documentById) {
  const chunkId = String(result.id ?? result.chunk_id ?? '').trim()
  const knowledgeId = String(result.knowledge_id ?? result.knowledgeId ?? '').trim()
  const doc = documentById.get(knowledgeId)
  if (!chunkId || !doc) return undefined
  const content = cleanMaterialText(result.content ?? result.matched_content ?? '', doc.title)
  if (!isReadableProse(content)) return undefined
  return { ...result, id: chunkId, knowledge_id: knowledgeId, content }
}

function cleanChunk(result, topic, documentById) {
  const readable = readableSearchResult(result, documentById)
  return readable ? { ...readable, topics: [topic.key], topicLabels: [topic.label] } : undefined
}

/** 归并重复 chunk、按主题保底，并用剩余名额补充整体高分结果。 */
export function balanceRetrievalResults(topicResults, documentById, { perTopic = 4, total = 20 } = {}) {
  const candidates = new Map()
  const topicCandidates = new Map()
  for (const { topic, results } of topicResults) {
    const topicRows = new Map()
    for (const result of results) {
      const chunk = cleanChunk(result, topic, documentById)
      if (!chunk) continue
      const oldTopicChunk = topicRows.get(chunk.id)
      if (!oldTopicChunk || Number(chunk.score ?? 0) > Number(oldTopicChunk.score ?? 0)) topicRows.set(chunk.id, chunk)

      const previous = candidates.get(chunk.id)
      if (!previous) candidates.set(chunk.id, chunk)
      else {
        if (!previous.topics.includes(topic.key)) previous.topics.push(topic.key)
        if (!previous.topicLabels.includes(topic.label)) previous.topicLabels.push(topic.label)
        if (Number(chunk.score ?? 0) > Number(previous.score ?? 0)) {
          candidates.set(chunk.id, { ...chunk, topics: previous.topics, topicLabels: previous.topicLabels })
        }
      }
    }
    topicCandidates.set(topic.key, [...topicRows.values()].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0)))
  }

  const selected = new Map()
  for (const { topic } of topicResults) {
    for (const chunk of (topicCandidates.get(topic.key) ?? []).slice(0, perTopic)) {
      if (selected.size >= total) break
      selected.set(chunk.id, candidates.get(chunk.id))
    }
  }
  const rest = [...candidates.values()].sort((a, b) => Number(b.score ?? 0) - Number(a.score ?? 0))
  for (const chunk of rest) {
    if (selected.size >= total) break
    if (!selected.has(chunk.id)) selected.set(chunk.id, chunk)
  }

  const results = [...selected.values()].map(chunk => ({
    ...chunk,
    topics: [...chunk.topics],
    topicLabels: [...chunk.topicLabels],
  }))
  const coverage = topicResults.map(({ topic }) => ({
    key: topic.key,
    label: topic.label,
    hits: results.filter(chunk => chunk.topics.includes(topic.key)).length,
  }))
  return { results, coverage }
}

export function retrievalCoverageText(coverage) {
  const missing = coverage.filter(item => item.hits === 0)
  const counts = coverage.map(item => `${item.label} ${item.hits} 条`).join('、')
  return `主题检索：${counts}${missing.length ? `；未检索到${missing.map(item => item.label).join('、')}资料` : ''}`
}
