require("dotenv").config();

const express = require("express");
const session = require("express-session");
const PgSession = require("connect-pg-simple")(session);
const pool = require("./database/postgres");
const path = require("path");
const helmet = require("helmet");
const rateLimit = require("express-rate-limit");

const authRoutes = require("./routes/authRoutes");
const examRoutes = require("./routes/examRoutes");
const practiceRoutes = require("./routes/practiceRoutes");
const materialRoutes = require("./routes/materialRoutes");
const adminRoutes = require("./routes/adminRoutes");
const secureAdminRoutes = require("./routes/secureAdminRoutes");

if (!process.env.SESSION_SECRET ||
    process.env.SESSION_SECRET === "REPLACE_WITH_A_LONG_RANDOM_SECRET" ||
    process.env.SESSION_SECRET.length < 32) {
  throw new Error("Set a random SESSION_SECRET of at least 32 characters.");
}

const app = express();
if (process.env.NODE_ENV === "production") app.set("trust proxy", 1);
app.disable("x-powered-by");
app.use(helmet());
app.use(express.json({ limit: "20kb" }));
app.use(express.urlencoded({ extended: false, limit: "20kb" }));

app.use(session({
  name: "itexamportal.sid",
  store: new PgSession({
    pool,
    tableName: "user_sessions",
    createTableIfMissing: true,
    pruneSessionInterval: 15 * 60
  }),
  secret: process.env.SESSION_SECRET,
  resave: false,
  saveUninitialized: false,
  cookie: {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    maxAge: 4 * 60 * 60 * 1000
  }
}));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 10,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  skip: req => req.method !== "POST" ||
    !["/login", "/register"].includes(req.path),
  message: { error: "Too many login or registration attempts. Please try again later." }
});

app.use("/api/auth", authLimiter);
app.use("/api/auth", authRoutes);
app.use("/api/exams", examRoutes);
app.use("/api/practice", practiceRoutes);
app.use("/api/materials", materialRoutes);
app.use("/api/admin", adminRoutes);
app.use("/api/admin-control", secureAdminRoutes);
app.use(express.static(path.join(__dirname, "dist")));

app.get("/api/health", async (req,res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "ok", portal: "itexamportal", database: "connected" });
  } catch (error) {
    res.status(503).json({ status: "error", database: "unavailable" });
  }
});

app.use((req,res) => res.status(404).json({ error: "Page or API route not found." }));
app.use((err,req,res,next) => {
  console.error("Server error:", err.message);
  res.status(500).json({ error: "Something went wrong on the server." });
});

const PORT = process.env.PORT || 3000;
const server = app.listen(PORT, () => console.log(`itexamportal running on port ${PORT}`));

async function shutdown() {
  server.close(async () => {
    await pool.end().catch(() => {});
    process.exit(0);
  });
}
process.on("SIGTERM", shutdown);
process.on("SIGINT", shutdown);

