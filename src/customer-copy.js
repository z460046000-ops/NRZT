/** 面客正文与校对状态分开保存；引用与事实来源始终保持原样。 */
const MARKER = /待后续沟通确认|待沟通确认|待复核|尚待确认|待(?:与贵方|与客户|客户|双方)?确认|待核实|待人工复核|资料推断[·・]|用户补充[·・]/gu
const INTERNAL_COPY = /本章尚未|原文不会直接|请根据所列资料|当前会话|模型输出|待人工复核|资料推断/u
const PLACEHOLDER = /^(?:本章暂无可核对的材料，需要补充资料后完善。|(?:待(?:与贵方)?确认[:：])?(?:本部分将在双方核对相关资料后补充。|本部分内容将在进一步沟通(?:并核对资料)?后完善。|产品能力、适用场景与贵方需求仍需进一步核对。)|目前只有产品名称，产品能力、客户问题与适用场景均待资料核实。|本章尚未形成可核对的客户表述，请根据所列资料复核并补充；原文不会直接作为方案正文。)$/u

export function hasInternalCopy(value) {
  return typeof value === 'string' && INTERNAL_COPY.test(value)
}

export function customerCopy(value) {
  if (typeof value !== 'string') return value
  if (PLACEHOLDER.test(value.trim())) return ''
  return value
    .replace(/[，,]?贵方的具体情况待后续沟通确认[。.]?/gu, '。')
    .replace(/[，,]?是否与贵方情况一致[，,]待沟通确认[。.]?/gu, '。')
    .replace(/待后续沟通确认|待沟通确认|待复核|尚待确认/gu, '')
    .replace(/(?:待与贵方确认[:：])?我们将结合贵方业务场景，进一步确认方案的适用范围与实施方式。/gu,
      '实施范围将结合贵方业务场景在项目启动阶段确认。')
    .replace(/现有资料主要说明技术实现，客户价值、适用场景及对应问题需要补充业务资料后确认。/gu, '')
    .replace(/资料推断[·・](?:待确认[:：]?)?/gu, '典型挑战：')
    .replace(/用户补充[·・](?:待核实[:：]?)?/gu, '沟通信息：')
    .replace(/[（(](?:待(?:与贵方|与客户|客户|双方)?确认|待核实|待人工复核)[）)]/gu, '')
    .replace(/(?:待(?:与贵方|与客户|客户|双方)?确认|待核实|待人工复核)[：:]?/gu, '')
    .replace(/\s*[·・]\s*(?=[:：]|$)/gu, '').replace(/方案初稿/gu, '解决方案').trim()
}

/** 使用编辑器已有的字段路径；旧稿无 ID 时采用与 prepareSolution 相同的稳定 ID。 */
export function customerFacingSolution(solution) {
  const reviews = new Map((solution.copyReview ?? []).map(item => [item.path, { ...item }]))
  const copy = (value, path, reason) => {
    const cleaned = customerCopy(value)
    if (typeof value !== 'string') return cleaned
    const marked = [...value.matchAll(MARKER)].length > 0 || PLACEHOLDER.test(value.trim()) || hasInternalCopy(value)
    const previous = reviews.get(path)
    if (marked || (reason && previous?.status !== 'confirmed') || previous?.status === 'pending') {
      reviews.set(path, { ...previous, path, status: 'pending', value: cleaned,
        original: previous?.original ?? value, reason: previous?.reason ?? reason ?? '需要核对表述及事实依据',
        placeholder: !cleaned.trim(), confirmedAt: undefined, confirmedRevision: undefined })
    } else if (previous && previous.value !== cleaned) {
      reviews.set(path, { ...previous, status: 'pending', value: cleaned, confirmedAt: undefined, confirmedRevision: undefined })
    }
    return cleaned
  }
  const result = {
    ...solution,
    title: copy(solution.title, 'title'), subtitle: copy(solution.subtitle, 'subtitle'),
    meta: { ...solution.meta, version: customerCopy(solution.meta?.version) },
    sections: solution.sections.map((section, s) => ({
      ...section, id: section.id ?? `section-${s}`,
      heading: copy(section.heading, `sections/${section.id ?? `section-${s}`}/heading`),
      lead: copy(section.lead, `sections/${section.id ?? `section-${s}`}/lead`),
      blocks: section.blocks.map((block, b) => {
        const id = block.id ?? `block-${s}-${b}`
        const root = `blocks/${id}`
        if (block.type === 'quote' && /^来源[:：]/u.test(block.text)) return { ...block, id }
        if (block.type === 'para' || block.type === 'quote') return { ...block, id, text: copy(block.text, `${root}/text`) }
        if (block.type === 'bullets' || block.type === 'steps') return { ...block, id, items: block.items.map((v, i) => copy(v, `${root}/items/${i}`)) }
        if (block.type === 'table') {
          const evidence = block.headers.map(header => /来源|依据|出处|证据/u.test(header))
          return { ...block, id, headers: block.headers.map((v, i) => copy(v, `${root}/headers/${i}`)),
            rows: block.rows.map((row, r) => row.map((v, c) => evidence[c] ? v : copy(v, `${root}/rows/${r}/${c}`))) }
        }
        if (block.type === 'metrics') return { ...block, id, items: block.items.map((item, i) => ({ ...item,
          label: copy(item.label, `${root}/metrics/${i}/label`), value: copy(item.value, `${root}/metrics/${i}/value`) })) }
        if (block.type === 'image') return { ...block, id, caption: copy(block.caption, `${root}/caption`) }
        if (block.type === 'chart') return { ...block, id, title: copy(block.title, `${root}/chart/title`,
          block.evidenceStatus === 'user_unverified' ? '图表数据有修改，需要核对原始依据' : undefined) }
        return { ...block, id }
      }),
    })),
    painSolutionLinks: solution.painSolutionLinks?.map(link => ({ ...link,
      pain: copy(link.pain, `links/${link.id}/pain`,
        ['inferred', 'public_unverified', 'user_unverified'].includes(link.painBasis) ? '典型挑战或沟通信息，需要核对适用性' : undefined),
      solution: copy(link.solution, `links/${link.id}/solution`),
    })),
  }
  const derived = new Set(result.painSolutionLinks?.length
    ? result.sections.filter(section => ['pains', 'solution'].includes(section.kind)).flatMap(section => section.blocks.map(block => block.id)) : [])
  result.copyReview = [...reviews.values()].filter(item => !derived.has(item.path.split('/')[1]))
  return result
}
