import popup from './en/popup.js';
import sheets from './en/sheets.js';
import passkey from './en/passkey.js';
import types from './en/types.js';
import importer from './en/import.js';
import ux from './en/ux.js';
import extra from './en/extra.js';
import attachments from './en/attachments.js';

export default Object.freeze({ ...types, ...importer, ...popup, ...sheets, ...passkey, ...ux, ...extra, ...attachments });
