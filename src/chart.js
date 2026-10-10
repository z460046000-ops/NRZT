/** 有来源的数值图表；仅表达可核对的同单位比较或时间趋势。 */
import { isSafeDisplayText } from './source-quality.js'
const NUMBER = /(?<![\d.])\d[\d,]*(?:\.\d+)?(?![\d.])/gu

function numericTokens(text) {
  return [...String(text).matchAll(NUMBER)].map(match => Number(match[0].replaceAll(',', '')))
}

export function normalizeChart(raw, { sourceText } = {}) {
  if (!raw || raw.type !== 'chart') throw new Error('图表类型无效')
  const chartType = raw.chartType
  if (!['bar', 'line'].includes(chartType)) throw new Error('图表仅支持比较图或趋势图')
  const title = String(raw.title ?? '').trim()
  const unit = String(raw.unit ?? '').trim()
  if (!title || title.length > 100 || !unit || unit.length > 24
    || !isSafeDisplayText(title) || !isSafeDisplayText(unit)) throw new Error('图表须有可读标题和统一单位')
  if (!Array.isArray(raw.points) || raw.points.length < 2 || raw.points.length > 6) {
    throw new Error('图表须有 2—6 个数据点')
  }
  const points = raw.points.map(point => {
    const label = String(point?.label ?? '').trim()
    const value = typeof point?.value === 'number' ? point.value : Number(String(point?.value ?? '').replaceAll(',', ''))
    if (!label || label.length > 40 || !isSafeDisplayText(label) || !Number.isFinite(value) || value < 0) throw new Error('图表标签或数值无效')
    return { label, value }
  })
  if (new Set(points.map(point => point.label)).size !== points.length) throw new Error('图表标签不能重复')
  const source = { path: String(raw.source?.path ?? raw.path ?? '').trim(),
    quote: String(raw.source?.quote ?? raw.quote ?? '').trim() }
  if (!source.path || !source.quote || source.quote.length < 8 || source.quote.length > 2000
    || !isSafeDisplayText(source.quote)) {
    throw new Error('图表须有可核对的材料路径和原文')
  }
  if (sourceText !== undefined && !String(sourceText).includes(source.quote)) throw new Error('图表引文不在对应材料中')
  const positions = points.map(point => source.quote.indexOf(point.label))
  const ordered = positions.map((position, index) => ({ position, index })).sort((a, b) => a.position - b.position)
  const eachValueFollowsItsLabel = ordered.every(({ position, index }, orderIndex) => {
    if (position < 0) return false
    const nextPosition = ordered[orderIndex + 1]?.position ?? source.quote.length
    const localText = source.quote.slice(position + points[index].label.length, nextPosition)
    return numericTokens(localText).includes(points[index].value)
  })
  if (!source.quote.includes(unit) || !eachValueFollowsItsLabel) {
    throw new Error('图表标签或数值未出现在引文中')
  }
  if (chartType === 'line' && points.some(point => !/\d/u.test(point.label))) {
    throw new Error('趋势图横轴须包含时间标识')
  }
  if (chartType === 'line') {
    const time = points.map(point => [...point.label.matchAll(/\d+/gu)].map(match => Number(match[0])))
    const later = (current, previous) => {
      for (let index = 0; index < Math.max(current.length, previous.length); index++) {
        if ((current[index] ?? 0) !== (previous[index] ?? 0)) return (current[index] ?? 0) > (previous[index] ?? 0)
      }
      return false
    }
    if (time.some((value, index) => index > 0 && !later(value, time[index - 1]))) throw new Error('趋势图时间须按顺序排列')
  }
  return { type: 'chart', chartType, title, unit, points, source, evidenceStatus: 'verified' }
}
