import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { mkdtemp } from 'node:fs/promises'
import path from 'node:path'
import os from 'node:os'
import ExcelJS from 'exceljs'
import { apply } from '../src/index.js'
import { classify, extractBinaryText } from '../src/ingest.js'
import { isUploadRequest, startUpload, resumeUpload, recentFiles } from '../src/upload-flow.js'

const workbookBytes = async () => {
  const book = new ExcelJS.Workbook()
  const sheet = book.addWorksheet('功能清单')
  sheet.addRow(['能力', '说明', '比例'])
  sheet.addRow(['病历质控', '按院区核对病历规则', 0.25])
  sheet.getCell('C2').numFmt = '0%'
  sheet.getCell('A3').value = { formula: '1+2', result: 3 }
  return Buffer.from(await book.xlsx.writeBuffer())
}

test('XLSX 提取保留工作表、行号、中文和缓存公式，不把 XLS 当成 XLSX', async () => {
  assert.equal(classify('资料.xlsx'), 'xlsx')
  assert.equal(classify('资料.xls'), 'other')
  const { text } = await extractBinaryText('xlsx', await workbookBytes())
  assert.match(text, /工作表：功能清单/u)
  assert.match(text, /行 2：病历质控 \| 按院区核对病历规则 \| 25%/u)
  assert.match(text, /行 3：3/u)
})

test('附 XLSX 后说同步，直接调用项目上传，中文文件名与认证正确，不调用模型', async () => {
  const bytes = await workbookBytes()
  const received = []
  const server = createServer(async (req, res) => {
    const send = (value, status = 200) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(value)) }
    try {
      if (req.url === '/api/v1/auth/login') return send({ token: 'test-only-token', active_tenant: { id: 55 } })
      assert.equal(req.headers.authorization, 'Bearer test-only-token')
      assert.equal(req.headers['x-tenant-id'], '55')
      if (req.url === '/api/v1/solutions/projects') return send({ success: true, data: [{ id: 'p1', name: '医疗项目' }] })
      if (req.url === '/api/v1/solutions/projects/p1/knowledge-bases') return send({ success: true, data: [{ knowledge_base_id: 'kb1' }] })
      if (req.url?.startsWith('/api/v1/knowledge-bases') && !req.url.endsWith('/files')) return send({ success: true, data: [{ id: 'kb1', name: '产品资料库' }] })
      if (req.url === '/api/v1/solutions/projects/p1/knowledge-bases/kb1/files') {
        const body = []
        for await (const chunk of req) body.push(chunk)
        const request = new Request('http://test/upload', { method: 'POST', headers: req.headers, body: Buffer.concat(body) })
        const file = (await request.formData()).get('file')
        received.push({ name: file.name, text: await file.text() })
        return send({ success: true, data: { id: 'k1', parse_status: 'completed' } }, 202)
      }
      return send({ success: false, message: 'unhandled route' }, 404)
    } catch (error) { send({ success: false, message: error.message }, 500) }
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const oldHome = process.env.DSH_HOME
  process.env.DSH_HOME = await mkdtemp(path.join(os.tmpdir(), 'wlyd-upload-home-'))
  try {
    const handlers = new Map()
    const definitions = new Map()
    const calls = []
    const ctx = { get(name) { return name === 'attachments' ? this.attachments : undefined },
      attachments: { async *readFileStream(ref) { assert.equal(ref.attachmentId, 'test-ref'); yield bytes } },
      fs: {}, llm: { stream() { throw new Error('同步不得调用模型') } },
      tools: { register(definition) { definitions.set(definition.name, definition) }, async execute(input) {
        calls.push(input.name)
        try { return { isError: false, value: await definitions.get(input.name).execute(input.arguments, input) } }
        catch (error) { return { isError: true, content: [{ type: 'text', text: error.message }] } }
      } }, on(name, callback) { handlers.set(name, callback) }, inject() {}, emit() {},
    }
    apply(ctx, { baseUrl: `http://127.0.0.1:${server.address().port}`, email: 'test@example.com', password: 'fake', tenantId: '55' })
    const message = { id: 'm1', source: { kind: 'user' }, role: 'user', content: [
      { type: 'file', attachment: { attachmentId: 'test-ref', name: '医疗产品.xlsx', bytes: bytes.length } },
      { type: 'text', text: '同步到内容中台' },
    ] }
    const agent = { session: { id: 'upload-test', header: { cwd: process.env.DSH_HOME } } }
    const decision = await handlers.get('agent/pre-step')({ agent, signal: new AbortController().signal },
      async () => ({ kind: 'enter', messages: [message] }))
    assert.deepEqual(calls, ['wlyd_platform_upload'])
    assert.match(decision.messages.at(-1).content[0].text, /资料已上传并解析完成/u)
    assert.equal(received[0].name, '医疗产品.md')
    assert.match(received[0].text, /病历质控/u)
    const reply = []
    for await (const chunk of handlers.get('llm/stream')({ sessionId: 'upload-test' }, () => { throw Error('不应进入模型') })) reply.push(chunk)
    assert.equal(reply.at(-1).reason.kind, 'stop')
  } finally {
    if (oldHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = oldHome
    await new Promise(resolve => server.close(resolve))
  }
})

test('上传意图不把否定句当授权，未指定目标时保留附件并让用户选', async () => {
  assert.equal(isUploadRequest('同步到内容中台'), true)
  assert.equal(isUploadRequest('不要同步到知识库'), false)
  const pending = { stage: 'upload-project', options: [{ id: 'p1', name: 'A' }, { id: 'p2', name: 'B' }], attachments: [] }
  const result = await resumeUpload({}, {}, new AbortController().signal, pending, '不确定', {})
  assert.equal(result.kind, 'question')
  assert.equal(result.pending.stage, 'upload-project')
  const canceled = await resumeUpload({}, {}, new AbortController().signal, pending, '取消', {})
  assert.equal(canceled.kind, 'stopped')
  const missing = await startUpload({}, {}, new AbortController().signal, '同步到内容中台', [], {})
  assert.equal(missing.pending.stage, 'upload-files')
  const ref = { attachmentId: 'earlier-file', name: 'old.xlsx', bytes: 20 }
  const resumed = { session: { deriveMessages: () => [
    { source: { kind: 'user' }, content: [{ type: 'file', attachment: ref }] },
    { source: { kind: 'user' }, content: [{ type: 'text', text: '同步到内容中台' }] },
  ] } }
  assert.deepEqual(await recentFiles(resumed), [ref], '升级前已上传的本会话附件也应能续用')
})
