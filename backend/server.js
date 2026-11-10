import { randomBytes, randomInt, createHash, createHmac, timingSafeEqual } from "node:crypto";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import bcrypt from "bcryptjs";
import express from "express";
import { rateLimit } from "express-rate-limit";
import mysql from "mysql2/promise";
import nodemailer from "nodemailer";
import { registerSettingsRoutes } from "./settings.js";
import { registerCloudRoutes } from "./cloudRoutes.js";
import { registerGcpRoutes } from "./gcpConnection.js";
import { registerGcpTerraformRoutes } from "./gcpTerraformRoutes.js";
import { registerAzureRoutes, revokeAzureDelegation } from "./azureConnection.js";
import { registerAzureTerraformRoutes } from "./azureTerraformRoutes.js";
import { registerSimulatedCloudRoutes } from "./simulatedCloudRoutes.js";
import { initializeDatabaseSchema } from "./schemaBootstrap.js";

const here = dirname(fileURLToPath(import.meta.url));
const isProduction = process.env.NODE_ENV === "production";
const sessionSecret = process.env.SESSION_SECRET || "local-development-only-change-this-secret";
const sessionCookie = "omnicloud_session";
// Keep sessions across browser restarts; logout explicitly revokes the stored token.
const sessionLifetimeMs = 2_147_483_647 * 1000;
const codeLifetimeMs = Math.max(1, Number(process.env.EMAIL_CODE_TTL_MINUTES || 10)) * 60 * 1000;

if (isProduction && sessionSecret.length < 32) {
  throw new Error("SESSION_SECRET must contain at least 32 characters in production.");
}

const pool = mysql.createPool({
  host: process.env.MYSQL_HOST || "127.0.0.1",
  port: Number(process.env.MYSQL_PORT || 3306),
  user: process.env.MYSQL_USER || "root",
  password: process.env.MYSQL_PASSWORD || "",
  database: process.env.MYSQL_DATABASE || "omnicloud_auth",
  ...(String(process.env.MYSQL_SSL || "false").toLowerCase() === "true" ? { ssl: { rejectUnauthorized: true } } : {}),
  waitForConnections: true,
  connectionLimit: 10,
  queueLimit: 0,
  charset: "utf8mb4",
});

const pendingRegistrations = new Map();

const gmailUser = process.env.GMAIL_USER?.trim() || "";
const gmailAppPassword = process.env.GMAIL_APP_PASSWORD?.replace(/\s/g, "") || "";
const mailer = gmailUser && gmailAppPassword && !gmailAppPassword.includes("replace_me")
  ? nodemailer.createTransport({
      service: "gmail",
      auth: { user: gmailUser, pass: gmailAppPassword },
      // Keep auth requests inside the hosting platform's HTTP request window
      // when Gmail SMTP is unreachable or the credential is rejected.
      connectionTimeout: 10_000,
      greetingTimeout: 10_000,
      socketTimeout: 15_000,
    })
  : null;

const app = express();
app.disable("x-powered-by");
if (isProduction) app.set("trust proxy", 1);
app.use((_req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  next();
});
app.use(express.json({ limit: "12kb" }));

const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: 20,
  standardHeaders: "draft-8",
  legacyHeaders: false,
  message: { message: "Too many attempts. Please wait a few minutes and try again." },
});

function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

function validEmail(email) {
  return email.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function normalizeMobile(value) {
  return typeof value === "string" ? value.trim().replace(/[\s().-]/g, "") : "";
}

function validName(name) {
  return typeof name === "string" && name.trim().length >= 2 &&
    name.trim().length <= 120 && !/[\u0000-\u001f]/.test(name);
}

function validMobile(mobile) {
  return /^\+?[1-9]\d{6,14}$/.test(mobile);
}

function passwordProblem(password) {
  if (typeof password !== "string") return "Enter a password.";
  if (password.length < 12) return "Use at least 12 characters.";
  if (Buffer.byteLength(password, "utf8") > 72) return "Password must be 72 bytes or fewer.";
  if (!/[a-z]/.test(password)) return "Add at least one lowercase letter.";
  if (!/[A-Z]/.test(password)) return "Add at least one uppercase letter.";
  if (!/[0-9]/.test(password)) return "Add at least one number.";
  if (!/[^A-Za-z0-9]/.test(password)) return "Add at least one symbol.";
  return "";
}

function codeDigest(email, purpose, code) {
  return createHmac("sha256", sessionSecret)
    .update(email + ":" + purpose + ":" + code)
    .digest("hex");
}

function escapeHtml(value) {
  return String(value || "").replace(/[&<>"']/g, (character) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", "\"": "&quot;", "'": "&#39;",
  })[character]);
}

