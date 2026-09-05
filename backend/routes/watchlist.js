import express from 'express';
import authenticate from '../middleware/auth.js';
import { createWatchlistController } from '../controllers/watchlist.controller.js';

export const createWatchlistRoutes = (stockService) => {
  const router = express.Router();
  const controller = createWatchlistController(stockService);
  router.use(authenticate);
  router.get('/', controller.getWatchlists);
  router.post('/:id/symbols', controller.addSymbol);
  router.delete('/:id/symbols/:symbol', controller.removeSymbol);
  return router;
};

export default createWatchlistRoutes;