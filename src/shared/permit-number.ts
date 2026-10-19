/** A permit number as entered: a letter or digit, then letters, digits, hyphens, and dots. */
export const PERMIT_NUMBER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9.-]*$/;

/** The shortest permit number accepted, in characters. */
export const PERMIT_NUMBER_MIN = 3;

/** The longest permit number accepted, in characters. */
export const PERMIT_NUMBER_MAX = 80;
