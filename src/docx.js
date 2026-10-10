/**
 * 标准解决方案的 DOCX 渲染:Word 交付物,销售侧可直接编辑协作。
 * @module @wlyd/dsh-solution-kit/docx
 */

import {
  AlignmentType, Document, HeadingLevel, ImageRun, Packer,
  Paragraph, Table, TableCell, TableRow, TextRun, WidthType,
} from 'docx'
import { imageSize } from 'image-size'
import { painWithBasis } from './pain-basis.js'

const DOCX_IMAGE_TYPES = new Set(['png', 'jpg', 'jpeg', 'gif'])
const MAX_IMG_WIDTH = 540
const MAX_IMG_HEIGHT = 620

/**
 * 渲染解决方案 DOCX 并返回字节。
 * @param {object} solution - normalizeSolution 产物。
 * @param {Array<{sourcePath: string, fileName: string, buffer: Buffer, caption?: string}>} assets - 图片素材(含字节)。
 * @returns {Promise<Buffer>} docx 文件字节。
 */
export async function renderDocx(solution, assets) {
  const assetByName = new Map(assets.map(a => [a.sourcePath, a]))
  const children = []

  children.push(new Paragraph({
    text: solution.title,
    heading: HeadingLevel.TITLE,
    alignment: AlignmentType.CENTER,
  }))
  if (solution.subtitle) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: solution.subtitle, italics: true, size: 24 })],
    }))
  }
  const meta = solution.meta
  const metaLine = [
    meta.company, meta.product, meta.version && `版本 ${meta.version}`, meta.date,
  ].filter(Boolean).join(' · ')
  if (metaLine) {
    children.push(new Paragraph({
      alignment: AlignmentType.CENTER,
      children: [new TextRun({ text: metaLine, color: '666666', size: 21 })],
    }))
  }
  children.push(new Paragraph({ text: '' }))

  solution.sections.forEach((section, i) => {
    children.push(new Paragraph({
      text: `${i + 1}. ${section.heading}`,
      heading: HeadingLevel.HEADING_1,
    }))
    if (section.lead) {
      children.push(new Paragraph({
        children: [new TextRun({ text: section.lead, italics: true, color: '666666', size: 21 })],
        indent: { left: 240 },
      }))
    }
    if (section.kind === 'problem_solution' && solution.painSolutionLinks?.length) {
      pushBlock(children, solution.external
        ? { type: 'table', headers: ['编号', '客户问题', '对应做法'],
          rows: solution.painSolutionLinks.map(link => [link.id, painWithBasis(link), link.solution]) }
        : { type: 'table', headers: ['编号', '客户问题', '对应做法', '材料依据'],
          rows: solution.painSolutionLinks.map(link => [link.id, painWithBasis(link), link.solution,
            `${link.painEvidence.path}：${link.painEvidence.quote}；${link.solutionEvidence.path}：${link.solutionEvidence.quote}`]) }, assetByName)
    }
    for (const block of section.blocks) {
      pushBlock(children, block, assetByName)
    }
  })

  children.push(new Paragraph({ text: '' }))
  children.push(new Paragraph({
    alignment: AlignmentType.CENTER,
    children: [new TextRun({
      text: solution.external ? [meta.version, meta.date].filter(Boolean).join(' · ') : meta.contact || meta.company || '',
      color: '999999', size: 18,
    })],
  }))

  const doc = new Document({
    sections: [{ properties: {}, children }],
    styles: {
      default: {
        document: { run: { font: 'Microsoft YaHei', size: 22 } },
      },
    },
  })
  return Packer.toBuffer(doc)
}

function pushBlock(children, block, assetByName) {
  switch (block.type) {
    case 'para':
      children.push(new Paragraph({ text: block.text }))
      break
    case 'bullets':
      for (const item of block.items) {
        children.push(new Paragraph({ text: item, bullet: { level: 0 } }))
      }
      break
    case 'steps':
      block.items.forEach((item, i) => {
        children.push(new Paragraph({
          children: [new TextRun({ text: `${i + 1}. `, bold: true }), new TextRun({ text: item })],
          indent: { left: 240 },
        }))
      })
      break
    case 'table':
      children.push(makeTable(block.headers, block.rows.map(r => r.map(c => ({ text: c })))))
      children.push(new Paragraph({ text: '' }))
      break
    case 'metrics':
      children.push(makeTable(
        ['指标', '数值'],
        block.items.map(m => [{ text: m.label }, { text: m.value, bold: true }]),
      ))
      children.push(new Paragraph({ text: '' }))
      break
    case 'image': {
      const asset = assetByName.get(block.path)
      if (!asset) break
      const run = imageRunFor(asset)
      if (run) {
        children.push(new Paragraph({ alignment: AlignmentType.CENTER, children: [run] }))
        if (block.caption) {
          children.push(new Paragraph({
            alignment: AlignmentType.CENTER,
            children: [new TextRun({ text: block.caption, color: '666666', size: 19 })],
          }))
        }
      }
      break
    }
    case 'quote':
      children.push(new Paragraph({
        indent: { left: 480 },
        children: [new TextRun({ text: block.text, italics: true, color: '555555' })],
      }))
      break
    default:
      break
  }
}

function makeTable(headers, rows) {
  const headerRow = new TableRow({
    tableHeader: true,
    children: headers.map(h => new TableCell({
      shading: { fill: 'E8EEF9' },
      children: [new Paragraph({ children: [new TextRun({ text: h, bold: true })] })],
    })),
  })
  const bodyRows = rows.map(cells => new TableRow({
    children: cells.map(cell => new TableCell({
      children: [new Paragraph({ children: [new TextRun(cell)] })],
    })),
  }))
  return new Table({
    width: { size: 100, type: WidthType.PERCENTAGE },
    rows: [headerRow, ...bodyRows],
  })
}

function imageRunFor(asset) {
  const ext = asset.fileName.toLowerCase().split('.').pop() ?? ''
  if (!DOCX_IMAGE_TYPES.has(ext)) return undefined
  let width = 480
  let height = 360
  try {
    const dims = imageSize(asset.buffer)
    if (dims.width > 0 && dims.height > 0) {
      const scale = Math.min(1, MAX_IMG_WIDTH / dims.width, MAX_IMG_HEIGHT / dims.height)
      width = Math.round(dims.width * scale)
      height = Math.round(dims.height * scale)
    }
  } catch {
    // 保留默认尺寸
  }
  return new ImageRun({
    type: ext === 'jpeg' ? 'jpg' : ext,
    data: asset.buffer,
    transformation: { width, height },
  })
}
