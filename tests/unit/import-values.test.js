import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toDate, toMonth, monthOf, wifiSecurity } from '../../extension/src/lib/import/importers/_values.js';

const DATES = [
  [631152000, '1990-01-01', '1990-01'],
  [631152000000, '1990-01-01', '1990-01'],
  [-315619200, '1960-01-01', '1960-01'],
  [1893456000, '2030-01-01', '2030-01'],
  ['631152000', '1990-01-01', '1990-01'],
  [14256000, '1970-06-15', '1970-06'],
  [-86400, '1969-12-31', '1969-12'],
  [19900105, '1990-01-05', '1990-01'],
  ['14256000', '', ''],
  ['2021-3-5', '2021-03-05', '2021-03'],
  ['1990/1/5', '1990-01-05', '1990-01'],
  ['1988/02/29', '1988-02-29', '1988-02'],
  ['2024-05-06T07:08:09Z', '2024-05-06', '2024-05'],
  ['1990-01-05T00:00:00Z', '1990-01-05', '1990-01'],
  ['2030 - 06', '', '2030-06'],
  ['19900105', '1990-01-05', '1990-01'],
  ['2027年3月31日', '2027-03-31', '2027-03'],
  ['1990年1月5日', '1990-01-05', '1990-01'],
  ['2030年12月', '', '2030-12'],
  ['2023年1月15日(日)', '2023-01-15', '2023-01'],
  ['2023年1月15日（日）', '2023-01-15', '2023-01'],
  ['2023年1月15日 (日)', '2023-01-15', '2023-01'],
  ['２０３０年１２月３１日', '2030-12-31', '2030-12'],
  [202812, '', '2028-12'],
  ['122029', '', '2029-12'],
  ['0528', '', '2028-05'],
  ['03/27', '', '2027-03'],
  ['12/30', '', '2030-12'],
  ['12/2029', '', '2029-12'],
  ['29/02/1988', '1988-02-29', '1988-02'],
  ['31/12/2030', '2030-12-31', '2030-12'],
  ['12/31/2030', '2030-12-31', '2030-12'],
  ['04/05/2032', '', ''],
  ['01/02/2030', '', ''],
  ['1 April 2022', '2022-04-01', '2022-04'],
  ['15 January 1990', '1990-01-15', '1990-01'],
  ['January,15,1990', '1990-01-15', '1990-01'],
  ['Jan 15, 1990 10:30 PM', '1990-01-15', '1990-01'],
  ['Sat, 01 Apr 2022 10:00:00 GMT', '2022-04-01', '2022-04'],
  ['December,2030', '', '2030-12'],
  ['Dec 2030', '', '2030-12'],
  ['February,30,2030', '', ''],
  ['2023-02-30', '', ''],
  ['202920', '', ''],
  ['123456', '', ''],
  ['112012', '', '2012-11'],
  ['13/27', '', ''],
  ['13/2030', '', ''],
  ['1991', '', ''],
  ['2030', '', ''],
  ['Expiry', '', ''],
  ['soon', '', ''],
  [1e300, '', ''],
  [0, '', ''],
  ['', '', ''],
  [null, '', ''],
  [undefined, '', ''],
  [{}, '', ''],
  [true, '', ''],
];

test('toDate / toMonth read every common spelling and refuse doubtful ones', () => {
  for (const [input, date, month] of DATES) {
    assert.equal(toDate(input), date, `toDate(${JSON.stringify(input)})`);
    assert.equal(toMonth(input), month, `toMonth(${JSON.stringify(input)})`);
  }
});

test('monthOf joins a separate expiry month and year', () => {
  assert.equal(monthOf('4', '2029'), '2029-04');
  assert.equal(monthOf('11', '27'), '2027-11');
  assert.equal(monthOf(4, 2029), '2029-04');
  assert.equal(monthOf('', '2029'), '');
  assert.equal(monthOf('13', '2029'), '');
  assert.equal(monthOf(null, null), '');
});

test('wifiSecurity maps names and codes to the template option ids', () => {
  const cases = {
    WPA3: 'wpa3', 'WPA3-SAE': 'wpa3', 'WPA2 Personal': 'wpa2', 'WPA2-PSK (AES)': 'wpa2', wpa2p: 'wpa2', 'WPA/WPA2': 'wpa2', RSN: 'wpa2',
    WPA: 'wpa', 'WPA-PSK': 'wpa', wep: 'wep', None: 'none', Open: 'none', off: 'none', なし: 'none', オープン: 'none', セキュリティなし: 'none',
    'enterprise-x': '', '': '',
  };
  for (const [raw, id] of Object.entries(cases)) assert.equal(wifiSecurity(raw), id, raw);
  assert.equal(wifiSecurity(null), '');
  assert.equal(wifiSecurity('WPA3', [{ id: 'wpa2', label: 'WPA2' }]), '');
  assert.equal(wifiSecurity('wpa2', [{ id: 'wpa2', label: 'WPA2' }]), 'wpa2');
});
