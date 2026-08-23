import Component from '@glimmer/component';
import { on } from '@ember/modifier';
import { errorLog } from '../state/errors.ts';

/**
 * What went wrong, still readable a minute later.
 *
 * Inline status is right for "what is happening now" and wrong for "what
 * happened" — it gets replaced by the next action and cleared on navigation.
 * Doug: "I hit send and it flashed something so fast I couldn't read it, then
 * it did nothing." Both halves of that were real: the message was unreadable
 * AND the send had been cancelled. Neither was diagnosable from the panel.
 */
export default class ErrorLog extends Component {
  get log(): typeof errorLog {
    return errorLog;
  }

  clear = (): void => errorLog.clear();

  <template>
    <div class="elog">
      <p class="elog__head">
        Errors
        {{#unless this.log.isEmpty}}
          <button type="button" class="elog__clear" {{on "click" this.clear}}>Clear</button>
        {{/unless}}
      </p>

      {{#if this.log.isEmpty}}
        <p class="elog__empty">Nothing has failed yet.</p>
      {{else}}
        <ul class="elog__list">
          {{#each this.log.entries key="id" as |entry|}}
            <li class="elog__row">
              <span class="elog__meta">
                {{entry.at}} · {{entry.source}}{{#if entry.host}} · {{entry.host}}{{/if}}
              </span>
              <span class="elog__msg">{{entry.message}}</span>
            </li>
          {{/each}}
        </ul>
      {{/if}}
    </div>
  </template>
}
