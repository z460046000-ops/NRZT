/**
 * 售前解决方案的 HTML 渲染:集团模板幻灯片风格(1280×720 页面)。
 * 结构:封面 → 目录 → 每节(篇章页 + 内容页,内容按容量自动分页)→ 结尾页。
 * 浏览器直接查看,打印(@page 1280×720)可导出 PDF。
 * @module @wlyd/dsh-presales-solution/html
 */

import { readFileSync } from 'node:fs'
import { painBasisLabel } from './pain-basis.js'

const EDITOR_SCRIPT = readFileSync(new URL('./editor-client.js', import.meta.url), 'utf8')
const RELEASE_SCRIPT = readFileSync(new URL('./release-client.js', import.meta.url), 'utf8')

const THEMES = {
  // 集团模板:白底、红 #d51008 主色、蓝 #1362af 辅色、微软雅黑
  corporate: {
    bg: '#dce2e7', slideBg: '#ffffff', ink: '#142034', ink2: '#3e4b5a', ink3: '#647181',
    red: '#d51008', blue: '#1362af', blueDark: '#0e4a85',
    line: 'rgba(30,44,57,.18)', soft: 'rgba(30,44,57,.085)',
    editorActionText: '#ffffff', editorAlert: '#ad1009',
    theadBg: '#f2f5f7', cardTint: '#f7f9fa', noticeBg: '#fff7f6',
    coverFrom: '#142034', coverTo: '#142034', coverInk: '#ffffff',
    heroMuted: '#b8c6d5',
    dividerFrom: '#142034', dividerTo: '#142034', dividerInk: '#ffffff',
    closingFrom: '#142034', closingTo: '#142034', closingInk: '#ffffff',
    font: "'Microsoft YaHei', '微软雅黑', 'PingFang SC', 'Noto Sans SC', sans-serif",
  },
  dark: {
    bg: '#0b1020', slideBg: '#121a30', ink: '#e2e8f0', ink2: '#a8b3c7', ink3: '#7a86a0',
    red: '#e5484d', blue: '#38bdf8', blueDark: '#0ea5e9',
    line: 'rgba(148,163,184,.22)', soft: 'rgba(148,163,184,.10)',
    editorActionText: '#0b1020', editorAlert: '#ff9194',
    theadBg: '#1b2647', cardTint: '#182238', noticeBg: '#231a2e',
    coverFrom: '#101832', coverTo: '#1a2547', coverInk: '#f1f5f9',
    heroMuted: '#aebdd2',
    dividerFrom: '#151f3d', dividerTo: '#1c2a52', dividerInk: '#e2e8f0',
    closingFrom: '#101832', closingTo: '#1a2547', closingInk: '#f1f5f9',
    font: "'Microsoft YaHei', 'PingFang SC', 'Noto Sans SC', sans-serif",
  },
  elegant: {
    bg: '#e5ddd0', slideBg: '#fffdf8', ink: '#2c2014', ink2: '#5c4f3d', ink3: '#8a7a63',
    red: '#bc6c25', blue: '#92400e', blueDark: '#7c3a0c',
    line: 'rgba(92,79,61,.22)', soft: 'rgba(92,79,61,.09)',
    editorActionText: '#1e1409', editorAlert: '#82400d',
    theadBg: '#f3ead9', cardTint: '#faf6ee', noticeBg: '#fdf3e3',
    coverFrom: '#fffdf8', coverTo: '#f7efe2', coverInk: '#2c2014',
    heroMuted: '#695743',
    dividerFrom: '#fdf8ee', dividerTo: '#f5ead6', dividerInk: '#2c2014',
    closingFrom: '#fdf8ee', closingTo: '#f5ead6', closingInk: '#2c2014',
    font: "'Microsoft YaHei', 'PingFang SC', 'Songti SC', serif",
  },
}

function esc(text) {
  return String(text)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
}

// ── 内容分页:按粗略高度权重把块切到多页 ──────────────────────────

/** 按文字量估算版心占用；超长内容先拆块，再分页。 */
function blockWeight(block) {
  switch (block.type) {
    case 'para': return 1 + String(block.text).length / 95
    case 'bullets': return 1.5 + block.items.reduce((sum, item) => sum + Math.max(1, String(item).length / 65), 0)
    case 'steps': return 1.5 + block.items.reduce((sum, item) => sum + Math.max(1, String(item).length / 90), 0)
    case 'table': return 2 + block.rows.reduce((sum, row) => sum + Math.max(1, row.join('').length / 80), 0)
    case 'metrics': return 4
    case 'chart': return 6.5
    case 'image': return 6.5
    case 'quote': return 2 + String(block.text).length / 95
    default: return 3
  }
}

const PAGE_CAPACITY = 7.2

function splitText(value, maxLength) {
  const text = String(value)
  const parts = []
  let rest = text
  while (rest.length > maxLength) {
    const boundary = Math.max(rest.lastIndexOf('。', maxLength), rest.lastIndexOf('；', maxLength), rest.lastIndexOf('，', maxLength), rest.lastIndexOf(' ', maxLength))
    const end = boundary >= maxLength / 2 ? boundary + 1 : maxLength
    parts.push(rest.slice(0, end))
    rest = rest.slice(end)
  }
  if (rest) parts.push(rest)
  return parts.length ? parts : ['']
}

function splitBlock(block) {
  if (block.type === 'para' || block.type === 'quote') {
    return splitText(block.text, block.type === 'quote' ? 200 : 270).map(text => ({ ...block, text }))
  }
  if (block.type === 'bullets' || block.type === 'steps') {
    const entries = block.items.flatMap((item, index) => splitText(item, block.type === 'steps' ? 95 : 180)
      .map((text, part) => ({ text, number: index + 1, continued: part > 0 })))
    const size = block.type === 'steps' ? 4 : 4
    const parts = []
    for (let i = 0; i < entries.length; i += size) {
      const group = entries.slice(i, i + size)
      parts.push({ ...block, items: group.map(item => item.continued ? `${item.text}（续）` : item.text), numbers: group.map(item => item.number) })
    }
    return parts
  }
  if (block.type === 'table') {
    const rows = []
    for (const row of block.rows) {
      const pieces = row.map(cell => splitText(cell, 150))
      const count = Math.max(...pieces.map(part => part.length))
      for (let i = 0; i < count; i++) rows.push(pieces.map(part => part[i] ?? ''))
    }
    const pages = []
    let page = []
    let used = 2
    for (const row of rows) {
      const weight = Math.max(1.2, row.join('').length / 80)
      if (page.length && (page.length >= (block.headers.length >= 3 ? 3 : 6) || used + weight > 7.5)) {
        pages.push({ ...block, rows: page }); page = []; used = 2
      }
      page.push(row); used += weight
    }
    if (page.length) pages.push({ ...block, rows: page })
    return pages
  }
  return [block]
}

/** 相邻的要点块(2-4 个)合成卡片栅格;其余顺序堆叠。 */
function groupCards(chunks) {
  const out = []
  let run = []
  const flush = () => {
    if (run.length >= 2 && run.length <= 4) {
      out.push({ kind: 'cards', cols: run.length >= 4 ? 2 : run.length === 3 ? 3 : 2, items: run })
    } else {
      out.push(...run)
    }
    run = []
  }
  for (const block of chunks) {
    if (block.type === 'quote' && block.text.startsWith('来源：')) { flush(); out.push(block) }
    else if (block.type === 'bullets' || block.type === 'quote') run.push(block)
    else { flush(); out.push(block) }
  }
  flush()
  return out
}

/** 把一节的块按容量切成多页；三列表格每页最多 3 行。 */
function paginateBlocks(blocks) {
  const pages = []
  let current = []
  let used = 0
  const pushPage = () => { if (current.length > 0) { pages.push(current); current = []; used = 0 } }
  for (const block of blocks.flatMap(splitBlock)) {
    const w = blockWeight(block)
    if (used + w > PAGE_CAPACITY && current.length > 0) pushPage()
    current.push(block)
    used += w
  }
  pushPage()
  return pages.map(groupCards)
}

// ── 块渲染 ────────────────────────────────────────────────────────

