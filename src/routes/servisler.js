const router = require('express').Router();
const { authMiddleware } = require('../middleware/auth');
router.use(authMiddleware);
router.get('/', (req, res) => res.json({ mesaj: 'ok' }));
router.post('/', (req, res) => res.json({ mesaj: 'ok' }));
module.exports = router;
