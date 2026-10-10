/** 管理可热更新的外发规则。用法: node bin/external-policy.mjs show|history|rollback <摘要> */
import { readdir, readFile } from 'node:fs/promises'
import path from 'node:path'
import { loadExternalPolicy, policyHistory, restoreExternalPolicy } from '../src/external-policy.js'

const [action = 'show', digest] = process.argv.slice(2)
try {
  if (action === 'show') {
    const active = await loadExternalPolicy()
    process.stdout.write(`活动规则：${active.policy.version} · ${active.digest}\n文件：${active.file}\n`)
  } else if (action === 'history') {
    await loadExternalPolicy()
    for (const file of (await readdir(policyHistory())).filter(name => /^[a-f0-9]{64}\.json$/u.test(name)).sort()) {
      const policy = JSON.parse(await readFile(path.join(policyHistory(), file), 'utf8'))
      process.stdout.write(`${policy.version}\t${file.slice(0, -5)}\n`)
    }
  } else if (action === 'rollback') {
    if (!digest) throw new Error('请提供 history 列表中的完整规则摘要')
    const active = await restoreExternalPolicy(digest)
    process.stdout.write(`已切回规则 ${active.policy.version} · ${active.digest}\n`)
  } else {
    throw new Error('用法: node bin/external-policy.mjs show|history|rollback <完整规则摘要>')
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}
