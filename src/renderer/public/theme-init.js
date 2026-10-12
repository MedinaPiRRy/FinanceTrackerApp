// Runs before the page is drawn (loaded from index.html, which the app's security policy only allows as a file, not inline),
// so the saved style is in place from the first paint. Keep the list in step with src/renderer/themes.ts (a test checks this).
(function () {
  try {
    var ids = ['light', 'dark', 'business', 'girlmath', 'programmer', 'cozy', 'casual', 'adhd']
    var v = localStorage.getItem('theme')
    if (ids.indexOf(v) !== -1) document.documentElement.setAttribute('data-theme', v)
  } catch (e) { /* storage unavailable: the default look is used */ }
})()
