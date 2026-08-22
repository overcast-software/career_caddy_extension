import { renderComponent } from '@ember/renderer';
import Workbench from './components/workbench.gts';
import './styles.css';

// This is the entire bootstrap. No Application, no router, no resolver, no
// dependency-injection container — `owner` is optional and we do not pass one.
//
// `renderComponent` is public API in ember-source 7.x (RFC #1099). It is NOT
// in 6.x, which is what the SPA in frontend/ still pins; that version gap is
// the main reason this extension carries its own package.json.
const root = document.getElementById('root');
if (root) {
  renderComponent(Workbench, { into: root });
}
