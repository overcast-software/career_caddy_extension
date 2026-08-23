import Component from '@glimmer/component';

export type IconName = 'sun' | 'moon' | 'monitor' | 'rows' | 'columns';

export interface IconSignature {
  Args: { name: IconName };
  Element: SVGElement;
}

/**
 * Inline SVG icons, by name.
 *
 * Inline rather than unicode, and that is not a preference. `☾` and `☀` have
 * no glyph in the panel's font stack — a theme toggle drawn with them rendered
 * as an EMPTY SQUARE and went unnoticed until Doug said "I never saw the theme
 * toggle". The legacy extension uses inline SVG for exactly this reason.
 *
 * Inline rather than an image file, too: `stroke="currentColor"` means each
 * icon inherits its button's colour, so they theme themselves across
 * light/dark × six palettes without a second asset or a filter hack.
 *
 * `sun` and `moon` are carried over verbatim from the legacy's SUN_SVG and
 * MOON_SVG so the panel keeps the same icon language.
 */
export default class Icon extends Component<IconSignature> {
  get isSun(): boolean {
    return this.args.name === 'sun';
  }
  get isMoon(): boolean {
    return this.args.name === 'moon';
  }
  get isMonitor(): boolean {
    return this.args.name === 'monitor';
  }
  get isRows(): boolean {
    return this.args.name === 'rows';
  }
  get isColumns(): boolean {
    return this.args.name === 'columns';
  }

  <template>
    {{#if this.isSun}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <circle cx="12" cy="12" r="4" />
        <path d="M12 2v2M12 20v2M4.93 4.93l1.41 1.41M17.66 17.66l1.41 1.41M2 12h2M20 12h2M4.93 19.07l1.41-1.41M17.66 6.34l1.41-1.41" />
      </svg>

    {{else if this.isMoon}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <path d="M21 12.79A9 9 0 1 1 11.21 3 7 7 0 0 0 21 12.79z" />
      </svg>

    {{else if this.isMonitor}}
      {{! "System" needs an icon meaning "whatever the machine says". A
          display is the convention every OS settings panel already uses. }}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <rect x="2" y="3" width="20" height="14" rx="2" />
        <path d="M8 21h8M12 17v4" />
      </svg>

    {{else if this.isRows}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <rect x="3" y="4" width="18" height="5" rx="1" />
        <rect x="3" y="13" width="18" height="7" rx="1" />
      </svg>

    {{else if this.isColumns}}
      <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
           stroke-width="2" stroke-linecap="round" stroke-linejoin="round"
           aria-hidden="true" ...attributes>
        <path d="M3 7h18M3 7v13h18V7" />
        <path d="M9 4v3M15 4v3" />
      </svg>
    {{/if}}
  </template>
}
