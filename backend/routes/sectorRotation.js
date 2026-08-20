import express from 'express';
import SectorRotationService from '../services/SectorRotationService.js';

const router = express.Router();

router.get('/', async (req, res) => {
  try {
    const data = await SectorRotationService.getSectorRotation();
    res.json({ data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
