// Dummy-only diagnostics: quote/newline token boundaries must not expose credential suffixes.
export const toolRecoveryUrlDiagnostics = [
  ["apostrophe", "postgres://user:prefix'DSN_QUOTE_SENTINEL@db.example/test"],
  ["double quote", 'postgres://user:prefix"DSN_DOUBLE_SENTINEL@db.example/test'],
  ["backtick", "postgres://user:prefix`DSN_BACKTICK_SENTINEL@db.example/test"],
  ["encoded punctuation", "postgres://user:prefix%27%22%60%0A%40DSN_ENCODED_SENTINEL@db.example/test"],
  ["newline", "postgres://user:prefix\nDSN_NEWLINE_SENTINEL@db.example/test"],
  ["CRLF and tab", "postgres://user:prefix\r\n\tDSN_CRLF_SENTINEL@db.example/test"],
  ["space after quote", "postgres://user:prefix' DSN_SPACE_SENTINEL@db.example/test"],
  ["unterminated credential", "postgres://user:prefix'\nDSN_UNTERMINATED_SENTINEL"],
  ["malformed quoted host", 'postgres://user:prefix"DSN_MALFORMED_SENTINEL@[invalid/test'],
] as const;
