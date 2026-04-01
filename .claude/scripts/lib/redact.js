'use strict';

function redactValue(value) {
  if (typeof value !== 'string') return value;
  const emailLike = /([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,})/g;

  const knownSecretLike = new RegExp(
    [
      '(?:\\bsk-[A-Za-z0-9]{20,}\\b)',
      '(?:\\bghp_[A-Za-z0-9]{20,}\\b)',
      '(?:\\bgithub_pat_[A-Za-z0-9_]{20,}\\b)',
      '(?:\\bxox[baprs]-[A-Za-z0-9-]{10,}\\b)',
      '(?:\\bAIza[0-9A-Za-z\\-_]{20,}\\b)',
      '(?:\\bAKIA[0-9A-Z]{16}\\b)',
      '(?:\\beyJ[0-9A-Za-z_-]+\\.[0-9A-Za-z_-]+\\.[0-9A-Za-z_-]+\\b)',
      '(?:-----BEGIN [A-Z ]+-----[\\s\\S]*?-----END [A-Z ]+-----)',
    ].join('|'),
    'g'
  );

  return value.replace(emailLike, '[REDACTED_EMAIL]').replace(knownSecretLike, '[REDACTED_TOKEN]');
}

function redactObject(input) {
  if (Array.isArray(input)) {
    return input.map(redactObject);
  }
  if (!input || typeof input !== 'object') {
    return redactValue(input);
  }

  const out = {};
  for (const [key, val] of Object.entries(input)) {
    const lower = key.toLowerCase();
    if (lower.includes('token') || lower.includes('secret') || lower.includes('password') || lower.includes('apikey') || lower.includes('api_key')) {
      out[key] = '[REDACTED]';
      continue;
    }
    out[key] = redactObject(val);
  }
  return out;
}

module.exports = {
  redactValue,
  redactObject,
};
