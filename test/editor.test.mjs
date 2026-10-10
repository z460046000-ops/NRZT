import assert from 'node:assert/strict'
import test from 'node:test'
import { mkdtemp, mkdir, readFile, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createServer } from 'node:http'
import { renderHtml } from '../src/html.js'
import { renderMarkdown } from '../src/markdown.js'
import { renderDocx } from '../src/docx.js'
import { prepareSolution, registerDocument, snapshotInitial, loadDocument, latestKnowledgeStatus, saveDocument } from '../src/editor-store.js'
import { deliverKnowledgeProposal } from '../src/knowledge-adapter.js'
import { registerEditorRoutes } from '../src/editor-routes.js'

test('HTML 修改保存为同版 JSON、Markdown、DOCX，事实变更只进入待对接审核记录', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-editor-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(dir, 'dsh')
  try {
    const baseAbs = path.join(dir, 'runs', 'solution')
    await mkdir(path.dirname(baseAbs), { recursive: true })
    await mkdir(path.join(path.dirname(baseAbs), 'solution-assets'), { recursive: true })
    const image = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64')
    await writeFile(path.join(path.dirname(baseAbs), 'solution-assets', 'old.png'), image)
    const source = prepareSolution({
      title: '原始方案', subtitle: '初稿', meta: { company: '示例企业' }, theme: 'corporate',
      generatedAt: '2026-10-08T00:00:00.000Z',
      painSolutionLinks: [{ id: 'P1', pain: '资料分散', solution: '集中管理',
        painEvidence: { path: 'a.md', quote: '资料分散' }, solutionEvidence: { path: 'a.md', quote: '集中管理' } }],
      sections: [
        { kind: 'pains', heading: '客户痛点', blocks: [{ type: 'table', headers: ['编号', '客户痛点', '材料依据'], rows: [['P1', '资料分散', 'a.md：资料分散']] }] },
        { kind: 'solution', heading: '解决方案', blocks: [{ type: 'table', headers: ['编号', '方案', '材料依据'], rows: [['P1', '集中管理', 'a.md：集中管理']] }] },
        { kind: 'boundary', heading: '边界', blocks: [{ type: 'para', text: '原始边界' }, { type: 'image', path: 'solution-assets/old.png', caption: '旧图' }] },
      ],
      assets: [{ sourcePath: 'solution-assets/old.png', fileName: 'solution-assets/old.png', caption: '旧图' }],
    })
    const initialAssets = [{ ...source.assets[0], buffer: image }]
    await writeFile(`${baseAbs}.json`, JSON.stringify(source))
    await writeFile(`${baseAbs}.md`, renderMarkdown(source, initialAssets))
    await writeFile(`${baseAbs}.html`, renderHtml(source, initialAssets))
    await writeFile(`${baseAbs}.docx`, await renderDocx(source, initialAssets))
    await registerDocument(baseAbs, source.editorId)
    await snapshotInitial(baseAbs)

    const result = await saveDocument(source.editorId, {
      baseRevision: 1,
      changes: [
        { path: 'title', value: '人工修改后的方案' },
        { path: 'links/P1/pain', value: '资料分散且版本不清' },
        { path: `blocks/${source.sections[2].blocks[0].id}/text`, value: '人工确认边界' },
      ],
      replacements: [{ blockId: source.sections[2].blocks[1].id, data: image.toString('base64') }],
      knowledge: { factChange: true, scope: 'project', targetId: 'project-1', reason: '更新客户问题' },
    })
    assert.equal(result.revision, 2)
    assert.equal(result.knowledge.status, 'awaiting_knowledge_api')
    const saved = (await loadDocument(source.editorId)).solution
    assert.equal(saved.title, '人工修改后的方案')
    assert.equal(saved.sections[0].blocks[0].rows[0][1], '资料分散且版本不清')
    assert.equal(saved.sections[2].blocks[0].text, '人工确认边界')
    assert.deepEqual(saved.knowledgeProposals, [{ id: result.knowledge.id, materialRevision: 2 }])
    assert.notEqual(saved.sections[2].blocks[1].path, 'solution-assets/old.png')
    assert.deepEqual(await readFile(path.join(path.dirname(baseAbs), saved.sections[2].blocks[1].path)), image)
    assert.match(await readFile(`${baseAbs}.md`, 'utf8'), /资料分散且版本不清/)
    assert.match(await readFile(`${baseAbs}.html`, 'utf8'), /人工修改后的方案/)
    assert.equal((await readFile(`${baseAbs}.docx`))[0], 0x50)
    assert.equal(JSON.parse(await readFile(`${baseAbs}.versions/1/solution.json`, 'utf8')).title, '原始方案')
    assert.equal(JSON.parse(await readFile(`${baseAbs}.versions/2/solution.json`, 'utf8')).revision, 2)
    const proposal = JSON.parse(await readFile(`${baseAbs}.knowledge-proposals/${result.knowledge.id}.json`, 'utf8'))
    assert.equal(proposal.status, 'awaiting_knowledge_api')
    assert.equal(proposal.targetId, 'project-1')
    await assert.rejects(saveDocument(source.editorId, { baseRevision: 1, changes: [{ path: 'title', value: '覆盖他人' }] }), { status: 409 })
    assert.equal((await loadDocument(source.editorId)).solution.title, '人工修改后的方案')
    const wording = await saveDocument(source.editorId, {
      baseRevision: 2, changes: [{ path: 'subtitle', value: '只修改表达' }], knowledge: { factChange: false },
    })
    assert.equal(wording.revision, 3)
    assert.equal((await latestKnowledgeStatus(baseAbs, (await loadDocument(source.editorId)).solution)).status, 'not_requested')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})

