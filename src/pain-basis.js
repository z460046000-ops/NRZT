/** 保留候选痛点的来源状态，避免在交付物中变成已确认客户事实。 */
export function painBasisLabel(link) {
  if (link.painBasis === 'typical') return '典型挑战'
  if (link.painBasis === 'public_unverified') return '行业参考'
  if (link.painBasis === 'inferred') return '典型挑战'
  if (link.painBasis === 'user_unverified') return '沟通信息'
  return '资料明确'
}

export function painWithBasis(link) {
  return link.painBasis && link.painBasis !== 'explicit'
    ? `${link.pain}（${painBasisLabel(link)}）` : link.pain
}
