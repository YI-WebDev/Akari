export const EMAIL_MAX_LENGTH = 254;

const EMAIL_SHAPE = /^[^\s@]+@[^\s@]+$/;
const UNPRINTABLE = /[\u0000-\u001f\u007f-\u009f­​-‏‪-‮⁠-⁩﻿]/;

export function cleanEmail(value) {
  if (typeof value !== 'string') return '';
  const v = value.trim();
  return v.length <= EMAIL_MAX_LENGTH && EMAIL_SHAPE.test(v) && !UNPRINTABLE.test(v) ? v : '';
}