async function sendCode(email, purpose, code, recipientName = "") {
  const subjects = {
    verify: "Verify your OmniCloud email",
    reset: "Your OmniCloud password reset code",
  };
  const isVerification = purpose === "verify";
  const action = isVerification ? "verify your email address" : "reset your password";
  const heading = isVerification ? "Verify your email" : "Reset your password";
  const greeting = recipientName ? "Hi " + escapeHtml(recipientName) + "," : "Hello,";
  const expiryMinutes = codeLifetimeMs / 60000;

  if (!mailer) {
    if (isProduction) throw new Error("GMAIL_USER or GMAIL_APP_PASSWORD is not configured.");
    console.info("[OmniCloud development email] " + email + " — " + subjects[purpose] + ": " + code);
    return;
  }

  await mailer.sendMail({
    from: "OmniCloud <" + gmailUser + ">",
    to: email,
    subject: subjects[purpose],
    text: "OmniCloud — " + heading + "\n\n" + greeting + "\n\nYour verification code is " + code + ".\n\n" +
      "This code expires in " + expiryMinutes + " minutes. If you didn’t request this, you can ignore this email.\n\n" +
      "OmniCloud · Multi-cloud infrastructure workspace",
    html: "<!doctype html><html><body style=\"margin:0;padding:0;background:#f3f7fc;font-family:Arial,Helvetica,sans-serif;color:#172b45\">" +
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"background:#f3f7fc;padding:32px 12px\"><tr><td align=\"center\">" +
      "<table role=\"presentation\" width=\"100%\" cellspacing=\"0\" cellpadding=\"0\" style=\"max-width:560px;background:#ffffff;border:1px solid #e3ebf5;border-radius:18px;overflow:hidden\">" +
      "<tr><td style=\"padding:24px 30px;border-bottom:1px solid #edf2f8\"><table role=\"presentation\" cellspacing=\"0\" cellpadding=\"0\"><tr>" +
      "<td style=\"width:42px;height:42px;text-align:center;vertical-align:middle;border:1px solid #d6e7ff;border-radius:12px;background:#eff6ff;color:#1769d2;font-size:24px\">☁</td>" +
      "<td style=\"padding-left:11px;font-size:23px;font-weight:700;letter-spacing:-.7px;color:#15263e\">Omni<span style=\"color:#1769d2\">Cloud</span></td>" +
      "</tr></table><div style=\"margin-top:8px;color:#71839a;font-size:11px;letter-spacing:1.1px\">MULTI-CLOUD INFRASTRUCTURE WORKSPACE</div></td></tr>" +
      "<tr><td style=\"padding:32px 30px 28px\"><p style=\"margin:0 0 10px;color:#536983;font-size:15px\">" + greeting + "</p>" +
      "<h1 style=\"margin:0 0 10px;font-size:25px;line-height:1.25;color:#15263e\">" + heading + "</h1>" +
      "<p style=\"margin:0 0 22px;color:#61748c;font-size:15px;line-height:1.7\">Use the secure code below to " + action + ".</p>" +
      "<div style=\"padding:18px 12px;border:1px solid #dceafe;border-radius:12px;background:#f4f8ff;text-align:center\">" +
      "<div style=\"margin-bottom:7px;color:#61748c;font-size:11px;font-weight:700;letter-spacing:1px\">YOUR ONE-TIME CODE</div>" +
      "<div style=\"font-size:34px;line-height:1.25;font-weight:700;letter-spacing:9px;color:#1769d2\">" + code + "</div></div>" +
      "<p style=\"margin:20px 0 0;color:#61748c;font-size:13px;line-height:1.7\">This code expires in " + expiryMinutes +
      " minutes and can only be used once. OmniCloud will never ask you to share this code.</p>" +
      "<p style=\"margin:16px 0 0;color:#61748c;font-size:13px;line-height:1.7\">If you didn’t request this, you can safely ignore this email.</p></td></tr>" +
      "<tr><td style=\"padding:18px 30px;border-top:1px solid #edf2f8;background:#fbfcfe;color:#8292a6;font-size:11px;line-height:1.6\">" +
      "OmniCloud · One control plane for every cloud<br>This is an automated account-security email.</td></tr></table>" +
      "</td></tr></table></body></html>",
  });
}