function renderBlock(block, assetByName, features) {
  switch (block.type) {
    case 'para':
      return `<p class="para${/^来源[:：]/u.test(block.text) ? ' source-evidence' : ''}">${esc(block.text)}</p>`
    case 'bullets':
      return `<div class="card"><ul class="bullets">${block.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`
    case 'quote':
      if (block.text.startsWith('来源：') && block.text.includes('\n')) {
        const [source, ...excerpt] = block.text.slice(3).split('\n')
        const label = source.split(/[\\/]/u).at(-1).replace(/^[a-f0-9]{8}-[a-f0-9-]{27,}-/iu, '')
        return `<aside class="source-note" title="${esc(source)}"><strong>资料依据 · ${esc(label)}</strong><p>${esc(excerpt.join('\n'))}</p></aside>`
      }
      return `<blockquote class="editorial-quote${/^来源[:：]/u.test(block.text) ? ' source-evidence' : ''}">${esc(block.text)}</blockquote>`
    case 'steps':
      return `<div class="flow" style="grid-template-columns:repeat(${Math.min(block.items.length, 4)},1fr)">`
        + block.items.map((item, i) => `<div class="step"><i>${String(block.numbers?.[i] ?? i + 1).padStart(2, '0')}</i><span>${esc(item)}</span></div>`).join('')
        + '</div>'
    case 'table': {
      const evidenceColumns = block.headers.map(header => /来源|依据|出处/u.test(header))
      return '<table class="table"><thead><tr>'
        + block.headers.map((h, index) => `<th${evidenceColumns[index] ? ' class="source-evidence"' : ''}>${esc(h)}</th>`).join('')
        + '</tr></thead><tbody>'
        + block.rows.map(r => `<tr>${r.map((c, index) => `<td${evidenceColumns[index] ? ' class="source-evidence"' : ''}>${esc(c)}</td>`).join('')}</tr>`).join('')
        + '</tbody></table>'
    }
    case 'metrics':
      return `<div class="metrics" style="grid-template-columns:repeat(${Math.min(block.items.length, 4)},1fr)">`
        + block.items.map(m => `<div class="metric"><strong>${esc(m.value)}</strong><span>${esc(m.label)}</span></div>`).join('')
        + '</div>'
    case 'chart': return renderChart(block)
    case 'image': {
      const asset = assetByName.get(block.sourcePath ?? block.path)
      if (!asset) return ''
      features.hasImage = true
      return `<figure class="visual"><div class="frame"><img src="./${esc(asset.fileName)}" alt="${esc(block.caption ?? '')}"></div>`
        + (block.caption ? `<em>${esc(block.caption)}</em>` : '')
        + '</figure>'
    }
    default:
      return ''
  }
}

function renderChart(block) {
  const max = Math.max(1, ...block.points.map(point => point.value))
  const pending = block.evidenceStatus === 'user_unverified'
  const source = block.external ? '' : `<p class="chart-source source-evidence">${pending ? '数据已修改，待核对原始依据' : '数据依据'}：${esc(block.source.path)} · ${esc(block.source.quote)}</p>`
  const body = block.chartType === 'bar'
    ? `<div class="chart-bars">${block.points.map(point => `<div class="chart-row"><span class="chart-label">${esc(point.label)}</span><div class="chart-track"><span style="width:${Math.max(0, point.value / max * 100).toFixed(2)}%"></span></div><strong>${esc(point.value)} ${esc(block.unit)}</strong></div>`).join('')}</div>`
    : (() => {
      const coords = block.points.map((point, index) => ({ x: 58 + index * 884 / (block.points.length - 1), y: 30 + (1 - point.value / max) * 225 }))
      const line = coords.map(point => `${point.x.toFixed(1)},${point.y.toFixed(1)}`).join(' ')
      return `<div class="chart-line"><svg viewBox="0 0 1000 290" role="img" aria-label="${esc(block.title)}，单位 ${esc(block.unit)}"><line x1="58" y1="255" x2="942" y2="255" class="chart-base"/><polyline points="${line}" class="chart-path"/>${coords.map((point, index) => `<circle cx="${point.x}" cy="${point.y}" r="7" class="chart-dot"><title>${esc(block.points[index].label)}：${esc(block.points[index].value)} ${esc(block.unit)}</title></circle>`).join('')}</svg><div class="chart-axis" style="grid-template-columns:repeat(${block.points.length},1fr)">${block.points.map(point => `<div><span>${esc(point.label)}</span><strong>${esc(point.value)}</strong></div>`).join('')}</div></div>`
    })()
  return `<figure class="data-chart ${block.chartType === 'line' ? 'trend-chart' : 'comparison-chart'}"><figcaption><h3>${esc(block.title)}</h3><span>${esc(block.unit)}${pending ? ' · 待确认' : ''}</span></figcaption>${body}${source}</figure>`
}

function renderCard(block, assetByName, features) {
  if (block.type === 'quote') {
    return renderBlock(block, assetByName, features)
  }
  return `<div class="card"><ul class="bullets">${block.items.map(i => `<li>${esc(i)}</li>`).join('')}</ul></div>`
}

// ── 页面渲染 ──────────────────────────────────────────────────────

function coverSlide(solution, t) {
  const meta = solution.meta
  const titleSize = solution.title.length > 70 ? 46 : solution.title.length > 35 ? 56 : 68
  const offset = [...solution.title].reduce((value, char) => value + char.codePointAt(0), 0) % 2 === 1
  return `<section class="slide cover${offset ? ' cover-offset' : ''}">
  <div class="cover-top"><span>${esc(meta.company ?? '')}</span><span>${esc(meta.date ?? '')}</span></div>
  <div class="cover-grid"><div class="cover-main">
    <h1 style="font-size:${titleSize}px">${esc(solution.title)}</h1>
    ${solution.subtitle ? `<p class="sub">${esc(solution.subtitle)}</p>` : ''}
  </div><div class="cover-geometry" aria-hidden="true"><span></span><span></span><span></span></div></div>
  <div class="cover-bottom"><span>${esc(meta.product ?? '')}</span><span>${esc([meta.version, meta.contact].filter(Boolean).join(' · '))}</span></div>
</section>`
}

function tocSlide(solution, sections, start) {
  return `<section class="slide toc-slide">
  <div class="head"><h2>目录${start ? ' · 续' : ''}</h2></div>
  <div class="toc">
    ${sections.map((s, i) => `<div class="toc-item"><span class="no">${String(start + i + 1).padStart(2, '0')}</span><div><strong>${esc(s.heading)}</strong>${s.lead ? `<span>${esc(s.lead)}</span>` : ''}</div></div>`).join('\n    ')}
  </div>
  <div class="footer"><span class="brand">${esc(solution.meta.company ?? '')}</span><span></span></div>
</section>`
}

function dividerSlide(solution, section, no, t) {
  const headingSize = section.heading.length > 60 ? 30 : section.heading.length > 30 ? 36 : 44
  return `<section class="slide divider${no % 2 === 0 ? ' divider-light' : ''}">
  <div class="inner">
    <p class="chap">${String(no).padStart(2, '0')}</p>
    <h2 style="font-size:${headingSize}px">${esc(section.heading)}</h2>
    ${section.lead ? `<p>${esc(section.lead)}</p>` : ''}
  </div>
  <div class="footer"><span class="brand">${esc(solution.meta.company ?? '')}</span><span></span></div>
</section>`
}

