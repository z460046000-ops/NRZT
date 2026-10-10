/** 可热更新、可回退的外发规则；一次导出固定规则摘要。 */
import { createHash } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

const bundled = new URL('../policies/external-release.json', import.meta.url)
const root = () => path.join(process.env.DSH_HOME || path.join(homedir(), '.dsh'), 'wlyd-presales-editor')
export const policyPath = () => process.env.WLYD_PRESALES_EXTERNAL_POLICY || path.join(root(), 'external-policy.json')
export const policyHistory = () => path.join(root(), 'policy-history')

function validate(policy) {
  if (!policy || typeof policy !== 'object' || !/^\d+\.\d+\.\d+$/u.test(policy.version)) {
    throw new Error('外发规则需要 version，格式如 1.0.0')
  }
  for (const key of ['blockedTerms', 'strongClaims']) {
    if (!Array.isArray(policy[key]) || policy[key].some(value => typeof value !== 'string' || !value.trim())) {
      throw new Error(`外发规则 ${key} 必须是非空文字数组`)
    }
  }
  if (!Array.isArray(policy.claimStrengthPairs) || policy.claimStrengthPairs.some(pair =>
    !Array.isArray(pair) || pair.length !== 2 || pair.some(value => typeof value !== 'string' || !value.trim()))) {
    throw new Error('外发规则 claimStrengthPairs 必须是成对文字数组')
  }
  return policy
}

/** 每次读取活动文件；历史以内容摘要命名，修改规则不覆盖旧规则。 */
export async function loadExternalPolicy() {
  const file = policyPath()
  await mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  let raw
  try { raw = await readFile(file, 'utf8') }
  catch (error) {
    if (error.code !== 'ENOENT') throw error
    raw = await readFile(bundled, 'utf8')
    try { await writeFile(file, raw, { flag: 'wx', mode: 0o600 }) }
    catch (race) { if (race.code !== 'EEXIST') throw race; raw = await readFile(file, 'utf8') }
  }
  const policy = validate(JSON.parse(raw))
  const digest = createHash('sha256').update(raw).digest('hex')
  await mkdir(policyHistory(), { recursive: true, mode: 0o700 })
  try { await writeFile(path.join(policyHistory(), `${digest}.json`), raw, { flag: 'wx', mode: 0o600 }) }
  catch (error) { if (error.code !== 'EEXIST') throw error }
  return { policy, digest, file }
}

/** 将指定历史规则重新设为活动版本，当前内容已经由 loadExternalPolicy 留档。 */
export async function restoreExternalPolicy(digest) {
  if (!/^[a-f0-9]{64}$/u.test(digest)) throw new Error('规则摘要无效')
  await loadExternalPolicy()
  const raw = await readFile(path.join(policyHistory(), `${digest}.json`), 'utf8')
  validate(JSON.parse(raw))
  await writeFile(policyPath(), raw, { mode: 0o600 })
  return loadExternalPolicy()
}