async function issueCode(email, purpose, recipientName = "") {
  const now = Date.now();
  const connection = await pool.getConnection();
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const digest = codeDigest(email, purpose, code);

  try {
    await connection.beginTransaction();
    const [existing] = await connection.execute(
      "SELECT last_sent_at FROM verification_codes WHERE email = ? AND purpose = ? FOR UPDATE",
      [email, purpose],
    );
    if (existing.length && now - Number(existing[0].last_sent_at) < 60_000) {
      const error = new Error("Please wait a minute before requesting another code.");
      error.status = 429;
      throw error;
    }
    await connection.execute(
      "INSERT INTO verification_codes (email, purpose, code_hash, expires_at, attempts, last_sent_at) " +
      "VALUES (?, ?, ?, ?, 0, ?) ON DUPLICATE KEY UPDATE code_hash = VALUES(code_hash), " +
      "expires_at = VALUES(expires_at), attempts = 0, last_sent_at = VALUES(last_sent_at)",
      [email, purpose, digest, now + codeLifetimeMs, now],
    );
    await connection.commit();
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }

  try {
    await sendCode(email, purpose, code, recipientName);
  } catch (error) {
    await pool.execute(
      "DELETE FROM verification_codes WHERE email = ? AND purpose = ? AND code_hash = ?",
      [email, purpose, digest],
    );
    throw error;
  }
}

async function issuePendingRegistrationCode(email, registration) {
  const previous = pendingRegistrations.get(email);
  const now = Date.now();
  if (previous && now - previous.lastSentAt < 60_000) {
    const error = new Error("Please wait a minute before requesting another code.");
    error.status = 429;
    throw error;
  }

  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const pending = {
    ...registration,
    codeHash: codeDigest(email, "verify", code),
    expiresAt: now + codeLifetimeMs,
    attempts: 0,
    lastSentAt: now,
  };
  await sendCode(email, "verify", code, registration.name);
  pendingRegistrations.set(email, pending);
}

function checkPendingRegistrationCode(email, submittedCode) {
  const pending = pendingRegistrations.get(email);
  if (!pending || pending.expiresAt < Date.now()) {
    pendingRegistrations.delete(email);
    return { ok: false, message: "That code has expired. Register again to get a new one." };
  }
  if (typeof submittedCode !== "string" || !/^\d{6}$/.test(submittedCode)) {
    return { ok: false, message: "Enter the 6-digit code." };
  }
  if (pending.attempts >= 5) {
    pendingRegistrations.delete(email);
    return { ok: false, message: "Too many incorrect attempts. Register again to get a new code." };
  }

  const expected = Buffer.from(pending.codeHash, "hex");
  const actual = Buffer.from(codeDigest(email, "verify", submittedCode), "hex");
  if (!timingSafeEqual(expected, actual)) {
    pending.attempts += 1;
    if (pending.attempts >= 5) pendingRegistrations.delete(email);
    return { ok: false, message: "That code is incorrect." };
  }
  return { ok: true, registration: pending };
}

const pendingRegistrationCleanup = setInterval(() => {
  const now = Date.now();
  for (const [email, pending] of pendingRegistrations) {
    if (pending.expiresAt < now) pendingRegistrations.delete(email);
  }
}, 60_000);
pendingRegistrationCleanup.unref();

