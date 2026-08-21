import { HTTP_STATUS } from '../utils/constants.js';
import { createInvalidInputError } from '../utils/errorHandler.js';
import { AngelOneService } from '../services/angelOne.service.js';

const angelOneService = new AngelOneService();

export class StockController {
  async getStock(req, res, next) {
    try {
      const symbol = String(req.params.symbol || '').trim().toUpperCase();

      if (!symbol) {
        throw createInvalidInputError('Symbol path parameter is required');
      }

      const quote = await angelOneService.fetchQuote(symbol);

      res.status(HTTP_STATUS.OK).json({
        success: true,
        data: {
          symbol: quote.symbol,
          companyName: quote.companyName,
          price: quote.price,
          open: quote.open,
          high: quote.high,
          low: quote.low,
          previousClose: quote.previousClose,
          volume: quote.volume,
          timestamp: quote.timestamp,
        },
        message: `Stock quote for ${quote.symbol}`,
      });
    } catch (error) {
      next(error);
    }
  }
}
