import express from 'express';
import SectorRotationService from '../services/SectorRotationService.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const data = await SectorRotationService.getSectorRotation();
    res.json({ data, asOf: new Date().toISOString() });
  } catch (err) {
    res.status(503).json({ error: err.message });
  }
});

export default router;