async function consumeCode(email, purpose, submittedCode) {
  if (typeof submittedCode !== "string" || !/^\d{6}$/.test(submittedCode)) {
    return { ok: false, message: "Enter the 6-digit code." };
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();
    const [rows] = await connection.execute(
      "SELECT code_hash, expires_at, attempts FROM verification_codes " +
      "WHERE email = ? AND purpose = ? FOR UPDATE",
      [email, purpose],
    );
    const saved = rows[0];
    if (!saved || Number(saved.expires_at) < Date.now()) {
      await connection.execute(
        "DELETE FROM verification_codes WHERE email = ? AND purpose = ?",
        [email, purpose],
      );
      await connection.commit();
      return { ok: false, message: "That code has expired. Request a new one." };
    }
    if (Number(saved.attempts) >= 5) {
      await connection.execute(
        "DELETE FROM verification_codes WHERE email = ? AND purpose = ?",
        [email, purpose],
      );
      await connection.commit();
      return { ok: false, message: "Too many incorrect attempts. Request a new code." };
    }

    const expected = Buffer.from(saved.code_hash, "hex");
    const actual = Buffer.from(codeDigest(email, purpose, submittedCode), "hex");
    if (!timingSafeEqual(expected, actual)) {
      await connection.execute(
        "UPDATE verification_codes SET attempts = attempts + 1 WHERE email = ? AND purpose = ?",
        [email, purpose],
      );
      await connection.commit();
      return { ok: false, message: "That code is incorrect." };
    }
    await connection.execute(
      "DELETE FROM verification_codes WHERE email = ? AND purpose = ?",
      [email, purpose],
    );
    await connection.commit();
    return { ok: true };
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
  }
}

function hashSession(token) {
  return createHash("sha256").update(token).digest("hex");
}

function setSessionCookie(res, token, maxAgeSeconds) {
  const secure = isProduction ? "; Secure" : "";
  res.setHeader(
    "Set-Cookie",
    sessionCookie + "=" + token + "; Path=/; HttpOnly; SameSite=Lax; Max-Age=" + maxAgeSeconds + secure,
  );
}

async function createSession(res, userId) {
  const token = randomBytes(32).toString("hex");
  const now = Date.now();
  await pool.execute(
    "INSERT INTO sessions (token_hash, user_id, expires_at, created_at) VALUES (?, ?, ?, ?)",
    [hashSession(token), userId, now + sessionLifetimeMs, now],
  );
  setSessionCookie(res, token, Math.floor(sessionLifetimeMs / 1000));
}

function cookieValue(req, name) {
  const pair = (req.headers.cookie || "").split(";").map((item) => item.trim())
    .find((item) => item.startsWith(name + "="));
  return pair ? pair.slice(name.length + 1) : "";
}

async function requireUser(req, res, next) {
  try {
    const token = cookieValue(req, sessionCookie);
    if (!token) return res.status(401).json({ message: "Please sign in." });
    const [rows] = await pool.execute(
      "SELECT users.id, users.email, users.name, users.mobile_number, sessions.expires_at " +
      "FROM sessions JOIN users ON users.id = sessions.user_id WHERE sessions.token_hash = ?",
      [hashSession(token)],
    );
    const session = rows[0];
    if (!session || Number(session.expires_at) < Date.now()) {
      if (session) await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [hashSession(token)]);
      return res.status(401).json({ message: "Your session has expired. Please sign in again." });
    }
    req.user = {
      id: session.id,
      email: session.email,
      name: session.name,
      mobileNumber: session.mobile_number,
    };
    return next();
  } catch (error) {
    return next(error);
  }
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

app.get("/api/health", (_req, res) => res.json({ status: "ok" }));

app.post("/api/auth/register", authLimiter, asyncRoute(async (req, res) => {
  const name = typeof req.body?.name === "string" ? req.body.name.trim() : "";
  const mobile = normalizeMobile(req.body?.mobile);
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!validName(name)) return res.status(400).json({ message: "Enter your name (2–120 characters)." });
  if (!validMobile(mobile)) return res.status(400).json({ message: "Enter a mobile number with country code (7–15 digits)." });
  if (!validEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ message: problem });

  const [existingRows] = await pool.execute(
    "SELECT id, verified_at FROM users WHERE email = ?",
    [email],
  );
  if (existingRows[0]?.verified_at) {
    return res.status(409).json({ message: "An account already uses this email. Sign in instead." });
  }
  const [mobileRows] = await pool.execute("SELECT id FROM users WHERE mobile_number = ? LIMIT 1", [mobile]);
  if (mobileRows.length) return res.status(409).json({ message: "That mobile number is already registered." });
  for (const [pendingEmail, pending] of pendingRegistrations) {
    if (pendingEmail !== email && pending.registration.mobile === mobile) {
      return res.status(409).json({ message: "That mobile number is already being used for registration." });
    }
  }
  const passwordHash = await bcrypt.hash(password, 12);
  try {
    await issuePendingRegistrationCode(email, { name, mobile, passwordHash });
  } catch (error) {
    console.error("Registration verification email failed:", error.code || error.name || "SMTP_ERROR");
    return res.status(error.status || 503).json({
      message: error.status ? error.message
        : "We couldn’t send the verification email. Check MySQL and Gmail settings, then try again.",
    });
  }
  return res.status(201).json({ message: "Verification code sent." });
}));

