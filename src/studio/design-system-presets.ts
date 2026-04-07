/**
 * Curated stylesheet URLs for HTML export. Pin versions so production handoffs stay stable;
 * adjust when upgrading a design system.
 */
export type DesignSystemPreset = {
  id: string
  label: string
  /** Shown in the UI — one line each. */
  description: string
  stylesheetUrls: string[]
}

/** Salt: core CSS variables and base styles (JPMorgan Chase Salt). */
const SALT_CORE_VERSION = '1.59.0'

export const DESIGN_SYSTEM_PRESETS: DesignSystemPreset[] = [
  {
    id: 'none',
    label: 'None',
    description: 'POP tokens and layout only.',
    stylesheetUrls: [],
  },
  {
    id: 'salt',
    label: 'Salt (core CSS)',
    description: `Salt design system base styles and CSS variables (@salt-ds/core ${SALT_CORE_VERSION}).`,
    stylesheetUrls: [`https://cdn.jsdelivr.net/npm/@salt-ds/core@${SALT_CORE_VERSION}/css/salt-core.css`],
  },
  {
    id: 'material-fonts',
    label: 'Material (Roboto + symbols)',
    description: 'Google Fonts: Roboto and Material Symbols Outlined — pair with imported M3 color tokens.',
    stylesheetUrls: [
      'https://fonts.googleapis.com/css2?family=Roboto:wght@400;500;700&display=swap',
      'https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@24,400,0,0',
    ],
  },
]
