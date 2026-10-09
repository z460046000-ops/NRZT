/**
 * 材料导入与文本提取:支持 md/txt/csv/json/html 等文本、docx、pdf、pptx,
 * zip 产品包在内存中递归展开;图片与暂不支持的格式登记为素材条目。
 * @module @wlyd/dsh-solution-kit/ingest
 */

import { readFile } from 'node:fs/promises'
import path from 'node:path'
import mammoth from 'mammoth'
import { PDFParse } from 'pdf-parse'
import JSZip from 'jszip'
import { cleanMaterialText } from './source-quality.js'

const TEXT_EXTS = new Set(['md', 'txt', 'csv', 'json', 'html', 'htm', 'xml', 'yaml', 'yml', 'log'])
const IMAGE_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'svg', 'bmp'])

/** 单文件大小与包内展开的保护上限。 */
const MAX_FILE_BYTES = 100 * 1024 * 1024
const MAX_ZIP_ENTRIES = 500
const MAX_ZIP_EXPANDED_BYTES = 100 * 1024 * 1024
const MAX_WALK_FILES = 400

/**
 * 按扩展名归类材料文件。
 * @param {string} name - 文件名。
 * @returns {('text'|'docx'|'pdf'|'pptx'|'xlsx'|'image'|'archive'|'other')} 类别。
 */
export function classify(name) {
  const ext = name.toLowerCase().split('.').pop() ?? ''
  if (TEXT_EXTS.has(ext)) return 'text'
  if (ext === 'docx') return 'docx'
  if (ext === 'pdf') return 'pdf'
  if (ext === 'pptx') return 'pptx'
  if (ext === 'xlsx' || ext === 'xls' || ext === 'doc' || ext === 'ppt') return 'xlsx'
  if (IMAGE_EXTS.has(ext)) return 'image'
  if (ext === 'zip') return 'archive'
  return 'other'
}

/**
 * 递归列出目录下的普通文件(跳过隐藏项与 node_modules,深度≤4)。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {object} dirTarget - ctx.fs.resolve 产生的目录 target。
 * @param {AbortSignal} signal - 取消信号。
 * @param {Array<{name: string, target: object, size: number}>} acc - 累积结果。
 * @param {number} depth - 当前深度。
 */
async function walkFiles(ctx, dirTarget, signal, acc, depth = 0) {
  if (depth > 4 || acc.length >= MAX_WALK_FILES) return
  const entries = await ctx.fs.listDir(dirTarget, signal)
  for (const entry of entries) {
    if (acc.length >= MAX_WALK_FILES) return
    if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
    if (entry.type === 'directory') {
      await walkFiles(ctx, entry.target, signal, acc, depth + 1)
    } else if (entry.type === 'file') {
      acc.push({ name: entry.name, target: entry.target, size: entry.size ?? 0 })
    }
  }
}

/**
 * 从二进制内容提取纯文本。
 * @param {string} kind - classify 得到的类别(docx/pdf/pptx)。
 * @param {Buffer} buffer - 文件字节。
 * @returns {Promise<{text: string, note?: string}>} 提取文本与备注。
 */
export async function extractBinaryText(kind, buffer) {
  if (kind === 'docx') {
    const { value } = await mammoth.extractRawText({ buffer })
    return { text: value }
  }
  if (kind === 'pdf') {
    const parser = new PDFParse({ data: buffer })
    try {
      const result = await parser.getText()
      // 去掉 pdf-parse 的 "-- N of M -" 页标
      return { text: cleanMaterialText((result.text ?? '').replace(/-- \d+ of \d+ -/g, ''), 'document.pdf') }
    } finally {
      parser.destroy()
    }
  }
  // pptx:幻灯片 XML 中 <a:t> 文本按页拼接
  const zip = await JSZip.loadAsync(buffer)
  const slideNames = Object.keys(zip.files)
    .filter(n => /^ppt\/slides\/slide\d+\.xml$/.test(n))
    .sort((a, b) => slideNo(a) - slideNo(b))
  const pages = []
  for (const n of slideNames) {
    const xml = await zip.files[n].async('string')
    const runs = [...xml.matchAll(/<a:t>([^<]*)<\/a:t>/g)].map(m => m[1])
    if (runs.length > 0) pages.push(runs.join(''))
  }
  return { text: pages.join('\n\n') }
}

function slideNo(name) {
  const m = name.match(/slide(\d+)\.xml$/)
  return m ? Number(m[1]) : 0
}

/**
 * 在内存中递归展开 zip,产出虚拟条目(路径形如 `包名.zip!内层文件`)。
 * @param {Buffer} buffer - zip 字节。
 * @param {string} prefix - 虚拟路径前缀。
 * @param {Array<{vpath: string, kind: string, buffer: Buffer}>} acc - 累积条目。
 * @param {Array<string>} warnings - 警告收集。
 * @param {number} depth - zip 嵌套深度(≤2)。
 */
