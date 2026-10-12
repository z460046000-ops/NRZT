/* 外部稿预览只供内部检查；外发文件由服务端审核后单独生成。 */
(() => {
  const panel = document.getElementById('release-panel')
  if (!panel) return
  const fields = document.getElementById('release-fields')
  const result = document.getElementById('release-result')
  let acknowledgedIssues
  document.getElementById('release-confirm-all').addEventListener('click', () => {
    fields.querySelectorAll('input[type="checkbox"]').forEach(input => { input.checked = true })
  })
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
          ...(acknowledgedIssues ? { acknowledgedIssues } : {}),
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
      acknowledgedIssues = undefined
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '外发检查失败')
      if (data.issues?.length) {
        result.replaceChildren()
        const title = document.createElement('strong')
        title.textContent = '请核对以下问题：'
        const list = document.createElement('ul')
        data.issues.forEach(issue => {
          const li = document.createElement('li')
          li.textContent = issue.message
          if (issue.location) {
            const detail = document.createElement('p')
            detail.textContent = `${issue.location.sectionHeading} · ${issue.location.field}：${issue.location.excerpt}`
            const locate = document.createElement('button')
            locate.type = 'button'; locate.textContent = '定位文字'
            locate.addEventListener('click', () => {
              const slides = [...document.querySelectorAll('.slide')]
              const marked = [...document.querySelectorAll('[data-edit-path]')].find(item => item.dataset.editPath === issue.location.field)
              if (marked) {
                const slide = marked.closest('.slide')
                fields.hidden = true
                document.getElementById('release-open').textContent = '外发检查'
                window.dispatchEvent(new CustomEvent('presales:go-to-slide', { detail: slides.indexOf(slide) + 1 }))
                marked.click()
                return
              }
              const scopeText = slide => {
                if (issue.location.field.startsWith('links/')) return slide.querySelector('.linked-body,.relation-board')?.textContent ?? ''
                if (issue.location.field.includes('/blocks/')) return slide.querySelector('.body')?.textContent ?? ''
                return slide.classList.contains('toc-slide') ? '' : slide.textContent
              }
              const target = slides.find(slide => scopeText(slide).includes(issue.location.term)
                && (slide.textContent.includes(issue.location.sectionHeading) || issue.location.sectionHeading === '封面'))
                ?? slides.find(slide => scopeText(slide).includes(issue.location.term))
              if (!target) return
              fields.hidden = true
              document.getElementById('release-open').textContent = '外发检查'
              window.dispatchEvent(new CustomEvent('presales:go-to-slide', { detail: slides.indexOf(target) + 1 }))
              document.querySelectorAll('.review-highlight').forEach(item => item.classList.remove('review-highlight'))
              const text = [...target.querySelectorAll('p,li,h1,h2,h3,span')].find(item => item.textContent.includes(issue.location.term))
              text?.classList.add('review-highlight')
            })
            li.append(detail, locate)
          }
          list.append(li)
        })
        result.append(title, list)
        const reviewable = data.issues.filter(issue => issue.reviewable)
        if (reviewable.length) {
          const approve = document.createElement('button')
          approve.type = 'button'
          approve.textContent = '以上措辞提示全部已核对，继续外发'
          approve.addEventListener('click', () => {
            acknowledgedIssues = { keys: reviewable.map(issue => issue.key), policyDigest: data.policyDigest }
            document.getElementById('release-submit').click()
          })
          result.append(approve)
        }
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
