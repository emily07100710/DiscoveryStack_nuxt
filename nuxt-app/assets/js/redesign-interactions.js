/**
 * DiscoveryStack 重新設計互動腳本
 * 處理頁面的滾動動畫和互動功能
 */

export function initRedesignInteractions() {
  const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches

  // Hero 逐行揭露
  const heroTitle = document.getElementById('heroTitle')
  if (heroTitle && !reduce) {
    requestAnimationFrame(() => {
      setTimeout(() => heroTitle.classList.add('is-in'), 80)
    })
  }

  // 捲動揭露
  const revealables = document.querySelectorAll('.reveal')
  if (reduce) {
    revealables.forEach(el => el.classList.add('is-in'))
  } else if ('IntersectionObserver' in window) {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          entry.target.classList.add('is-in')
          io.unobserve(entry.target)
        }
      })
    }, { rootMargin: '0px 0px -12% 0px', threshold: 0.15 })
    revealables.forEach(el => io.observe(el))
  } else {
    revealables.forEach(el => el.classList.add('is-in'))
  }

  // 全站路徑進度軌
  const rail = document.querySelector('.route-rail')
  const header = document.getElementById('siteHeader')
  let ticking = false

  function onScroll() {
    const doc = document.documentElement
    const max = doc.scrollHeight - window.innerHeight
    const pct = max > 0 ? (window.scrollY / max) * 100 : 0
    if (rail) rail.style.setProperty('--route-progress', pct.toFixed(2) + '%')
    if (header) header.classList.toggle('is-stuck', window.scrollY > 12)
    ticking = false
  }

  window.addEventListener('scroll', () => {
    if (!ticking) {
      ticking = true
      requestAnimationFrame(onScroll)
    }
  }, { passive: true })
  onScroll()

  // 需求路徑：sticky 編號同步
  const steps = Array.from(document.querySelectorAll('.step'))
  const numbers = Array.from(document.querySelectorAll('.rail-numbers b'))
  const railLabel = document.getElementById('railLabel')
  const railTrack = document.getElementById('railTrack')

  function setActiveStep(index) {
    numbers.forEach((n, i) => n.classList.toggle('is-active', i === index))
    if (railLabel && steps[index]) {
      railLabel.textContent = steps[index].dataset.label || ''
    }
    if (railTrack) {
      railTrack.style.width = `${((index + 1) / steps.length) * 100}%`
    }
  }

  if (steps.length && 'IntersectionObserver' in window) {
    const stepIO = new IntersectionObserver((entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          setActiveStep(Number(entry.target.dataset.step))
        }
      })
    }, { rootMargin: '-35% 0px -45% 0px', threshold: 0 })
    steps.forEach(s => stepIO.observe(s))
  }
  if (steps.length > 0) setActiveStep(0)

  // 行動版導覽
  const toggle = document.getElementById('navToggle')
  const nav = document.getElementById('siteNav')
  if (toggle && nav) {
    toggle.addEventListener('click', () => {
      const open = nav.classList.toggle('is-open')
      toggle.setAttribute('aria-expanded', String(open))
      toggle.textContent = open ? '關閉' : '選單'
    })
    nav.addEventListener('click', (e) => {
      if (e.target.tagName === 'A') {
        nav.classList.remove('is-open')
        toggle.setAttribute('aria-expanded', 'false')
        toggle.textContent = '選單'
      }
    })
  }
}
