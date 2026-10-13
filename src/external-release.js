/** 外发检查与不可变文件快照。内部 JSON、证据和编辑版本始终保留。 */
import { createHash, randomUUID } from 'node:crypto'
import { copyFile, mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { EditorError, loadDocument } from './editor-store.js'
import { externalizeSolution, visibleExternalText } from './external-copy.js'
import { loadExternalPolicy } from './external-policy.js'
import { renderHtml } from './html.js'
import { renderMarkdown } from './markdown.js'
import { renderDocx } from './docx.js'

const RELEASE_ID = /^[a-f0-9-]{36}$/u
const secret = /(?:api[_-]?key|access[_-]?token|password|secret|密码|密钥)\s*[:=：]\s*\S+|\bsk-[A-Za-z0-9_-]{12,}\b/iu
const internalPath = /(?:\/Users\/|presales-runs\/|materials\/|\.\.\/|[A-Za-z]:\\|\bEV-\d+\b|\b[\w-]+\.(?:md|pdf|docx|pptx)\b)/iu
const money = /[¥￥]\s*\d|\d+(?:\.\d+)?\s*(?:元|万元|折)/u

const issue = (id, message, location, reviewable = false) => ({ id, message, reviewable,
  ...(location ? { location } : {}),
  key: createHash('sha256').update(JSON.stringify([id, message, location])).digest('hex').slice(0, 20) })

function locatedText(draft) {
  const fields = []
  const add = (text, field, sectionIndex, sectionHeading = '封面') => {
    if (typeof text === 'string' && text.trim()) fields.push({ text, field, sectionIndex, sectionHeading })
  }
  add(draft.title, 'title'); add(draft.subtitle, 'subtitle')
  Object.entries(draft.meta).forEach(([key, value]) => add(value, `meta/${key}`))
  draft.sections.forEach((section, index) => {
    const root = `sections/${index}`
    add(section.heading, `${root}/heading`, index, section.heading)
    add(section.lead, `${root}/lead`, index, section.heading)
    section.blocks.forEach((block, b) => {
      for (const key of ['text', 'caption', 'title', 'unit']) add(block[key], `${root}/blocks/${b}/${key}`, index, section.heading)
      for (const key of ['items', 'headers', 'rows', 'points']) {
        (block[key] ?? []).flat().forEach((value, n) => {
          const text = typeof value === 'object' ? Object.values(value).join(' ') : String(value)
          add(text, `${root}/blocks/${b}/${key}/${n}`, index, section.heading)
        })
      }
    })
  })
  draft.painSolutionLinks.forEach(link => {
    add(link.pain, `links/${link.id}/pain`, undefined, `问题与做法 ${link.id}`)
    add(link.solution, `links/${link.id}/solution`, undefined, `问题与做法 ${link.id}`)
  })
  return fields
}

function checkRelease(source, draft, policy, confirmation) {
  const problems = []
  const manualChecks = {
    noInternalResidue: '请确认无评审状态、来源路径、证据编号和内部负责人',
    noUnapprovedContent: '请确认客户、案例、指标、商务承诺和图片均获批准',
    planningLabeled: '请确认规划能力与已有能力的状态没有混淆',
    boundariesVisible: '请确认商务、责任及风险边界仍可见',
    noAutomationResidue: '请确认无占位符、生成痕迹和模板表达',
    structureConsistent: '请确认目录、标题层级与引用一致',
    versionConsistent: '请确认各交付文件的名称、版本和日期一致',
    claimStrengthChecked: '请确认改写没有升级声明强度',
    causalChainPreserved: '请确认问题、方案、价值及必要论证仍完整',
  }
  for (const [key, message] of Object.entries(manualChecks)) {
    if (confirmation?.[key] !== true) problems.push(issue(key, message))
  }
  if (confirmation?.structure !== true) problems.push(issue('structure', '请先确认结构已由决策人选定'))
  if (!['verified', 'planned', 'mixed'].includes(confirmation?.stance)) problems.push(issue('stance', '请选择事实与规划口径'))
  if (typeof confirmation?.audience !== 'string' || !confirmation.audience.trim()) problems.push(issue('audience', '请写明目标读者和关注点'))
  if (!['partner', 'public'].includes(confirmation?.distribution)) problems.push(issue('distribution', '请选择可给外部合作方或可公开'))
  if (confirmation?.factBaseline !== true) problems.push(issue('fact_baseline', '请确认每条声明的证据等级与适用边界'))
  if (typeof confirmation?.version !== 'string' || !confirmation.version.trim()) problems.push(issue('version', '请确定本次外发版本'))
  if (typeof confirmation?.reviewer !== 'string' || !confirmation.reviewer.trim()) problems.push(issue('reviewer', '请填写本次确认人'))
  if (confirmation?.assetsApproved !== true) problems.push(issue('assets', '请核对客户信息、案例、指标与图片授权'))

  const text = visibleExternalText(draft)
  for (const field of locatedText(draft)) {
    const matches = policy.blockedTerms.filter(term => field.text.includes(term))
    const unresolved = /(?:待与贵方确认|待确认|待核实|草稿|待定|待补充|第\s*\d+\s*轮)/u.exec(field.text)?.[0]
    if (unresolved && !matches.some(term => term.includes(unresolved))) matches.push(unresolved)
    for (const term of matches) {
      const at = field.text.indexOf(term)
      const location = { field: field.field, sectionIndex: field.sectionIndex, sectionHeading: field.sectionHeading,
        term, excerpt: field.text.slice(Math.max(0, at - 28), at + term.length + 44) }
      problems.push(issue(policy.blockedTerms.includes(term) ? 'internal_term' : 'unresolved',
        `请核对面客措辞：${term}`, location, true))
    }
  }
  if (secret.test(text)) problems.push(issue('secret', '检测到可能的密钥或凭证，须从外发内容中移除'))
  if (internalPath.test(text)) problems.push(issue('path', '检测到文件路径、内部来源编号或资料文件名'))
  if (money.test(text) && confirmation?.commercialApproved !== true) problems.push(issue('commercial', '价格、折扣或金额需要确认批准口径'))
  if (policy.strongClaims.some(term => text.includes(term)) && confirmation?.claimsApproved !== true) {
    problems.push(issue('strong_claim', '强声明需要有事实依据并由确认人检查'))
  }
  const original = visibleExternalText(externalizeSolution(source, new Map()))
  for (const [weaker, stronger] of policy.claimStrengthPairs) {
    if (original.includes(weaker) && !original.includes(stronger) && text.includes(stronger)) {
      problems.push(issue('claim_upgrade', `声明不能从“${weaker}”升级为“${stronger}”`))
    }
  }
  for (const item of source.copyReview ?? []) {
    if (item.status !== 'pending') continue
    const sectionIndex = source.sections.findIndex(section => item.path.includes(`/${section.id}/`) || section.blocks.some(block => item.path.includes(`/${block.id}/`)) ||
      (item.path.startsWith('links/') && ['problem_solution', 'pains', 'solution'].includes(section.kind)))
    problems.push(issue('copy_review', item.placeholder ? '此处尚无实质内容，请补充或确认本次外发范围' : '此处内容尚待校对', {
      field: item.path, sectionIndex, sectionHeading: source.sections[sectionIndex]?.heading ?? '封面',
      excerpt: item.value?.slice(0, 120) || '尚无实质内容', term: '',
    }, true))
  }
  source.sections.forEach((section, sectionIndex) => section.blocks.forEach((block, blockIndex) => {
    if (block.type !== 'image' || !block.visualSuggestion || block.path) return
    problems.push(issue('visual_suggestion', '配图位置尚未放入真实素材；确认后可省略该图外发', {
      field: `sections/${sectionIndex}/blocks/${blockIndex}/image`, sectionIndex,
      sectionHeading: section.heading, excerpt: block.visualSuggestion.focus, term: '',
    }, true))
  }))
  if ((source.painSolutionLinks ?? []).some(link => ['public_unverified', 'user_unverified'].includes(link.painBasis))) {
    problems.push(issue('unverified_basis', '公开资料或用户补充的痛点仍待核实，不能标记为可外发'))
  }
  if (source.sections.some(section => section.blocks.some(block => block.type === 'chart' && block.evidenceStatus !== 'verified'))) {
    problems.push(issue('unverified_chart', '图表数据修改后尚未核对原始资料，不能外发'))
  }
  if (draft.sections.some(section => section.blocks.length === 0 &&
    !(['pains', 'solution', 'problem_solution'].includes(section.kind) && draft.painSolutionLinks.length))) {
    problems.push(issue('empty_section', '清理来源后出现空章节，请补充有依据的正文'))
  }
  return [...new Map(problems.map(item => [item.key, item])).values()]
}

function assetMap(solution, external) {
  const used = new Set(solution.sections.flatMap(section => section.blocks)
    .filter(block => block.type === 'image').map(block => block.sourcePath ?? block.path))
  return new Map((solution.assets ?? []).filter(asset => used.has(asset.sourcePath)).map((asset, index) => [asset.sourcePath,
    external ? `assets/image-${index + 1}${path.extname(asset.fileName).toLowerCase()}` : asset.fileName]))
}

export async function externalPreview(id) {
  const { solution } = await loadDocument(id)
  const { policy, digest } = await loadExternalPolicy()
  const names = assetMap(solution, false)
  return { html: renderHtml(externalizeSolution(solution, names),
    (solution.assets ?? []).map(asset => ({ ...asset, fileName: names.get(asset.sourcePath) })),
    { externalPreview: { editorId: id, revision: solution.revision, policyVersion: `${policy.version} · ${digest.slice(0, 8)}` }, copyReview: solution.copyReview }),
  }
}

/** 失败时只返回问题；成功时生成独立目录，不覆盖内部文件和历史外发文件。 */
export async function publishExternalRelease(id, request) {
  const { baseAbs, solution } = await loadDocument(id)
  if (!Number.isInteger(request?.baseRevision) || request.baseRevision !== solution.revision) {
    throw new EditorError(409, `内部稿已更新到第 ${solution.revision} 版，请刷新外部稿预览`)
  }
  const { policy, digest } = await loadExternalPolicy()
  const names = assetMap(solution, true)
  const draft = externalizeSolution(solution, names)
  const confirmation = request.confirmation ?? {}
  draft.meta.version = typeof confirmation.version === 'string' ? confirmation.version.trim().slice(0, 80) : ''
  draft.meta.date = new Date().toISOString().slice(0, 10)
  const issues = checkRelease(solution, draft, policy, confirmation)
  const acknowledgement = request.acknowledgedIssues
  if (acknowledgement?.keys?.length && acknowledgement.policyDigest !== digest) {
    throw new EditorError(409, '外发规则已更新，请重新核对问题列表')
  }
  const approvedKeys = new Set(Array.isArray(acknowledgement?.keys) ? acknowledgement.keys : [])
  const reviewedIssues = issues.filter(item => item.reviewable && approvedKeys.has(item.key))
  const outstanding = issues.filter(item => !reviewedIssues.includes(item))
  if (outstanding.length) return { issues: outstanding, policyVersion: policy.version, policyDigest: digest }

  const releaseId = randomUUID()
  const folder = `${baseAbs}.releases/${releaseId}`
  const assets = []
  for (const asset of (solution.assets ?? []).filter(item => names.has(item.sourcePath))) {
    const original = asset.fileName
    const allowed = `${path.basename(baseAbs)}-assets/`
    if (typeof original !== 'string' || !original.startsWith(allowed) || original.includes('..')) {
      throw new EditorError(400, '图片路径无效，外发已停止')
    }
    const buffer = await readFile(path.join(path.dirname(baseAbs), original))
    assets.push({ sourcePath: names.get(asset.sourcePath), fileName: names.get(asset.sourcePath),
      caption: asset.caption, buffer, original })
  }
  const outputs = {
    html: renderHtml(draft, assets), md: renderMarkdown(draft, assets),
    docx: await renderDocx(draft, assets),
  }
  if (secret.test(outputs.html) || internalPath.test(visibleExternalText(draft))) {
    throw new EditorError(400, '外发文件仍含内部信息，已停止生成')
  }
  if ((await loadDocument(id)).solution.revision !== solution.revision) {
    throw new EditorError(409, '生成期间内部稿发生修改，请重新检查')
  }
  await mkdir(path.join(folder, 'assets'), { recursive: true, mode: 0o700 })
  for (const asset of assets) await copyFile(path.join(path.dirname(baseAbs), asset.original), path.join(folder, asset.fileName))
  for (const [ext, data] of Object.entries(outputs)) await writeFile(path.join(folder, `solution.${ext}`), data, { flag: 'wx', mode: 0o600 })
  await writeFile(path.join(folder, 'release-record.json'), JSON.stringify({
    releaseId, editorId: id, sourceRevision: solution.revision, createdAt: new Date().toISOString(),
    policyVersion: policy.version, policyDigest: digest,
    fileDigests: Object.fromEntries(Object.entries(outputs).map(([ext, data]) =>
      [`solution.${ext}`, createHash('sha256').update(data).digest('hex')])),
    confirmation, reviewedIssues,
  }, null, 2) + '\n', { flag: 'wx', mode: 0o600 })
  const prefix = `/wlyd-presales/doc/${id}/releases/${releaseId}`
  return { releaseId, policyVersion: policy.version, policyDigest: digest,
    urls: { html: `${prefix}/solution.html`, md: `${prefix}/solution.md`, docx: `${prefix}/solution.docx` } }
}

export function releaseFile(baseAbs, releaseId, file) {
  if (!RELEASE_ID.test(releaseId) || !/^(?:solution\.(?:html|md|docx)|assets\/image-\d+\.(?:png|jpg|jpeg|gif|webp))$/u.test(file)) {
    throw new EditorError(404, '外发文件不存在')
  }
  return path.join(`${baseAbs}.releases`, releaseId, file)
}
