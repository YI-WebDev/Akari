// LastPass CSV: url,username,password,totp,extra,name,grouping,fav
// - secure notes have url "http://sn"; structured ones ("NoteType:Credit Card" …) keep their
//   "Key:Value" lines in `extra`. Those whose NoteType Akari has a type for (cards, bank accounts,
//   addresses, …) become that type; keys with no template slot become custom fields, and the
//   free text after "Notes:" is the note. Other NoteTypes (Email Account, Insurance, Custom_…)
//   stay secure notes listing their lines.
// - `extra` of a normal login is its note, fav is "1" for favourites

import { isTruthy } from '../model.js';
import { t } from '../../../shared/i18n.js';
import { collect, fits, otpOf, readCsv, routeToTemplate } from './_csv.js';
import { normKey, toMonth } from './_values.js';

const SHAPE = { all: ['url', 'username', 'password', 'name'], any: ['extra', 'grouping', 'fav'] };
export const accepts = (headers) => fits(headers, SHAPE);

const SECURE_NOTE_URL = 'http://sn';

/** NoteType (normalised) → Akari type. */
const NOTE_TYPES = {
  creditcard: 'card',
  bankaccount: 'bankAccount',
  address: 'identity',
  driverslicense: 'driverLicense',
  passport: 'passport',
  socialsecurity: 'socialSecurity',
  database: 'database',
  server: 'server',
  sshkey: 'sshKey',
  softwarelicense: 'softwareLicense',
  wifipassword: 'wifi',
  membership: 'membership',
  healthinsurance: 'medicalRecord',
};

/** Akari template key → the LastPass labels it is filled from (besides its own key and label). */
const ALIASES = {
  card: {
    cardholder: ['Name on Card'], number: ['Number'], expiry: ['Expiration Date'], cvv: ['Security Code'],
  },
  bankAccount: {
    bankName: ['Bank Name'], accountType: ['Account Type'], accountNumber: ['Account Number'],
    accountHolder: ['Name on Account', 'Account Holder'], routingNumber: ['Routing Number'],
    swift: ['SWIFT Code', 'SWIFT'], iban: ['IBAN Number', 'IBAN'], pin: ['PIN'],
  },
  identity: {
    fullName: ['Full Name', 'Name'], firstName: ['First Name'], middleName: ['Middle Name'], lastName: ['Last Name'],
    email: ['Email Address'], phone: ['Phone', 'Mobile Phone', 'Evening Phone'], birthDate: ['Birthday', 'Date of Birth'],
    company: ['Company'], postalCode: ['Zip / Postal Code', 'Zip Code', 'Postal Code'], country: ['Country'],
    state: ['State', 'Province'], city: ['City / Town', 'City'], address1: ['Address 1'], address2: ['Address 2'],
    website: ['Website', 'URL'],
  },
  driverLicense: {
    fullName: ['Name'], number: ['Number', 'License Number'], licenseClass: ['License Class', 'Class'],
    birthDate: ['Date of Birth', 'Birthday'], issuedOn: ['Issued Date', 'Issue Date'],
    expiry: ['Expiration Date'], issuer: ['Issuing Authority', 'Issued By'], address: ['Address'],
  },
  passport: {
    fullName: ['Name'], number: ['Number', 'Passport Number'], nationality: ['Nationality'],
    issuingCountry: ['Country', 'Issuing Country'], birthDate: ['Date of Birth', 'Birthday'],
    issuedOn: ['Issued Date', 'Issue Date'], expiry: ['Expiration Date'], authority: ['Issuing Authority'],
  },
  socialSecurity: { fullName: ['Name'], number: ['Number', 'Social Security Number', 'SSN'] },
  database: {
    dbType: ['Type'], host: ['Hostname', 'Host'], port: ['Port'], database: ['Database', 'Database Name'],
    username: ['Username', 'User'], password: ['Password'],
  },
  server: {
    host: ['Hostname', 'Host', 'IP Address'], port: ['Port'], username: ['Username', 'User'],
    password: ['Password'], url: ['URL', 'Admin URL', 'Website'],
  },
  sshKey: {
    privateKey: ['Private Key'], publicKey: ['Public Key'], fingerprint: ['Fingerprint'],
    passphrase: ['Passphrase'], host: ['Hostname', 'Host'], username: ['Username', 'User'],
  },
  softwareLicense: {
    product: ['Product', 'Product Name', 'Software'], version: ['Version'], licenseKey: ['License Key', 'Product Key', 'Serial Number'],
    licensee: ['Licensee', 'Registered To'], email: ['Registration Email', 'License Email'],
    purchaseDate: ['Purchase Date'], expiry: ['Expiration Date'], url: ['Website', 'URL'],
  },
  wifi: {
    ssid: ['SSID', 'Network Name', 'Name'], password: ['Password', 'Pre-shared Key', 'PSK', 'Network Key'],
    security: ['Authentication', 'Security', 'Security Type'],
  },
  membership: {
    organization: ['Organization', 'Organisation', 'Membership Name'], memberName: ['Member Name', 'Name'],
    memberId: ['Membership Number', 'Member ID', 'Member Number'], since: ['Start Date', 'Member Since'],
    expiry: ['Expiration Date'], pin: ['PIN'], url: ['Website', 'URL'],
  },
  medicalRecord: {
    patientName: ['Member Name', 'Patient Name', 'Patient'], provider: ['Provider', 'Hospital', 'Clinic'],
    recordNumber: ['Patient ID', 'Record Number', 'Medical Record Number'], doctor: ['Physician Name', 'Doctor'],
    insurer: ['Company', 'Insurance Company', 'Insurer'], policyNumber: ['Policy Number'],
  },
};

