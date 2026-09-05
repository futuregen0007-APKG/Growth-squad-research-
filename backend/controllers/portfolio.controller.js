import PortfolioHolding from '../models/PortfolioHolding.js';

const invalid = (message) => ({ success: false, error: message });

const validateHolding = (body = {}) => {
  const symbol = String(body.symbol || '').trim().toUpperCase();
  const quantity = Number(body.quantity);
  const averageBuyPrice = Number(body.averageBuyPrice ?? body.avgPrice);
  if (!/^[A-Z0-9&-]{2,15}$/.test(symbol)) return { error: 'A valid stock symbol is required' };
  if (!Number.isFinite(quantity) || quantity <= 0) return { error: 'Quantity must be greater than zero' };
  if (!Number.isFinite(averageBuyPrice) || averageBuyPrice < 0) return { error: 'Average buy price must be zero or greater' };
  return { symbol, quantity, averageBuyPrice };
};

const enrichHolding = async (holding, stockService) => {
  let stock = null;
  try {
    stock = await stockService.getStock(holding.symbol);
  } catch {
    stock = null;
  }
  const currentPrice = Number.isFinite(Number(stock?.price)) ? Number(stock.price) : null;
  const investedAmount = holding.quantity * holding.averageBuyPrice;
  const currentValue = currentPrice === null ? null : holding.quantity * currentPrice;
  const pnl = currentValue === null ? null : currentValue - investedAmount;
  const pnlPercentage = pnl === null || investedAmount === 0 ? null : (pnl / investedAmount) * 100;
  return {
    id: holding._id,
    symbol: holding.symbol,
    quantity: holding.quantity,
    avgPrice: holding.averageBuyPrice,
    averageBuyPrice: holding.averageBuyPrice,
    name: stock?.name || holding.symbol,
    sector: stock?.sector || 'N/A',
    currentPrice,
    investedAmount,
    investedValue: investedAmount,
    currentValue,
    pnl,
    pnlPercentage,
    pnlPct: pnlPercentage,
    priceUnavailable: currentPrice === null,
    updatedAt: holding.updatedAt,
  };
};

export const createPortfolioController = (stockService) => {
  const getPortfolio = async (req, res, next) => {
    try {
      const holdings = await PortfolioHolding.find({ userId: req.userId }).sort({ createdAt: 1 }).lean();
      const enriched = await Promise.all(holdings.map((holding) => enrichHolding(holding, stockService)));
      const priced = enriched.filter((holding) => holding.currentValue !== null);
      const totalInvested = enriched.reduce((sum, holding) => sum + holding.investedAmount, 0);
      const currentValue = priced.reduce((sum, holding) => sum + holding.currentValue, 0);
      const pnl = priced.length === enriched.length ? currentValue - totalInvested : null;
      const pnlPercentage = pnl === null || totalInvested === 0 ? null : (pnl / totalInvested) * 100;
      const sectorTotals = priced.reduce((totals, holding) => {
        totals[holding.sector] = (totals[holding.sector] || 0) + holding.currentValue;
        return totals;
      }, {});
      const allocation = Object.entries(sectorTotals).map(([sector, value]) => ({
        sector,
        value,
        percentage: currentValue > 0 ? (value / currentValue) * 100 : 0,
      }));
      return res.json({ success: true, data: { holdings: enriched, summary: { totalInvested, currentValue, pnl, pnlPercentage, allocation } } });
    } catch (error) {
      return next(error);
    }
  };

  const addHolding = async (req, res, next) => {
    try {
      const parsed = validateHolding(req.body);
      if (parsed.error) return res.status(400).json(invalid(parsed.error));
      const holding = await PortfolioHolding.create({ userId: req.userId, ...parsed });
      return res.status(201).json({ success: true, data: await enrichHolding(holding.toObject(), stockService) });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json(invalid('This stock is already in your portfolio'));
      return next(error);
    }
  };

  const updateHolding = async (req, res, next) => {
    try {
      const parsed = validateHolding(req.body);
      if (parsed.error) return res.status(400).json(invalid(parsed.error));
      const holding = await PortfolioHolding.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId }, parsed, { new: true, runValidators: true },
      ).lean();
      if (!holding) return res.status(404).json(invalid('Holding not found'));
      return res.json({ success: true, data: await enrichHolding(holding, stockService) });
    } catch (error) {
      return next(error);
    }
  };

  const deleteHolding = async (req, res, next) => {
    try {
      const deleted = await PortfolioHolding.findOneAndDelete({ _id: req.params.id, userId: req.userId });
      if (!deleted) return res.status(404).json(invalid('Holding not found'));
      return res.json({ success: true, message: 'Holding removed' });
    } catch (error) {
      return next(error);
    }
  };

  return { getPortfolio, addHolding, updateHolding, deleteHolding };
};