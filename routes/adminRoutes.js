const express = require("express");
const pool = require("../database/postgres");
const { requireRole } = require("../middleware/auth");
const router = express.Router();

router.get("/dashboard", requireRole("admin"), async (req, res, next) => {
  try {
    const result = await pool.query(
      "SELECT COUNT(*)::int AS count FROM users WHERE role = 'student'"
    );
    res.json({
      message: "Administrator access granted.",
      totalStudents: result.rows[0].count
    });
  } catch (error) { next(error); }
});

module.exports = router;
