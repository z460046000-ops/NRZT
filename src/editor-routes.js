/** Authenticated DSH Web routes for editing a generated HTML solution. */
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { EditorError, latestKnowledgeStatus, loadDocument, saveDocument } from './editor-store.js'

const PREFIX = '/wlyd-presales/doc'

function xml(value) {
  return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;').replaceAll('"', '&quot;')
}

/** 同源结构化封面缩略图，用于对话内预览；完整内容仍从 HTML 打开。 */
function previewSvg(solution) {
  const title = [...solution.title]
  const titleLines = title.length > 24 ? [title.slice(0, 24).join(''), title.slice(24, 48).join('')]
    : [solution.title]
  const chapters = solution.sections.slice(0, 4).map((section, index) =>
    `<text x="80" y="${340 + index * 41}" fill="#d5dce8" font-size="20" font-family="sans-serif">${String(index + 1).padStart(2, '0')}  ${xml([...section.heading].slice(0, 31).join(''))}</text>`).join('')
  return `<svg xmlns="http://www.w3.org/2000/svg" width="960" height="540" viewBox="0 0 960 540" role="img" aria-label="方案结构预览">
<rect width="960" height="540" fill="#142034"/><rect x="0" y="0" width="10" height="540" fill="#c8272b"/>
<text x="80" y="76" fill="#aab8ca" font-size="18" font-family="sans-serif">售前解决方案 · 预览</text>
${titleLines.map((line, index) => `<text x="80" y="${172 + index * 64}" fill="#ffffff" font-size="43" font-weight="700" font-family="sans-serif">${xml(line)}</text>`).join('')}
<line x1="80" y1="286" x2="880" y2="286" stroke="#657386" stroke-width="1"/>
${chapters}<text x="880" y="502" fill="#aab8ca" font-size="16" text-anchor="end" font-family="sans-serif">待人工复核</text>
</svg>`
}

function errorResponse(error) {
  const status = error instanceof EditorError ? error.status : 500
  return Response.json({ error: error instanceof EditorError ? error.message : '保存服务发生错误，请重试' }, { status })
}

function mime(file) {
  const ext = path.extname(file).toLowerCase()
  if (ext === '.png') return 'image/png'
  if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg'
  if (ext === '.gif') return 'image/gif'
  if (ext === '.webp') return 'image/webp'
  return 'application/octet-stream'
}

export function registerEditorRoutes(ctx) {
  ctx.connection.fetch.register({
    path: '/api/wlyd-presales/document', methods: ['GET'], requestBody: 'buffered',
    async fetch(request) {
      try {
        const id = new URL(request.url).searchParams.get('id') ?? ''
        const { baseAbs, solution } = await loadDocument(id)
        const knowledge = await latestKnowledgeStatus(baseAbs, solution)
        return Response.json({ solution, knowledge }, { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) { return errorResponse(error) }
    },
  })

  ctx.connection.fetch.register({
    path: '/api/wlyd-presales/save', methods: ['POST'], requestBody: 'buffered',
    async fetch(request) {
      try {
        if (Number(request.headers.get('content-length') ?? 0) > 48 * 1024 * 1024) {
          throw new EditorError(413, '提交内容过大，请缩小图片后再试')
        }
        let body
        try { body = await request.json() }
        catch { throw new EditorError(400, '保存数据格式无效') }
        const result = await saveDocument(body?.id, body)
        return Response.json(result, { headers: { 'Cache-Control': 'no-store' } })
      } catch (error) { return errorResponse(error) }
    },
  })

  ctx.effect(() => ctx.webServer.register({
    kind: 'prefix', path: PREFIX,
    async handler(req, res) {
      const rejection = ctx.connection.requestRejection(req)
      if (rejection !== undefined) { res.writeHead(rejection); res.end(); return }
      if (req.method !== 'GET' && req.method !== 'HEAD') { res.writeHead(405); res.end(); return }
      try {
        const pathname = new URL(req.url ?? '/', 'http://127.0.0.1').pathname
        const relative = decodeURIComponent(pathname.slice(PREFIX.length + 1))
        const split = relative.indexOf('/')
        if (split < 0) throw new EditorError(404, '页面不存在')
        const id = relative.slice(0, split)
        const file = relative.slice(split + 1)
        const { baseAbs, solution } = await loadDocument(id)
        let target
        let contentType
        if (file === 'solution.html') {
          target = `${baseAbs}.html`
          contentType = 'text/html; charset=utf-8'
        } else if (file === 'preview.svg') {
          const bytes = Buffer.from(previewSvg(solution))
          res.writeHead(200, { 'Content-Type': 'image/svg+xml; charset=utf-8',
            'Content-Length': bytes.length, 'Cache-Control': 'no-store',
            'X-Content-Type-Options': 'nosniff' })
          res.end(req.method === 'HEAD' ? undefined : bytes)
          return
        } else if (['solution.md', 'solution.docx', 'solution.json'].includes(file)) {
          target = `${baseAbs}${path.extname(file)}`
          contentType = file.endsWith('.docx') ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
            : file.endsWith('.json') ? 'application/json; charset=utf-8' : 'text/markdown; charset=utf-8'
        } else if (solution.assets?.some(asset => asset.fileName === file)) {
          target = path.join(path.dirname(baseAbs), `${path.basename(baseAbs)}-assets`, path.basename(file))
          contentType = mime(file)
        } else throw new EditorError(404, '页面或图片不存在')
        const bytes = await readFile(target)
        res.writeHead(200, {
          'Content-Type': contentType,
          'Content-Length': bytes.length,
          ...(file.startsWith('solution.') && file !== 'solution.html'
            ? { 'Content-Disposition': `attachment; filename="${file}"` } : {}),
          'Cache-Control': 'no-store',
          'X-Content-Type-Options': 'nosniff',
        })
        res.end(req.method === 'HEAD' ? undefined : bytes)
      } catch (error) {
        res.writeHead(error instanceof EditorError ? error.status : 500)
        res.end(error instanceof EditorError ? error.message : '页面读取失败')
      }
    },
  }), 'wlyd-presales: authenticated editor document route')
}
