/** Give first-time readers a concrete opening and give editors useful image slots. */
export const VOICE_FINGERPRINT_VERSION = 'observed-callwan-20261013-v2'

const VISUAL_KINDS = {
  architecture: { kind: 'diagram', label: '方案关系图', instruction: '按本页已确认内容画清业务环节与对应做法；不要增加未出现的能力或数字。' },
  capabilities: { kind: 'screenshot', label: '产品界面截图', instruction: '上传真实产品界面，标出本页提到的操作或信息；不要用概念图冒充已实现界面。' },
  scenarios: { kind: 'screenshot', label: '场景操作截图', instruction: '上传真实场景或产品操作截图，说明谁在什么环节完成什么事。' },
}

const substantive = block => ['para', 'bullets', 'steps', 'table', 'chart'].includes(block.type)
  && (block.text || block.items?.length || block.rows?.length || block.points?.length)

function focusOf(section) {
  const para = section.blocks.find(block => block.type === 'para')?.text
  const source = /^(?:总体方案|平台能力|场景与应用|典型场景)$/u.test(section.heading)
    ? para || section.lead : section.lead || para
  const text = String(source || section.heading).replace(/\s+/gu, ' ').trim().split(/[。；]/u)[0]
  if (text.length <= 55) return text
  const prefix = text.slice(0, 55)
  const boundary = Math.max(prefix.lastIndexOf('，'), prefix.lastIndexOf(','))
  return `${(boundary >= 20 ? prefix.slice(0, boundary) : prefix).trim()}…`
}

/** Suggestions are internal image blocks, so the existing editor can replace them. */
export function addImageSuggestions(solution) {
  if (solution.external) return solution
  for (const [index, section] of solution.sections.entries()) {
    const byHeading = /平台|产品|界面|功能|操作|线索|发布|素材|知识库/u.test(section.heading)
      && !/痛点|挑战|困境|趋势|环境|公司/u.test(section.heading) ? VISUAL_KINDS.capabilities : undefined
    const config = VISUAL_KINDS[section.kind] ?? byHeading
    if (!config || !section.blocks.some(substantive)
      || section.blocks.some(block => block.type === 'image')) continue
    const focus = focusOf(section)
    const suggestion = { id: `suggested-image-${section.id ?? index}`, type: 'image', path: '',
      caption: `${section.heading}：${config.label}`,
      visualSuggestion: { kind: config.kind, label: config.label, focus,
        instruction: config.instruction } }
    const insertAt = section.blocks.length
    section.blocks.splice(insertAt, 0, suggestion)
  }
  return solution
}

const vague = /(?:增长系统|连接问题|持续运营|重构(?:一切|增长)|全链路闭环|赋能增长)/u

/** Editorial warnings never weaken evidence checks or discard usable chapters. */
export function firstReaderWarnings(solution) {
  const warnings = []
  const product = String(solution.meta?.product || '').trim()
  const subtitle = String(solution.subtitle || '').trim()
  if (product && (!subtitle.toLowerCase().includes(product.toLowerCase())
    || !/(?:平台|工作台|系统|工具|服务|产品)/u.test(subtitle))) {
    warnings.push('封面副标题尚未直接说明产品是什么、给谁用；请在编辑器中补充有依据的产品定位。')
  }
  for (const [index, section] of solution.sections.entries()) {
    const lead = String(section.lead || '')
    if (vague.test(lead)) warnings.push(`第 ${index + 1} 章导语有抽象说法；请改成客户能看到的业务动作或结果。`)
  }
  return warnings
}
