/** Retry saved knowledge-review proposals after the knowledge API is configured. */
import { readdir } from 'node:fs/promises'
import path from 'node:path'
import { deliverKnowledgeProposal } from '../src/knowledge-adapter.js'

const [projectDir = '.', base] = process.argv.slice(2)
if (!base) {
  console.error('用法: node bin/submit-knowledge.mjs <项目目录> <文件名基底>')
  process.exit(1)
}
const folder = path.join(projectDir, `${base}.knowledge-proposals`)
const files = await readdir(folder).catch(() => [])
if (!process.env.WLYD_KNOWLEDGE_PROPOSAL_URL) {
  console.error('未配置 WLYD_KNOWLEDGE_PROPOSAL_URL；待审核记录仍保留在本地')
  process.exit(1)
}
for (const file of files.filter(name => name.endsWith('.json'))) {
  const result = await deliverKnowledgeProposal(path.join(folder, file))
  console.log(`${result.id}: ${result.status}`)
}
