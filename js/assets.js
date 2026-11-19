/* ============ Asset loading ============
 * Background, step texture and character images come from the original
 * "Stair Stepping" game (reference.html) and live in assets/.
 * window.assetsReady resolves when they are loaded (or after 5 s at most).
 */
const ASSETS = {
  step: 'assets/step.png',
  bg: 'assets/stage-bg.jpg',
  stand: 'assets/stand.png',
  jump: 'assets/jump.png'
};

(function applyAssetVars() {
  const root = document.documentElement.style;
  // absolute URLs so they resolve from the page, not from css/style.css
  const abs = p => new URL(p, document.baseURI).href;
  root.setProperty('--step-img', "url('" + abs(ASSETS.step) + "')");
  root.setProperty('--stage-bg-img', "url('" + abs(ASSETS.bg) + "')");
})();

window.assetsReady = (function () {
  const loads = Object.keys(ASSETS).map(function (k) {
    return new Promise(function (res) {
      const img = new Image();
      img.onload = img.onerror = function () { res(); };
      img.src = ASSETS[k];
    });
  });
  const timeout = new Promise(function (res) { setTimeout(res, 5000); });
  return Promise.race([Promise.all(loads), timeout]);
})();
