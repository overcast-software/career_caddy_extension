import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import { on } from '@ember/modifier';
import { openPanel, detectPanelHost } from '../lib/panel.ts';

/**
 * The popup. Deliberately small.
 *
 * The popup keeps the one job it is actually good at — "send this page" is a
 * single click, and the fact that the popup is destroyed a moment later does
 * not matter for an interaction that is already over. Everything that needs to
 * survive being looked away from lives in the panel.
 */
export default class SendCard extends Component {
  @tracked status = '';
  @tracked panelHost = detectPanelHost();

  /**
   * THE USER-GESTURE TRAP.
   *
   * `sidePanel.open()` may only be called while the browser can still see a
   * user gesture in progress. It needs a tabId — but `chrome.tabs.query` is
   * async, and the moment you `await` it inside the click handler the gesture
   * is spent and the call is rejected with "must be called in response to a
   * user gesture".
   *
   * So we read the tab up front, when the popup opens, and the click handler
   * only reads a field. Costs one query on open; makes the button work.
   */
  @tracked private tabId: number | undefined;

  constructor(owner: unknown, args: object) {
    super(owner, args);
    void this.captureActiveTab();
  }

  private async captureActiveTab(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.tabId = tab?.id;
    } catch {
      this.tabId = undefined;
    }
  }

  /**
   * NOT `async`. An async function suspends at its first `await`, and the
   * gesture would be gone by the time `openPanel` ran. Calling it and handling
   * the promise with `.then` keeps the `sidePanel.open()` call synchronous
   * with the click.
   */
  handleOpenPanel = (): void => {
    if (this.tabId === undefined) {
      this.status = 'Could not identify the active tab.';
      return;
    }
    openPanel(this.tabId).then((result) => {
      // Narrowing on the discriminant: inside this branch TypeScript knows
      // `result.reason` exists, and would refuse to let us read it above.
      if (!result.ok) {
        this.status = result.reason;
        return;
      }
      // On Chrome the popup closes itself once the panel takes focus.
      window.close();
    });
  };

  /**
   * A getter, not a method. Modern Glimmer *can* invoke a plain function from
   * a template as `{{(this.hasPanel)}}`, but a getter reads better and is
   * autotracked the same way — it re-evaluates when `panelHost` changes,
   * because reading a tracked property is what creates the dependency.
   */
  get hasPanel(): boolean {
    return this.panelHost !== 'unsupported';
  }

  <template>
    <header class="sc__head">
      <h1 class="sc__title">Career Caddy</h1>
    </header>

    {{#if this.hasPanel}}
      <button type="button" class="sc__btn" {{on "click" this.handleOpenPanel}}>
        Open the workbench
      </button>
      <p class="sc__hint">Answer application questions in a panel that stays open.</p>
    {{else}}
      <p class="sc__hint">
        This browser has no side panel, so the workbench is unavailable.
      </p>
    {{/if}}

    {{#if this.status}}
      <p class="sc__status">{{this.status}}</p>
    {{/if}}
  </template>
}
