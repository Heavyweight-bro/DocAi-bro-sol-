(() => {
  const nav = document.getElementById('nav');
  const onScroll = () => nav.classList.toggle('scrolled', window.scrollY > 10);
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });

  // mobile menu
  const btn = document.querySelector('.menu-btn');
  const menu = document.getElementById('mobile-menu');
  btn?.addEventListener('click', () => {
    const open = btn.getAttribute('aria-expanded') !== 'true';
    btn.setAttribute('aria-expanded', String(open));
    menu.hidden = !open;
  });
  menu?.addEventListener('click', (e) => { if (e.target.closest('a')) { btn.setAttribute('aria-expanded', 'false'); menu.hidden = true; } });

  // reveal on scroll (content below the first screen only)
  const io = 'IntersectionObserver' in window ? new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
  }, { rootMargin: '0px 0px -8% 0px' }) : null;
  document.querySelectorAll('.reveal').forEach((el) => (io ? io.observe(el) : el.classList.add('in')));

  document.querySelectorAll('.scan span').forEach((s, i) => s.style.setProperty('--i', i));

  // steps → screenshot
  const shot = document.querySelector('#step-screen img');
  const steps = [...document.querySelectorAll('.step')];
  const counter = document.querySelector('[data-step-counter]');
  const select = (step) => {
    steps.forEach((s) => { s.classList.toggle('on', s === step); s.setAttribute('aria-selected', String(s === step)); });
    if (counter) counter.textContent = `${step.querySelector('.n').textContent} — 04`;
    if (shot && shot.getAttribute('src') !== step.dataset.img) {
      shot.style.opacity = '0';
      setTimeout(() => { shot.src = step.dataset.img; shot.onload = () => { shot.style.opacity = '1'; }; }, 180);
    }
  };
  steps.forEach((s) => { s.addEventListener('click', () => select(s)); s.addEventListener('mouseenter', () => select(s)); });

  // ROI calculator — plain arithmetic on the visitor's own numbers
  const roi = document.querySelector('[data-roi]');
  if (roi) {
    const val = (name) => Math.max(0, Number(String(roi.querySelector(`[name="${name}"]`).value).replace(',', '.')) || 0);
    const out = (name, text) => { roi.querySelector(`[data-out="${name}"]`).textContent = text; };
    const uah = (n) => `${Math.round(n).toLocaleString('uk-UA')} грн`;
    const calc = () => {
      const docs = val('docs'), manual = val('manual'), review = val('review'), rate = val('rate'), ai = val('ai');
      const hours = (docs * Math.max(0, manual - review)) / 60;
      const aiCost = docs * ai;
      const month = hours * rate - aiCost;
      out('hours', `${hours.toLocaleString('uk-UA', { maximumFractionDigits: 0 })} год`);
      out('month', uah(month));
      out('year', uah(month * 12));
      out('aicost', uah(aiCost));
      const fte = hours / 168;
      out('fte', fte >= 0.1 ? `${fte.toLocaleString('uk-UA', { maximumFractionDigits: 1 })} ставки` : '< 0,1 ставки');
    };
    roi.addEventListener('input', calc);
    calc();
  }

  // video placeholder when the file is missing
  const frame = document.querySelector('[data-video]');
  const video = frame?.querySelector('video');
  const empty = frame?.querySelector('.video-empty');
  const showEmpty = () => { if (video) video.hidden = true; if (empty) empty.hidden = false; };
  video?.querySelector('source')?.addEventListener('error', showEmpty);
  video?.addEventListener('error', showEmpty);

  // app link: same host, port 3000 (works for localhost and LAN addresses)
  const app = window.DOCAI_APP_URL || `${location.protocol}//${location.hostname || 'localhost'}:3000`;
  document.querySelectorAll('[data-app-link]').forEach((a) => { a.href = app; });
})();
