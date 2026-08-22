import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import DraftBox from './draft-box.gts';

/**
 * The panel root.
 *
 * This component exists to make one architectural claim visible: in a side
 * panel, component state is allowed to LIVE. The uptime counter keeps
 * counting and the draft keeps its text while you click into the page, fill
 * fields, and switch tabs. In the popup, every one of those gestures destroys
 * the document and resets both to zero — which is why the current extension
 * mirrors everything into storage.local before it dares render it.
 */
export default class Workbench extends Component {
  /**
   * `@tracked` is Glimmer's `ref`. The difference from Vue: no `.value`
   * unwrapping — you read and write the property directly, and the tracking
   * happens at the property access.
   */
  @tracked uptime = 0;
  @tracked draft = '';
  @tracked pageUrl = '(reading…)';

  /**
   * `number | undefined` because the field genuinely has no value until the
   * constructor runs. Writing `: number` and leaving it unassigned would be a
   * lie the compiler would catch under strict mode.
   *
   * `ReturnType<typeof setInterval>` rather than `number`: in a DOM context
   * setInterval returns a number, in @types/node it returns a Timeout object.
   * Deriving the type from the function means this compiles under either,
   * instead of picking one and being wrong somewhere.
   */
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(owner: unknown, args: object) {
    super(owner, args);
    this.ticker = setInterval(() => (this.uptime += 1), 1000);
    void this.readActiveTab();
  }

  /**
   * Glimmer's unmount hook. A panel is long-lived, not immortal — the user can
   * close it — and an interval that outlives its component is a leak.
   */
  willDestroy(): void {
    super.willDestroy();
    if (this.ticker !== undefined) clearInterval(this.ticker);
  }

  get uptimeLabel(): string {
    const m = Math.floor(this.uptime / 60);
    const s = this.uptime % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  private async readActiveTab(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.pageUrl = tab?.url ?? '(no active tab)';
    } catch {
      this.pageUrl = '(cannot read the active tab)';
    }
  }

  /**
   * Passed down to <DraftBox> as `@onInput`. An arrow-function class field,
   * not a method, so `this` is bound — a plain method passed as a callback
   * would lose its receiver.
   */
  updateDraft = (next: string): void => {
    this.draft = next;
  };

  <template>
    <header class="wb__head">
      <h1 class="wb__title">Career Caddy</h1>
      <p class="wb__sub">Glimmer · side panel</p>
    </header>

    <section class="wb__proof">
      <p class="wb__uptime">This panel has been alive for <strong>{{this.uptimeLabel}}</strong></p>
      <p class="wb__url">{{this.pageUrl}}</p>
      <p class="wb__hint">
        Click into the page, type in a form, switch tabs — then look back here.
        The timer never restarted and your draft is still below. A popup would
        have been destroyed and rebuilt on every one of those.
      </p>
    </section>

    <DraftBox
      class="wb__draft"
      @label="Draft answer"
      @value={{this.draft}}
      @onInput={{this.updateDraft}}
    />
  </template>
}
