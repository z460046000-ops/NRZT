/** 将材料提取结果限制为可读文字；代码、样式和损坏的 PDF 字符不进入生成语料。 */
const CODE_LINE = /^(?:<!doctype|<\/?[a-z][^>]*>|@(?:media|font-face|keyframes|import)\b|[#.][\w-]+\s*\{|(?:const|let|var|function|import|export)\s+\w+|(?:xref|endobj|endstream|stream)\b|\d+\s+\d+\s+obj\b)|(?:font-family|font-size|background-color|border-radius|grid-template|display|position|padding|margin)\s*:/iu
const CODE_FRAGMENT = /<\/?[a-z][^>]*>|\b(?:font-size|font-family|background-color|border-radius|grid-template|display|position|padding|margin)\s*:|(?:[.#]?[a-z][\w-]*\s*)?\{\s*(?:color|display|font|margin|padding|background)\s*:/iu
const BROKEN = /[\u0000-\u0008\u000b\u000e-\u001f\ufffd]/u
const SUSPICIOUS_GLYPH = /[\u3400-\u4dbf\ue000-\uf8ff]/gu

function decodeEntities(text) {
  const named = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }
  return text.replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/giu, (match, value) => {
    if (value[0] !== '#') return named[value.toLowerCase()] ?? match
    const code = value[1]?.toLowerCase() === 'x'
      ? Number.parseInt(value.slice(2), 16) : Number.parseInt(value.slice(1), 10)
    return Number.isInteger(code) && code >= 32 && code <= 0x10ffff
      ? String.fromCodePoint(code) : ' '
  })
}

function readableLine(line) {
  if (CODE_LINE.test(line) || CODE_FRAGMENT.test(line) || BROKEN.test(line)) return false
  if ([...line.matchAll(SUSPICIOUS_GLYPH)].length > Math.max(2, line.length * 0.1)) return false
  if (/^[{}();,\[\]<>/\\|~`._\d\s-]+$/u.test(line)) return false
  if (line.length > 180 && !/[\s，。；：！？、]/u.test(line)) return false
  const letters = [...line.matchAll(/[\p{L}\p{N}]/gu)].length
  return letters >= 2 && letters / line.length >= 0.3
}

export function cleanMaterialText(value, sourcePath = '') {
  let text = String(value ?? '')
  const html = /\.(?:html?|xhtml)(?:$|[?!/])/iu.test(sourcePath)
    || /<!doctype html|<html[\s>]|<body[\s>]/iu.test(text.slice(0, 2000))
  if (html || /<(?:style|script|svg|pre|code)\b/iu.test(text)) {
    text = decodeEntities(text)
      .replace(/<!--[\s\S]*?-->/gu, ' ')
      .replace(/<(style|script|svg|pre|code|template|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/giu, '\n')
      // 行内标签用空格衔接，避免把一整句拆成大量短片段后误判为乱码。
      .replace(/<\/?(?:div|p|h[1-6]|li|section|article|header|footer|main|aside|br|tr|table|ul|ol)\b[^>]*>/giu, '\n')
      .replace(/<[^>]+>/gu, ' ')
  }
  const lines = []
  let fenced = false
  for (const original of text.split(/\r?\n/gu)) {
    const line = original.replace(/\s+/gu, ' ').trim()
    if (/^(```|~~~~)/u.test(line)) { fenced = !fenced; continue }
    if (fenced) continue
    if (!line) {
      if (!html && lines.length && lines.at(-1) !== '') lines.push('')
      continue
    }
    if (!readableLine(line)) continue
    lines.push(line)
  }
  return lines.join('\n').trim()
}

/** 用于审查模型正文和逐字引文，避免把代码或乱码作为销售表述。 */
export function isReadableProse(value) {
  if (!isSafeDisplayText(value)) return false
  const cleaned = cleanMaterialText(value)
  return cleaned.length >= 4 && cleaned.length >= value.trim().length * 0.55
}

export function isSafeDisplayText(value) {
  return typeof value === 'string' && !!value.trim() && !BROKEN.test(value)
    && !CODE_FRAGMENT.test(value)
    && !value.split(/\r?\n/u).some(line => CODE_LINE.test(line.trim()))
    && [...value.matchAll(SUSPICIOUS_GLYPH)].length <= Math.max(2, value.length * 0.1)
}
