/**
 * CompanyResearchProvider - abstract contract for company/fundamental
 * research data (as opposed to live tradeable quotes, which remain the
 * responsibility of LiveMarketDataProvider / AngelOneProvider).
 *
 * Any concrete provider (IndianApiProvider today, a future
 * GlobalDatafeedsProvider tomorrow) extends this class. Business logic
 * (StockController, CompanyResearchService, ManagementPromiseService, the
 * frontend) must depend only on this shape — never on a provider's raw
 * field names.
 *
 * UNSUPPORTED CAPABILITIES: a provider that cannot support a method must
 * NOT fabricate data and must NOT throw a generic error. It returns the
 * structured result from `unsupported()` so callers can render an honest
 * "unavailable" state instead of guessing.
 */
export class CompanyResearchProvider {
  /** Stable identifier used in provenance.provider on normalized records. */
  get providerName() {
    throw new Error(`${this.constructor.name} must implement providerName`);
  }

  /**
   * Resolve a free-text symbol or company name to the provider's internal
   * identifier. Returns { symbol, companyName, providerId } or null.
   */
  async resolveCompany(symbolOrName) {
    return this.unsupported('resolveCompany');
  }

  /** Company profile (description, industry, sector, identifiers). */
  async getCompanyProfile(symbolOrName) {
    return this.unsupported('getCompanyProfile');
  }

  /** Financial statements (income/balance/cash flow, periodic). */
  async getFinancials(symbolOrName) {
    return this.unsupported('getFinancials');
  }

  /** Key ratios/metrics (PE, PB, margins, ROE, ROCE, etc.). */
  async getKeyMetrics(symbolOrName) {
    return this.unsupported('getKeyMetrics');
  }

  /** Shareholding pattern (promoter/FII/DII/public, by period). */
  async getShareholding(symbolOrName) {
    return this.unsupported('getShareholding');
  }

  /** Corporate actions (dividends, splits, bonuses, buybacks). */
  async getCorporateActions(symbolOrName) {
    return this.unsupported('getCorporateActions');
  }

  /** Analyst views/targets. Informational only — never an actual outcome. */
  async getAnalystData(symbolOrName) {
    return this.unsupported('getAnalystData');
  }

  /** Recent, dated company news. */
  async getCompanyNews(symbolOrName) {
    return this.unsupported('getCompanyNews');
  }

  /**
   * Dated, structured evidence usable to verify a management promise's
   * actual outcome (Earnings Intelligence support role). options may
   * include { metric, targetPeriod, sinceDate }.
   * Returns an array of provider-neutral OutcomeEvidence records (see
   * services/OutcomeEvidenceService.js for the shared shape).
   */
  async getOutcomeEvidence(symbolOrName, options = {}) {
    return this.unsupported('getOutcomeEvidence');
  }

  /**
   * Structured "not supported by this provider" result. Never throw for a
   * missing optional capability — callers check `.supported`.
   */
  unsupported(capability) {
    return {
      supported: false,
      capability,
      provider: this.providerName,
      reason: `${capability} is not supported by ${this.providerName}`,
    };
  }
}

export default CompanyResearchProvider;
