// Jest test-only mock. react-markdown ships ESM-only and CRA's default
// Jest config (transformIgnorePatterns) never transforms node_modules, so
// importing it directly in a test breaks with "Unexpected token 'export'".
// This renders the raw markdown string as plain text, which is enough for
// component tests that only assert on message content/structure, not the
// actual markdown rendering itself (react-markdown has its own upstream
// test coverage) — see package.json's jest.moduleNameMapper.
import React from 'react';

export default function ReactMarkdown({ children }) {
  return <div>{children}</div>;
}
