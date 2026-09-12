/**
 * CompanyResearchProfileSync.js
 * ================================
 * Populates CompanyResearchProfile dynamically from the existing stock
 * master (SUPPORTED_STOCKS, ~215 symbols) matched against the real, live
 * BSE scrip master (BseScripMasterProvider) -- never 205 hardcoded records.
 * A symbol whose BSE scrip code cannot be resolved is persisted with
 * researchEnabled:false and bseScripCode:null (never guessed), so it is
 * visibly and honestly excluded from the batch runner rather than silently
 * dropped.
 */
import { SUPPORTED_STOCKS } from '../utils/constants.js';
import { CompanyResearchProfile } from '../models/CompanyResearchProfile.js';
import { getScripMaster, resolveScripForSymbol } from '../providers/BseScripMasterProvider.js';
import { logger } from '../utils/logger.js';

export const syncCompanyResearchProfiles = async () => {
  const scripMaster = await getScripMaster();
  if (!scripMaster.length) {
    logger.warn('[CompanyResearchProfileSync] BSE scrip master unavailable -- profiles not updated this run.');
    return { synced: 0, resolved: 0, unresolved: 0 };
  }

  let resolved = 0;
  let unresolved = 0;
  const unresolvedSymbols = [];

  for (const [symbol, meta] of Object.entries(SUPPORTED_STOCKS)) {
    // eslint-disable-next-line no-await-in-loop
    const scrip = await resolveScripForSymbol(symbol, scripMaster);
    const researchEnabled = Boolean(scrip);
    if (researchEnabled) resolved += 1; else { unresolved += 1; unresolvedSymbols.push(symbol); }

    // eslint-disable-next-line no-await-in-loop
    await CompanyResearchProfile.findOneAndUpdate(
      { symbol },
      {
        $set: {
          symbol,
          companyName: scrip?.companyName || meta.name || symbol,
          bseScripCode: scrip?.scripCode || null,
          nseSymbol: symbol,
          isin: scrip?.isin || null,
          sector: meta.sector || null,
          marketCapCr: scrip?.marketCapCr ?? null,
          researchEnabled,
          lastProfileSyncAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  if (unresolvedSymbols.length) {
    logger.warn(`[CompanyResearchProfileSync] ${unresolvedSymbols.length} symbols have no resolvable BSE scrip code (researchEnabled:false): ${unresolvedSymbols.join(', ')}`);
  }

  return { synced: resolved + unresolved, resolved, unresolved, unresolvedSymbols };
};

export default syncCompanyResearchProfiles;
