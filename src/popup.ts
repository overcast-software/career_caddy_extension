import { renderComponent } from '@ember/renderer';
import SendCard from './components/send-card.gts';
import './styles.css';

// Same two lines as the panel, a different component. One component tree, two
// extension surfaces, no framework application object in either.
const root = document.getElementById('root');
if (root) {
  renderComponent(SendCard, { into: root });
}