async function expandZip(buffer, prefix, acc, warnings, depth = 0, budget = { used: 0 }) {
  if (depth > 2) {
    warnings.push(`压缩包嵌套过深,已跳过:${prefix}`)
    return
  }
  const zip = await JSZip.loadAsync(buffer)
  for (const name of Object.keys(zip.files)) {
    if (zip.files[name].dir) continue
    if (acc.length >= MAX_ZIP_ENTRIES) {
      warnings.push(`包内条目过多,已截断:${prefix}`)
      return
    }
    const size = zip.files[name]._data?.uncompressedSize
    if (!Number.isSafeInteger(size) || size < 0 || size > MAX_FILE_BYTES
      || budget.used + size > MAX_ZIP_EXPANDED_BYTES) {
      warnings.push(`压缩包条目过大或大小未知，已跳过:${prefix}!${name}`)
      continue
    }
    budget.used += size
    const entryBuffer = await zip.files[name].async('nodebuffer')
    const vpath = `${prefix}!${name}`
    const kind = classify(name)
    if (kind === 'archive') {
      await expandZip(entryBuffer, vpath, acc, warnings, depth + 1, budget)
    } else {
      acc.push({ vpath, kind, buffer: entryBuffer })
    }
  }
}

/**
 * 对一个文本提取结果做截断,返回 {text, note}。
 * @param {string} text - 完整文本。
 * @param {number} maxChars - 单文件入库上限。
 */
function capText(text, maxChars) {
  if (text.length <= maxChars) return { text, note: undefined }
  return { text: text.slice(0, maxChars), note: `已截断(原文 ${text.length} 字,上限 ${maxChars})` }
}

function excerpt(text, n = 300) {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= n ? flat : `${flat.slice(0, n)}…`
}

/**
 * 执行材料导入分析:扫描路径、提取文本、写 analysis/materials.json 与 analysis/corpus.md。
 * @param {import('@deepseek-ai/cordis').Context} ctx - 插件上下文。
 * @param {{path: string, label?: string, max_chars_per_file?: number, output_dir?: string}} args - 工具参数(已过基础校验)。
 * @param {object} exec - 工具执行上下文(signal/agent)。
 * @returns {Promise<object>} 规范返回值。
 */
