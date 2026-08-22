import Component from '@glimmer/component';
import { tracked } from '@glimmer/tracking';
import DraftBox from './draft-box.gts';
import PermissionProbe from './permission-probe.gts';
import SectionSet from './section-set.gts';
import Section from './section.gts';
import type { SectionSpec } from './section.gts';
import { layout } from '../state/layout.ts';

/**
 * The panel root.
 *
 * Sections are declared once, in workflow order, and rendered by <SectionSet>
 * as either an accordion or tabs. The legacy extension's three tabs
 * (Posts | Applications | Staff) existed because a 320×600 popup had no room;
 * whether the panel still wants them is a question to answer by using it,
 * which is why the switch is a runtime toggle rather than a code change.
 *
 * The uptime counter is the architectural claim made visible: in a panel,
 * component state is allowed to LIVE. Click into the page, fill a field,
 * switch tabs — it keeps counting and the draft keeps its text. A popup would
 * have been destroyed and rebuilt on every one of those.
 */
export default class Workbench extends Component {
  @tracked uptime = 0;
  @tracked draft = '';
  @tracked pageUrl = '(reading…)';

  /**
   * `number | undefined` because the field genuinely has no value until the
   * constructor runs. `ReturnType<typeof setInterval>` rather than `number`:
   * in a DOM context setInterval returns a number, under @types/node it
   * returns a Timeout object. Deriving the type from the function compiles
   * under either instead of picking one and being wrong somewhere.
   */
  private ticker: ReturnType<typeof setInterval> | undefined;

  constructor(owner: unknown, args: object) {
    super(owner, args);
    this.ticker = setInterval(() => (this.uptime += 1), 1000);
    void layout.load();
    void this.readActiveTab();
  }

  /** A panel is long-lived, not immortal. An interval outliving it is a leak. */
  willDestroy(): void {
    super.willDestroy();
    if (this.ticker !== undefined) clearInterval(this.ticker);
  }

  get uptimeLabel(): string {
    const m = Math.floor(this.uptime / 60);
    const s = this.uptime % 60;
    return m > 0 ? `${m}m ${s}s` : `${s}s`;
  }

  get host(): string {
    try {
      return new URL(this.pageUrl).hostname;
    } catch {
      return this.pageUrl;
    }
  }

  /**
   * A getter, so the collapsed summaries stay current: `host` and `uptimeLabel`
   * are tracked reads, so this recomputes and every section header updates
   * without anything explicitly telling it to.
   */
  get sections(): SectionSpec[] {
    return [
      { id: 'page', title: 'This page', summary: this.host },
      { id: 'answers', title: 'Answer desk', summary: `${this.draft.length} chars` },
      { id: 'diagnostics', title: 'Diagnostics', summary: `up ${this.uptimeLabel}` },
    ];
  }

  private async readActiveTab(): Promise<void> {
    try {
      const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
      this.pageUrl = tab?.url ?? '(no active tab)';
    } catch {
      this.pageUrl = '(cannot read the active tab)';
    }
  }

  updateDraft = (next: string): void => {
    this.draft = next;
  };

  <template>
    <header class="wb__head">
      <h1 class="wb__title">Career Caddy</h1>
      <p class="wb__sub">Glimmer · side panel</p>
    </header>

    <SectionSet @sections={{this.sections}} />

      <Section @id="page" @sections={{this.sections}}>
        <p class="wb__url">{{this.pageUrl}}</p>
        <p class="wb__hint">
          Sending, tracking and scoring land here. Empty for now — this is the
          shell the import fills in.
        </p>
      </Section>

      <Section @id="answers" @sections={{this.sections}}>
        <DraftBox
          @label="Draft answer"
          @value={{this.draft}}
          @onInput={{this.updateDraft}}
        />
        <p class="wb__hint">
          Click into the page, type in a form, switch tabs — then look back.
          The draft is still here and the timer never restarted.
        </p>
      </Section>

      <Section @id="diagnostics" @sections={{this.sections}}>
        <p class="wb__uptime">
          Panel alive for <strong>{{this.uptimeLabel}}</strong>
        </p>
        <PermissionProbe />
      </Section>
  </template>
}
