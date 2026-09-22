const header = document.querySelector('[data-header]')
const menuToggle = document.querySelector('[data-menu-toggle]')
const navigation = document.querySelector('[data-nav]')
const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches

const syncNavigationState = () => {
  if (!menuToggle || !navigation) return

  const isClosedMobile = window.innerWidth <= 920 && menuToggle.getAttribute('aria-expanded') !== 'true'
  navigation.toggleAttribute('inert', isClosedMobile)
}

const closeMenu = ({ restoreFocus = false } = {}) => {
  if (!menuToggle || !navigation) return

  const wasOpen = menuToggle.getAttribute('aria-expanded') === 'true'
  menuToggle.setAttribute('aria-expanded', 'false')
  menuToggle.setAttribute('aria-label', 'Open navigation')
  navigation.classList.remove('is-open')
  document.body.classList.remove('menu-open')
  syncNavigationState()

  if (restoreFocus && wasOpen) menuToggle.focus()
}

if (menuToggle && navigation) {
  syncNavigationState()

  menuToggle.addEventListener('click', () => {
    const willOpen = menuToggle.getAttribute('aria-expanded') !== 'true'

    menuToggle.setAttribute('aria-expanded', String(willOpen))
    menuToggle.setAttribute('aria-label', willOpen ? 'Close navigation' : 'Open navigation')
    navigation.classList.toggle('is-open', willOpen)
    document.body.classList.toggle('menu-open', willOpen)
    syncNavigationState()
  })

  navigation.querySelectorAll('a').forEach((link) => link.addEventListener('click', () => closeMenu()))

  document.addEventListener('keydown', (event) => {
    if (event.key === 'Escape') closeMenu({ restoreFocus: true })
  })

  window.addEventListener('resize', () => {
    if (window.innerWidth > 920) closeMenu()
    else syncNavigationState()
  })
}

const updateHeader = () => header?.classList.toggle('is-scrolled', window.scrollY > 12)

updateHeader()
window.addEventListener('scroll', updateHeader, { passive: true })

document.querySelectorAll('[data-year]').forEach((element) => {
  element.textContent = new Date().getFullYear()
})

const revealElements = document.querySelectorAll('.reveal')

if (reduceMotion || !('IntersectionObserver' in window)) {
  revealElements.forEach((element) => element.classList.add('is-visible'))
} else {
  const observer = new IntersectionObserver(
    (entries, currentObserver) => {
      entries.forEach((entry) => {
        if (!entry.isIntersecting) return
        entry.target.classList.add('is-visible')
        currentObserver.unobserve(entry.target)
      })
    },
    { threshold: 0.12, rootMargin: '0px 0px -45px' },
  )

  revealElements.forEach((element) => observer.observe(element))
}

const demoChat = document.querySelector('[data-demo-chat]')
const demoButtons = [...document.querySelectorAll('[data-demo]')]

const demoConversations = {
  missed: `
    <span class="demo-day">TODAY</span>
    <div class="bubble bubble--student">What did I miss today?<time>6:43 PM</time></div>
    <div class="bubble bubble--peer">
      <p>You have <strong>3 important updates</strong>:</p>
      <ol>
        <li><strong>CSC 301:</strong> Friday's test is at 10 AM in LG7.</li>
        <li><strong>MTH 202:</strong> Today's class moved to LT2.</li>
        <li><strong>GST 201:</strong> The assignment is due tomorrow.</li>
      </ol>
      <span class="bubble-source">Sources: Dr Bello's voice note, class rep update + assignment brief</span>
      <time>6:43 PM</time>
    </div>
    <div class="bubble bubble--student">Where is the MTH class again?<time>6:44 PM</time></div>
    <div class="bubble bubble--peer">Lecture Theatre 2 (LT2). The class rep changed it at 2:08 PM.<time>6:44 PM</time></div>
  `,
  resources: `
    <span class="demo-day">TODAY</span>
    <div class="bubble bubble--student">Send the CSC 301 resources<time>8:16 PM</time></div>
    <div class="bubble bubble--peer">
      <p>I found <strong>4 CSC 301 files</strong> shared since I joined the group:</p>
      <ol>
        <li>Week 4 — Data structures.pdf</li>
        <li>Linked lists — lecture slides.pptx</li>
        <li>2025 past questions.pdf</li>
        <li>Assignment 2 brief.docx</li>
      </ol>
      <span class="bubble-source">Filed from CSC 301 · newest first</span>
      <time>8:16 PM</time>
    </div>
    <div class="bubble bubble--student">Send the second one<time>8:17 PM</time></div>
    <div class="bubble bubble--peer">Here you go: <strong>Linked lists — lecture slides.pptx</strong> (3.1 MB).<time>8:17 PM</time></div>
  `,
  prep: `
    <span class="demo-day">TODAY</span>
    <div class="bubble bubble--student">Quiz me for the CSC 301 test<time>9:03 PM</time></div>
    <div class="bubble bubble--peer">
      <p>I built a five-question practice set from the latest CSC 301 slides and past questions.</p>
      <p><strong>Question 1 of 5:</strong><br />What is the time complexity of inserting an item at the head of a singly linked list?</p>
      <span class="bubble-source">Based on Week 4 slides + 2025 past questions</span>
      <time>9:03 PM</time>
    </div>
    <div class="bubble bubble--student">O(1)<time>9:04 PM</time></div>
    <div class="bubble bubble--peer">Correct ✓ The head pointer changes without traversing the list. Ready for question 2?<time>9:04 PM</time></div>
  `,
}

