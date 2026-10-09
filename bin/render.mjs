/**
 * 离线重渲染:从 <base>.json 结构化源重新生成 md/html/docx,不调用模型。
 * 用法:node render.mjs <项目目录> <文件名基底>
 * 例:node render.mjs . insightflow-presales
 * 图片素材路径按 json 内 assets 的 fileName(相对项目目录)直接复制。
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { renderMarkdown } from '../src/markdown.js'
import { renderHtml } from '../src/html.js'
import { renderDocx } from '../src/docx.js'

const [projectDir = '.', base] = process.argv.slice(2)
if (!base) {
  console.error('用法:node render.mjs <项目目录> <文件名基底>')
  process.exit(1)
}

const solution = JSON.parse(await readFile(path.join(projectDir, `${base}.json`), 'utf8'))
const assets = []
for (const asset of solution.assets ?? []) {
  try {
    assets.push({ ...asset, buffer: await readFile(path.join(projectDir, asset.fileName)) })
  } catch (err) {
    console.warn(`素材读取失败,已跳过 ${asset.fileName}:${err.message}`)
  }
}

const markdown = renderMarkdown(solution, assets)
const html = renderHtml(solution, assets)
const docx = await renderDocx(solution, assets)

await writeFile(path.join(projectDir, `${base}.md`), markdown)
await writeFile(path.join(projectDir, `${base}.html`), html)
await writeFile(path.join(projectDir, `${base}.docx`), docx)
console.log(`已重渲染:${base}.md / ${base}.html / ${base}.docx(${solution.sections.length} 节,图片 ${assets.length} 张)`)