app.post("/api/auth/verify-email", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  if (!validEmail(email)) return res.status(400).json({ message: "The verification details are invalid." });
  const result = await checkPendingRegistrationCode(email, req.body?.code);
  if (!result.ok) return res.status(400).json({ message: result.message });
  const registration = result.registration;
  let connection;
  try {
    connection = await pool.getConnection();
    await connection.beginTransaction();
    const [insert] = await connection.execute(
      "INSERT INTO users (name, mobile_number, email, password_hash, verified_at, created_at) VALUES (?, ?, ?, ?, ?, ?)",
      [registration.name, registration.mobile, email, registration.passwordHash, Date.now(), Date.now()],
    );
    await connection.commit();
    pendingRegistrations.delete(email);
    await createSession(res, insert.insertId);
  } catch (error) {
    if (connection) await connection.rollback();
    if (error.code === "ER_DUP_ENTRY") {
      return res.status(409).json({ message: "That email or mobile number is already registered. Please sign in." });
    }
    throw error;
  } finally {
    connection?.release();
  }
  return res.json({ message: "Email verified." });
}));

app.post("/api/auth/resend-verification", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const pending = validEmail(email) ? pendingRegistrations.get(email) : null;
  if (pending) {
    try {
      await issuePendingRegistrationCode(email, pending.registration);
    } catch (error) {
      console.error("Verification email resend failed:", error.code || error.name || "SMTP_ERROR");
      return res.status(error.status || 503).json({
        message: error.status ? error.message : "We couldn’t send the email. Try again later.",
      });
    }
  }
  return res.json({ message: "If the account is waiting for verification, a fresh code has been sent." });
}));

app.post("/api/auth/login", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const password = req.body?.password;
  if (!validEmail(email) || typeof password !== "string") {
    return res.status(400).json({ message: "Enter your email and password." });
  }
  const [rows] = await pool.execute(
    "SELECT id, email, name, mobile_number, password_hash, verified_at FROM users WHERE email = ?",
    [email],
  );
  const user = rows[0];
  if (!user) {
    const pending = pendingRegistrations.get(email);
    const matchesPending = pending ? await bcrypt.compare(password, pending.registration.passwordHash) : false;
    if (matchesPending) {
      return res.status(403).json({ code: "EMAIL_NOT_VERIFIED", message: "Verify your email to finish signing in." });
    }
    return res.status(401).json({ message: "Email or password is incorrect." });
  }
  const matches = await bcrypt.compare(password, user.password_hash);
  if (!matches) return res.status(401).json({ message: "Email or password is incorrect." });
  if (!user.verified_at) {
    return res.status(403).json({
      code: "EMAIL_NOT_VERIFIED",
      message: "Verify your email to finish signing in.",
    });
  }
  await createSession(res, user.id);
  return res.json({ user: { email: user.email, name: user.name, mobileNumber: user.mobile_number } });
}));

app.post("/api/auth/forgot-password", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const [rows] = validEmail(email)
    ? await pool.execute("SELECT name, verified_at FROM users WHERE email = ?", [email])
    : [[]];
  const user = rows[0];
  if (user?.verified_at) {
    try {
      await issueCode(email, "reset", user.name);
    } catch (error) {
      console.error("Unable to send reset email:", error.message);
    }
  }
  return res.json({ message: "If an account uses this email, a reset code is on its way." });
}));

