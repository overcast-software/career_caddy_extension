import { renderComponent } from '@ember/renderer';
import Workbench from './components/workbench.gts';
import './styles.css';

// The entire bootstrap. No Application, no router, no resolver, no
// dependency-injection container — `owner` is optional and we do not pass one.
//
// `renderComponent` is public API in ember-source 7.x (RFC #1099). It is NOT
// in 6.x, which is what the SPA in frontend/ still pins; that version gap is
// the main reason this extension carries its own package.json.
const root = document.getElementById('root');

if (!root) {
  console.error('[cc] #root missing from panel.html — nothing to render into');
} else {
  try {
    renderComponent(Workbench, { into: root });
  } catch (error) {
    // A render failure otherwise produces an EMPTY PANEL AND A CLEAN CONSOLE,
    // which is indistinguishable from "the extension didn't load" and sends
    // you looking in entirely the wrong place. Ask me how I know.
    console.error('[cc] panel failed to render', error);
    // Built with DOM calls rather than innerHTML. The string was static and
    // safe, but store reviewers grep for innerHTML and a hit costs a round of
    // correspondence to explain — cheaper to not have one. The only
    // innerHTML-adjacent calls left in the bundle are Glimmer's own
    // insertAdjacentHTML, which is vendor code on a path we never take.
    const notice = document.createElement('p');
    notice.style.cssText = 'font:12px system-ui;padding:12px';
    notice.textContent =
      'The panel failed to render. Open DevTools on this panel for the error.';
    root.replaceChildren(notice);
  }
}
