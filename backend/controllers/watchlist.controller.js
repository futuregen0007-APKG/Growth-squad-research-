import Watchlist from '../models/Watchlist.js';

const DEFAULT_NAME = 'My Watchlist';
const normalizeSymbol = (value) => String(value || '').trim().toUpperCase();

const getOrCreateDefault = async (userId) => Watchlist.findOneAndUpdate(
  { userId, name: DEFAULT_NAME },
  { $setOnInsert: { userId, name: DEFAULT_NAME, symbols: [] } },
  { new: true, upsert: true, setDefaultsOnInsert: true },
).lean();

export const createWatchlistController = (stockService) => ({
  getWatchlists: async (req, res, next) => {
    try {
      const existing = await Watchlist.find({ userId: req.userId }).sort({ createdAt: 1 }).lean();
      const watchlists = existing.length ? existing : [await getOrCreateDefault(req.userId)];
      const data = await Promise.all(watchlists.map(async (watchlist) => {
        const stocks = await Promise.all(watchlist.symbols.map(async (symbol) => {
          try { return await stockService.getStock(symbol); } catch { return null; }
        }));
        return { id: watchlist._id, name: watchlist.name, symbols: watchlist.symbols, stocks: stocks.filter(Boolean) };
      }));
      return res.json({ success: true, data });
    } catch (error) { return next(error); }
  },

  addSymbol: async (req, res, next) => {
    try {
      const symbol = normalizeSymbol(req.body?.symbol);
      if (!/^[A-Z0-9&-]{2,15}$/.test(symbol)) return res.status(400).json({ success: false, error: 'A valid stock symbol is required' });
      const watchlist = await Watchlist.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        { $addToSet: { symbols: symbol } },
        { new: true },
      ).lean();
      if (!watchlist) return res.status(404).json({ success: false, error: 'Watchlist not found' });
      return res.json({ success: true, data: { id: watchlist._id, name: watchlist.name, symbols: watchlist.symbols } });
    } catch (error) { return next(error); }
  },

  removeSymbol: async (req, res, next) => {
    try {
      const symbol = normalizeSymbol(req.params.symbol);
      const watchlist = await Watchlist.findOneAndUpdate(
        { _id: req.params.id, userId: req.userId },
        { $pull: { symbols: symbol } },
        { new: true },
      ).lean();
      if (!watchlist) return res.status(404).json({ success: false, error: 'Watchlist not found' });
      return res.json({ success: true, data: { id: watchlist._id, name: watchlist.name, symbols: watchlist.symbols } });
    } catch (error) { return next(error); }
  },
});