demoButtons.forEach((button) => {
  button.addEventListener('click', () => {
    const conversation = demoConversations[button.dataset.demo]
    if (!demoChat || !conversation) return

    demoButtons.forEach((currentButton) => {
      const isActive = currentButton === button
      currentButton.classList.toggle('is-active', isActive)
      currentButton.setAttribute('aria-pressed', String(isActive))
    })

    demoChat.style.opacity = '0'
    demoChat.style.transform = 'translateY(5px)'

    window.setTimeout(
      () => {
        demoChat.innerHTML = conversation
        demoChat.style.opacity = '1'
        demoChat.style.transform = 'translateY(0)'
      },
      reduceMotion ? 0 : 140,
    )
  })
})

if (demoChat) {
  demoChat.style.transition = 'opacity 160ms ease, transform 160ms ease'
}

const faqItems = [...document.querySelectorAll('.faq-list details')]

faqItems.forEach((item) => {
  item.addEventListener('toggle', () => {
    if (!item.open) return
    faqItems.forEach((otherItem) => {
      if (otherItem !== item) otherItem.open = false
    })
  })
})

const signupDialog = document.querySelector('[data-signup-dialog]')
const signupClose = document.querySelector('[data-signup-close]')
const signupForm = document.querySelector('[data-email-signup]')
const signupStatus = document.querySelector('[data-signup-status]')
const signupToast = document.querySelector('[data-signup-toast]')
const signupCtas = [...document.querySelectorAll('[data-signup-cta]')]
const signupStorageKey = 'peermate.signup.v1'
let whatsappUrl = 'https://wa.me/15076046411'
let signupComplete = false

try {
  signupComplete = window.localStorage.getItem(signupStorageKey) === 'complete'
} catch {
  // Signup still works when storage is unavailable; the CTA resets on the next visit.
}

const setSignupStatus = (message = '', isError = false) => {
  if (!signupStatus) return
  signupStatus.textContent = message
  signupStatus.classList.toggle('is-error', isError)
}

const syncSignupCtas = () => {
  signupCtas.forEach((cta) => {
    const label = cta.querySelector('[data-cta-label]')
    if (!signupComplete) {
      cta.setAttribute('href', '#signup')
      cta.removeAttribute('target')
      cta.removeAttribute('rel')
      cta.setAttribute('aria-label', 'Sign up for PeerMate')
      return
    }

    cta.setAttribute('href', whatsappUrl)
    cta.setAttribute('target', '_blank')
    cta.setAttribute('rel', 'noopener noreferrer')
    cta.setAttribute('aria-label', 'Chat with PeerMate on WhatsApp')
    if (label) label.textContent = cta.dataset.signedInLabel || 'Chat on WhatsApp'
  })
}

const openSignup = () => {
  if (!signupDialog) return
  setSignupStatus()
  if (typeof signupDialog.showModal === 'function') signupDialog.showModal()
  else signupDialog.setAttribute('open', '')
  signupForm?.querySelector('input[name="email"]')?.focus()
}

const closeSignup = () => {
  if (!signupDialog) return
  if (typeof signupDialog.close === 'function') signupDialog.close()
  else signupDialog.removeAttribute('open')
}

signupCtas.forEach((cta) => {
  cta.addEventListener('click', (event) => {
    if (signupComplete) return
    event.preventDefault()
    closeMenu()
    openSignup()
  })
})

signupClose?.addEventListener('click', closeSignup)
signupDialog?.addEventListener('click', (event) => {
  if (event.target === signupDialog) closeSignup()
})

const finishSignup = (nextWhatsappUrl) => {
  whatsappUrl = nextWhatsappUrl || whatsappUrl
  signupComplete = true
  try {
    window.localStorage.setItem(signupStorageKey, 'complete')
  } catch {
    // The current page still transitions even if the browser blocks storage.
  }
  syncSignupCtas()
  closeSignup()
  if (signupToast) {
    signupToast.hidden = false
    window.setTimeout(() => {
      signupToast.hidden = true
    }, 5000)
  }
}

const postSignup = async (path, payload) => {
  const response = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
  const result = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(result.error || 'Signup could not be saved. Please try again.')
  return result
}

signupForm?.addEventListener('submit', async (event) => {
  event.preventDefault()
  const submitButton = signupForm.querySelector('button[type="submit"]')
  const submitLabel = signupForm.querySelector('[data-submit-label]')
  const fields = new FormData(signupForm)
  const email = String(fields.get('email') || '').trim()
  const name = String(fields.get('name') || '').trim()

  if (!email || !signupForm.reportValidity()) return

  submitButton?.setAttribute('disabled', '')
  if (submitLabel) submitLabel.textContent = 'Signing you up…'
  setSignupStatus('Saving your signup…')

  try {
    const result = await postSignup('/api/signup/email', { email, name })
    signupForm.reset()
    finishSignup(result.whatsappUrl)
  } catch (error) {
    setSignupStatus(error instanceof Error ? error.message : 'Signup failed.', true)
  } finally {
    submitButton?.removeAttribute('disabled')
    if (submitLabel) submitLabel.textContent = 'Sign up with email'
  }
})

// Google signup is intentionally disabled for now.

const loadSignupConfig = async () => {
  try {
    const response = await fetch('/api/signup/config', { headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error('Signup configuration is unavailable.')
    const config = await response.json()
    whatsappUrl = config.whatsappUrl || whatsappUrl
    syncSignupCtas()
  } catch {
    syncSignupCtas()
  }
}

syncSignupCtas()
void loadSignupConfig()