function layoutFor(solution, section, blocks, pageIndex, recentLayouts) {
  const types = blocks.flatMap(block => block.kind === 'cards' ? block.items.map(item => item.type) : [block.type])
  const leadText = blocks.find(block => block.type === 'para')?.text ?? ''
  const family = types.includes('chart') ? 'chart'
    : types.includes('steps') ? 'process'
      : types.includes('image') ? 'evidence'
        : blocks.length <= 2 && blocks[0]?.type === 'para' && String(leadText).length <= 92 ? 'statement'
          : ['capabilities', 'architecture', 'scenarios'].includes(section.kind) && types.includes('bullets') ? 'capability' : 'editorial'
  const variants = family === 'chart' ? ['chart-wide'] : ({
    statement: ['statement-left', 'statement-right', 'statement-center'],
    process: ['process-horizontal', 'process-right', 'process-staggered'],
    evidence: ['evidence-left', 'evidence-right', 'evidence-full'],
    capability: ['capability-left', 'capability-right', 'capability-band'],
    editorial: ['editorial-left', 'editorial-right', 'editorial-led'],
  })[family]
  const seed = [...`${solution.title}:${section.heading}:${pageIndex}`].reduce((value, char) => (value * 31 + char.codePointAt(0)) >>> 0, 17)
  const notes = blocks.filter(block => block.type === 'quote' && block.text.startsWith('来源：')).length
  const stepCount = blocks.filter(block => block.type === 'steps').reduce((count, block) => count + block.items.length, 0)
  const bulletItems = blocks.flatMap(block => block.kind === 'cards'
    ? block.items.filter(item => item.type === 'bullets').flatMap(item => item.items)
    : block.type === 'bullets' ? block.items : [])
  const dense = bulletItems.length >= 5 || bulletItems.some(item => String(item).length > 56)
  const preferred = family === 'statement' && notes === 0 ? 'statement-center'
    : family === 'process' && stepCount >= 4 ? 'process-staggered'
      : family === 'process' && stepCount <= 2 ? 'process-right'
        : family === 'evidence' && notes === 0 ? 'evidence-full'
          : family === 'capability' && dense ? 'capability-right'
            : family === 'capability' && bulletItems.length >= 2 && bulletItems.length <= 4 ? 'capability-band'
              : family === 'editorial' && String(leadText).length > 180 && blocks.length > 1 ? 'editorial-led' : undefined
  const usable = variants.filter(item => !recentLayouts.includes(item))
  const candidates = usable.length ? usable : variants
  return preferred && candidates.includes(preferred) ? preferred : candidates[seed % candidates.length]
}

function contentSlide(solution, section, pageNo, pageIndex, blocks, assetByName, features, layout) {
  const statement = blocks.length <= 2 && blocks[0]?.type === 'para'
    && String(blocks[0].text).length <= 92
    && (blocks.length === 1 || blocks[1]?.type === 'quote')
  const body = blocks.map(group => {
    if (group.kind === 'cards') {
      return `<div class="grid g${group.cols}">${group.items.map(b => renderCard(b, assetByName, features)).join('')}</div>`
    }
    return renderBlock(group, assetByName, features)
  }).join('\n')
  const gap = blocks.length > 1 ? ' style="gap:20px"' : ''
  const tag = solution.meta.product ?? solution.title
  const headingSize = section.heading.length > 42 ? 26 : section.heading.length > 30 ? 30
    : section.heading.length > 20 ? 34 : 40
  const types = blocks.flatMap(block => block.kind === 'cards' ? block.items.map(item => item.type) : [block.type])
  const visual = types.includes('steps') ? ' process-slide' : types.includes('image') ? ' evidence-slide'
    : ['capabilities', 'architecture', 'scenarios'].includes(section.kind) && types.includes('bullets') ? ' capability-slide' : ''
  return `<section class="slide content-slide${statement ? ' statement-slide' : ''}${visual} layout-${layout}">
  <div class="header"><div class="tag">${esc(tag)}</div></div>
  <div class="head"><h2 style="font-size:${headingSize}px">${esc(section.heading)}</h2>${section.lead ? `<p class="lead">${esc(section.lead)}</p>` : ''}</div>
  <div class="body"${gap}>
${body}
  </div>
  <div class="footer"><span class="brand">${esc(solution.meta.company ?? '')}</span><span></span></div>
</section>`
}

function paginateLink(link) {
  const fields = ['pain', 'solution']
  const evidence = ['painEvidence', 'solutionEvidence']
  const parts = Object.fromEntries(fields.map(field => [field, splitText(link[field], 120)]))
  for (const field of evidence) {
    parts[`${field}Path`] = splitText(link[field]?.path ?? '', 95)
    parts[`${field}Quote`] = splitText(link[field]?.quote ?? '', 120)
  }
  const count = Math.max(...Object.values(parts).map(value => value.length))
  return Array.from({ length: count }, (_, i) => ({
    ...link,
    pain: parts.pain[i] ?? '', solution: parts.solution[i] ?? '',
    painEvidence: { ...link.painEvidence, path: parts.painEvidencePath[i] ?? '', quote: parts.painEvidenceQuote[i] ?? '' },
    solutionEvidence: { ...link.solutionEvidence, path: parts.solutionEvidencePath[i] ?? '', quote: parts.solutionEvidenceQuote[i] ?? '' },
    continued: i > 0,
  }))
}

/** 痛点页与方案页使用同一编号；每页最多两组，保留阅读和证据空间。 */
function linkedSlide(solution, section, links, solutionPage, index = 0) {
  const tag = solution.meta.product ?? solution.title
  const headingSize = section.heading.length > 60 ? 28 : section.heading.length > 30 ? 34 : 40
  const cards = links.map(link => solutionPage
    ? `<article class="pair-map"><div class="pair-problem"><span class="pair-id">${esc(link.id)} · ${esc(link.painBasis && link.painBasis !== 'explicit' ? painBasisLabel(link) : '客户挑战')}${link.continued ? '（续）' : ''}</span><h3>${esc(link.pain)}</h3>${solution.external ? '' : `<p class="source-evidence">依据：${esc(link.painEvidence.path)} · ${esc(link.painEvidence.quote)}</p>`}</div><span class="pair-arrow" aria-hidden="true"></span><div class="pair-answer"><span class="pair-id">${esc(link.id)} · 对应方案${link.continued ? '（续）' : ''}</span><h3>${esc(link.solution)}</h3>${solution.external ? '' : `<p class="source-evidence">依据：${esc(link.solutionEvidence.path)} · ${esc(link.solutionEvidence.quote)}</p>`}</div></article>`
    : `<article class="pain-card"><span class="pair-id">${esc(link.id)} · ${esc(link.painBasis && link.painBasis !== 'explicit' ? painBasisLabel(link) : '客户痛点')}${link.continued ? '（续）' : ''}</span><h3>${esc(link.pain)}</h3>${solution.external ? '' : `<p class="source-evidence">材料依据：${esc(link.painEvidence.path)} · ${esc(link.painEvidence.quote)}</p>`}</article>`).join('\n')
  return `<section class="slide linked-slide ${solutionPage ? 'solution-links' : 'pain-links'}${index % 2 ? ' pair-stacked' : ''}">
  <div class="header"><div class="tag">${esc(tag)}</div></div>
  <div class="head"><h2 style="font-size:${headingSize}px">${esc(section.heading)}</h2></div>
  <div class="linked-body">${cards}</div>
  <div class="footer"><span class="brand">${esc(solution.meta.company ?? '')}</span><span></span></div>
</section>`
}

function closingSlide(solution, t) {
  return `<section class="slide closing">
  <div>
    <h2>期待与您共同推进下一步</h2>
    <p>${esc([solution.meta.company, solution.meta.version, solution.meta.contact].filter(Boolean).join(' · '))}</p>
  </div>
</section>`
}

/**
 * 渲染售前解决方案 HTML(集团模板幻灯片风格)。
 * @param {object} solution - normalizeSolution 产物。
 * @param {Array<{sourcePath: string, fileName: string, caption?: string}>} assets - 已复制的图片素材。
 * @returns {string} 完整 HTML 文档。
 */