const isNoteType = (line) => /^NoteType:/i.test(line);

/**
 * Old-style rendering for NoteTypes Akari has no type for: "NoteType: X", then "Key: Value"
 * lines, then optionally a "Notes:" line that starts free text running to the end. The Language
 * line is dropped; anything that is not a Key:Value line is kept as-is.
 */
function noteFromExtra(extra) {
  const text = String(extra ?? '').replace(/\r\n?/g, '\n');
  const lines = text.split('\n');
  if (!isNoteType(lines[0])) return text;
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = /^([^:]+):(.*)$/.exec(lines[i]);
    if (m && m[1].trim().toLowerCase() === 'notes') {
      out.push('Notes: ' + [m[2].trim(), ...lines.slice(i + 1)].join('\n').trim());
      break;
    }
    if (!m) { if (lines[i].trim()) out.push(lines[i]); continue; }
    if (m[1].trim().toLowerCase() === 'language' || !m[2].trim()) continue;
    out.push(`${m[1].trim()}: ${m[2].trim()}`);
  }
  return out.join('\n');
}

/**
 * Lines after "NoteType:X" → { pairs: [label, value][], notes, loose }. A line without a "Key:"
 * continues the previous value; inside a PEM block every line does (its headers contain
 * colons). "Notes:" starts the free text; "Language" is dropped.
 */
function structuredLines(lines) {
  const pairs = [];
  const loose = [];
  let notes = '';
  let last = null;
  let pem = false;
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i];
    if (pem) {
      last[1] += '\n' + line;
      if (/-----END /.test(line)) pem = false;
      continue;
    }
    const m = /^([^:]+):(.*)$/.exec(line);
    if (m && m[1].trim().toLowerCase() === 'notes') {
      notes = [m[2].trim(), ...lines.slice(i + 1)].join('\n').trim();
      break;
    }
    if (m) {
      last = [m[1].trim(), m[2].trim()];
      if (last[0].toLowerCase() !== 'language') pairs.push(last);
      pem = /^-----BEGIN /.test(last[1]) && !/-----END /.test(last[1]);
    } else if (line.trim()) {
      if (last) last[1] += '\n' + line.trim(); else loose.push(line.trim());
    }
  }
  return { pairs, notes, loose };
}

/** A structured secure note as an Akari item, or null when its NoteType has no Akari type. */
function structuredItem(r, lines) {
  const kind = normKey(lines[0].slice(lines[0].indexOf(':') + 1));
  const type = Object.hasOwn(NOTE_TYPES, kind) ? NOTE_TYPES[kind] : null;
  if (!type) return null;
  const { pairs, notes, loose } = structuredLines(lines);
  const routed = pairs.map(([label, value]) => [label, type === 'card' && normKey(label) === 'startdate' ? toMonth(value) || value : value]);
  const { fields, extra } = routeToTemplate(type, routed, ALIASES[type], { numbers: true });
  return {
    type, title: r.name, fields, extra,
    note: [loose.join('\n'), notes].filter(Boolean).join('\n\n'),
    fav: isTruthy(r.fav),
  };
}

export async function parse(file) {
  const { records } = readCsv(file, accepts,
    t('LastPass の CSV ではないようです（url, username, password, name, extra の列が見つかりません）'));
  const warnings = [];
  let foldered = false;
  const out = collect(records, (r) => {
    const group = String(r.grouping ?? '').trim();
    if (group && group !== '(none)') foldered = true;
    const url = String(r.url ?? '').trim();
    if (url.toLowerCase() === SECURE_NOTE_URL) {
      const lines = String(r.extra ?? '').replace(/\r\n?/g, '\n').split('\n');
      const structured = isNoteType(lines[0]) ? structuredItem(r, lines) : null;
      return structured || { type: 'note', title: r.name, note: noteFromExtra(r.extra), fav: isTruthy(r.fav) };
    }
    const { totp, extra } = otpOf(r.totp);
    return {
      title: r.name,
      url: url === 'http://' ? '' : url,
      username: r.username,
      password: r.password,
      note: r.extra,
      extra,
      totp,
      fav: isTruthy(r.fav),
    };
  }, warnings);
  if (foldered) warnings.push(t('フォルダー（グループ）の情報は取り込まれません'));
  return out;
}
