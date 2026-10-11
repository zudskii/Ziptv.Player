// Applies the saved theme before first paint (no flash of the wrong theme).
(function () {
  try {
    var raw = localStorage.getItem('ziptv:theme');
    var pref = raw ? JSON.parse(raw).state.preference : 'dark';
    var light = pref === 'light' || (pref === 'system' && window.matchMedia('(prefers-color-scheme: light)').matches);
    document.documentElement.className = light ? 'theme-light' : 'theme-dark';
  } catch (e) {
    /* storage unavailable: keep dark */
  }
})();