export async function ingestMaterials(ctx, args, exec) {
  const signal = exec.signal
  const cwd = exec.agent?.session?.header?.cwd ?? process.cwd()
  const maxChars = clampInt(args.max_chars_per_file, 500, 200_000, 12_000)
  const outDir = args.output_dir || 'analysis'

  const rootTarget = await ctx.fs.resolve(args.path, { cwd, signal })
  const rootInfo = await ctx.fs.stat(rootTarget, signal)
  if (rootInfo === undefined) throw new Error(`wlyd_ingest: 材料路径不存在:${args.path}`)
  if (rootInfo.type === 'other') throw new Error(`wlyd_ingest: 材料路径不是文件或目录:${args.path}`)

  const files = []
  if (rootInfo.type === 'directory') {
    await walkFiles(ctx, rootTarget, signal, files)
  } else {
    files.push({ name: path.basename(ctx.fs.processPath(rootTarget)), target: rootTarget, size: rootInfo.size ?? 0 })
  }
  if (files.length === 0) throw new Error(`wlyd_ingest: 目录中没有可分析的材料文件:${args.path}`)

  /** @type {Array<{path: string, kind: string, bytes: number, chars?: number, note?: string, text?: string, excerpt?: string}>} */
  const entries = []
  const warnings = []
  const counts = { total: 0, extracted: 0, images: 0, archives: 0, other: 0 }

  const pushEntry = (p, kind, bytes, text, note) => {
    counts.total += 1
    const entry = { path: p, kind, bytes }
    if (text !== undefined) {
      const readable = cleanMaterialText(text, p)
      if (readable) {
        counts.extracted += 1
        entry.chars = readable.length
        entry.text = readable
        entry.excerpt = excerpt(readable)
      } else {
        counts.other += 1
        entry.note = '未提取到可读正文'
      }
    } else if (kind === 'image') {
      counts.images += 1
    } else if (kind === 'archive') {
      counts.archives += 1
    } else {
      counts.other += 1
    }
    if (note) entry.note = entry.note ? `${entry.note}；${note}` : note
    entries.push(entry)
  }

  const relOf = target => {
    const rel = path.relative(cwd, ctx.fs.processPath(target))
    return rel.startsWith('..') ? ctx.fs.processPath(target) : rel
  }

  for (const file of files) {
    signal.throwIfAborted()
    if (file.size > MAX_FILE_BYTES) {
      pushEntry(relOf(file.target), classify(file.name), file.size, undefined, `文件过大(${fmtBytes(file.size)}),未提取`)
      continue
    }
    const kind = classify(file.name)
    try {
      if (kind === 'text') {
        const raw = await ctx.fs.readText(file.target, signal)
        const { text, note } = capText(raw, maxChars)
        pushEntry(relOf(file.target), kind, file.size, text, note)
      } else if (kind === 'docx' || kind === 'pdf' || kind === 'pptx') {
        const buffer = await readFile(ctx.fs.processPath(file.target))
        const { text } = await extractBinaryText(kind, buffer)
        const capped = capText(text.trim(), maxChars)
        pushEntry(relOf(file.target), kind, file.size, capped.text, capped.note)
      } else if (kind === 'archive') {
        const buffer = await readFile(ctx.fs.processPath(file.target))
        const rel = relOf(file.target)
        pushEntry(rel, kind, file.size)
        const inner = []
        await expandZip(buffer, rel, inner, warnings)
        for (const item of inner) {
          signal.throwIfAborted()
          const itemKind = classify(item.vpath)
          if (itemKind === 'docx' || itemKind === 'pdf' || itemKind === 'pptx' || itemKind === 'text') {
            try {
              let text
              if (itemKind === 'text') {
                text = item.buffer.toString('utf8')
              } else {
                text = (await extractBinaryText(itemKind, item.buffer)).text
              }
              const capped = capText(text.trim(), maxChars)
              pushEntry(item.vpath, itemKind, item.buffer.length, capped.text, capped.note ?? '位于压缩包内')
            } catch (err) {
              warnings.push(`包内文件提取失败 ${item.vpath}:${errMsg(err)}`)
              pushEntry(item.vpath, itemKind, item.buffer.length, undefined, '提取失败')
            }
          } else if (itemKind === 'image') {
            pushEntry(item.vpath, 'image', item.buffer.length, undefined, '位于压缩包内,如需嵌入方案请先解压')
          } else {
            pushEntry(item.vpath, itemKind, item.buffer.length, undefined, '位于压缩包内')
          }
        }
      } else if (kind === 'image') {
        pushEntry(relOf(file.target), kind, file.size)
      } else {
        pushEntry(relOf(file.target), kind, file.size, undefined, '暂不支持提取该格式')
      }
    } catch (err) {
      if (signal.aborted) throw err
      warnings.push(`提取失败 ${file.name}:${errMsg(err)}`)
      pushEntry(relOf(file.target), kind, file.size, undefined, '提取失败')
    }
  }

  // 写语料与清单
  const generatedAt = new Date().toISOString()
  const label = args.label || path.basename(ctx.fs.processPath(rootTarget))
  const corpus = buildCorpus(label, generatedAt, entries)
  const manifest = {
    label,
    generatedAt,
    root: relOf(rootTarget),
    counts,
    files: entries.map(({ text, ...rest }) => rest),
  }

  const manifestTarget = await ctx.fs.resolve(`${outDir}/materials.json`, { cwd, signal })
  const corpusTarget = await ctx.fs.resolve(`${outDir}/corpus.md`, { cwd, signal })
  const manifestOutcome = await ctx.fs.writeText(manifestTarget, JSON.stringify(manifest, null, 2) + '\n', undefined, signal)
  const corpusOutcome = await ctx.fs.writeText(corpusTarget, corpus, undefined, signal)
  ctx.emit('fs/observed', manifestTarget, { kind: 'present', version: manifestOutcome.version }, exec)
  ctx.emit('fs/observed', corpusTarget, { kind: 'present', version: corpusOutcome.version }, exec)

  return {
    dir: outDir,
    label,
    manifestPath: `${outDir}/materials.json`,
    corpusPath: `${outDir}/corpus.md`,
    counts,
    warnings,
    files: entries.map(({ text, ...rest }) => rest),
  }
}

function buildCorpus(label, generatedAt, entries) {
  const lines = [
    `# 材料语料 · ${label}`,
    '',
    `> 生成时间 ${generatedAt};共 ${entries.length} 个文件。`,
    '',
  ]
  for (const e of entries) {
    if (e.text === undefined) {
      lines.push(`## [${e.kind}] ${e.path}`, '', `(${fmtBytes(e.bytes)}${e.note ? ` · ${e.note}` : ''})`, '')
      continue
    }
    lines.push(`## [${e.kind}] ${e.path}`, '')
    lines.push(`(${fmtBytes(e.bytes)} · ${e.chars} 字${e.note ? ` · ${e.note}` : ''})`, '')
    lines.push('````text', e.text, '````', '')
  }
  return lines.join('\n') + '\n'
}

function fmtBytes(n) {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function clampInt(v, min, max, dflt) {
  const n = typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : dflt
  return Math.min(max, Math.max(min, n))
}

function errMsg(err) {
  return err instanceof Error ? err.message : String(err)
}