export function renderHtml(solution, assets, options = {}) {
  const preview = options.externalPreview
  const t = THEMES[solution.theme] ?? THEMES.corporate
  const assetByName = new Map(assets.map(a => [a.sourcePath, a]))
  const features = { hasImage: false }

  const slides = [coverSlide(solution, t)]
  for (let i = 0; i < solution.sections.length; i += 6) {
    slides.push(tocSlide(solution, solution.sections.slice(i, i + 6), i))
  }
  let contentPages = 0
  const recentLayouts = []
  solution.sections.forEach((section, i) => {
    slides.push(dividerSlide(solution, section, i + 1, t))
    if (solution.painSolutionLinks?.length && ['pains', 'solution', 'problem_solution'].includes(section.kind)) {
      for (const [index, link] of solution.painSolutionLinks.flatMap(paginateLink).entries()) {
        slides.push(linkedSlide(solution, section, [link], section.kind !== 'pains', index))
      }
      if (section.kind !== 'problem_solution') return
    }
    for (const pageBlocks of paginateBlocks(section.blocks)) {
      contentPages += 1
      const layout = layoutFor(solution, section, pageBlocks, contentPages, recentLayouts)
      recentLayouts.push(layout)
      if (recentLayouts.length > 2) recentLayouts.shift()
      slides.push(contentSlide(solution, section, i + 1, contentPages, pageBlocks, assetByName, features, layout))
    }
  })
  slides.push(closingSlide(solution, t))

  const sourceToggleScript = solution.external && !preview ? '' : `
  const sourceToggle = document.getElementById('source-toggle');
  if (sourceToggle) sourceToggle.addEventListener('click', () => {
    if (document.body.hasAttribute('data-revision')) { location.href = 'solution.html' + location.search; return; }
    if (document.body.hasAttribute('data-editor-id')) { location.href = 'external-preview.html' + location.search; return; }
    const hidden = document.body.classList.toggle('sources-hidden');
    sourceToggle.textContent = hidden ? '显示来源' : '隐藏来源';
    sourceToggle.setAttribute('aria-pressed', String(hidden));
  });`

  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(solution.title)}</title>
<style>
${cssFor(t, features)}
</style>
</head>
<body${solution.editorId ? ` data-editor-id="${esc(solution.editorId)}"` : ''}${preview ? ` data-editor-id="${esc(preview.editorId)}" data-revision="${esc(preview.revision)}"` : ''}>
<main class="deck">
${slides.join('\n')}
</main>
<nav class="deck-controls" aria-label="幻灯片控制"><button type="button" id="prev-slide" aria-label="上一页">上一页</button><span id="slide-count">纵向浏览</span><button type="button" id="next-slide" aria-label="下一页">下一页</button>${preview ? '<button type="button" id="source-toggle">返回内部稿</button>' : solution.external ? '' : `<button type="button" id="source-toggle" aria-pressed="false">${solution.editorId ? '查看外部稿' : '隐藏来源'}</button>`}${solution.editorId ? '<button type="button" id="edit-toggle" class="edit-toggle">编辑方案</button>' : ''}</nav>
${preview ? `<aside class="release-panel" id="release-panel"><strong>外部稿预览 · 尚未批准外发</strong><p>确认内容、受众和授权后，才能生成可下载的外发文件。规则版本 ${esc(preview.policyVersion)}</p><button type="button" id="release-open">外发检查</button><div id="release-fields" hidden><label>结构已确认 <input id="release-structure" type="checkbox"></label><label>口径 <select id="release-stance"><option value="">请选择</option><option value="verified">已验证事实</option><option value="planned">以规划为主</option><option value="mixed">两者混合</option></select></label><label>目标受众 <input id="release-audience" type="text" placeholder="角色与关注点"></label><label>分发范围 <select id="release-distribution"><option value="">请选择</option><option value="partner">外部合作方</option><option value="public">可公开</option></select></label><label>事实基线已核对 <input id="release-facts" type="checkbox"></label><label>版本 <input id="release-version" type="text" placeholder="例如 V1.0"></label><label>确认人 <input id="release-reviewer" type="text" placeholder="填写姓名，仅留在内部记录"></label><label>客户名称、案例、指标与图片授权已检查 <input id="release-assets" type="checkbox"></label><label>价格、折扣和服务承诺已核对 <input id="release-commercial" type="checkbox"></label><label>强声明已有事实支撑 <input id="release-claims" type="checkbox"></label><fieldset class="release-checklist"><legend>外发前逐项检查</legend><label>无内部残留 <input id="release-no-internal" type="checkbox"></label><label>无未批准内容 <input id="release-approved" type="checkbox"></label><label>规划内容已标状态 <input id="release-planning" type="checkbox"></label><label>商务、责任、风险边界可见 <input id="release-boundaries" type="checkbox"></label><label>无生成痕迹与占位符 <input id="release-no-automation" type="checkbox"></label><label>目录、标题、引用一致 <input id="release-structure-consistent" type="checkbox"></label><label>名称、版本、日期一致 <input id="release-version-consistent" type="checkbox"></label><label>声明强度未升级 <input id="release-strength" type="checkbox"></label><label>问题、方案、价值与必要论证完整 <input id="release-causal-chain" type="checkbox"></label></fieldset><button type="button" id="release-submit">检查并生成外发文件</button><div id="release-result" role="status"></div></div></aside>` : ''}
${solution.editorId ? `<aside id="editor-panel" class="editor-panel" aria-label="编辑方案" hidden>
  <header class="editor-header"><div><strong>编辑方案</strong><span>修改将生成新版本</span></div><button type="button" id="editor-close" aria-label="关闭编辑区">关闭</button></header>
  <div id="editor-status" class="editor-status" role="status">点击“编辑方案”开始</div>
  <div id="editor-fields" class="editor-fields"></div>
  <div class="editor-footer"><label class="editor-check"><input id="editor-fact" type="checkbox">本次修改涉及产品事实，提交知识审核</label>
    <div id="editor-knowledge" class="editor-knowledge" hidden><label>知识范围<select id="editor-scope"><option value="project">项目知识</option><option value="enterprise">企业知识</option></select></label>
      <label>归属 ID<input id="editor-target" type="text" placeholder="待知识库接入后关联"></label>
      <label>修改原因<textarea id="editor-note" rows="2" placeholder="说明需要确认的事实变化"></textarea><span id="editor-note-error" class="editor-inline-error" hidden>请填写事实修改原因，再保存。</span></label></div>
    <button type="button" id="editor-save" disabled>保存并同步文件</button>
    <p>知识事实需审核后才会入库；当前等待知识库接口对接。</p></div>
</aside>` : ''}
${solution.editorId ? '<div id="save-notice" class="save-notice" role="status" hidden></div>' : ''}
<script>
  const slides = document.querySelectorAll('.slide');
  const fitDeck = () => {
    const width = window.innerWidth - (document.body.classList.contains('editor-open') && window.innerWidth > 1100 ? 430 : 0);
    const height = document.body.classList.contains('single-slide') ? window.innerHeight : Infinity;
    document.documentElement.style.setProperty('--deck-scale', Math.min(1, Math.max(0.01, width / 1280), Math.max(0.01, height / 720)));
  };
  fitDeck();
  window.addEventListener('resize', fitDeck);
  slides.forEach((slide, index) => {
    const page = slide.querySelector('.footer span:last-child');
    if (page) page.textContent = (index + 1) + ' / ' + slides.length;
  });
  let active = Number(new URLSearchParams(location.search).get('slide'));
  const counter = document.getElementById('slide-count');
  const show = index => {
    if (index < 1 || index > slides.length) return;
    active = index;
    document.body.classList.add('single-slide');
    fitDeck();
    slides.forEach((slide, position) => slide.classList.toggle('preview-active', position === active - 1));
    counter.textContent = active + ' / ' + slides.length;
    const url = new URL(location.href);
    url.searchParams.set('slide', String(active));
    history.replaceState(null, '', url);
  };
  if (active > 0) show(active);
  document.getElementById('prev-slide').addEventListener('click', () => show(active ? active - 1 : 1));
  document.getElementById('next-slide').addEventListener('click', () => show(active ? active + 1 : 1));
${sourceToggleScript}
  document.addEventListener('keydown', event => {
    if (event.target instanceof Element && event.target.closest('input,textarea,select,[contenteditable]')) return;
    if (['ArrowRight','ArrowDown','PageDown',' '].includes(event.key)) { event.preventDefault(); show(active ? active + 1 : 1); }
    if (['ArrowLeft','ArrowUp','PageUp'].includes(event.key)) { event.preventDefault(); show(active ? active - 1 : 1); }
    if (event.key === 'Home') { event.preventDefault(); show(1); }
    if (event.key === 'End') { event.preventDefault(); show(slides.length); }
  });
