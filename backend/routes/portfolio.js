import express from 'express';
import authenticate from '../middleware/auth.js';
import { createPortfolioController } from '../controllers/portfolio.controller.js';

export const createPortfolioRoutes = (stockService) => {
  const router = express.Router();
  const controller = createPortfolioController(stockService);
  router.use(authenticate);
  router.get('/', controller.getPortfolio);
  router.post('/holdings', controller.addHolding);
  router.put('/holdings/:id', controller.updateHolding);
  router.delete('/holdings/:id', controller.deleteHolding);
  return router;
};

export default createPortfolioRoutes;