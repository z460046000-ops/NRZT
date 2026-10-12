/** 新方案轮换视觉方向；选择结果写入 JSON，重渲染不再重新抽选。 */
import { randomBytes, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export const VISUAL_DIRECTIONS = Object.freeze([
  { id: 'redline', theme: 'corporate' },
  { id: 'paper', theme: 'elegant' },
  { id: 'night', theme: 'dark' },
  { id: 'signal', theme: 'corporate' },
])

const defaultStateFile = () => path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'),
  'wlyd-presales-editor', 'visual-sequence.json')

let pending = Promise.resolve()

/** 本机连续生成按方向轮换；不存放客户文字或资料路径。 */
export function assignVisualDesign(solution, { themeExplicit = false, stateFile = defaultStateFile() } = {}) {
  if (solution.visualDesign) return Promise.resolve(solution)
  const run = pending.catch(() => {}).then(async () => {
    let previous = -1
    try {
      const saved = JSON.parse(await readFile(stateFile, 'utf8'))
      if (Number.isSafeInteger(saved.sequence) && saved.sequence >= 0) previous = saved.sequence
    } catch (error) {
      if (error?.code !== 'ENOENT' && !(error instanceof SyntaxError)) throw error
    }
    const sequence = previous + 1
    const direction = VISUAL_DIRECTIONS[sequence % VISUAL_DIRECTIONS.length]
    const folder = path.dirname(stateFile)
    await mkdir(folder, { recursive: true, mode: 0o700 })
    const temporary = path.join(folder, `.visual-sequence-${randomUUID()}.json`)
    await writeFile(temporary, JSON.stringify({ sequence }) + '\n', { flag: 'wx', mode: 0o600 })
    await rename(temporary, stateFile)
    solution.visualDesign = { version: 1, direction: direction.id, seed: randomBytes(4).readUInt32BE(0) }
    if (!themeExplicit) solution.theme = direction.theme
    return solution
  })
  pending = run.catch(() => {})
  return run
}
