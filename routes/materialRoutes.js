const express = require("express");
const pool = require("../database/postgres");
const { requireLogin } = require("../middleware/auth");
const router = express.Router();

router.get("/", requireLogin, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT id, chapter, title, description, content, file_url,
             material_type, created_at
      FROM it_study_materials
      WHERE is_published = 1
      ORDER BY sort_order ASC, id ASC
    `);
    res.set("Cache-Control", "no-store");
    res.json({ materials: result.rows });
  } catch (error) { next(error); }
});

module.exports = router;
