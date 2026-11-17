const express = require("express");
const bcrypt = require("bcryptjs");
const pool = require("../database/postgres");

const router = express.Router();

router.post("/register", async (req, res, next) => {
  let client;
  let transactionStarted = false;

  try {
    const { name, email, password } = req.body;

    if (
      typeof name !== "string" ||
      typeof email !== "string" ||
      typeof password !== "string"
    ) {
      return res.status(400).json({ error: "Please enter valid details." });
    }

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();

    if (cleanName.length < 2 || cleanName.length > 60) {
      return res.status(400).json({ error: "Name must be 2–60 characters." });
    }

    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) {
      return res.status(400).json({ error: "Enter a valid email address." });
    }

    if (password.length < 12 || password.length > 72) {
      return res.status(400).json({
        error: "Password must be 12–72 characters long."
      });
    }

    const passwordHash = await bcrypt.hash(password, 12);

    client = await pool.connect();
    await client.query("BEGIN");
    transactionStarted = true;

    const existing = await client.query(
      "SELECT id FROM users WHERE email = $1",
      [cleanEmail]
    );

    if (existing.rowCount > 0) {
      await client.query("ROLLBACK");
      transactionStarted = false;

      return res.status(409).json({
        error: "An account with this email already exists."
      });
    }

    const sequenceResult = await client.query(
      "SELECT next_value FROM candidate_sequence WHERE id = 1 FOR UPDATE"
    );

    if (
      sequenceResult.rowCount === 0 ||
      sequenceResult.rows[0].next_value > 2574
    ) {
      throw new Error(
        "All candidate numbers for batch 2026-27 have been allocated."
      );
    }

    const number = sequenceResult.rows[0].next_value;
    const letters = "MNOPQRSTUVWXYZABCDEFGHIJKL";
    const letter = letters[Math.floor((number - 1) / 99)];
    const serial = ((number - 1) % 99) + 1;
    const candidateNo = `${letter}2027${String(serial).padStart(2, "0")}`;

    const inserted = await client.query(
      `INSERT INTO users (name, email, password_hash, candidate_no)
       VALUES ($1, $2, $3, $4)
       RETURNING id`,
      [cleanName, cleanEmail, passwordHash, candidateNo]
    );

    const userId = inserted.rows[0].id;

    await client.query(
      "UPDATE candidate_sequence SET next_value = $1 WHERE id = 1",
      [number + 1]
    );

    await client.query("COMMIT");
    transactionStarted = false;

    return res.status(201).json({
      message: "itexamportal account created successfully.",
      candidateNo,
      userId
    });

  } catch (error) {
    if (transactionStarted && client) {
      await client.query("ROLLBACK").catch(() => {});
    }

    if (error.code === "23505") {
      return res.status(409).json({
        error: "This email or candidate number is already registered."
      });
    }

    next(error);
  } finally {
    if (client) client.release();
  }
});

router.post("/login", async (req, res, next) => {
  try {
    const { email, password } = req.body;

    if (typeof email !== "string" || typeof password !== "string") {
      return res.status(400).json({
        error: "Enter your email and password."
      });
    }

    const result = await pool.query(
      `SELECT id, name, email, password_hash, role, candidate_no
       FROM users
       WHERE email = $1`,
      [email.trim().toLowerCase()]
    );

    const user = result.rows[0];

    if (!user || !(await bcrypt.compare(password, user.password_hash))) {
      return res.status(401).json({
        error: "Incorrect email or password."
      });
    }

    req.session.regenerate((error) => {
      if (error) return next(error);

      req.session.userId = user.id;
      req.session.role = user.role;

      req.session.save((saveError) => {
        if (saveError) return next(saveError);

        res.json({
          message: "Login successful.",
          user: {
            id: user.id,
            name: user.name,
            email: user.email,
            role: user.role,
            candidateNo: user.candidate_no
          }
        });
      });
    });

  } catch (error) {
    next(error);
  }
});

router.get("/me", async (req, res, next) => {
  try {
    if (!req.session || !req.session.userId) {
      return res.status(401).json({ error: "Please log in first." });
    }

    const result = await pool.query(
      `SELECT id, name, email, role, candidate_no, created_at
       FROM users
       WHERE id = $1`,
      [req.session.userId]
    );

    const user = result.rows[0];

    if (!user) {
      return res.status(401).json({ error: "Account not found." });
    }

    res.json({ user });

  } catch (error) {
    next(error);
  }
});

router.post("/logout", (req, res, next) => {
  if (!req.session) {
    return res.status(401).json({ error: "Please log in first." });
  }

  req.session.destroy((error) => {
    if (error) return next(error);

    res.clearCookie("itexamportal.sid");
    res.json({ message: "Logged out successfully." });
  });
});

module.exports = router;

