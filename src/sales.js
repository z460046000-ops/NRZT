/** 售前请求与资料角色识别。技术资料可作能力依据，但不能决定客户版目录。 */
const TECHNICAL = /接口|swagger|openapi|api(?:\b|[-_])|开发文档|参数|状态码|请求响应|调试|样式表/iu
const MARKET = /营销|增长|获客|客户|场景|解决方案|产品介绍|能力清单|公司介绍|集团简介|品牌|协同|工作台|数字员工/iu

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

/** 手工方案的增长与协同叙事不同，优先依据材料标题判断，避免把协同产品写成营销平台。 */
export function salesScenario(manifest) {
  const files = [...(manifest.files ?? [])].filter(file => file.kind !== 'public' && file.kind !== 'user')
    .sort((a, b) => sourcePriority(b) - sourcePriority(a))
  const names = files.slice(0, 3).map(file => file.path.split('/').at(-1)).join(' ')
  return /协同|工作台|数字员工/iu.test(names) && !/增长|营销获客/iu.test(names)
    ? 'collaboration' : 'growth'
}

export function salesOutlineCandidate(manifest, product, stage) {
  const files = [...(manifest.files ?? [])].filter(file => file.excerpt?.trim())
    .sort((a, b) => sourcePriority(b) - sourcePriority(a))
  const business = files.filter(file => file.kind !== 'public' && sourcePriority(file) >= 0).map(file => file.path)
  const all = files.filter(file => file.kind !== 'public').map(file => file.path)
  const trend = files.filter(file => /增长环境|行业趋势|营销趋势|流量竞争|流量变化|合规治理|获客变化|AI\s*搜索|生成式搜索|内容供给.{0,12}(?:变化|压力|竞争|需求)|第一方数据.{0,12}(?:趋势|重要|变化)/u
    .test(`${file.path} ${file.excerpt}`)).map(file => file.path)
  const service = files.filter(file => file.kind !== 'public' && sourcePriority(file) >= 0
    && /实施|培训|运营服务|客户成功|服务保障|上线|交付/u.test(`${file.path} ${file.excerpt}`)).map(file => file.path)
  const company = files.filter(file => file.kind !== 'public' && sourcePriority(file) >= 0
    && /公司介绍|集团简介|企业介绍|集团基础|业务生态|服务网络|资质/u.test(`${file.path} ${file.excerpt}`))
    .map(file => file.path)
  const publicPaths = (manifest.files ?? []).filter(file => file.kind === 'public').map(file => file.path)
  const scenario = salesScenario(manifest)
  if (scenario === 'growth') {
    const result = [
      { heading: trend.length ? '增长环境与趋势' : '营销业务背景', topics: trend.length ? ['trends'] : ['context'],
        sourcePaths: trend.length ? trend.slice(0, 4) : [...business.slice(0, 2), ...publicPaths.slice(0, 1)] },
      { heading: '现状与挑战', topics: ['problem_solution'], sourcePaths: [...business.slice(0, 3), ...publicPaths.slice(0, 1)] },
      { heading: '总体方案', topics: ['architecture'], sourcePaths: all.slice(0, 4) },
      { heading: '平台能力', topics: ['capabilities', 'scenarios'], sourcePaths: all.slice(0, 4) },
    ]
    if (service.length) result.push({ heading: '实施与服务', topics: ['implementation', 'service'], sourcePaths: service.slice(0, 3) })
    if (company.length) result.push({ heading: '公司介绍', topics: ['company'], sourcePaths: company.slice(0, 3) })
    return result
  }
  const result = [
    { heading: '业务背景与机会', topics: ['context'], sourcePaths: [...business.slice(0, 2), ...publicPaths.slice(0, 1)] },
    { heading: stage === 'deep' ? '客户现状与关键问题（待确认）' : '目标客户与典型挑战（待确认）',
      topics: ['problem_solution'], sourcePaths: [...business.slice(0, 2), ...publicPaths.slice(0, 1)] },
    { heading: `${product}的解决思路与业务价值`, topics: ['capabilities'], sourcePaths: all.slice(0, 4) },
    { heading: scenario === 'collaboration' ? '协同场景与落地方式' : '营销场景与落地方式',
      topics: ['scenarios', 'implementation'], sourcePaths: all.slice(0, 4) },
  ]
  if (company.length) result.push({ heading: '企业背景与服务支持', topics: ['company', 'service'], sourcePaths: company.slice(0, 3) })
  return result
}
