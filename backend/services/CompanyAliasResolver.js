/**
 * CompanyAliasResolver.js
 * =========================
 * Phase 4A.2 hardening: replaces the Phase 4A.1 hardcoded 9-company alias
 * map (unacceptable at 205-stock scale) with alias resolution built
 * dynamically from the project's own canonical company data source --
 * CompanyResearchProfile (symbol, companyName, nseSymbol, bseScripCode,
 * aliases) -- never hand-authored per company.
 *
 * Loaded ONCE per process and cached with a TTL (see CACHE_TTL_MS): every
 * call after the first is a synchronous in-memory lookup, never a
 * per-query database read or network request. The cache is small and
 * bounded (one entry per known company-name phrase across ~215 real
 * profiles today, scales linearly and stays trivially small even at the
 * full 205-stock universe).
 *
 * Ambiguity is never resolved by guessing: if the SAME normalized phrase
 * legitimately maps to more than one symbol, resolution reports
 * `ambiguous: true` with the candidate list, and text-level alias
 * substitution (normalizeAliasesInTextSync) leaves that phrase completely
 * untouched rather than picking one. This module NEVER touches the
 * `symbols` filter a caller passes to the retriever -- it only affects
 * how free text is normalized for lexical SCORING, so it can never by
 * itself cause cross-company retrieval; the retriever's own symbol-scoped
 * MongoDB filter remains the sole, structural source of truth for which
 * company's chunks are even candidates.
 */
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { logger } from '../utils/logger.js';

const CACHE_TTL_MS = 60 * 60 * 1000; // 1 hour -- company rosters change rarely.
const MIN_PHRASE_LEN = 3; // avoid over-eager substitution on very short/common fragments.

// A genuinely tiny, explicit override list for real-world colloquial
// names that don't reduce cleanly from `companyName` via generic
// corporate-suffix stripping (e.g. "L&T" is not a substring match of
// "Larsen & Toubro Ltd." after suffix-stripping alone). Every OTHER
// alias in the system comes from CompanyResearchProfile, not from this
// list -- this must never grow into a per-company map.
const EXPLICIT_OVERRIDES = {
  'l&t': 'LT',
  'l and t': 'LT',
};

const CORPORATE_SUFFIXES = /\b(ltd|limited|pvt|private|inc|incorporated|corp|corporation|plc|llp|co)\b\.?/gi;

/** Deterministic normalization shared by both index-building and lookup -- the same company name always normalizes to the same key regardless of casing, punctuation, or corporate-suffix wording. */
export const normalizeCompanyText = (text) => String(text || '')
  .toLowerCase()
  .replace(CORPORATE_SUFFIXES, ' ')
  .replace(/[.,'"()]/g, ' ')
  .replace(/&/g, ' and ')
  .replace(/\s+/g, ' ')
  .trim();

let cachedIndex = null;
let cachedAt = 0;
let inFlightBuild = null;

const buildIndex = async () => {
  const profiles = await CompanyResearchProfile.find({}).select('symbol companyName nseSymbol bseScripCode aliases').lean();
  const phraseToSymbols = new Map(); // normalizedPhrase -> Set<symbol>

  const add = (phrase, symbol) => {
    const norm = normalizeCompanyText(phrase);
    if (!norm || norm.length < 2) return;
    if (!phraseToSymbols.has(norm)) phraseToSymbols.set(norm, new Set());
    phraseToSymbols.get(norm).add(symbol);
  };

  for (const p of profiles) {
    if (!p.symbol) continue;
    add(p.symbol, p.symbol);
    if (p.companyName) add(p.companyName, p.symbol);
    if (p.nseSymbol) add(p.nseSymbol, p.symbol);
    for (const alias of p.aliases || []) add(alias, p.symbol);
  }
  for (const [phrase, symbol] of Object.entries(EXPLICIT_OVERRIDES)) add(phrase, symbol);

  // Longest-phrase-first so a greedy text replacement never matches a
  // short substring of a longer, more specific company name first.
  const phrases = [...phraseToSymbols.keys()]
    .filter((p) => p.length >= MIN_PHRASE_LEN)
    .sort((a, b) => b.length - a.length);

  return {
    phraseToSymbols, phrases, symbolSet: new Set(profiles.map((p) => p.symbol)), builtAt: Date.now(),
  };
};

/** getAliasIndex - the one async entry point; cached and TTL-bounded, never a per-query network call once warm. Call this ONCE at the start of a retrieval and pass the resolved index into the synchronous helpers below for the rest of that call's scoring loop. */
export const getAliasIndex = async () => {
  const now = Date.now();
  if (cachedIndex && (now - cachedAt) < CACHE_TTL_MS) return cachedIndex;
  if (inFlightBuild) return inFlightBuild; // de-dupe concurrent cold-start builds
  inFlightBuild = buildIndex()
    .then((index) => { cachedIndex = index; cachedAt = Date.now(); return index; })
    .catch((error) => {
      logger.warn(`[CompanyAliasResolver] failed to (re)build alias index: ${error.message}`);
      if (!cachedIndex) cachedIndex = { phraseToSymbols: new Map(), phrases: [], symbolSet: new Set(), builtAt: 0 };
      return cachedIndex;
    })
    .finally(() => { inFlightBuild = null; });
  return inFlightBuild;
};

/**
 * resolveCompanyAlias - given one free-text company mention, resolves it
 * to a single symbol, or honestly reports no-match / ambiguity. Never
 * guesses among multiple real candidates.
 */
export const resolveCompanyAlias = async (text) => {
  const index = await getAliasIndex();
  const norm = normalizeCompanyText(text);
  const symbols = index.phraseToSymbols.get(norm);
  if (!symbols || symbols.size === 0) return { resolved: null, ambiguous: false, candidates: [] };
  if (symbols.size > 1) return { resolved: null, ambiguous: true, candidates: [...symbols].sort() };
  return { resolved: [...symbols][0], ambiguous: false, candidates: [...symbols] };
};

/**
 * normalizeAliasesInTextSync - text-level substitution used by the
 * lexical scorer: replaces every UNAMBIGUOUS known company-name phrase in
 * `text` with its canonical lowercased ticker, longest-phrase-first. An
 * ambiguous phrase (maps to more than one real symbol) is left completely
 * untouched — this function never guesses, so it can never manufacture a
 * false cross-company match through aliasing alone.
 */
export const normalizeAliasesInTextSync = (text, index) => {
  if (!index || !index.phrases?.length) return text;
  let result = String(text || '');
  for (const phrase of index.phrases) {
    const symbols = index.phraseToSymbols.get(phrase);
    if (symbols.size !== 1) continue; // ambiguous -- never guess
    const symbol = [...symbols][0].toLowerCase();
    const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    if (!new RegExp(`\\b${escaped}\\b`, 'i').test(result)) continue;
    result = result.replace(new RegExp(`\\b${escaped}\\b`, 'gi'), symbol);
  }
  return result;
};

/** Test-only: forces the next getAliasIndex() call to rebuild from the database. */
export const clearAliasCacheForTests = () => { cachedIndex = null; cachedAt = 0; inFlightBuild = null; };

export default {
  getAliasIndex, resolveCompanyAlias, normalizeAliasesInTextSync, normalizeCompanyText, clearAliasCacheForTests,
};