app.post("/api/auth/reset-password", authLimiter, asyncRoute(async (req, res) => {
  const email = normalizeEmail(req.body?.email);
  const { code, password } = req.body || {};
  if (!validEmail(email)) return res.status(400).json({ message: "Enter a valid email address." });
  const problem = passwordProblem(password);
  if (problem) return res.status(400).json({ message: problem });
  const [rows] = await pool.execute("SELECT id, verified_at FROM users WHERE email = ?", [email]);
  const user = rows[0];
  if (!user || !user.verified_at) {
    return res.status(400).json({ message: "The reset details are invalid or expired." });
  }
  const result = await consumeCode(email, "reset", code);
  if (!result.ok) return res.status(400).json({ message: result.message });
  const passwordHash = await bcrypt.hash(password, 12);
  await pool.execute("UPDATE users SET password_hash = ? WHERE id = ?", [passwordHash, user.id]);
  await pool.execute("DELETE FROM sessions WHERE user_id = ?", [user.id]);
  return res.json({ message: "Password updated." });
}));

app.get("/api/auth/me", requireUser, (req, res) => res.json({
  user: {
    email: req.user.email,
    name: req.user.name,
    mobileNumber: req.user.mobileNumber,
  },
}));

app.post("/api/auth/logout", asyncRoute(async (req, res) => {
  const token = cookieValue(req, sessionCookie);
  if (token) await pool.execute("DELETE FROM sessions WHERE token_hash = ?", [hashSession(token)]);
  setSessionCookie(res, "", 0);
  return res.json({ message: "Signed out." });
}));

registerSettingsRoutes(app, { pool, requireUser });
registerCloudRoutes(app, { pool, requireUser, disconnectAzure: revokeAzureDelegation });
registerSimulatedCloudRoutes(app, { pool, requireUser });
registerGcpRoutes(app, { pool, requireUser });
registerGcpTerraformRoutes(app, { pool, requireUser });
registerAzureRoutes(app, { pool, requireUser });
registerAzureTerraformRoutes(app, { pool, requireUser });
app.use("/api", (_req, res) => res.status(404).json({ message: "API route not found." }));

if (String(process.env.SERVE_FRONTEND || "true").toLowerCase() !== "false") {
  const frontendDist = resolve(here, "../frontend/omnicloud/dist");
  app.use(express.static(frontendDist));
  app.use((req, res, next) => {
    if (req.method !== "GET") return next();
    return res.sendFile(resolve(frontendDist, "index.html"), (error) => {
      if (error) next(error);
    });
  });
}

app.use((error, _req, res, _next) => {
  console.error(error);
  if (res.headersSent) return;
  const status = Number.isInteger(error.status) ? error.status : 500;
  return res.status(status).json({
    message: status === 500 ? "Something went wrong. Please try again." : error.message,
  });
});

const staleTime = Date.now();
const port = Number(process.env.PORT || 3001);
const host = process.env.HOST || (isProduction ? "0.0.0.0" : "127.0.0.1");

async function start() {
  try {
    await initializeDatabaseSchema();
    console.info("Database schema initialized from backend/schema.sql.");
    await pool.execute("SELECT 1");
    await pool.execute("SELECT id FROM users LIMIT 0");
    await pool.execute("SELECT email FROM verification_codes LIMIT 0");
    await pool.execute("SELECT token_hash FROM sessions LIMIT 0");
    await pool.execute("DELETE FROM sessions WHERE expires_at < ?", [staleTime]);
    await pool.execute("DELETE FROM verification_codes WHERE expires_at < ?", [staleTime]);
    await pool.execute("DELETE FROM verification_codes WHERE purpose = 'verify'");
    await pool.execute("DELETE FROM users WHERE verified_at IS NULL");
  } catch (error) {
    console.error("Could not connect to the OmniCloud MySQL database.");
    console.error("The backend initializes backend/schema.sql automatically. Check that MySQL is running, the configured database credentials can create databases and tables, and MYSQL_HOST, MYSQL_USER, MYSQL_PASSWORD, and MYSQL_DATABASE are correct in backend/.env.");
    console.error(error.message);
    await pool.end();
    process.exitCode = 1;
    return;
  }

  app.listen(port, host, () => {
    console.info("OmniCloud authentication backend listening on http://localhost:" + port);
    if (!mailer && !isProduction) {
      console.info("Gmail SMTP is not configured; verification codes will be printed in this terminal for local development.");
    }
  });
}

start();

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, async () => {
    await pool.end();
    process.exit(0);
  });
}
