import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdir, mkdtemp, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import JSZip from 'jszip'
import { renderHtml } from '../src/html.js'
import { renderMarkdown } from '../src/markdown.js'
import { renderDocx } from '../src/docx.js'
import { prepareSolution, registerDocument, snapshotInitial, saveDocument } from '../src/editor-store.js'
import { externalPreview, publishExternalRelease } from '../src/external-release.js'
import { loadExternalPolicy, policyPath, restoreExternalPolicy } from '../src/external-policy.js'

const confirmation = {
  structure: true, stance: 'mixed', audience: '客户业务负责人，关注适用场景',
  distribution: 'partner', factBaseline: true, version: 'V1.0', reviewer: '测试确认人',
  assetsApproved: true, commercialApproved: true, claimsApproved: true,
  noInternalResidue: true, noUnapprovedContent: true, planningLabeled: true,
  boundariesVisible: true, noAutomationResidue: true, structureConsistent: true,
  versionConsistent: true, claimStrengthChecked: true, causalChainPreserved: true,
}

test('内部稿保留证据，外发稿去除来源且规则可改可回退', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-external-'))
  const oldHome = process.env.DSH_HOME
  const oldPolicy = process.env.WLYD_PRESALES_EXTERNAL_POLICY
  process.env.DSH_HOME = path.join(dir, 'dsh')
  delete process.env.WLYD_PRESALES_EXTERNAL_POLICY
  try {
    const base = path.join(dir, 'solution')
    const source = prepareSolution({
      title: 'CallWan 解决方案', subtitle: '营销场景', theme: 'corporate',
      meta: { company: '示例企业', product: 'CallWan', version: '内部 V0.1', date: '2026-10-10' },
      painSolutionLinks: [{ id: 'P1', pain: '资料分散', solution: '集中管理', painBasis: 'explicit',
        painEvidence: { path: 'materials/secret.md', quote: '资料分散' },
        solutionEvidence: { path: 'materials/secret.md', quote: '集中管理' } }],
      sections: [
        { kind: 'problem_solution', heading: '资料集中管理可以缩短查找过程', lead: '问题与做法逐项对应', blocks: [
          { type: 'para', text: '统一入口集中管理资料，便于团队查找。' },
          { type: 'quote', text: '来源：materials/secret.md\n集中管理' },
        ] },
        { kind: 'boundary', heading: '适用范围', lead: '', blocks: [
          { type: 'para', text: '待与贵方确认：我们将结合贵方业务场景，进一步确认方案的适用范围与实施方式。' },
          { type: 'image', path: 'solution-assets/sample.png', sourcePath: 'solution-assets/sample.png', caption: '产品界面示意' },
        ] },
      ],
      assets: [{ sourcePath: 'solution-assets/sample.png', fileName: 'solution-assets/sample.png', caption: '产品界面示意' }],
    })
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLytQAAAABJRU5ErkJggg==', 'base64')
    await mkdir(`${base}-assets`)
    await writeFile(`${base}-assets/sample.png`, png)
    const internalAssets = [{ ...source.assets[0], buffer: png }]
    await writeFile(`${base}.json`, JSON.stringify(source))
    await writeFile(`${base}.html`, renderHtml(source, internalAssets))
    await writeFile(`${base}.md`, renderMarkdown(source, internalAssets))
    await writeFile(`${base}.docx`, await renderDocx(source, internalAssets))
    await registerDocument(base, source.editorId)
    await snapshotInitial(base)
    const preview = await externalPreview(source.editorId)
    assert.match(preview.html, /返回内部稿|外部稿预览/u)
    assert.doesNotMatch(preview.html, /materials\/secret\.md/u)
    const blocked = await publishExternalRelease(source.editorId, { baseRevision: 1, confirmation: { ...confirmation, factBaseline: false } })
    assert.ok(blocked.issues.some(item => item.id === 'fact_baseline'))
    const unchecked = await publishExternalRelease(source.editorId, { baseRevision: 1, confirmation: { ...confirmation, noInternalResidue: false } })
    assert.ok(unchecked.issues.some(item => item.id === 'noInternalResidue'))

    const approved = await publishExternalRelease(source.editorId, { baseRevision: 1, confirmation })
    assert.equal(approved.issues, undefined)
    const folder = `${base}.releases/${approved.releaseId}`
    const html = await readFile(path.join(folder, 'solution.html'), 'utf8')
    assert.match(html, /assets\/image-1\.png/u)
    assert.doesNotMatch(html, /solution-assets\/sample\.png/u)
    assert.deepEqual(await readFile(path.join(folder, 'assets/image-1.png')), png)
    const md = await readFile(path.join(folder, 'solution.md'), 'utf8')
    const docx = await readFile(path.join(folder, 'solution.docx'))
    const xml = await JSZip.loadAsync(docx).then(zip => zip.file('word/document.xml').async('string'))
    for (const content of [html, md, xml]) {
      assert.doesNotMatch(content, /materials\/secret\.md|来源：|材料依据|内部 V0\.1|测试确认人/u)
      assert.match(content, /适用范围/u)
      assert.match(content, /V1\.0/u)
      assert.match(content, /实施范围将结合贵方业务场景在项目启动阶段确认/u)
    }
    assert.match(await readFile(`${base}.md`, 'utf8'), /materials\/secret\.md/u)
    const record = JSON.parse(await readFile(path.join(folder, 'release-record.json'), 'utf8'))
    assert.equal(record.sourceRevision, 1)
    assert.equal(record.policyDigest, approved.policyDigest)

    const first = await loadExternalPolicy()
    const changed = { ...first.policy, version: '1.0.1', blockedTerms: [...first.policy.blockedTerms, '集中管理'] }
    await writeFile(policyPath(), JSON.stringify(changed, null, 2))
    const later = await publishExternalRelease(source.editorId, { baseRevision: 1, confirmation })
    assert.ok(later.issues.some(item => item.id === 'internal_term'))
    const restored = await restoreExternalPolicy(first.digest)
    assert.equal(restored.digest, first.digest)
    const afterRestore = await publishExternalRelease(source.editorId, { baseRevision: 1, confirmation })
    assert.equal(afterRestore.policyDigest, first.digest)
    assert.equal(await readFile(path.join(folder, 'solution.md'), 'utf8'), md)
    await saveDocument(source.editorId, { baseRevision: 1, changes: [{ path: 'subtitle', value: '更新版' }] })
    await assert.rejects(publishExternalRelease(source.editorId, { baseRevision: 1, confirmation }), { status: 409 })
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    if (oldPolicy === undefined) delete process.env.WLYD_PRESALES_EXTERNAL_POLICY
    else process.env.WLYD_PRESALES_EXTERNAL_POLICY = oldPolicy
  }
})

test('未解决状态、密钥和未经核实的问题阻止外发', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-external-block-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(dir, 'dsh')
  try {
    const base = path.join(dir, 'solution')
    const source = prepareSolution({
      title: 'CallWan 解决方案', meta: { company: '示例企业' }, theme: 'corporate',
      painSolutionLinks: [{ id: 'P1', pain: '客户流程问题', solution: '统一处理', painBasis: 'public_unverified',
        painEvidence: { path: 'public', quote: '问题' }, solutionEvidence: { path: 'source', quote: '处理' } }],
      sections: [{ kind: 'problem_solution', heading: '客户问题与方案', blocks: [
        { type: 'para', text: '待与贵方确认：API_KEY=topsecretvalue' },
      ] }],
    })
    await writeFile(`${base}.json`, JSON.stringify(source))
    await registerDocument(base, source.editorId)
    const checked = await publishExternalRelease(source.editorId, { baseRevision: 1, confirmation })
    assert.ok(checked.issues.some(item => item.id === 'unverified_basis'))
    assert.ok(checked.issues.some(item => item.id === 'secret'))
    assert.ok(checked.issues.some(item => item.id === 'unresolved'))
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})