</script>
${solution.editorId ? `<script>${EDITOR_SCRIPT}</script>` : ''}
${preview ? `<script>${RELEASE_SCRIPT}</script>` : ''}
</body>
</html>
`
}

function cssFor(t, features) {
  return `:root{
  --deck-scale:1;
  --bg:${t.bg};--slide:${t.slideBg};--ink:${t.ink};--ink2:${t.ink2};--ink3:${t.ink3};
  --hero-ink:${t.coverInk};--hero-muted:${t.heroMuted};
  --red:${t.red};--blue:${t.blue};--blue-dark:${t.blueDark};
  --editor-action-text:${t.editorActionText};--editor-alert:${t.editorAlert};
  --line:${t.line};--soft:${t.soft};--thead:${t.theadBg};--tint:${t.cardTint};--notice:${t.noticeBg};
}
*{box-sizing:border-box;margin:0;padding:0}
html{scroll-snap-type:y proximity;scroll-behavior:smooth}
body{background:var(--bg);font-family:${t.font};color:var(--ink);padding:28px 0;-webkit-font-smoothing:antialiased}
.deck{width:1280px;margin:0 auto;zoom:var(--deck-scale)}
.slide{position:relative;width:1280px;height:720px;margin:0 auto 24px;background:var(--slide);overflow:hidden;box-shadow:0 12px 32px rgba(20,34,48,.12);scroll-snap-align:start;overflow-wrap:anywhere}
.slide *{min-width:0}
.header{position:relative;z-index:20;padding:42px 64px 0}
.header .tag{display:inline-block;max-width:100%;font-size:12px;font-weight:700;letter-spacing:.08em;color:var(--red);overflow-wrap:anywhere}
.head{position:relative;z-index:20;padding:14px 64px 0;max-height:125px;overflow:auto}
.head h2{max-width:1080px;font-size:30px;line-height:1.28;font-weight:750;color:var(--ink);letter-spacing:-.025em;overflow-wrap:anywhere}
.head .lead{margin-top:12px;max-width:1030px;font-size:17px;line-height:1.6;color:var(--ink2)}
.content-slide .head::after,.linked-slide .head::after{content:"";display:block;width:76px;height:2px;margin-top:22px;background:var(--red)}
.body{position:absolute;z-index:20;top:169px;left:0;right:0;bottom:72px;padding:16px 64px 0;display:flex;flex-direction:column;gap:20px;overflow:auto}
.footer{position:absolute;left:64px;right:64px;bottom:24px;display:flex;justify-content:space-between;font-size:12px;color:var(--ink3);padding-top:10px;border-top:1px solid var(--line)}
.footer .brand{color:var(--ink2);font-weight:600}
.grid{display:grid;gap:18px;flex:1;min-height:0}
.g2{grid-template-columns:repeat(2,1fr)}
.g3{grid-template-columns:repeat(3,1fr)}
.card{background:var(--tint);border:1px solid var(--line);border-radius:10px;padding:26px 30px;display:flex;flex-direction:column;overflow-wrap:anywhere}
.card ul{margin-top:2px;padding-left:20px;flex:1}
.card li{font-size:17px;line-height:1.62;color:var(--ink2)}
.card li+li{margin-top:10px}
.card.notice{background:var(--notice)}
.card.notice p{font-size:18px;line-height:1.62;color:var(--ink2)}
.para{font-size:18px;line-height:1.7;color:var(--ink2);max-width:920px;overflow-wrap:anywhere}
.table{width:100%;table-layout:fixed;border-collapse:collapse;background:var(--slide);border:1px solid var(--line)}
.table th{background:var(--thead);color:var(--ink);text-align:left;padding:15px 18px;font-size:16px;border-bottom:1px solid var(--line)}
.table td{border-top:1px solid var(--soft);padding:15px 18px;font-size:16px;line-height:1.6;color:var(--ink2);vertical-align:top}
.table td,.table th{overflow-wrap:anywhere}
.table th:first-child,.table td:first-child{width:90px}
.linked-body{position:absolute;top:169px;left:64px;right:64px;bottom:72px;display:flex;flex-direction:column;gap:18px;overflow:auto}
.pain-card,.pair-map{flex:1;min-height:0;background:var(--tint);border-radius:10px}
.pain-card{padding:34px 44px;display:flex;flex-direction:column;justify-content:center}
.pair-id{display:block;font-size:15px;font-weight:800;color:var(--red);letter-spacing:.035em}
.pain-card h3{margin-top:20px;font-size:25px;line-height:1.32;color:var(--ink);font-weight:750;letter-spacing:-.02em;overflow-wrap:anywhere}
.pain-card p,.pair-map p{margin-top:24px;font-size:16px;line-height:1.6;color:var(--ink2);overflow-wrap:anywhere}
.pair-map{display:grid;grid-template-columns:minmax(0,1fr) 48px minmax(0,1fr);align-items:stretch;background:transparent}
.pair-problem,.pair-answer{padding:26px 32px;display:flex;flex-direction:column;justify-content:center;min-width:0;background:var(--tint);border-radius:10px}
.pair-answer{background:var(--slide);border:1px solid var(--line)}
.pair-answer .pair-id{color:var(--blue-dark)}
.pair-map h3{margin-top:16px;font-size:23px;line-height:1.38;color:var(--ink);font-weight:700;overflow-wrap:anywhere}
.pair-map p{margin-top:18px}
.pair-arrow{display:grid;place-items:center;font-size:28px;color:var(--red);font-weight:700}
.deck-controls{position:fixed;z-index:100;right:24px;bottom:24px;display:flex;align-items:center;gap:10px;padding:8px 10px;background:var(--slide);border:1px solid var(--line);box-shadow:0 6px 18px rgba(0,0,0,.14);font-size:13px}
.deck-controls button{border:1px solid var(--line);background:var(--slide);color:var(--ink);padding:7px 12px;cursor:pointer;font:inherit}
.sources-hidden .source-note,.sources-hidden .source-evidence{display:none!important}
.deck-controls button:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
@media(max-width:560px){.deck-controls{left:8px;right:8px;bottom:8px;justify-content:center;flex-wrap:wrap;gap:5px}.deck-controls button{padding:6px 8px}}
.deck-controls .edit-toggle,.editor-footer>button{background:var(--red);color:var(--editor-action-text);border-color:var(--red);font-weight:700}
.editor-panel{position:fixed;z-index:110;top:0;right:0;bottom:0;width:410px;background:var(--slide);box-shadow:-8px 0 30px rgba(0,0,0,.17);display:flex;flex-direction:column;color:var(--ink);font-size:14px}
.editor-panel[hidden]{display:none}
.editor-header{display:flex;justify-content:space-between;align-items:center;gap:16px;padding:18px 20px;border-bottom:1px solid var(--line)}
.editor-header strong{display:block;font-size:19px}.editor-header span{display:block;margin-top:3px;color:var(--ink2);font-size:12px}
.editor-header button{padding:7px 10px;background:var(--slide);color:var(--ink);border:1px solid var(--line);cursor:pointer}
.editor-status{padding:11px 20px;background:var(--tint);color:var(--ink2);line-height:1.45;font-size:12px}
.editor-status[data-kind=error]{background:var(--notice);color:var(--editor-alert)}
.editor-status[data-kind=success]{color:var(--blue-dark)}
.editor-status[data-kind=warning]{color:var(--editor-alert)}
.editor-fields{flex:1;overflow:auto;padding:18px 20px 32px;scrollbar-color:var(--ink3) transparent}
.editor-field{display:block;margin:14px 0;color:var(--ink2);font-size:12px;font-weight:600}
.editor-field>span{display:block;margin-bottom:6px}
.editor-field input,.editor-field textarea,.editor-footer input[type=text],.editor-footer textarea,.editor-footer select{display:block;width:100%;padding:9px 10px;background:var(--slide);color:var(--ink);border:1px solid var(--line);border-radius:4px;font:inherit;line-height:1.45;outline:none}
.editor-field textarea{min-height:70px;resize:vertical}
.editor-field input:focus,.editor-field textarea:focus,.editor-footer input:focus,.editor-footer textarea:focus,.editor-footer select:focus{border-color:var(--blue);box-shadow:0 0 0 2px var(--soft)}
.editor-field input[type=file]{padding:7px;font-size:12px}
.editor-section{border-top:1px solid var(--line);padding:13px 0}
.editor-section summary{cursor:pointer;color:var(--ink);font-size:14px;font-weight:700;line-height:1.45}
.editor-section summary:focus-visible,.editor-header button:focus-visible,.editor-footer button:focus-visible{outline:3px solid var(--blue);outline-offset:2px}
.editor-block{margin:15px 0 20px;padding:0 0 8px;border-bottom:1px solid var(--soft)}
.editor-block h4{font-size:12px;color:var(--ink);margin:0 0 8px}
.editor-hint{margin:14px 0;color:var(--ink2);font-size:12px;line-height:1.5}
.editor-footer{padding:16px 20px;border-top:1px solid var(--line);background:var(--tint)}
.editor-check{display:flex;align-items:flex-start;gap:8px;line-height:1.4;font-size:12px;font-weight:600}
.editor-check input{margin-top:2px;accent-color:var(--red)}
.editor-knowledge{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:12px}
.editor-knowledge[hidden]{display:none}
.editor-knowledge label{font-size:11px;color:var(--ink2)}
.editor-knowledge label:last-child{grid-column:1/-1}
.editor-knowledge input,.editor-knowledge select,.editor-knowledge textarea{margin-top:5px;font-size:12px}
.editor-inline-error{display:block;margin-top:5px;color:var(--editor-alert);font-size:12px;font-weight:700}
.editor-inline-error[hidden]{display:none}
.editor-footer>button{width:100%;margin-top:12px;padding:10px;border-radius:4px;cursor:pointer}
.editor-footer>button:disabled{background:var(--thead);border-color:var(--line);color:var(--ink2);cursor:not-allowed}
.editor-footer>p{margin-top:9px;color:var(--ink2);font-size:11px;line-height:1.45}
.save-notice{position:fixed;z-index:105;left:20px;bottom:20px;max-width:min(520px,calc(100vw - 40px));padding:12px 15px;background:var(--slide);color:var(--ink);box-shadow:0 6px 18px rgba(0,0,0,.18);font-size:13px;line-height:1.5}
.save-notice[hidden]{display:none}.save-notice[data-kind=error]{color:var(--editor-alert)}.save-notice[data-kind=warning]{color:var(--editor-alert)}
body.editor-open .deck{margin-left:12px;margin-right:430px}
body.editor-open .deck-controls{right:434px}
@media(max-width:1100px){.editor-panel{width:100%;max-width:none}.editor-open .deck{margin:0 auto}.editor-open .deck-controls{display:none}}
.flow{display:grid;gap:10px;flex:0 0 auto}
.step{position:relative;min-height:112px;background:var(--tint);border:1px solid var(--line);border-radius:8px;padding:18px;display:flex;flex-direction:column}
.step:not(:last-child)::after{content:"";position:absolute;right:-9px;top:50%;width:7px;height:7px;border-top:2px solid var(--ink3);border-right:2px solid var(--ink3);transform:rotate(45deg)}
.step i{font-style:normal;font-size:14px;font-weight:800;color:var(--red)}
.step span{margin-top:12px;font-size:16px;line-height:1.55;color:var(--ink2);flex:1}
.metrics{display:grid;gap:14px;flex:0 0 auto}
.metric{background:var(--tint);border:1px solid var(--line);border-radius:8px;padding:22px 26px}
.metric strong{display:block;font-size:36px;color:var(--red);line-height:1.18}
.metric span{display:block;margin-top:12px;font-size:16px;line-height:1.5;color:var(--ink2)}
.visual{flex:1;min-height:0;background:var(--slide);border:1px solid var(--line);border-radius:8px;padding:12px;display:flex;flex-direction:column}
.visual .frame{flex:1;min-height:0;border-radius:2px;background:var(--tint);display:flex;align-items:center;justify-content:center;overflow:hidden}
.visual img{max-width:100%;max-height:100%;object-fit:contain}
.visual em{margin-top:10px;font-style:normal;font-size:15px;line-height:1.5;color:var(--ink3)}
.toc-slide .head{padding:78px 80px 0}
.toc-slide .head{max-height:140px}
.toc-slide .head h2{font-size:40px}
.toc{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));grid-auto-rows:minmax(82px,auto);align-content:start;gap:4px 54px;max-height:505px;overflow:auto;padding:52px 80px 0}
.toc-item{display:grid;grid-template-columns:60px 1fr;align-items:start;padding:15px 0;border-bottom:1px solid var(--line)}
.toc-item .no{font-size:26px;line-height:1.15;color:var(--red);font-variant-numeric:tabular-nums;font-weight:700}
.toc-item strong{display:block;margin-bottom:5px;font-size:19px;line-height:1.4;color:var(--ink)}
.toc-item span{display:block;font-size:14px;line-height:1.55;color:var(--ink2);overflow-wrap:anywhere}
.cover{background:linear-gradient(150deg,${t.coverFrom},${t.coverTo});color:${t.coverInk}}
.cover::after{content:"";position:absolute;left:76px;bottom:110px;width:96px;height:3px;background:var(--red)}
.cover-top{position:absolute;top:62px;left:76px;right:76px;display:flex;justify-content:space-between;align-items:center;color:var(--ink2);font-size:14px;font-weight:700;letter-spacing:.04em}
.cover-top span:last-child{color:var(--red)}
.cover-inner{position:absolute;z-index:10;left:76px;right:76px;top:178px;bottom:126px;overflow:auto}
.cover h1{max-width:1010px;font-size:62px;line-height:1.18;font-weight:800;letter-spacing:-.035em;overflow-wrap:anywhere}
.cover .sub{max-width:900px;margin-top:20px;font-size:22px;line-height:1.5;color:var(--ink2)}
.cover-tags{display:flex;flex-wrap:wrap;gap:10px;margin-top:24px;max-width:900px}
.cover-tags span{background:var(--slide);border:1px solid var(--line);border-radius:4px;padding:9px 13px;font-size:14px;color:var(--ink2)}
.cover-bottom{position:absolute;left:76px;right:76px;bottom:62px;display:flex;justify-content:space-between;gap:20px;font-size:15px;color:var(--ink2);overflow-wrap:anywhere}
.divider{background:linear-gradient(150deg,${t.dividerFrom},${t.dividerTo});color:${t.dividerInk};display:flex;align-items:center}
.divider .inner{padding:0 100px 4px;max-width:1100px;max-height:600px;overflow:auto}
.divider .chap{font-size:18px;color:var(--red);font-weight:800;letter-spacing:.12em}
.divider h2{margin:26px 0 0;font-size:44px;line-height:1.25;font-weight:800;letter-spacing:-.03em;overflow-wrap:anywhere}
.divider p{max-width:860px;margin-top:26px;font-size:22px;line-height:1.6;color:var(--ink2)}
.closing{background:linear-gradient(150deg,${t.closingFrom},${t.closingTo});color:${t.closingInk};display:flex;align-items:center;justify-content:center;text-align:center}
.closing h2{font-size:40px}
.closing p{margin-top:22px;font-size:20px;color:var(--ink2)}
@media print{
  html{scroll-snap-type:none;scroll-behavior:auto}
  body{padding:0;background:#fff}
  .deck{width:auto;zoom:1}
  .slide{margin:0;box-shadow:none;page-break-after:always;break-after:page;scroll-snap-align:none}
  .deck-controls,.editor-panel,.save-notice{display:none!important}
  @page{size:1280px 720px;margin:0}
}
body.single-slide{padding:0;background:var(--bg)}
body.single-slide:not(.editor-open){min-height:100vh;display:flex;align-items:center;justify-content:center}
body.single-slide .deck{width:1280px;margin:0 auto}
body.single-slide .slide{display:none}
body.single-slide .slide.preview-active{display:block;margin:0;box-shadow:none}
body.single-slide .slide.closing.preview-active{display:flex}
@media print{body.single-slide{display:block!important;min-height:0;background:#fff}body.single-slide .slide{display:block}body.single-slide .slide.closing{display:flex}}
/* 售前页型：用内容关系决定版式，字体角色和图形只服务于阅读顺序。 */
.cover::after{display:none}
.cover-top{top:42px;left:76px;right:76px;padding-bottom:18px;border-bottom:1px solid color-mix(in srgb,var(--hero-ink) 25%,transparent);color:var(--hero-muted);font-size:14px;letter-spacing:0}
.cover-top span:last-child{color:var(--hero-muted);font-weight:500}
.cover-grid{position:absolute;inset:142px 76px 124px;display:grid;grid-template-columns:minmax(0,1fr) 160px;gap:70px;min-height:0}
.cover-main{display:flex;flex-direction:column;justify-content:center;min-width:0;overflow:auto}
.cover h1{max-width:100%;font-weight:760;line-height:1.13;color:var(--hero-ink);letter-spacing:-.032em;text-wrap:balance}
.cover .sub{max-width:850px;margin-top:30px;font-size:23px;line-height:1.5;color:var(--hero-muted)}
.cover-geometry{position:relative;align-self:center;height:282px;border-left:1px solid color-mix(in srgb,var(--hero-ink) 34%,transparent)}
.cover-geometry::before{content:"";position:absolute;left:-5px;top:50%;width:9px;height:9px;background:var(--red);transform:translateY(-50%)}
.cover-geometry span{position:absolute;left:0;height:1px;background:color-mix(in srgb,var(--hero-ink) 30%,transparent)}
.cover-geometry span:nth-child(1){top:16%;width:95px}.cover-geometry span:nth-child(2){top:50%;width:145px;background:var(--red)}
.cover-geometry span:nth-child(3){top:84%;width:70px}
.cover-bottom{left:76px;right:76px;bottom:44px;padding-top:18px;border-top:1px solid color-mix(in srgb,var(--hero-ink) 25%,transparent);color:var(--hero-muted);font-size:13px}
.toc{grid-template-columns:1fr;gap:0;max-width:1100px;padding-top:28px;max-height:520px}
.toc-item{grid-template-columns:74px 1fr;min-height:72px;padding:12px 0}
.toc-item .no{font-size:19px;font-weight:550}
.toc-item strong{font-size:22px;font-weight:600}
.divider .inner{position:relative;padding-left:100px}
.divider .chap{font-size:84px;line-height:1;font-weight:700;letter-spacing:-.045em;color:var(--hero-muted);opacity:.5}
.divider h2{max-width:940px;margin-top:16px;font-size:62px;color:var(--hero-ink);text-wrap:balance}
.divider p{color:var(--hero-muted)}
.content-slide .head::after,.linked-slide .head::after{width:48px;margin-top:17px}
.content-slide .head,.linked-slide .head{max-height:160px}
.content-slide .head h2,.linked-slide .head h2{line-height:1.17;letter-spacing:-.028em;text-wrap:balance}
.content-slide .head .lead{font-size:18px;line-height:1.48;max-width:900px;margin-top:15px}
.content-slide .body{top:196px;gap:18px;padding-top:12px}
.linked-body{top:196px}
.statement-slide .body{display:grid;grid-template-columns:minmax(0,1.55fr) minmax(0,.65fr);align-items:center;gap:66px;padding-top:0}
.statement-slide .body:has(> :only-child){grid-template-columns:minmax(0,850px)}
.sources-hidden .statement-slide .body{grid-template-columns:minmax(0,1fr)}
.statement-slide .para{font-size:35px;line-height:1.46;letter-spacing:-.02em;font-weight:620;text-wrap:pretty}
.statement-slide .source-note{align-self:center;border-top:2px solid var(--red);padding-top:19px}
.statement-slide .source-note p{max-height:200px;font-size:15px;line-height:1.58}
.para{max-width:1000px;font-size:21px;line-height:1.58;color:var(--ink);font-weight:480;text-wrap:pretty}
.source-note{max-width:1030px;padding-top:10px;border-top:1px solid var(--line);color:var(--ink2)}
.source-note strong{display:block;font-size:12px;font-weight:700;color:var(--ink3)}
.source-note p{margin-top:5px;font-size:13px;line-height:1.48;color:var(--ink2);max-height:62px;overflow:auto}
.editorial-quote{padding:18px 0;border-top:1px solid var(--line);font-size:20px;line-height:1.55;color:var(--ink2)}
.card,.card.notice{background:transparent;border:0;border-top:1px solid var(--line);border-radius:0;padding:16px 0}
.card li{font-size:19px;line-height:1.55;color:var(--ink);text-wrap:pretty}
.card li+li{margin-top:9px}
.grid{gap:30px}
.capability-slide .bullets{list-style:none;padding:0;counter-reset:capability}
.capability-slide .bullets li{display:grid;grid-template-columns:48px minmax(0,1fr);gap:18px;align-items:start;counter-increment:capability;padding:13px 0;border-bottom:1px solid var(--line)}
.capability-slide .bullets li::before{content:counter(capability,decimal-leading-zero);font-size:16px;font-weight:750;line-height:1.5;color:var(--blue-dark);font-variant-numeric:tabular-nums}
.process-slide .flow{position:relative;gap:0;margin-top:14px;border-top:1px solid var(--line)}
.process-slide .step{background:transparent;border:0;border-radius:0;min-height:168px;padding:30px 26px 12px 0}
.process-slide .step::before{content:"";position:absolute;top:-5px;left:0;width:9px;height:9px;background:var(--red)}
.process-slide .step:not(:last-child)::after{right:18px;top:-5px;width:9px;height:9px;border-color:var(--red)}
.process-slide .step i{font-size:31px;line-height:1;color:var(--red);font-variant-numeric:tabular-nums}
.process-slide .step span{margin-top:22px;font-size:20px;line-height:1.45;color:var(--ink)}
.metric{background:transparent;border:0;border-top:1px solid var(--line);border-radius:0;padding:26px 0}
.metric strong{font-size:46px;line-height:1.1;color:var(--ink);font-variant-numeric:tabular-nums}
.metric span{font-size:18px;color:var(--ink2)}
.evidence-slide .visual{border:0;padding:0;background:transparent}
.evidence-slide .visual .frame{border:1px solid var(--line);background:var(--tint)}
.pair-problem,.pair-answer,.pain-card{border-radius:0;background:transparent;border:0;border-top:1px solid var(--line)}
.pair-answer{border-top-color:var(--blue)}
.pair-arrow{position:relative;font-size:0}
.pair-arrow::before{content:"";position:absolute;left:4px;right:12px;top:50%;height:2px;background:var(--red)}
.pair-arrow::after{content:"";position:absolute;right:10px;top:calc(50% - 5px);width:9px;height:9px;border-top:2px solid var(--red);border-right:2px solid var(--red);transform:rotate(45deg)}
.layout-statement-right .body{grid-template-columns:minmax(0,.68fr) minmax(0,1.45fr)}
.layout-statement-right .body>.para{grid-column:2;grid-row:1}
.layout-statement-right .body>.source-note{grid-column:1;grid-row:1}
.layout-statement-right .body:has(> :only-child)>.para{grid-column:1 / -1}
.layout-statement-center .head{text-align:center}
.layout-statement-center .head h2,.layout-statement-center .head .lead{margin-left:auto;margin-right:auto}
.layout-statement-center .head::after{margin-left:auto;margin-right:auto}
.layout-statement-center .body{align-items:center;justify-content:center}
.layout-statement-center .para{text-align:center;max-width:820px}
.layout-process-right .flow{display:grid!important;grid-template-columns:1fr!important;border-top:0;margin:0;gap:0}
.layout-process-right .flow::before{content:"";position:absolute;left:22px;top:32px;bottom:32px;width:1px;background:var(--line)}
.layout-process-right .step{display:grid;grid-template-columns:78px minmax(0,1fr);align-items:center;min-height:0;padding:14px 0;border-bottom:1px solid var(--line)}
.layout-process-right .step::before,.layout-process-right .step::after{display:none}
.layout-process-right .step i{position:relative;z-index:1;width:45px;height:45px;display:grid;place-items:center;background:var(--slide);border:1px solid var(--red);border-radius:50%;font-size:17px}
.layout-process-right .step span{margin:0;font-size:19px}
.layout-process-staggered .flow{display:grid!important;grid-template-columns:repeat(2,minmax(0,1fr))!important;gap:8px 48px;border-top:0}
.layout-process-staggered .step{min-height:0;padding:18px 0 18px 62px;border-top:1px solid var(--line)}
.layout-process-staggered .step::before{display:none}
.layout-process-staggered .step:not(:last-child)::after{display:none}
.layout-process-staggered .step i{position:absolute;left:0;top:18px;font-size:18px}
.layout-process-staggered .step span{margin:0;font-size:18px}
.layout-capability-left .body .card .bullets{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:20px 36px;align-content:start}
.layout-capability-left .body .card .bullets li{display:block;padding:18px 0;border-top:1px solid var(--line);border-bottom:0;font-size:20px}
.layout-capability-left .body .card .bullets li::before{display:block;margin-bottom:12px}
.layout-capability-right .body>.grid{grid-template-columns:1fr!important;gap:4px}
.layout-capability-right .card{padding:6px 0 16px}
.layout-capability-band .body>.grid{grid-template-columns:repeat(2,minmax(0,1fr));gap:0 44px}
.layout-capability-band .body>.grid .card{align-self:start;border-top:2px solid var(--blue);padding:18px 0;background:transparent}
.layout-capability-band .body>.grid .card:nth-child(2n){border-top-color:var(--red)}
.layout-capability-band .body .bullets li{font-size:18px;line-height:1.52}
.layout-editorial-right .body{display:grid;grid-template-columns:minmax(0,1.45fr) minmax(0,.75fr);align-content:start;gap:24px 44px}
.layout-editorial-right .body>.source-note{grid-column:2;align-self:start}
.layout-editorial-right .body>.grid,.layout-editorial-right .body>.table{grid-column:1 / -1}
.layout-editorial-right .body>.para{grid-column:1}
.layout-editorial-led .body{display:grid;grid-template-columns:repeat(12,minmax(0,1fr));align-content:start;gap:18px 28px}
.layout-editorial-led .body>.para:first-child{grid-column:1 / -1;max-width:1050px;font-size:25px;line-height:1.5;color:var(--ink);font-weight:600}
.layout-editorial-led .body>.source-note{grid-column:1 / 5;align-self:start}
.layout-editorial-led .body>.para:not(:first-child),.layout-editorial-led .body>.card{grid-column:5 / -1}
.layout-editorial-led .body>.table,.layout-editorial-led .body>.visual,.layout-editorial-led .body>.flow{grid-column:1 / -1}
.layout-evidence-left .body,.layout-evidence-right .body{display:grid;grid-template-columns:minmax(0,1.2fr) minmax(0,.8fr);align-items:center;gap:36px}
.layout-evidence-left .body>.visual{grid-column:1;grid-row:1 / span 3}
.layout-evidence-left .body>.source-note{grid-column:2}
.layout-evidence-right .body{grid-template-columns:minmax(0,.8fr) minmax(0,1.2fr)}
.layout-evidence-right .body>.visual{grid-column:2;grid-row:1 / span 3}
.layout-evidence-right .body>.source-note{grid-column:1}
.layout-evidence-full .body{display:grid;grid-template-rows:minmax(0,1fr) auto;justify-items:center;gap:14px}
.layout-evidence-full .body>.visual{height:100%;width:min(100%,1040px)}
.layout-evidence-full .body>.visual .frame{height:100%}
.pair-stacked .pair-map{grid-template-columns:1fr;grid-template-rows:minmax(0,1fr) minmax(0,1fr);gap:20px}
.pair-stacked .pair-arrow{display:none}
.pair-stacked .pair-problem,.pair-stacked .pair-answer{padding:16px 28px}
.pair-stacked .pair-map h3{margin-top:8px;font-size:21px}
.pair-stacked .pair-map p{margin-top:10px;font-size:13px;line-height:1.45}
.cover-offset .cover-grid{grid-template-columns:160px minmax(0,1fr)}
.cover-offset .cover-main{grid-column:2;grid-row:1}
.cover-offset .cover-geometry{grid-column:1;grid-row:1;transform:scaleX(-1)}
.divider-light{background:var(--slide);color:var(--ink)}
.divider-light .chap{color:var(--red);opacity:1}
.divider-light h2{color:var(--ink)}
.divider-light p{color:var(--ink2)}
.data-chart{display:flex;flex-direction:column;width:100%;height:100%;min-height:0;gap:18px;margin:0}
.data-chart figcaption{display:flex;justify-content:space-between;gap:24px;align-items:baseline;border-bottom:1px solid var(--line);padding-bottom:14px}
.data-chart figcaption h3{font-size:25px;line-height:1.25;font-weight:740;color:var(--ink)}
.data-chart figcaption span{font-size:14px;color:var(--ink2);white-space:nowrap}
.chart-bars{display:flex;flex-direction:column;justify-content:center;gap:14px;flex:1;min-height:0}
.chart-row{display:grid;grid-template-columns:170px minmax(0,1fr) 150px;align-items:center;gap:24px;min-height:45px}
.chart-label{font-size:17px;color:var(--ink);overflow-wrap:anywhere}
.chart-track{height:20px;background:var(--tint);overflow:hidden}
.chart-track span{display:block;height:100%;background:var(--blue)}
.chart-row strong{text-align:right;font-size:19px;font-weight:720;color:var(--ink);font-variant-numeric:tabular-nums}
.chart-line{flex:1;min-height:0;display:flex;flex-direction:column;justify-content:center}
.chart-line svg{width:100%;height:245px;overflow:visible}
.chart-base{stroke:var(--line);stroke-width:2}
.chart-path{fill:none;stroke:var(--blue);stroke-width:5;stroke-linecap:round;stroke-linejoin:round}
.chart-dot{fill:var(--red);stroke:var(--slide);stroke-width:3}
.chart-axis{display:grid;gap:12px;margin:4px 0 0 0}
.chart-axis div{text-align:center;display:flex;flex-direction:column;gap:6px;min-width:0}
.chart-axis span{font-size:15px;color:var(--ink2);overflow-wrap:anywhere}
.chart-axis strong{font-size:18px;color:var(--ink);font-variant-numeric:tabular-nums}
.chart-source{font-size:12px;line-height:1.45;color:var(--ink2);border-top:1px solid var(--line);padding-top:10px;max-height:55px;overflow:auto;overflow-wrap:anywhere}
.closing h2{color:var(--hero-ink)}
.closing p{color:var(--hero-muted)}
.release-panel{position:fixed;z-index:101;right:20px;top:20px;width:min(360px,calc(100vw - 40px));max-height:calc(100vh - 40px);overflow:auto;padding:18px;background:var(--slide);border:1px solid var(--line);box-shadow:0 12px 32px rgba(0,0,0,.18);font-size:14px;line-height:1.5}
.release-panel>strong{display:block;font-size:16px}.release-panel>p{margin:7px 0 12px;color:var(--ink2)}
.release-panel button{padding:9px 12px;border:1px solid var(--line);background:var(--tint);color:var(--ink);cursor:pointer}
.release-checklist{margin:6px 0;padding:10px;border:1px solid var(--line);display:grid;gap:9px}.release-checklist legend{padding:0 5px;font-weight:700}.release-checklist label{font-size:13px}
.release-panel button:focus-visible,.release-panel input:focus-visible,.release-panel select:focus-visible{outline:2px solid var(--blue)}
#release-fields{display:grid;gap:10px;margin-top:15px}#release-fields[hidden]{display:none}
#release-fields label{display:grid;gap:4px}#release-fields input[type=text],#release-fields select{width:100%;padding:8px;border:1px solid var(--line);background:var(--slide);color:var(--ink)}
#release-fields label:has(>input[type=checkbox]){display:flex;flex-direction:row-reverse;justify-content:flex-end;align-items:center;gap:9px;min-height:24px}
#release-fields input[type=checkbox]{width:18px;height:18px}#release-result{overflow-wrap:anywhere}#release-result ul{padding-left:20px}#release-result a{display:inline-block;margin:8px 10px 0 0;color:var(--blue-dark)}
::selection{background:var(--blue);color:#fff}
@media print{.cover,.divider,.closing{-webkit-print-color-adjust:exact;print-color-adjust:exact}.release-panel{display:none!important}}`
}
