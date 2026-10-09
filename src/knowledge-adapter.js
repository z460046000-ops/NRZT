/** Optional knowledge-review handoff. Knowledge is never published by this plugin. */
import { readFile, writeFile } from 'node:fs/promises'

export async function deliverKnowledgeProposal(file) {
  const proposal = JSON.parse(await readFile(file, 'utf8'))
  if (proposal.status === 'submitted_for_review') return proposal
  const endpoint = process.env.WLYD_KNOWLEDGE_PROPOSAL_URL
  if (!endpoint) return proposal
  if (!proposal.targetId) {
    proposal.status = 'needs_target'
  } else {
    try {
      const response = await fetch(endpoint, {
        method: 'POST', signal: AbortSignal.timeout(10000),
        headers: {
          'Content-Type': 'application/json',
          'Idempotency-Key': proposal.id,
          ...(process.env.WLYD_KNOWLEDGE_API_TOKEN ? { Authorization: `Bearer ${process.env.WLYD_KNOWLEDGE_API_TOKEN}` } : {}),
        },
        body: JSON.stringify(proposal),
      })
      if (!response.ok) throw new Error(`知识库返回 HTTP ${response.status}`)
      const accepted = await response.json().catch(() => ({}))
      proposal.status = 'submitted_for_review'
      proposal.remoteRequestId = typeof accepted.requestId === 'string' ? accepted.requestId : undefined
      proposal.deliveredAt = new Date().toISOString()
      delete proposal.deliveryError
    } catch (error) {
      proposal.status = 'delivery_failed'
      proposal.deliveryError = error instanceof Error ? error.message : String(error)
    }
  }
  await writeFile(file, JSON.stringify(proposal, null, 2) + '\n')
  return proposal
}
