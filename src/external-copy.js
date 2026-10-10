/** 从可追溯的内部源稿派生只含展示字段的外部稿；不改原稿。 */
import { customerCopy } from './customer-copy.js'

const sourceColumn = value => /来源|依据|出处|证据/u.test(value)
const sourceQuote = value => /^\s*(?:来源|材料依据)[:：]/u.test(value)

function displayText(value) {
  return customerCopy(String(value ?? '')).replaceAll(
    '待与贵方确认：我们将结合贵方业务场景，进一步确认方案的适用范围与实施方式。',
    '实施范围将结合贵方业务场景在项目启动阶段确认。',
  )
}

function displayBlock(block, assetNames) {
  if (block.type === 'para' || block.type === 'quote') {
    if (sourceQuote(block.text)) return null
    return { type: block.type, text: displayText(block.text) }
  }
  if (block.type === 'bullets' || block.type === 'steps') {
    return { type: block.type, items: block.items.map(displayText) }
  }
  if (block.type === 'table') {
    const columns = block.headers.map((heading, index) => sourceColumn(heading) ? -1 : index).filter(index => index >= 0)
    if (!columns.length) return null
    return { type: 'table', headers: columns.map(index => displayText(block.headers[index])),
      rows: block.rows.map(row => columns.map(index => displayText(row[index] ?? ''))) }
  }
  if (block.type === 'metrics') {
    return { type: 'metrics', items: block.items.map(item => ({ label: displayText(item.label), value: displayText(item.value) })) }
  }
  if (block.type === 'image') {
    const source = block.sourcePath ?? block.path
    const publicName = assetNames.get(source)
    return publicName ? { type: 'image', path: publicName, sourcePath: publicName, caption: displayText(block.caption ?? '') } : null
  }
  return null
}

/** assetNames: Map<内部素材路径, 预览或外发素材路径>。 */
export function externalizeSolution(source, assetNames = new Map()) {
  return {
    external: true,
    title: displayText(source.title), subtitle: displayText(source.subtitle ?? ''), theme: source.theme,
    meta: {
      company: displayText(source.meta?.company ?? ''), product: displayText(source.meta?.product ?? ''),
      version: displayText(source.meta?.version ?? ''), date: source.meta?.date ?? '',
    },
    sections: source.sections.map(section => ({
      kind: section.kind, heading: displayText(section.heading), lead: displayText(section.lead ?? ''),
      blocks: section.blocks.map(block => displayBlock(block, assetNames)).filter(Boolean),
    })),
    painSolutionLinks: (source.painSolutionLinks ?? []).map(link => ({
      id: link.id,
      pain: displayText(link.pain), solution: displayText(link.solution),
      painBasis: link.painBasis === 'inferred' ? 'typical' : link.painBasis,
      painEvidence: { path: '', quote: '' }, solutionEvidence: { path: '', quote: '' },
    })),
  }
}

export function visibleExternalText(solution) {
  const parts = [solution.title, solution.subtitle, ...Object.values(solution.meta)]
  for (const section of solution.sections) {
    parts.push(section.heading, section.lead)
    for (const block of section.blocks) {
      if (block.text) parts.push(block.text)
      if (block.caption) parts.push(block.caption)
      if (block.items) parts.push(...block.items.flatMap(item => typeof item === 'string' ? [item] : Object.values(item)))
      if (block.headers) parts.push(...block.headers, ...block.rows.flat())
    }
  }
  for (const link of solution.painSolutionLinks ?? []) parts.push(link.pain, link.solution)
  return parts.filter(value => typeof value === 'string').join('\n')
}
