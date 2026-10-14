/* Browser editor embedded in generated solution.html. The Host remains the source of truth. */
(() => {
  const id = document.body.dataset.editorId
  if (!id) return
  const toggle = document.getElementById('edit-toggle')
  const panel = document.getElementById('editor-panel')
  const fields = document.getElementById('editor-fields')
  const status = document.getElementById('editor-status')
  const save = document.getElementById('editor-save')
  const notice = document.getElementById('save-notice')
  const close = document.getElementById('editor-close')
  const fact = document.getElementById('editor-fact')
  const knowledgeFields = document.getElementById('editor-knowledge')
  const note = document.getElementById('editor-note')
  const noteError = document.getElementById('editor-note-error')
  const scope = document.getElementById('editor-scope')
  const target = document.getElementById('editor-target')
  let source
  let dirty = false
  const originals = new Map()
  const replacements = new Map()
  const reviewed = new Set()

  function message(value, kind = '') {
    status.textContent = value
    status.dataset.kind = kind
  }

  function markDirty() {
    dirty = true
    save.disabled = false
    message('有未保存的修改', 'warning')
  }

  function field(parent, label, path, value, multiline = false) {
    const wrap = document.createElement('div')
    wrap.className = 'editor-field'
    const title = document.createElement('label')
    title.textContent = label
    const input = document.createElement(multiline ? 'textarea' : 'input')
    if (!multiline) input.type = 'text'
    input.id = `copy-field-${originals.size}`
    title.htmlFor = input.id
    input.value = value ?? ''
    input.dataset.path = path
    let reviewCheck
    input.addEventListener('input', () => {
      reviewed.delete(path)
      if (reviewCheck) { reviewCheck.checked = false; reviewCheck.disabled = !input.value.trim() }
      if (path.startsWith('links/') || (path.startsWith('blocks/') && !path.endsWith('/caption'))) {
        fact.checked = true; knowledgeFields.hidden = false
      }
      markDirty()
    })
    originals.set(path, input.value)
    wrap.append(title, input)
    const item = source?.copyReview?.find(item => item.path === path && item.status === 'pending')
    if (item) {
      const label = document.createElement('label')
      label.className = 'editor-review'
      reviewCheck = document.createElement('input')
      reviewCheck.type = 'checkbox'
      reviewCheck.disabled = !input.value.trim()
      reviewCheck.dataset.reviewPath = path
      reviewCheck.addEventListener('change', () => {
        if (reviewCheck.checked) reviewed.add(path)
        else reviewed.delete(path)
        markDirty()
      })
      const help = document.createElement('span')
      help.textContent = `${item.reason}。核对后勾选“此处已校对”，保存后取消下划线。`
      const text = document.createElement('span')
      text.textContent = '此处已校对'
      label.append(reviewCheck, text)
      wrap.append(help, label)
    }
    parent.append(wrap)
    return input
  }

  function addBlock(parent, block) {
    const area = document.createElement('div')
    area.className = 'editor-block'
    const typeNames = { para: '段落', quote: '引用', bullets: '要点', steps: '步骤', table: '表格', metrics: '指标', chart: '数据图表', image: '图片' }
    const heading = document.createElement('h4')
    heading.textContent = typeNames[block.type] ?? '内容'
    area.append(heading)
    if (block.type === 'para' && block.title) field(area, '短标题', `blocks/${block.id}/title`, block.title)
    if (block.type === 'para' && block.label) field(area, '类别', `blocks/${block.id}/label`, block.label)
    if (block.type === 'para' || block.type === 'quote') field(area, '正文', `blocks/${block.id}/text`, block.text, true)
    if (block.type === 'bullets' || block.type === 'steps') block.items.forEach((item, index) => {
      field(area, `${index + 1}`, `blocks/${block.id}/items/${index}`, item, true)
    })
    if (block.type === 'table') {
      block.headers.forEach((item, index) => field(area, `表头 ${index + 1}`, `blocks/${block.id}/headers/${index}`, item))
      block.rows.forEach((row, r) => row.forEach((item, c) => {
        field(area, `第 ${r + 1} 行 · ${block.headers[c]}`, `blocks/${block.id}/rows/${r}/${c}`, item, true)
      }))
    }
    if (block.type === 'metrics') block.items.forEach((item, index) => {
      field(area, `指标 ${index + 1} 名称`, `blocks/${block.id}/metrics/${index}/label`, item.label)
      field(area, `指标 ${index + 1} 数值`, `blocks/${block.id}/metrics/${index}/value`, item.value)
    })
    if (block.type === 'chart') {
      field(area, '图表标题', `blocks/${block.id}/chart/title`, block.title)
      field(area, '统一单位', `blocks/${block.id}/chart/unit`, block.unit)
      block.points.forEach((point, index) => {
        field(area, `数据 ${index + 1} 标签`, `blocks/${block.id}/chart/${index}/label`, point.label)
        field(area, `数据 ${index + 1} 数值`, `blocks/${block.id}/chart/${index}/value`, String(point.value))
      })
      const hint = document.createElement('p')
      hint.className = 'editor-hint'
      hint.textContent = '修改标签、单位或数值后，图表会标为待确认；原始资料仍保留供审核。'
      area.append(hint)
    }
    if (block.type === 'image') {
      field(area, '图片说明', `blocks/${block.id}/caption`, block.caption ?? '')
      const replace = document.createElement('label')
      replace.className = 'editor-field'
      const caption = document.createElement('span')
      caption.textContent = '替换图片（PNG/JPEG，最多 5MB）'
      const input = document.createElement('input')
      input.type = 'file'
      input.accept = 'image/png,image/jpeg'
      input.addEventListener('change', async () => {
        const file = input.files?.[0]
        if (!file) return
        if (file.size > 5 * 1024 * 1024) { message('图片超过 5MB，请换一张', 'error'); input.value = ''; return }
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000))
        replacements.set(block.id, { blockId: block.id, data: btoa(binary) })
        markDirty()
      })
      replace.append(caption, input)
      area.append(replace)
    }
    parent.append(area)
  }

  function renderForm(solution) {
    fields.replaceChildren()
    originals.clear()
    field(fields, '方案标题', 'title', solution.title)
    field(fields, '副标题', 'subtitle', solution.subtitle ?? '')
    if (solution.painSolutionLinks?.length) {
      const group = document.createElement('details')
      group.className = 'editor-section'
      group.open = true
      const summary = document.createElement('summary')
      summary.textContent = '痛点与解决方案 · 成对编辑'
      group.append(summary)
      solution.painSolutionLinks.forEach(link => {
        const item = document.createElement('div')
        item.className = 'editor-block'
        const heading = document.createElement('h4')
        heading.textContent = `${link.id} · ${link.painBasis === 'public_unverified' ? '行业参考·待核实' : link.painBasis === 'inferred' ? '资料推断·待确认' : link.painBasis === 'user_unverified' ? '用户补充·待核实' : '资料明确'}`
        item.append(heading)
        field(item, '客户痛点', `links/${link.id}/pain`, link.pain, true)
        field(item, '对应做法', `links/${link.id}/solution`, link.solution, true)
        group.append(item)
      })
      fields.append(group)
    }
    solution.sections.forEach((section, index) => {
      const group = document.createElement('details')
      group.className = 'editor-section'
      group.open = index === 0
      const summary = document.createElement('summary')
      summary.textContent = `${index + 1}. ${section.heading}`
      group.append(summary)
      field(group, '章节标题', `sections/${section.id}/heading`, section.heading)
      field(group, '章节说明', `sections/${section.id}/lead`, section.lead ?? '', true)
      if (['pains', 'solution'].includes(section.kind) && solution.painSolutionLinks?.length
        && section.blocks.length === 1 && section.blocks[0].type === 'table') {
        const hint = document.createElement('p')
        hint.className = 'editor-hint'
        hint.textContent = '本章对照表由上方的痛点与解决方案自动生成。'
        group.append(hint)
      } else section.blocks.forEach(block => addBlock(group, block))
      fields.append(group)
    })
  }

  async function open(fieldPath) {
    panel.hidden = false
    document.body.classList.add('editor-open')
    document.getElementById('editor-close').focus()
    window.dispatchEvent(new Event('resize'))
    if (source) { focusField(fieldPath); return }
    message('正在读取方案…')
    try {
      if (location.protocol === 'file:') throw new Error('离线文件无法连接 DSH 保存服务。请在 DSH 对话中打开编辑链接。')
      const response = await fetch(`/api/wlyd-presales/document?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '读取失败')
      source = data.solution
      renderForm(source)
      focusField(fieldPath)
      message(`第 ${source.revision} 版 · 修改后保存将同步 JSON、Markdown 和 DOCX`)
    } catch (error) { message(error.message, 'error') }
  }

  function focusField(path) {
    if (typeof path !== 'string') return
    const input = [...fields.querySelectorAll('[data-path]')].find(input => input.dataset.path === path)
    if (!input) { message('该内容未找到编辑项，请刷新后重试', 'error'); return }
    for (const marked of fields.querySelectorAll('.review-target')) marked.classList.remove('review-target')
    let parent = input.parentElement
    while (parent && parent !== fields) {
      if (parent.tagName === 'DETAILS') parent.open = true
      parent = parent.parentElement
    }
    input.closest('.editor-field').classList.add('review-target')
    input.scrollIntoView({ block: 'center' })
    input.focus()
  }

  function hide() {
    if (dirty && !window.confirm('有未保存的修改，确定关闭编辑区吗？')) return
    panel.hidden = true
    document.body.classList.remove('editor-open')
    toggle.focus()
    window.dispatchEvent(new Event('resize'))
  }

  async function persist() {
    if (!source) return
    const changes = [...fields.querySelectorAll('[data-path]')]
      .filter(input => input.value !== originals.get(input.dataset.path))
      .map(input => ({ path: input.dataset.path, value: input.value }))
    if (!changes.length && !replacements.size && !reviewed.size) { message('没有需要保存的修改'); return }
    if (fact.checked && !note.value.trim()) {
      noteError.hidden = false
      message('请填写事实修改原因', 'error')
      note.focus()
      return
    }
    noteError.hidden = true
    save.disabled = true
    message('正在保存并重生成文件…')
    try {
      const response = await fetch('/api/wlyd-presales/save', {
        method: 'POST', credentials: 'same-origin', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id, baseRevision: source.revision, changes, reviewedPaths: [...reviewed],
          replacements: [...replacements.values()],
          knowledge: { factChange: fact.checked, scope: scope.value, targetId: target.value, reason: note.value } }),
      })
      const data = await response.json()
      if (!response.ok) throw new Error(data.error || '保存失败')
      dirty = false
      const url = new URL(location.href)
      url.searchParams.set('saved', String(data.revision))
      location.replace(url)
    } catch (error) { save.disabled = false; message(error.message, 'error') }
  }

  function editTarget(event) {
    const direct = event.target.closest?.('[data-edit-path]')
    if (direct) return direct
    // 多行行内文字的边界框包含留白；点击其唯一所属段落也打开同一字段。
    const paragraph = event.target.closest?.('p,h1,h2,h3,li,td,em,strong')
    const marks = paragraph?.querySelectorAll('[data-edit-path]')
    return marks?.length === 1 ? marks[0] : undefined
  }
  toggle.addEventListener('click', () => open())
  document.addEventListener('click', event => {
    const target = editTarget(event)
    if (target) open(target.dataset.editPath)
  })
  document.addEventListener('keydown', event => {
    const target = editTarget(event)
    if (target && ['Enter', ' '].includes(event.key)) { event.preventDefault(); open(target.dataset.editPath) }
  })
  fact.addEventListener('change', () => { knowledgeFields.hidden = !fact.checked; noteError.hidden = true })
  note.addEventListener('input', () => { noteError.hidden = true })
  close.addEventListener('click', hide)
  save.addEventListener('click', persist)
  document.addEventListener('keydown', event => { if (event.key === 'Escape' && !panel.hidden) hide() })
  window.addEventListener('beforeunload', event => { if (dirty) { event.preventDefault(); event.returnValue = '' } })
  const params = new URLSearchParams(location.search)
  if (params.has('saved')) {
    fetch(`/api/wlyd-presales/document?id=${encodeURIComponent(id)}`, { credentials: 'same-origin' })
      .then(async response => {
        const data = await response.json()
        if (!response.ok) throw new Error(data.error || '无法核对保存状态')
        const revision = data.solution.revision
        const requested = Number(params.get('saved'))
        const statusText = {
          awaiting_knowledge_api: '知识变更留在本地，待知识库接口接入',
          submitted_for_review: '知识变更已提交审核',
          needs_target: '知识变更待补归属 ID',
          delivery_failed: '知识接口提交失败，可重试',
          record_failed: '知识记录失败，请人工检查',
        }[data.knowledge.status] ?? '各格式已同步'
        const text = requested === revision
          ? `第 ${revision} 版已保存；${statusText}`
          : `当前是第 ${revision} 版；请核对最新内容`
        const kind = ['delivery_failed', 'record_failed'].includes(data.knowledge.status) ? 'error'
          : ['awaiting_knowledge_api', 'needs_target'].includes(data.knowledge.status) ? 'warning' : 'success'
        notice.textContent = text
        notice.dataset.kind = kind
        notice.hidden = false
        message(text, kind)
        toggle.textContent = `第 ${revision} 版 · 编辑方案`
      })
      .catch(error => { notice.textContent = error.message; notice.dataset.kind = 'error'; notice.hidden = false })
    const cleanUrl = new URL(location.href)
    cleanUrl.searchParams.delete('saved')
    cleanUrl.searchParams.delete('knowledge')
    history.replaceState(null, '', cleanUrl)
  }
})()
