const METRICS = new Set([
  'EMPLOYEE_PERCENTAGE', 'REVENUE', 'REVENUE_GROWTH', 'EBITDA', 'EBITDA_MARGIN', 'PAT',
  'ORDER_BOOK', 'NIM', 'CREDIT_GROWTH', 'DEPOSIT_GROWTH', 'CASA', 'OTHER_QUANTIFIABLE'
]);

const forwardLanguage = /\b(commit(?:s|ted)?|target(?:s|ed)?|expect(?:s|ed)?|plan(?:s|ned)?|intend(?:s|ed)?|aim(?:s|ed)?|guid(?:e|ance|ing)|forecast(?:s|ed)?)\b/i;
const historicalLanguage = /\b(grew|grown|increased|decreased|declined|reported|stood at|was|were|rose|fell)\b/i;
const numberPattern = '(\\d+(?:\\.\\d+)?)';

const clean = (value) => String(value || '').replace(/\s+/g, ' ').trim();

const metricFor = (statement) => {
  const lower = statement.toLowerCase();
  if (/employee\s+base|employees|workforce/.test(lower)) return 'EMPLOYEE_PERCENTAGE';
  if (/revenue growth|top[- ]line growth/.test(lower)) return 'REVENUE_GROWTH';
  if (/revenue|top[- ]line/.test(lower)) return 'REVENUE';
  if (/ebitda margin|operating margin/.test(lower)) return 'EBITDA_MARGIN';
  if (/ebitda/.test(lower)) return 'EBITDA';
  if (/pat|profit after tax|net profit/.test(lower)) return 'PAT';
  if (/order book|backlog/.test(lower)) return 'ORDER_BOOK';
  if (/nim|net interest margin/.test(lower)) return 'NIM';
  if (/credit growth/.test(lower)) return 'CREDIT_GROWTH';
  if (/deposit growth|deposits/.test(lower)) return 'DEPOSIT_GROWTH';
  if (/casa/.test(lower)) return 'CASA';
  return 'OTHER_QUANTIFIABLE';
};

const targetFrom = (statement) => {
  const atLeast = statement.match(new RegExp(`\\bat least\\s+${numberPattern}\\s*(%|percent|percentage)?`, 'i'));
  if (atLeast) return { value: Number(atLeast[1]), unit: atLeast[2] ? 'PERCENTAGE' : 'OTHER', direction: 'AT_LEAST' };
  const atMost = statement.match(new RegExp(`\\bat most\\s+${numberPattern}\\s*(%|percent|percentage)?`, 'i'));
  if (atMost) return { value: Number(atMost[1]), unit: atMost[2] ? 'PERCENTAGE' : 'OTHER', direction: 'AT_MOST' };
  const range = statement.match(new RegExp(`\\b${numberPattern}\\s*(%|percent|percentage)?\\s*(?:to|-)\\s*${numberPattern}\\s*(%|percent|percentage)?`, 'i'));
  if (range) return { value: Number(range[1]), upperValue: Number(range[3]), unit: range[2] || range[4] ? 'PERCENTAGE' : 'OTHER', direction: 'RANGE' };
  const percentage = statement.match(new RegExp(`${numberPattern}\\s*(%|percent|percentage)`, 'i'));
  if (percentage) return { value: Number(percentage[1]), unit: 'PERCENTAGE', direction: /growth|grow|increase|expand/i.test(statement) ? 'GROWTH' : 'EXACT' };
  return null;
};

const sourceFor = (document) => ({
  sourceDocument: document.title || document.sourceName || 'Source document',
  sourceUrl: document.sourceUrl || document.url || document.canonicalUrl || null,
  page: document.page ?? document.pageNumber ?? null,
  sourceDate: document.sourceDate || document.publishedAt || null,
});

export const extractPromisesFromDocument = (document = {}) => {
  const source = sourceFor(document);
  if (!source.sourceUrl) return [];
  const pages = Array.isArray(document.pages) && document.pages.length
    ? document.pages
    : [{ pageNumber: source.page, text: document.fullText || document.text || document.excerpt || '' }];
  const promises = [];

  for (const page of pages) {
    const text = clean(page.text || page.content);
    if (!text) continue;
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      const statement = clean(sentence);
      if (!forwardLanguage.test(statement) || historicalLanguage.test(statement)) continue;
      const target = targetFrom(statement);
      if (!target) continue;
      const metric = metricFor(statement);
      if (!METRICS.has(metric)) continue;
      promises.push({
        statement,
        metric,
        targetValue: target.value,
        ...(target.upperValue == null ? {} : { targetUpperValue: target.upperValue }),
        targetUnit: target.unit,
        direction: target.direction,
        period: /going forward|new operating model/.test(statement.toLowerCase()) ? 'GOING_FORWARD' : null,
        confidence: 0.9,
        evidence: {
          ...source,
          page: page.pageNumber ?? source.page,
          excerpt: statement
        }
      });
    }
  }
  return promises;
};

export default { extractPromisesFromDocument };