/**
 * CompanyFinancialsResolver - resolves free-text company search input to a
 * real ISIN, never guessing. Five deterministic steps:
 *   1. Exact case-insensitive match against CompanyResearchProfile.symbol
 *      (handles a literal ticker like "TCS" instantly, no alias lookup).
 *   2. Otherwise, CompanyAliasResolver.resolveCompanyAlias() against the
 *      project's real company-name/alias index.
 *   3. An ambiguous alias match (>1 symbol) is returned as-is with its
 *      candidates -- this module NEVER auto-picks one.
 *   4. Once a symbol is known, CompanyResearchProfile.findOne({symbol})
 *      supplies companyName + isin.
 *   5. A null isin is reported explicitly (ISIN_UNAVAILABLE) rather than
 *      proceeding with a fabricated or guessed identifier.
 */
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { resolveCompanyAlias } from './CompanyAliasResolver.js';

/**
 * resolveCompanyForFinancials - returns one of:
 *   { status: 'RESOLVED', symbol, companyName, isin }
 *   { status: 'AMBIGUOUS', candidates: string[] }
 *   { status: 'NOT_FOUND' }
 *   { status: 'ISIN_UNAVAILABLE', symbol, companyName }
 */
export const resolveCompanyForFinancials = async (query) => {
  const text = String(query || '').trim();
  if (!text) return { status: 'NOT_FOUND', query: text };

  const exact = await CompanyResearchProfile.findOne({ symbol: text.toUpperCase() }).lean();
  let symbol = exact?.symbol || null;

  if (!symbol) {
    const aliasResult = await resolveCompanyAlias(text);
    if (aliasResult.ambiguous) {
      return { status: 'AMBIGUOUS', query: text, candidates: aliasResult.candidates };
    }
    symbol = aliasResult.resolved;
  }

  if (!symbol) return { status: 'NOT_FOUND', query: text };

  const profile = exact && exact.symbol === symbol ? exact : await CompanyResearchProfile.findOne({ symbol }).lean();
  if (!profile) return { status: 'NOT_FOUND', query: text };
  if (!profile.isin) {
    return { status: 'ISIN_UNAVAILABLE', symbol, companyName: profile.companyName };
  }
  return {
    status: 'RESOLVED', symbol, companyName: profile.companyName, isin: profile.isin,
  };
};

export default { resolveCompanyForFinancials };
