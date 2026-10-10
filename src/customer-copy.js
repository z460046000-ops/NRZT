/** 面客稿的最后一道措辞整理；只改展示话语，不触碰逐字引文与来源。 */
const REWRITES = [
  [/本章暂无可核对的材料，需要补充资料后完善。/gu, '待确认：本部分将在双方核对相关资料后补充。'],
  [/目前只有产品名称，产品能力、客户问题与适用场景均待资料核实。/gu,
    '待确认：产品能力、适用场景与贵方需求仍需进一步核对。'],
  [/现有资料主要说明技术实现，客户价值、适用场景及对应问题需要补充业务资料后确认。/gu,
    '待确认：我们将结合贵方业务场景，进一步确认方案的适用范围与实施方式。'],
  [/本章尚未形成可核对的客户表述，请根据所列资料复核并补充；原文不会直接作为方案正文。/gu,
    '待确认：本部分内容将在进一步沟通并核对资料后完善。'],
  [/资料推断·待确认/gu, '典型挑战·待与贵方确认'],
  [/用户补充·待核实/gu, '沟通信息·待确认'],
  [/待人工复核/gu, '待确认'],
  [/方案初稿/gu, '解决方案'],
  [/待确认：/gu, '待与贵方确认：'],
  [/（待确认）/gu, '（待与贵方确认）'],
]

const INTERNAL_COPY = /本章尚未|原文不会直接|请根据所列资料|当前会话|模型输出|待人工复核|资料推断/u

export function hasInternalCopy(value) {
  return typeof value === 'string' && INTERNAL_COPY.test(value)
}

export function customerCopy(value) {
  if (typeof value !== 'string') return value
  return REWRITES.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value)
}

function customerBlock(block) {
  if (block.type === 'quote' && /^来源[:：]/u.test(block.text)) return block
  if (block.type === 'table') {
    const evidence = block.headers.map(header => /来源|依据|出处/u.test(header))
    return { ...block,
      headers: block.headers.map(customerCopy),
      rows: block.rows.map(row => row.map((cell, index) => evidence[index] ? cell : customerCopy(cell))),
    }
  }
  if (block.type === 'metrics') {
    return { ...block, items: block.items.map(item => ({ ...item, label: customerCopy(item.label) })) }
  }
  if (block.type === 'bullets' || block.type === 'steps') {
    return { ...block, items: block.items.map(customerCopy) }
  }
  if (block.type === 'image') return { ...block, caption: customerCopy(block.caption) }
  if (block.type === 'chart') return { ...block, title: customerCopy(block.title) }
  if (block.type === 'para' || block.type === 'quote') return { ...block, text: customerCopy(block.text) }
  return block
}

/** 在写入 JSON 前统一处理，保证 HTML、Markdown、DOCX 同版。 */
export function customerFacingSolution(solution) {
  return {
    ...solution,
    title: customerCopy(solution.title), subtitle: customerCopy(solution.subtitle),
    meta: { ...solution.meta, version: customerCopy(solution.meta?.version) },
    sections: solution.sections.map(section => ({
      ...section, heading: customerCopy(section.heading), lead: customerCopy(section.lead),
      blocks: section.blocks.map(customerBlock),
    })),
    painSolutionLinks: solution.painSolutionLinks?.map(link => ({
      ...link, pain: customerCopy(link.pain), solution: customerCopy(link.solution),
    })),
  }
}
