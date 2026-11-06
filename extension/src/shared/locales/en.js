// The English dictionary, in parts by area. Keys are the Japanese source text (or a dotted key
// used with a Japanese fallback); see shared/i18n.js.

import popup from './en/popup.js';
import sheets from './en/sheets.js';
import passkey from './en/passkey.js';
import types from './en/types.js';
import importer from './en/import.js';

export default Object.freeze({ ...types, ...importer, ...popup, ...sheets, ...passkey });
