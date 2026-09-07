import { AngelOneProvider } from './AngelOneProvider.js';
import { IndianApiProvider } from './indian-api/IndianApiProvider.js';
import { logger } from '../utils/logger.js';

/**
 * ProviderRegistry - resolves the configured live-market-data and
 * company-research providers from environment configuration, so the rest
 * of the app (services, controllers) never has to know which concrete
 * provider is in use.
 *
 * MARKET_DATA_PROVIDER=angel-one           (existing behavior, untouched)
 * COMPANY_RESEARCH_PROVIDER=indian-api     (new)
 *
 * Adding Global Datafeeds later means: implement
 * providers/global-datafeeds/GlobalDatafeedsProvider.js against the same
 * CompanyResearchProvider / LiveMarketDataProvider contracts, register it
 * in the two switch statements below, and set
 * COMPANY_RESEARCH_PROVIDER=global-datafeeds (or MARKET_DATA_PROVIDER=
 * global-datafeeds) in the environment. No controller, service, model, or
 * frontend change is required.
 */

let companyResearchProviderInstance = null;

/**
 * createCompanyResearchProvider - factory for the CompanyResearchProvider
 * role. Returns null (not a throw) when no provider is configured, so
 * callers can render an honest "not configured" state instead of crashing
 * app startup — company research is supplementary, not required for the
 * app to run.
 */
export const createCompanyResearchProvider = (providerName = process.env.COMPANY_RESEARCH_PROVIDER) => {
  const normalized = String(providerName || 'indian-api').toLowerCase();

  switch (normalized) {
    case 'indian-api':
    case 'indianapi':
      return new IndianApiProvider();
    // case 'global-datafeeds':
    //   return new GlobalDatafeedsProvider();
    case 'none':
    case '':
      return null;
    default:
      logger.warn(`Unknown COMPANY_RESEARCH_PROVIDER '${providerName}' — falling back to indian-api`);
      return new IndianApiProvider();
  }
};

/** Singleton accessor — company research provider has no per-request state worth re-creating. */
export const getCompanyResearchProvider = () => {
  if (!companyResearchProviderInstance) {
    companyResearchProviderInstance = createCompanyResearchProvider();
  }
  return companyResearchProviderInstance;
};

/**
 * createLiveMarketDataProvider - documents the existing MARKET_DATA_PROVIDER
 * resolution as a registry entry point. server.js retains its own
 * (unchanged) provider-selection logic for Angel One / legacy providers;
 * this export exists so a future GlobalDatafeedsProvider has a single,
 * documented place to be registered for the live-market-data role too.
 */
export const createLiveMarketDataProvider = (providerName = process.env.MARKET_DATA_PROVIDER) => {
  const normalized = String(providerName || 'angel-one').toLowerCase();
  switch (normalized) {
    case 'angel-one':
    case 'angelone':
    case 'angel':
      return new AngelOneProvider();
    // case 'global-datafeeds':
    //   return new GlobalDatafeedsProvider();
    default:
      return new AngelOneProvider();
  }
};

export default {
  createCompanyResearchProvider,
  getCompanyResearchProvider,
  createLiveMarketDataProvider,
};
