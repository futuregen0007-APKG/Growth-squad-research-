import express from 'express';
import {
  getFeaturedCompanies,
  searchCompanies,
  getCompanyReport,
  getCompanyPromises,
  getCompanyFacts,
  getCompanyHistory,
  createResearchJob,
  getResearchJob,
  getCompanyResearchDebug,
  getCompanyTimeline,
} from '../services/ManagementPromiseService.js';
import * as CuratedEarningsIntelligenceService from '../services/CuratedEarningsIntelligenceService.js';
import ManagementPromise from '../models/ManagementPromise.js';
import CompanyHistoricalFact from '../models/CompanyHistoricalFact.js';
import ReconciliationCheck, { OK_STATUSES as RECONCILIATION_OK_STATUSES } from '../models/ReconciliationCheck.js';
import { getAllStatuses as getScheduledJobStatuses } from '../services/ScheduledJobRunService.js';
import { isPubliclyVisibleRecord } from '../utils/earningsIntelligenceValidation.js';

const router = express.Router();

// Logging middleware
router.use((req, res, next) => {
  console.log(`[Earnings Intelligence API] ${req.method} ${req.path}`);
  next();
});

router.get('/featured', async (req, res, next) => {
  try {
    const data = await getFeaturedCompanies();
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /featured error:', error);
    if (error.name === 'MongooseError' || error.name === 'MongoError') {
      return res.status(503).json({ 
        success: false, 
        state: 'DATABASE_ERROR', 
        error: 'Database connection failed',
        data: [] 
      });
    }
    next(error);
  }
});

router.get('/search', async (req, res, next) => {
  try {
    const data = await searchCompanies(req.query.q);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /search error:', error);
    next(error);
  }
});

router.get('/promise/:id', async (req, res, next) => {
  try {
    const promise = await ManagementPromise.findOne({ _id: req.params.id, dataOrigin: 'REAL_RESEARCH' }).lean();
    // Phase 4F: a direct by-id lookup must be gated exactly like the list
    // endpoints -- a quarantined/unsupported record's Mongo _id is never a
    // secret, so this route must not become a bypass for evidence-integrity
    // filtering.
    if (!promise || !isPubliclyVisibleRecord(promise)) return res.status(404).json({ success: false, message: 'Promise not found.' });
    return res.json({ success: true, data: promise });
  } catch (error) {
    console.error('[Earnings Intelligence] /promise/:id error:', error);
    return next(error);
  }
});

router.get('/fact/:id', async (req, res, next) => {
  try {
    const fact = await CompanyHistoricalFact.findOne({ _id: req.params.id, dataOrigin: 'REAL_RESEARCH' }).lean();
    if (!fact) return res.status(404).json({ success: false, message: 'Historical fact not found.' });
    return res.json({ success: true, data: fact });
  } catch (error) {
    console.error('[Earnings Intelligence] /fact/:id error:', error);
    return next(error);
  }
});

router.get('/jobs/:jobId', async (req, res, next) => {
  try {
    const data = await getResearchJob(req.params.jobId);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /jobs/:jobId error:', error);
    next(error);
  }
});

/**
 * GET /data-quality - the operational status a human (not Claude, not a
 * laptop) needs to trust the pipeline is still running unattended: each
 * scheduled job's last success/failure, and every unresolved reconciliation
 * difference (see models/ReconciliationCheck.js) grouped by symbol. A
 * mismatch here does not mean a stored value is wrong -- see the model's own
 * docstring -- but it must be visible here rather than silently dropped once
 * the verification run that found it exits.
 */
router.get('/data-quality', async (req, res, next) => {
  try {
    const [scheduledJobs, unresolvedChecks] = await Promise.all([
      getScheduledJobStatuses(),
      ReconciliationCheck.find({ status: { $nin: RECONCILIATION_OK_STATUSES } }).sort({ symbol: 1 }).lean(),
    ]);
    const bySymbol = new Map();
    for (const check of unresolvedChecks) {
      if (!bySymbol.has(check.symbol)) bySymbol.set(check.symbol, []);
      bySymbol.get(check.symbol).push({
        checkType: check.checkType, metric: check.metric, period: check.period, basis: check.basis, status: check.status, detail: check.detail, lastCheckedAt: check.lastCheckedAt,
      });
    }
    res.json({
      success: true,
      data: {
        scheduledJobs: scheduledJobs.map((j) => ({
          jobName: j.jobName, status: j.status, startedAt: j.startedAt, finishedAt: j.finishedAt, heartbeatAt: j.heartbeatAt, checkpoint: j.checkpoint, lastSuccessAt: j.lastSuccessAt, lastFailureAt: j.lastFailureAt, lastFailureError: j.lastFailureError,
        })),
        reconciliation: {
          unresolvedCount: unresolvedChecks.length,
          unresolvedSymbolCount: bySymbol.size,
          bySymbol: Object.fromEntries(bySymbol),
        },
      },
    });
  } catch (error) {
    console.error('[Earnings Intelligence] /data-quality error:', error);
    next(error);
  }
});

