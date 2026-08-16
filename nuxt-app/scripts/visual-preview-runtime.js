(() => {
  const dock = document.querySelector('.ai-qa-dock')
  const launcher = dock?.querySelector('.qa-launcher')
  const panel = dock?.querySelector('.qa-panel')
  const closeButton = dock?.querySelector('.qa-toggle')
  const promptButtons = dock ? [...dock.querySelectorAll('.qa-prompts button')] : []
  const qaForm = dock?.querySelector('.qa-form')
  const qaInput = dock?.querySelector('.qa-form input')
  const conversation = dock?.querySelector('.qa-conversation')
  const isZh = document.documentElement.lang.toLowerCase().startsWith('zh')
  const setDockOpen = (open, restoreFocus = false) => {
    if (!dock || !launcher || !panel) return
    dock.classList.toggle('is-open', open)
    launcher.setAttribute('aria-expanded', String(open))
    panel.setAttribute('aria-hidden', String(!open))
    if (!open && restoreFocus) launcher.focus()
  }
  if (dock && launcher && panel) {
    launcher.addEventListener('click', () => setDockOpen(!dock.classList.contains('is-open')))
    closeButton?.addEventListener('click', () => setDockOpen(false, true))
    dock.addEventListener('keydown', (event) => {
      if (event.key === 'Escape') setDockOpen(false, true)
    })
    if (new URLSearchParams(window.location.search).get('qa') === 'open') setDockOpen(true)
    const appendMessage = (text, role) => {
      if (!conversation) return
      const message = document.createElement('p')
      message.className = `qa-message ${role}`
      message.textContent = text
      conversation.querySelector('.qa-welcome')?.remove()
      conversation.append(message)
      conversation.scrollTop = conversation.scrollHeight
    }
    const previewAnswer = (question) => {
      const value = question.toLowerCase()
      if (value.includes('audit') || value.includes('稽核')) return isZh
        ? '我們可以先一起看公開網站中能辨識的結構訊號；需要策略判斷時，仍會由人類仔細覆核。'
        : 'We can start with public structural signals, then bring human review into the strategy conversation where it matters.'
      if (value.includes('ai') || value.includes('亂') || value.includes('make')) return isZh
        ? '這個助手會盡量只根據已核准的資訊提供方向；需要更多脈絡時，我們會邀請真人和你一起確認。'
        : 'This assistant stays close to approved information, and we invite a person into the conversation when more context is needed.'
      return isZh
        ? '我們可以先一起找出需求在哪裡失去方向。這不是排名保證，而是一個較可靠的下一步起點。'
        : 'We can start by clarifying where demand loses its way. It is not a ranking promise—just a more grounded next step.'
    }
    const submitPreviewQuestion = (question) => {
      const text = question.trim()
      if (!text) return
      appendMessage(text, 'user')
      appendMessage(previewAnswer(text), 'assistant')
      setDockOpen(true)
      if (qaInput) qaInput.value = ''
    }
    promptButtons.forEach((button) => button.addEventListener('click', () => submitPreviewQuestion(button.textContent || '')))
    qaForm?.addEventListener('submit', (event) => {
      event.preventDefault()
      submitPreviewQuestion(qaInput?.value || '')
    })
  }

  const story = document.querySelector('.journey-story')
  if (!story || window.matchMedia('(prefers-reduced-motion: reduce)').matches) return

  const steps = [...story.querySelectorAll('.story-step')]
  const nodes = [...story.querySelectorAll('.story-node')]
  const index = story.querySelector('.story-index')
  const core = story.querySelector('.story-core')
  const canvas = story.querySelector('.story-canvas')
  let frame = 0

  const update = () => {
    const rect = story.getBoundingClientRect()
    const travel = Math.max(story.offsetHeight - window.innerHeight, 1)
    const progress = Math.min(1, Math.max(0, -rect.top / travel))
    const active = Math.min(steps.length - 1, Math.floor(progress * steps.length))
    story.style.setProperty('--story-progress', String(progress))
    story.style.setProperty('--scene-turn', String(progress))
    steps.forEach((step, position) => step.classList.toggle('is-active', position === active))
    nodes.forEach((node, position) => {
      node.classList.toggle('is-passed', position <= active)
      node.classList.toggle('is-current', position === active)
    })
    if (index) index.textContent = `${String(active + 1).padStart(2, '0')} / ${String(steps.length).padStart(2, '0')}`
    if (core) core.className = `story-core is-scene-${active + 1}`
  }

  const requestUpdate = () => {
    cancelAnimationFrame(frame)
    frame = requestAnimationFrame(update)
  }

  update()
  window.addEventListener('scroll', requestUpdate, { passive: true })
  window.addEventListener('resize', requestUpdate)

  if (canvas) {
    const resetPointer = () => {
      canvas.style.setProperty('--pointer-x', '0')
      canvas.style.setProperty('--pointer-y', '0')
    }
    canvas.addEventListener('pointermove', (event) => {
      if (event.pointerType && event.pointerType !== 'mouse') return
      const rect = canvas.getBoundingClientRect()
      canvas.style.setProperty('--pointer-x', String(((event.clientX - rect.left) / rect.width - 0.5) * 2))
      canvas.style.setProperty('--pointer-y', String(((event.clientY - rect.top) / rect.height - 0.5) * 2))
    })
    canvas.addEventListener('pointerleave', resetPointer)
  }
})()
