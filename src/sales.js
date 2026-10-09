/** 售前请求与资料角色识别。技术资料可作能力依据，但不能决定客户版目录。 */
const TECHNICAL = /接口|swagger|openapi|api(?:\b|[-_])|开发文档|参数|状态码|请求响应|调试|样式表/iu
const MARKET = /营销|增长|获客|客户|场景|解决方案|产品介绍|能力清单|公司介绍|集团简介|品牌/iu

export function salesRequest(text) {
  const marker = text.indexOf('售前解决方案')
  if (marker < 0) return undefined
  const before = text.slice(0, marker).trim().replace(/(?:的)?(?:产品)?\s*$/u, '')
  const english = [...before.matchAll(/[A-Za-z][A-Za-z0-9._-]{1,39}/gu)].at(-1)?.[0]
  const chinese = /(?:给我|帮我|请|我要|我想|生成|做|写|出|关于|针对|一份|一版|一个|的|产品|\s)*([\p{Script=Han}]{2,20})$/u.exec(before)?.[1]
  const product = english ?? chinese
  if (!product || /^(?:产品|客户|企业|方案|售前|一份|一个|生成|给我|帮我|做|写|出|请|我要|我想|关于|针对)$/u.test(product)) return undefined
  return {
    kind: 'auto', product,
    stage: /深入接触|深度沟通|已沟通|复访|二次沟通|已有客户需求|客户已提供需求/u.test(text) ? 'deep' : 'initial',
  }
}

export function sourcePriority(file) {
  const name = String(file.path ?? '').split('/').at(-1) ?? ''
  return (MARKET.test(name) ? 4 : 0) - (TECHNICAL.test(name) ? 5 : 0)
}

export function technicalHeading(heading) {
  return TECHNICAL.test(heading) || /\b(?:html|css)\b/iu.test(heading)
}

export function salesOutlineCandidate(manifest, product, stage) {
  const files = [...(manifest.files ?? [])].filter(file => file.excerpt?.trim())
    .sort((a, b) => sourcePriority(b) - sourcePriority(a))
  const business = files.filter(file => sourcePriority(file) >= 0).map(file => file.path)
  const all = files.map(file => file.path)
  const company = files.filter(file => sourcePriority(file) >= 0
    && /公司介绍|集团简介|企业介绍|服务保障|资质/u.test(`${file.path} ${file.excerpt}`))
    .map(file => file.path)
  const result = [
    { heading: '业务背景与机会', topics: ['context'], sourcePaths: business.slice(0, 3) },
    { heading: stage === 'deep' ? '客户现状与关键问题（待确认）' : '目标客户与典型挑战（待确认）',
      topics: ['problem_solution'], sourcePaths: business.slice(0, 3) },
    { heading: `${product}的解决思路与业务价值`, topics: ['capabilities'], sourcePaths: all.slice(0, 4) },
    { heading: '营销场景与落地方式', topics: ['scenarios', 'implementation'], sourcePaths: all.slice(0, 4) },
  ]
  if (company.length) result.push({ heading: '企业背景与服务支持', topics: ['company', 'service'], sourcePaths: company.slice(0, 3) })
  return result
}