router.get('/:symbol/promises', async (req, res, next) => {
  try {
    const data = await getCompanyPromises(req.params.symbol, req.query);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /:symbol/promises error:', error);
    if (error.name === 'MongooseError' || error.name === 'MongoError') {
      return res.status(503).json({ 
        success: false, 
        state: 'DATABASE_ERROR', 
        error: 'Database connection failed',
        data: [] 
      });
    }
    next(error);
  }
});

router.get('/:symbol/facts', async (req, res, next) => {
  try {
    const data = await getCompanyFacts(req.params.symbol, req.query);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /:symbol/facts error:', error);
    if (error.name === 'MongooseError' || error.name === 'MongoError') {
      return res.status(503).json({ 
        success: false, 
        state: 'DATABASE_ERROR', 
        error: 'Database connection failed',
        data: [] 
      });
    }
    next(error);
  }
});

router.get('/:symbol/history', async (req, res, next) => {
  try {
    const data = await getCompanyHistory(req.params.symbol, req.query);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /:symbol/history error:', error);
    if (error.name === 'MongooseError' || error.name === 'MongoError') {
      return res.status(503).json({ 
        success: false, 
        state: 'DATABASE_ERROR', 
        error: 'Database connection failed',
        data: [] 
      });
    }
    next(error);
  }
});

router.get('/:symbol/research-debug', async (req, res, next) => {
  try {
    const data = await getCompanyResearchDebug(req.params.symbol);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /:symbol/research-debug error:', error);
    next(error);
  }
});

router.get('/:symbol/timeline', async (req, res, next) => {
  try {
    const symbol = req.params.symbol;
    const filters = { year: req.query.year, category: req.query.category, status: req.query.status };

    // Fallback order (Step 9): curated verified dataset -> existing persisted
    // verified records -> honest RESEARCH_PENDING response. Live document
    // research is never triggered from this read path.
    const curated = await CuratedEarningsIntelligenceService.getCompanyTimeline(symbol, filters);

    if (curated?.dataMode === 'CURATED_VERIFIED') {
      return res.json({ success: true, data: curated });
    }

    const legacy = await getCompanyTimeline(symbol);
    if (legacy?.promises?.length > 0) {
      return res.json({ success: true, data: legacy });
    }

    if (curated) {
      // Supported stock, but neither curated nor legacy research exists yet.
      return res.json({ success: true, data: curated });
    }

    return res.status(404).json({ success: false, message: `Unsupported or unknown symbol: ${symbol}` });
  } catch (error) {
    console.error('[Earnings Intelligence] /:symbol/timeline error:', error);
    if (error.name === 'MongooseError' || error.name === 'MongoError') {
      return res.status(503).json({
        success: false,
        state: 'DATABASE_ERROR',
        error: 'Database connection failed',
        data: null
      });
    }
    next(error);
  }
});

router.get('/:symbol', async (req, res, next) => {
  try {
    const data = await getCompanyReport(req.params.symbol);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /:symbol error:', error);
    if (error.name === 'MongooseError' || error.name === 'MongoError') {
      return res.status(503).json({ 
        success: false, 
        state: 'DATABASE_ERROR', 
        error: 'Database connection failed',
        data: null 
      });
    }
    next(error);
  }
});

// Company report alias: /company/:symbol
router.get('/company/:symbol', async (req, res, next) => {
  try {
    const data = await getCompanyReport(req.params.symbol);
    res.json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /company/:symbol error:', error);
    next(error);
  }
});

router.post('/:symbol/research', async (req, res, next) => {
  try {
    const data = await createResearchJob(req.params.symbol);
    res.status(202).json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /:symbol/research error:', error);
    next(error);
  }
});

// Research trigger alias: /research/:symbol
router.post('/research/:symbol', async (req, res, next) => {
  try {
    const data = await createResearchJob(req.params.symbol);
    res.status(202).json({ success: true, data });
  } catch (error) {
    console.error('[Earnings Intelligence] /research/:symbol error:', error);
    next(error);
  }
});

export default router;
