/**
 * 售前解决方案的 Markdown 渲染:与 HTML/DOCX 同源的单一结构化数据。
 * @module @wlyd/dsh-presales-solution/markdown
 */
import { painWithBasis } from './pain-basis.js'

/**
 * 渲染售前解决方案 Markdown(可编辑的事实源)。
 * @param {object} solution - normalizeSolution 产物。
 * @param {Array<{fileName: string, caption?: string}>} assets - 已复制的图片素材。
 * @returns {string} Markdown 文本。
 */
export function renderMarkdown(solution, assets) {
  const assetByName = new Map(assets.map(a => [a.sourcePath, a]))
  const lines = []
  lines.push(`# ${solution.title}`, '')
  if (solution.subtitle) lines.push(`> ${solution.subtitle}`, '')
  const meta = solution.meta
  const metaParts = [
    meta.company && `公司:${meta.company}`,
    meta.product && `产品:${meta.product}`,
    meta.version && `版本:${meta.version}`,
    meta.date && `日期:${meta.date}`,
  ].filter(Boolean)
  if (metaParts.length > 0) lines.push(metaParts.join(' · '), '')
  solution.sections.forEach((section, i) => {
    lines.push(`## ${i + 1}. ${section.heading}`, '')
    if (section.lead) lines.push(`> ${section.lead}`, '')
    if (section.kind === 'problem_solution' && solution.painSolutionLinks?.length) {
      pushBlock(lines, solution.external
        ? { type: 'table', headers: ['编号', '客户问题', '对应做法'],
          rows: solution.painSolutionLinks.map(link => [link.id, painWithBasis(link), link.solution]) }
        : { type: 'table', headers: ['编号', '客户问题', '对应做法', '材料依据'],
          rows: solution.painSolutionLinks.map(link => [link.id, painWithBasis(link), link.solution,
            `${link.painEvidence.path}：${link.painEvidence.quote}；${link.solutionEvidence.path}：${link.solutionEvidence.quote}`]) }, assetByName)
    }
    for (const block of section.blocks) {
      pushBlock(lines, block, assetByName)
    }
  })
  if (meta.contact || solution.external) lines.push('---', '', [meta.contact, solution.external && [meta.version, meta.date].filter(Boolean).join(' · ')].filter(Boolean).join(' · '), '')
  return lines.join('\n')
}

function pushBlock(lines, block, assetByName) {
  switch (block.type) {
    case 'para':
      lines.push(block.text, '')
      break
    case 'bullets':
      for (const item of block.items) lines.push(`- ${item}`)
      lines.push('')
      break
    case 'steps':
      block.items.forEach((item, i) => lines.push(`${i + 1}. ${item}`))
      lines.push('')
      break
    case 'table':
      lines.push(`| ${block.headers.join(' | ')} |`)
      lines.push(`| ${block.headers.map(() => '---').join(' | ')} |`)
      for (const row of block.rows) lines.push(`| ${row.join(' | ')} |`)
      lines.push('')
      break
    case 'metrics':
      lines.push('| 指标 | 数值 |', '| --- | --- |')
      for (const item of block.items) lines.push(`| ${item.label} | ${item.value} |`)
      lines.push('')
      break
    case 'image': {
      const asset = assetByName.get(block.path)
      if (asset) lines.push(`![${block.caption ?? ''}](./${asset.fileName})`, '')
      break
    }
    case 'quote':
      lines.push(`> ${block.text}`, '')
      break
    default:
      break
  }
}
