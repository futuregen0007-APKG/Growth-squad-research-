// Jest test-only mock for an ESM-only remark/rehype plugin package whose
// actual behavior is irrelevant once react-markdown itself is mocked (see
// react-markdown.js in this same directory) — only its import must not
// crash the test transform.
export default function noopPlugin() {}
