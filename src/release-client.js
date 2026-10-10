/* 外部稿预览只供内部检查；外发文件由服务端审核后单独生成。 */
(() => {
  const panel = document.getElementById('release-panel')
  if (!panel) return
  const fields = document.getElementById('release-fields')
  const result = document.getElementById('release-result')
  document.getElementById('release-open').addEventListener('click', event => {
    fields.hidden = !fields.hidden
    event.currentTarget.textContent = fields.hidden ? '外发检查' : '收起检查'
    if (!fields.hidden) document.getElementById('release-audience').focus()
  })
  document.getElementById('release-submit').addEventListener('click', async event => {
    const button = event.currentTarget
    button.disabled = true
    result.textContent = '正在检查…'
    const value = id => document.getElementById(id).value.trim()
    const checked = id => document.getElementById(id).checked
    try {
      const response = await fetch('/api/wlyd-presales/release', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: document.body.dataset.editorId, baseRevision: Number(document.body.dataset.revision),
          confirmation: {
            structure: checked('release-structure'), stance: value('release-stance'),
            audience: value('release-audience'), distribution: value('release-distribution'),
            factBaseline: checked('release-facts'), version: value('release-version'),
            reviewer: value('release-reviewer'), assetsApproved: checked('release-assets'),
            commercialApproved: checked('release-commercial'), claimsApproved: checked('release-claims'),
            noInternalResidue: checked('release-no-internal'), noUnapprovedContent: checked('release-approved'),
            planningLabeled: checked('release-planning'), boundariesVisible: checked('release-boundaries'),
            noAutomationResidue: checked('release-no-automation'), structureConsistent: checked('release-structure-consistent'),
            versionConsistent: checked('release-version-consistent'), claimStrengthChecked: checked('release-strength'),
            causalChainPreserved: checked('release-causal-chain'),
          } }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '外发检查失败')
      if (data.issues?.length) {
        result.replaceChildren()
        const title = document.createElement('strong')
        title.textContent = '暂不能外发，请处理：'
        const list = document.createElement('ul')
        data.issues.forEach(issue => { const li = document.createElement('li'); li.textContent = issue.message; list.append(li) })
        result.append(title, list)
      } else {
        result.replaceChildren()
        const title = document.createElement('strong')
        title.textContent = `已生成外发稿 · 规则 ${data.policyVersion}`
        result.append(title)
        for (const [label, url] of [['HTML', data.urls.html], ['Word', data.urls.docx], ['Markdown', data.urls.md]]) {
          const link = document.createElement('a')
          link.href = url
          link.textContent = label
          link.target = '_blank'
          link.rel = 'noopener'
          result.append(link)
        }
      }
    } catch (error) { result.textContent = error.message }
    finally { button.disabled = false }
  })
})()
