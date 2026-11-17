const express = require("express");
const pool = require("../database/postgres");
const { requireLogin } = require("../middleware/auth");
const router = express.Router();

function parseOptions(value) {
  try {
    const options = typeof value === "string" ? JSON.parse(value) : value;
    if (!options || !["A","B","C","D"].every(
      key => typeof options[key] === "string" && options[key].trim()
    )) return null;
    return options;
  } catch { return null; }
}

router.get("/questions", requireLogin, async (req, res, next) => {
  try {
    const chapter = String(req.query.chapter || "").trim();
    const result = chapter
      ? await pool.query(`
          SELECT id, chapter, question, options_json
          FROM it_practice_questions
          WHERE is_published = 1 AND chapter = $1
          ORDER BY sort_order, id
        `, [chapter])
      : await pool.query(`
          SELECT id, chapter, question, options_json
          FROM it_practice_questions
          WHERE is_published = 1
          ORDER BY sort_order, id
        `);
    const questions = result.rows.map(row => ({
      id: row.id,
      chapter: row.chapter,
      question: row.question,
      options: parseOptions(row.options_json)
    })).filter(row => row.options);
    res.set("Cache-Control", "no-store");
    res.json({ questions });
  } catch (error) { next(error); }
});

router.post("/questions/:id/answer", requireLogin, async (req, res, next) => {
  try {
    const id = Number(req.params.id);
    const selectedOption = String(req.body.selectedOption || "").toUpperCase();
    if (!Number.isSafeInteger(id) || id < 1)
      return res.status(400).json({ error: "Invalid question." });
    if (!["A","B","C","D"].includes(selectedOption))
      return res.status(400).json({ error: "Select a valid answer." });

    const result = await pool.query(`
      SELECT correct_option, explanation
      FROM it_practice_questions
      WHERE id = $1 AND is_published = 1
    `, [id]);
    if (!result.rowCount)
      return res.status(404).json({ error: "Question not found." });

    res.set("Cache-Control", "no-store");
    res.json({
      isCorrect: selectedOption === result.rows[0].correct_option,
      explanation: result.rows[0].explanation || ""
    });
  } catch (error) { next(error); }
});

module.exports = router;
