/** 售前页面的语义图标。只标识既有内容，不表达新的产品能力。 */
const GLYPHS = {
  trends: '<path d="M3 18h18M5 15l5-5 4 3 5-7"/><path d="M16 6h3v3"/>',
  problem_solution: '<rect x="2.5" y="5" width="7" height="6" rx="1"/><rect x="14.5" y="13" width="7" height="6" rx="1"/><path d="M9.5 8h6v8h-1M12.5 5l3 3-3 3"/>',
  capabilities: '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  scenarios: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="4"/><circle cx="12" cy="12" r="1"/>',
  implementation: '<circle cx="4" cy="18" r="2"/><circle cx="20" cy="6" r="2"/><path d="M6 18h6a4 4 0 0 0 0-8h-1a4 4 0 0 1 0-8h7"/>',
  company: '<path d="M4 21V5l8-3 8 3v16M2 21h20M9 21v-5h6v5M8 8h1m6 0h1M8 12h1m6 0h1"/>',
  boundary: '<path d="M12 2l8 3v6c0 5-3 9-8 11-5-2-8-6-8-11V5l8-3z"/><path d="M9 12l2 2 4-4"/>',
  document: '<path d="M5 2h10l4 4v16H5zM15 2v5h4M8 11h8M8 15h8M8 19h5"/>',
  people: '<circle cx="9" cy="8" r="3"/><path d="M3 20v-2a6 6 0 0 1 12 0v2M16 5a3 3 0 0 1 0 6M18 14a5 5 0 0 1 3 5v1"/>',
  network: '<circle cx="4" cy="12" r="2"/><circle cx="20" cy="5" r="2"/><circle cx="20" cy="19" r="2"/><path d="M6 11l12-5M6 13l12 5"/>',
  data: '<path d="M3 20h18M5 17v-5h4v5M11 17V8h4v9M17 17V4h4v13"/>',
}

export function iconForText(text, fallback = 'capabilities') {
  const value = String(text ?? '')
  if (/数据|分析|指标|复盘|效果|转化/u.test(value)) return 'data'
  if (/客户|用户|线索|销售|成员/u.test(value)) return 'people'
  if (/渠道|触达|连接|协同|传播/u.test(value)) return 'network'
  if (/内容|资料|文档|知识|素材/u.test(value)) return 'document'
  return fallback
}

export function semanticIcon(kind, className = 'semantic-icon') {
  const paths = GLYPHS[kind] ?? GLYPHS.capabilities
  return `<svg class="${className}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false">${paths}</svg>`
}
