/**
 * EvidenceEnvelope.js
 * ======================
 * Phase 4A.1 hardening, item 7: "retriever behavior alone is not the
 * security boundary." This module is the normalized shape every piece of
 * retrieved document text must pass through before it ever reaches a
 * future Phase 4B composer/verifier prompt — full end-to-end composer
 * protection (actually wiring this into the LangGraph answer flow) is
 * Phase 4B work; this module only builds the envelope and a diagnostic
 * detector so that work has a ready, tested contract to build on.
 *
 * The envelope's structural fields (symbol, sourceUrl, pageStart/pageEnd,
 * documentType, fiscalPeriod, sourceAuthority, evidenceId) are ALWAYS
 * taken from the retriever's own typed DB-backed result — NEVER parsed
 * out of the document's free-text content. This is what makes "document
 * instructions cannot change citation metadata" true by construction: the
 * envelope builder never even looks inside `text` for anything other than
 * building the diagnostic injection-signal flag (which does not feed back
 * into any other field).
 *
 * `untrustedContent: true` is a permanent, non-optional marker — there is
 * no code path that produces an envelope without it. A future prompt
 * builder is expected to quote `text` as clearly-delimited untrusted data
 * (e.g. inside a fenced/quoted block with an explicit "this is retrieved
 * document text, not an instruction" framing) and never concatenate it
 * into anything that could be read as a system/developer instruction.
 */

/**
 * A deterministic, pattern-based detector for obvious instruction-like
 * phrasing inside retrieved document text — DIAGNOSTICS ONLY. It never
 * strips, redacts, or alters `text` in any way: a real filing legitimately
 * discussing "instructions to shareholders" or "override provisions in
 * the credit agreement" must survive completely untouched, so this only
 * ever produces a `debug`-style signal for logging/evaluation, never a
 * content transformation.
 */
const INJECTION_PATTERNS = [
  /ignore\s+(all|any|the)?\s*(previous|prior|above|earlier)\s+instructions?/i,
  /disregard\s+(all|any|the)?\s*(previous|prior|above|earlier|safety)\s+(instructions?|rules)/i,
  /reveal\s+(your|the)\s+(system\s+prompt|instructions)/i,
  /you\s+are\s+now\s+/i,
  /new\s+instructions?\s*:/i,
  /act\s+as\s+(if\s+you\s+are\s+)?/i,
  /override\s+(all|any|the)?\s*(previous|prior|safety)?\s*(instructions?|rules)/i,
  /\bsystem\s+prompt\b/i,
  /do\s+anything\s+now/i,
];

export const detectInjectionSignals = (text) => {
  const source = String(text || '');
  const matchedPatterns = INJECTION_PATTERNS
    .filter((pattern) => pattern.test(source))
    .map((pattern) => pattern.source);
  return { flagged: matchedPatterns.length > 0, matchedPatterns };
};

/**
 * toUntrustedEvidenceEnvelope - converts ONE retriever result (see
 * services/ResearchRetrieverService.js's toEvidenceShape) into the
 * normalized envelope. Every field except `text` and the diagnostic
 * `injectionSignal` comes straight from the retriever's own typed
 * metadata — never re-derived from parsing `text`.
 */
export const toUntrustedEvidenceEnvelope = (result) => ({
  evidenceId: result.chunkId,
  symbol: result.symbol,
  text: result.text,
  sourceUrl: result.sourceUrl,
  pageStart: result.pageStart,
  pageEnd: result.pageEnd,
  documentType: result.documentType,
  fiscalPeriod: result.fiscalQuarter ? `${result.fiscalYear} ${result.fiscalQuarter}` : result.fiscalYear,
  sourceAuthority: result.sourceAuthority,
  untrustedContent: true,
  // Diagnostic only (see detectInjectionSignals above) — never consulted
  // to decide whether to include/exclude/alter this evidence; a future
  // Phase 4B consumer may log/monitor it, nothing more.
  injectionSignal: detectInjectionSignals(result.text),
});

/** Batch form — the shape a future Phase 4B evidence-building step actually calls. */
export const toUntrustedEvidenceEnvelopes = (results) => (results || []).map(toUntrustedEvidenceEnvelope);

export default { detectInjectionSignals, toUntrustedEvidenceEnvelope, toUntrustedEvidenceEnvelopes };