test('知识接口可用时只提交审核请求，不直接发布知识', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-knowledge-'))
  const file = path.join(dir, 'proposal.json')
  await writeFile(file, JSON.stringify({ id: 'proposal-1', status: 'awaiting_knowledge_api', targetId: 'project-1' }))
  let received
  const server = createServer(async (req, res) => {
    let body = ''
    for await (const chunk of req) body += chunk
    received = { method: req.method, key: req.headers['idempotency-key'], body: JSON.parse(body) }
    res.writeHead(202, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify({ requestId: 'review-1' }))
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const oldUrl = process.env.WLYD_KNOWLEDGE_PROPOSAL_URL
  process.env.WLYD_KNOWLEDGE_PROPOSAL_URL = `http://127.0.0.1:${server.address().port}/review`
  try {
    const proposal = await deliverKnowledgeProposal(file)
    assert.equal(proposal.status, 'submitted_for_review')
    assert.equal(proposal.remoteRequestId, 'review-1')
    assert.deepEqual(received, { method: 'POST', key: 'proposal-1', body: { id: 'proposal-1', status: 'awaiting_knowledge_api', targetId: 'project-1' } })
  } finally {
    if (oldUrl === undefined) delete process.env.WLYD_KNOWLEDGE_PROPOSAL_URL
    else process.env.WLYD_KNOWLEDGE_PROPOSAL_URL = oldUrl
    await new Promise(resolve => server.close(resolve))
  }
})

test('方案预览、源稿和 Word 使用同一受保护地址打开或下载', async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'wlyd-delivery-'))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = path.join(dir, 'dsh')
  let server
  try {
    const base = path.join(dir, 'solution')
    const solution = prepareSolution({ title: '交付测试方案', meta: {}, theme: 'corporate',
      sections: [{ kind: 'capabilities', heading: '内容管理能力', blocks: [{ type: 'para', text: '统一管理资料。' }] }],
      painSolutionLinks: [], generatedAt: new Date().toISOString() })
    await writeFile(`${base}.json`, JSON.stringify(solution))
    await writeFile(`${base}.html`, renderHtml(solution, []))
    await writeFile(`${base}.md`, renderMarkdown(solution, []))
    await writeFile(`${base}.docx`, await renderDocx(solution, []))
    await mkdir(`${base}-assets`, { recursive: true })
    await writeFile(path.join(`${base}-assets`, 'old.png'), Buffer.from('image-bytes'))
    solution.assets = [{ fileName: 'solution-assets/old.png' }]
    await writeFile(`${base}.json`, JSON.stringify(solution))
    await registerDocument(base, solution.editorId)
    let route
    const api = new Map()
    registerEditorRoutes({
      connection: { fetch: { register(definition) { api.set(definition.path, definition) } }, requestRejection(req) { return req.headers['x-deny'] ? 401 : undefined } },
      webServer: { register(definition) { route = definition; return () => {} } },
      effect(callback) { callback() },
    })
    server = createServer((req, res) => route.handler(req, res))
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
    const prefix = `http://127.0.0.1:${server.address().port}/wlyd-presales/doc/${solution.editorId}`
    for (const file of ['solution.html', 'external-preview.html', 'preview.svg', 'solution.md', 'solution.docx', 'solution.json', 'solution-assets/old.png']) {
      const response = await fetch(`${prefix}/${file}`)
      assert.equal(response.status, 200, file)
      assert.ok((await response.arrayBuffer()).byteLength > 0)
      if (['solution.md', 'solution.docx', 'solution.json'].includes(file)) {
        assert.match(response.headers.get('content-disposition'), /attachment/)
      }
    }
    const release = await api.get('/api/wlyd-presales/release').fetch(new Request('http://localhost/api/wlyd-presales/release', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ id: solution.editorId, baseRevision: 1, confirmation: {
        structure: true, stance: 'verified', audience: '客户负责人', distribution: 'partner',
        factBaseline: true, version: 'V1.0', reviewer: '测试确认人', assetsApproved: true,
        commercialApproved: true, claimsApproved: true,
        noInternalResidue: true, noUnapprovedContent: true, planningLabeled: true,
        boundariesVisible: true, noAutomationResidue: true, structureConsistent: true,
        versionConsistent: true, claimStrengthChecked: true, causalChainPreserved: true,
      } }),
    }))
    assert.equal(release.status, 200)
    const released = await release.json()
    assert.ok(released.releaseId)
    const releasedHtml = await fetch(`http://127.0.0.1:${server.address().port}${released.urls.html}`)
    assert.equal(releasedHtml.status, 200)
    assert.doesNotMatch(await releasedHtml.text(), /编辑方案|查看外部稿|内部稿/u)
    assert.equal((await fetch(`${prefix}/releases/${released.releaseId}/release-record.json`)).status, 404)
    assert.equal((await fetch(`${prefix}/missing.txt`)).status, 404)
    assert.equal((await fetch(`${prefix}/solution.html`, { headers: { 'x-deny': '1' } })).status, 401)
  } finally {
    if (server) await new Promise(resolve => server.close(resolve))
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
  }
})
