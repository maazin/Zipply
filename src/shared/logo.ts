// Zipply's logo, from public/icons/logo.svg (the toolbar icons are rendered
// from the same file by scripts/icons.mjs).
import logo from '../../public/icons/logo.svg?raw'

/** The full logo: the white mark on its blue tile. */
export const LOGO_SVG = logo

/** The white mark alone, for drawing on Zipply's blue. */
export const MARK_SVG = logo.replace(/<defs>[\s\S]*?<\/defs>|<rect[^>]*\/>/g, '')
