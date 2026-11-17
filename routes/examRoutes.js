const express = require("express");
const pool = require("../database/postgres");
const { requireLogin } = require("../middleware/auth");
const router = express.Router();

function isSunday() {
  return new Date(Date.now() + 330 * 60000).getUTCDay() === 0;
}
function getUserId(req) {
  return req.session?.userId || req.user?.id || null;
}
function validId(value) {
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
function parseJson(value, fallback = {}) {
  try { return typeof value === "string" ? JSON.parse(value) : (value || fallback); }
  catch { return fallback; }
}

router.get("/papers", requireLogin, async (req, res, next) => {
  try {
    const userId = getUserId(req);
    if (!userId) return res.status(401).json({ error: "Login required." });
    const result = await pool.query(`
      SELECT p.id, p.title, p.exam_date, p.duration_minutes, p.total_marks,
             a.id AS attempt_id, a.submitted_at
      FROM student_exam_papers p
      LEFT JOIN student_exam_attempts a
        ON a.paper_id = p.id AND a.user_id = $1
      WHERE p.is_published = 1
      ORDER BY p.exam_date DESC
    `, [userId]);
    res.json({ papers: result.rows });
  } catch (error) { next(error); }
});

router.post("/:paperId/start", requireLogin, async (req, res, next) => {
  const userId = getUserId(req);
  const paperId = validId(req.params.paperId);
  if (!userId) return res.status(401).json({ error: "Login required." });
  if (!paperId) return res.status(400).json({ error: "Invalid exam." });
  if (!isSunday())
    return res.status(403).json({ error: "Exams are available on Sundays only." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const paperResult = await client.query(
      "SELECT * FROM student_exam_papers WHERE id=$1 AND is_published=1 FOR SHARE",
      [paperId]
    );
    if (!paperResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Exam not found." });
    }
    const paper = paperResult.rows[0];
    const existing = await client.query(
      "SELECT id FROM student_exam_attempts WHERE paper_id=$1 AND user_id=$2",
      [paperId, userId]
    );
    if (existing.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({
        error: "You have already used your attempt.",
        attemptId: existing.rows[0].id
      });
    }
    const questionsResult = await client.query(`
      SELECT id, question, options_json, marks
      FROM student_exam_questions WHERE paper_id=$1 ORDER BY id
    `, [paperId]);
    if (!questionsResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(409).json({ error: "This exam has no questions yet." });
    }
    const now = new Date();
    const deadline = new Date(now.getTime() + Number(paper.duration_minutes) * 60000);
    const inserted = await client.query(`
      INSERT INTO student_exam_attempts
        (paper_id,user_id,started_at,deadline_at,answers_json)
      VALUES ($1,$2,$3,$4,'{}')
      RETURNING id
    `, [paperId, userId, now.toISOString(), deadline.toISOString()]);
    await client.query("COMMIT");
    res.json({
      attemptId: inserted.rows[0].id,
      title: paper.title,
      durationMinutes: paper.duration_minutes,
      totalMarks: paper.total_marks,
      deadlineAt: deadline.toISOString(),
      questions: questionsResult.rows.map(q => ({
        id: q.id, question: q.question,
        options: parseJson(q.options_json), marks: q.marks
      }))
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    if (error.code === "23505")
      return res.status(409).json({ error: "You have already used your attempt." });
    next(error);
  } finally { client.release(); }
});

router.post("/attempt/:attemptId/answer", requireLogin, async (req, res, next) => {
  const attemptId = validId(req.params.attemptId);
  const userId = getUserId(req);
  const questionId = validId(req.body.questionId);
  const selectedOption = String(req.body.selectedOption || "").toUpperCase();
  if (!attemptId || !questionId || !["A","B","C","D"].includes(selectedOption))
    return res.status(400).json({ error: "Invalid answer." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const attemptResult = await client.query(`
      SELECT * FROM student_exam_attempts
      WHERE id=$1 AND user_id=$2 FOR UPDATE
    `, [attemptId, userId]);
    if (!attemptResult.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Attempt not found." });
    }
    const attempt = attemptResult.rows[0];
    if (attempt.submitted_at) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Attempt is locked." });
    }
    if (Date.now() >= Date.parse(attempt.deadline_at)) {
      await client.query("ROLLBACK");
      return res.status(403).json({ error: "Exam time has expired. Submit your exam." });
    }
    const question = await client.query(
      "SELECT id FROM student_exam_questions WHERE id=$1 AND paper_id=$2",
      [questionId, attempt.paper_id]
    );
    if (!question.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Question not found." });
    }
    const answers = parseJson(attempt.answers_json);
    answers[questionId] = selectedOption;
    await client.query(
      "UPDATE student_exam_attempts SET answers_json=$1 WHERE id=$2",
      [JSON.stringify(answers), attemptId]
    );
    await client.query("COMMIT");
    res.json({ saved: true });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.post("/attempt/:attemptId/submit", requireLogin, async (req, res, next) => {
  const attemptId = validId(req.params.attemptId);
  const userId = getUserId(req);
  if (!attemptId) return res.status(400).json({ error: "Invalid attempt." });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await client.query(`
      SELECT * FROM student_exam_attempts
      WHERE id=$1 AND user_id=$2 FOR UPDATE
    `, [attemptId, userId]);
    if (!result.rowCount) {
      await client.query("ROLLBACK");
      return res.status(404).json({ error: "Attempt not found." });
    }
    const attempt = result.rows[0];
    if (attempt.submitted_at) {
      await client.query("COMMIT");
      return res.json({ submitted: true, alreadySubmitted: true });
    }
    if (Date.now() < Date.parse(attempt.deadline_at) && req.body.confirm !== true) {
      await client.query("ROLLBACK");
      return res.status(400).json({ error: "Confirm submission by sending confirm:true." });
    }
    const answers = parseJson(attempt.answers_json);
    const questions = await client.query(
      "SELECT id,correct_option,marks FROM student_exam_questions WHERE paper_id=$1",
      [attempt.paper_id]
    );
    let score = 0;
    for (const q of questions.rows)
      if (answers[q.id] === q.correct_option) score += Number(q.marks);

    const written = await client.query(
      "SELECT COUNT(*)::int AS count FROM portal_written_questions WHERE paper_id=$1",
      [attempt.paper_id]
    );
    const submittedAt = new Date().toISOString();
    const gradingComplete = written.rows[0].count === 0 ? 1 : 0;
    await client.query(`
      UPDATE student_exam_attempts
      SET submitted_at=$1, score=$2, grading_complete=$3
      WHERE id=$4 AND submitted_at IS NULL
    `, [submittedAt, score, gradingComplete, attemptId]);
    await client.query("COMMIT");
    res.json({
      submitted: true,
      gradingPending: gradingComplete === 0,
      resultAvailableAt: new Date(Date.parse(submittedAt) + 12 * 3600000).toISOString()
    });
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    next(error);
  } finally { client.release(); }
});

router.get("/results", requireLogin, async (req, res, next) => {
  try {
    const result = await pool.query(`
      SELECT a.id,a.submitted_at,a.score,a.grading_complete,p.title,p.total_marks
      FROM student_exam_attempts a
      JOIN student_exam_papers p ON p.id=a.paper_id
      WHERE a.user_id=$1 AND a.submitted_at IS NOT NULL
      ORDER BY a.submitted_at DESC
    `, [getUserId(req)]);
    const results = result.rows.map(row => {
      const release = Date.parse(row.submitted_at) + 12 * 3600000;
      const available = Date.now() >= release && !!row.grading_complete;
      return {
        attemptId: row.id, title: row.title, submittedAt: row.submitted_at,
        available, resultAvailableAt: new Date(release).toISOString(),
        score: available ? row.score : null,
        totalMarks: available ? row.total_marks : null
      };
    });
    res.json({ results });
  } catch (error) { next(error); }
});

router.get("/results/:attemptId", requireLogin, async (req, res, next) => {
  try {
    const attemptId = validId(req.params.attemptId);
    if (!attemptId) return res.status(400).json({ error: "Invalid attempt." });
    const attemptResult = await pool.query(`
      SELECT * FROM student_exam_attempts WHERE id=$1 AND user_id=$2
    `, [attemptId, getUserId(req)]);
    if (!attemptResult.rowCount || !attemptResult.rows[0].submitted_at)
      return res.status(404).json({ error: "Result not found." });
    const attempt = attemptResult.rows[0];
    const release = Date.parse(attempt.submitted_at) + 12 * 3600000;
    if (Date.now() < release || !attempt.grading_complete)
      return res.status(403).json({ error: "Your result is not released yet." });

    const paperResult = await pool.query(
      "SELECT * FROM student_exam_papers WHERE id=$1", [attempt.paper_id]
    );
    const questions = await pool.query(`
      SELECT id,question,options_json,correct_option,marks,explanation
      FROM student_exam_questions WHERE paper_id=$1 ORDER BY id
    `, [attempt.paper_id]);
    const answers = parseJson(attempt.answers_json);
    res.json({
      title: paperResult.rows[0].title,
      score: attempt.score,
      totalMarks: paperResult.rows[0].total_marks,
      submittedAt: attempt.submitted_at,
      questions: questions.rows.map(q => ({
        question: q.question,
        options: parseJson(q.options_json),
        selected: answers[q.id] || null,
        correct: q.correct_option,
        marks: q.marks,
        explanation: q.explanation
      }))
    });
  } catch (error) { next(error); }
});

module.exports = router;
