/* Анимации появления. Подключается на страницах, использующих site.css.
   Контент виден без JS: класс .js-anim ставится только когда скрипт жив. */
(function(){
  var reduce = window.matchMedia('(prefers-reduced-motion:reduce)').matches;
  if (reduce || !('IntersectionObserver' in window)) return;
  document.documentElement.classList.add('js-anim');

  function init(){
    var sel = 'section > .wrap > *, .cat-grid > *, .post > h2, .post > p, .post > ol, .post > ul, .post > figure, .post > .tw, .case-strip, .kpis, .tw, .projects-scroller';
    var seen = new Set();
    var items = [];
    document.querySelectorAll(sel).forEach(function(el){
      if (seen.has(el) || el.closest('.hero') || el.closest('.projects-scroller')) return;
      seen.add(el); el.classList.add('reveal'); items.push(el);
    });

    var io = new IntersectionObserver(function(entries){
      entries.forEach(function(e){
        if (!e.isIntersecting) return;
        e.target.classList.add('on');
        io.unobserve(e.target);
      });
    }, {threshold:0.1, rootMargin:'0px 0px -5% 0px'});

    // лёгкий каскад для соседей в одной сетке
    items.forEach(function(el){
      var sibs = el.parentElement ? [].slice.call(el.parentElement.children) : [];
      var i = sibs.indexOf(el);
      if (i > 0 && i < 6) el.style.setProperty('--d', (i*60)+'ms');
      io.observe(el);
    });

    // страховка: всё, что не показалось за 3 с, показать принудительно
    setTimeout(function(){
      items.forEach(function(el){ el.classList.add('on'); });
    }, 1500);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init);
  else init();
})();
