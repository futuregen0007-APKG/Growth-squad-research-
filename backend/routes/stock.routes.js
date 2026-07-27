import express from 'express';
import { StockController } from '../controllers/StockController.js';

const router = express.Router();

router.get('/:symbol', (req, res, next) => {
  const controller = new StockController();
  return controller.getStock(req, res, next);
});

export default router;
