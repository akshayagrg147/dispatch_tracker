import "dotenv/config";
import express from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import pg from "pg";
import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { decidePatch, makeAdapters } from "./server/tracking.mjs";

const { Pool } = pg;
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const app = express();
const port = Number(process.env.PORT || 8000);
const cookieName = "dispatch_session";
const jwtSecret = process.env.JWT_SECRET || "";
const cookieSecure = process.env.COOKIE_SECURE === "true" || process.env.NODE_ENV === "production";
const pgSsl = process.env.PGSSL === "true"
  ? {
      rejectUnauthorized: process.env.PGSSL_REJECT_UNAUTHORIZED !== "false",
      ...(process.env.PGSSL_CA_PATH ? { ca: fs.readFileSync(process.env.PGSSL_CA_PATH, "utf8") } : {}),
    }
  : false;

const pool = process.env.DATABASE_URL
  ? new Pool({
      connectionString: process.env.DATABASE_URL,
      ssl: pgSsl,
      max: Number(process.env.PG_POOL_MAX || 10),
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    })
  : null;

app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));

function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map(part => {
    const i = part.indexOf("=");
    return i < 0 ? ["", ""] : [part.slice(0, i).trim(), decodeURIComponent(part.slice(i + 1).trim())];
  }).filter(([key]) => key));
}

function setSession(res, userId) {
  if (!jwtSecret) throw new Error("JWT_SECRET is not configured.");
  const token = jwt.sign({ sub: userId }, jwtSecret, { expiresIn: "7d" });
  const attributes = [`${cookieName}=${encodeURIComponent(token)}`, "Path=/", "HttpOnly", "SameSite=Lax", `Max-Age=${7 * 24 * 60 * 60}`];
  if (cookieSecure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function clearSession(res) {
  const attributes = [`${cookieName}=`, "Path=/", "HttpOnly", "SameSite=Lax", "Max-Age=0"];
  if (cookieSecure) attributes.push("Secure");
  res.setHeader("Set-Cookie", attributes.join("; "));
}

function requireDb(req, res, next) {
  if (!pool) return res.status(503).json({ message: "AWS PostgreSQL is not configured. Add DATABASE_URL to .env." });
  next();
}

async function findUserById(id) {
  const result = await pool.query(
    `select u.id, u.email, p.full_name, p.role
       from users u join profiles p on p.id = u.id
      where u.id = $1 and u.active = true and p.active = true`,
    [id],
  );
  return result.rows[0] || null;
}

async function authenticate(req, res, next) {
  if (!pool) return res.status(503).json({ message: "AWS PostgreSQL is not configured. Add DATABASE_URL to .env." });
  const cookies = parseCookies(req.headers.cookie);
  const bearer = req.headers.authorization?.startsWith("Bearer ") ? req.headers.authorization.slice(7) : null;
  const token = cookies[cookieName] || bearer;
  if (!token || !jwtSecret) return res.status(401).json({ message: "Please sign in again.", code: "unauthorized" });
  try {
    const payload = jwt.verify(token, jwtSecret);
    const user = await findUserById(payload.sub);
    if (!user) return res.status(401).json({ message: "This account is inactive.", code: "unauthorized" });
    req.user = user;
    next();
  } catch {
    return res.status(401).json({ message: "Please sign in again.", code: "unauthorized" });
  }
}

function requireAdmin(req, res, next) {
  if (req.user?.role !== "admin") return res.status(403).json({ message: "Your account is not allowed to do that.", code: "forbidden" });
  next();
}

function handleError(res, error) {
  console.error(error);
  if (error?.code === "23505") return res.status(409).json({ message: "That value already exists.", code: error.code });
  if (["23502", "23514", "22P02"].includes(error?.code)) return res.status(400).json({ message: "One of the values is invalid.", code: error.code });
  return res.status(500).json({ message: "The server could not complete that request." });
}

const orderFields = [
  "order_date", "inv_no", "inv_date", "party", "pincode", "area", "state_name", "contact", "gstin",
  "telecaller", "transport", "docket", "dispatch_date", "cases", "weight", "freight", "freight_mode",
  "amount", "payment_status", "status", "delivery_date", "remarks",
];
const dateFields = new Set(["order_date", "inv_date", "dispatch_date", "delivery_date"]);
const textFields = new Set([
  "inv_no", "party", "pincode", "area", "state_name", "contact", "gstin", "telecaller", "transport",
  "docket", "freight_mode", "payment_status", "status", "remarks",
]);
const numericFields = new Set(["cases", "weight", "freight", "amount"]);

function cleanOrder(body, partial = false) {
  const output = {};
  for (const field of orderFields) {
    if (!Object.prototype.hasOwnProperty.call(body, field)) continue;
    const value = body[field];
    if (dateFields.has(field)) output[field] = value ? String(value) : null;
    else if (textFields.has(field)) output[field] = String(value ?? "").trim();
    else if (numericFields.has(field)) output[field] = value === "" || value == null ? (field === "cases" || field === "amount" ? 0 : null) : Number(value);
  }
  if (!partial) {
    output.inv_no ??= "";
    output.party ??= "";
    output.pincode ??= "";
    output.area ??= "";
    output.state_name ??= "";
    output.contact ??= "";
    output.gstin ??= "";
    output.telecaller ??= "";
    output.transport ??= "";
    output.docket ??= "";
    output.cases ??= 0;
    output.freight_mode ??= "Paid";
    output.amount ??= 0;
    output.payment_status ??= "Credit";
    output.status ??= "Dispatched";
    output.remarks ??= "";
  }
  if (output.pincode && !/^\d{6}$/.test(output.pincode)) {
    const error = new Error("A pincode is six digits, or leave it blank.");
    error.status = 400;
    throw error;
  }
  for (const field of numericFields) {
    if (field in output && output[field] !== null && !Number.isFinite(output[field])) {
      const error = new Error(`${field} must be a number.`);
      error.status = 400;
      throw error;
    }
  }
  return output;
}

function rowsOrderByDate() {
  return "order by dispatch_date desc nulls last, created_at desc";
}

async function updateOrderById(id, patch, userId = null) {
  const fields = Object.keys(patch);
  if (userId && !fields.includes("updated_by")) {
    patch.updated_by = userId;
    fields.push("updated_by");
  }
  const values = fields.map(field => patch[field]);
  const set = fields.map((field, i) => `${field} = $${i + 1}`).join(", ");
  const result = await pool.query(`update orders set ${set} where id = $${values.length + 1} returning *`, [...values, id]);
  return result.rows[0] || null;
}

/* ---------------- health and authentication ---------------- */
app.get("/api/health", async (req, res) => {
  if (!pool) return res.status(503).json({ ok: false, configured: false, message: "DATABASE_URL is not configured." });
  try {
    await pool.query("select 1");
    res.json({ ok: true, database: "postgresql" });
  } catch (error) {
    res.status(503).json({ ok: false, configured: true, message: "PostgreSQL is unreachable." });
  }
});

app.post("/api/auth/login", requireDb, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  if (!email || !password) return res.status(400).json({ message: "Email and password are required." });
  try {
    const result = await pool.query(
      `select u.id, u.email, u.password_hash, p.full_name, p.role
         from users u join profiles p on p.id = u.id
        where lower(u.email) = $1 and u.active = true and p.active = true`,
      [email],
    );
    const row = result.rows[0];
    if (!row || !(await bcrypt.compare(password, row.password_hash))) {
      return res.status(401).json({ message: "That email and password do not match.", code: "invalid_credentials" });
    }
    if (!jwtSecret) return res.status(503).json({ message: "JWT_SECRET is not configured on the server." });
    setSession(res, row.id);
    res.json({ user: { id: row.id, email: row.email, full_name: row.full_name, role: row.role } });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/auth/logout", (req, res) => {
  clearSession(res);
  res.json({ ok: true });
});

app.get("/api/auth/me", authenticate, (req, res) => res.json({ user: req.user }));

/* ---------------- register data ---------------- */
app.get("/api/bootstrap", authenticate, async (req, res) => {
  try {
    const [profiles, orders, telecallers, couriers] = await Promise.all([
      pool.query("select id, full_name, role from profiles where active = true order by full_name"),
      pool.query(`select * from orders ${rowsOrderByDate()}`),
      pool.query("select name from telecallers order by name"),
      pool.query("select transport_name, slug, trackable, track_url from couriers order by transport_name"),
    ]);
    res.json({ user: req.user, profiles: profiles.rows, orders: orders.rows, telecallers: telecallers.rows, couriers: couriers.rows });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/orders", authenticate, async (req, res) => {
  try {
    const result = await pool.query(`select * from orders ${rowsOrderByDate()}`);
    res.json({ orders: result.rows });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/orders", authenticate, async (req, res) => {
  try {
    const data = cleanOrder(req.body || {});
    if (!data.inv_no || !data.party) return res.status(400).json({ message: "Invoice number and party name are both needed." });
    const fields = [...Object.keys(data), "created_by", "updated_by"];
    const values = [...Object.values(data), req.user.id, req.user.id];
    const placeholders = values.map((_, i) => `$${i + 1}`).join(", ");
    const result = await pool.query(`insert into orders (${fields.join(", ")}) values (${placeholders}) returning *`, values);
    res.status(201).json({ order: result.rows[0] });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    handleError(res, error);
  }
});

app.patch("/api/orders/:id", authenticate, async (req, res) => {
  try {
    const data = cleanOrder(req.body || {}, true);
    if (Object.prototype.hasOwnProperty.call(data, "status")) data.status_source = "manual";
    const updated = await updateOrderById(req.params.id, data, req.user.id);
    if (!updated) return res.status(404).json({ message: "That entry was not found." });
    res.json({ order: updated });
  } catch (error) {
    if (error.status) return res.status(error.status).json({ message: error.message });
    handleError(res, error);
  }
});

app.delete("/api/orders/:id", authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("delete from orders where id = $1 returning id", [req.params.id]);
    if (!result.rowCount) return res.status(404).json({ message: "That entry was not found." });
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

/* ---------------- admin lists ---------------- */
app.get("/api/telecallers", authenticate, async (req, res) => {
  try {
    const result = await pool.query("select name from telecallers order by name");
    res.json({ telecallers: result.rows });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/telecallers", authenticate, requireAdmin, async (req, res) => {
  const name = String(req.body?.name || "").trim();
  if (!name) return res.status(400).json({ message: "A name is required." });
  try {
    const result = await pool.query("insert into telecallers (name) values ($1) returning name", [name]);
    res.status(201).json({ telecaller: result.rows[0] });
  } catch (error) {
    handleError(res, error);
  }
});

app.delete("/api/telecallers/:name", authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("delete from telecallers where name = $1 returning name", [req.params.name]);
    if (!result.rowCount) return res.status(404).json({ message: "That telecaller was not found." });
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

app.get("/api/couriers", authenticate, async (req, res) => {
  try {
    const result = await pool.query("select transport_name, slug, trackable, track_url from couriers order by transport_name");
    res.json({ couriers: result.rows });
  } catch (error) {
    handleError(res, error);
  }
});

app.post("/api/couriers", authenticate, requireAdmin, async (req, res) => {
  const transportName = String(req.body?.transport_name || "").trim();
  if (!transportName) return res.status(400).json({ message: "A transporter name is required." });
  try {
    const result = await pool.query(
      "insert into couriers (transport_name, slug, trackable, track_url) values ($1, $2, $3, $4) returning transport_name, slug, trackable, track_url",
      [transportName, String(req.body?.slug || "").trim(), req.body?.trackable !== false, String(req.body?.track_url || "").trim()],
    );
    res.status(201).json({ courier: result.rows[0] });
  } catch (error) {
    handleError(res, error);
  }
});

app.put("/api/couriers/:name", authenticate, requireAdmin, async (req, res) => {
  const patch = {};
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "trackable")) patch.trackable = Boolean(req.body.trackable);
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "slug")) patch.slug = String(req.body.slug || "").trim();
  if (Object.prototype.hasOwnProperty.call(req.body || {}, "track_url")) patch.track_url = String(req.body.track_url || "").trim();
  const fields = Object.keys(patch);
  if (!fields.length) return res.status(400).json({ message: "No transporter changes were supplied." });
  try {
    const values = fields.map(field => patch[field]);
    const set = fields.map((field, i) => `${field} = $${i + 1}`).join(", ");
    const result = await pool.query(`update couriers set ${set} where transport_name = $${values.length + 1} returning transport_name, slug, trackable, track_url`, [...values, req.params.name]);
    if (!result.rowCount) return res.status(404).json({ message: "That transporter was not found." });
    res.json({ courier: result.rows[0] });
  } catch (error) {
    handleError(res, error);
  }
});

app.delete("/api/couriers/:name", authenticate, requireAdmin, async (req, res) => {
  try {
    const result = await pool.query("delete from couriers where transport_name = $1 returning transport_name", [req.params.name]);
    if (!result.rowCount) return res.status(404).json({ message: "That transporter was not found." });
    res.json({ ok: true });
  } catch (error) {
    handleError(res, error);
  }
});

/* ---------------- optional courier tracking ---------------- */
const trackingProvider = (process.env.TRACK_PROVIDER || "aftership").toLowerCase() === "trackingmore" ? "trackingmore" : "aftership";
const trackingApiKey = process.env.TRACK_API_KEY || "";
const trackingBaseUrl = process.env.TRACK_BASE_URL || (trackingProvider === "trackingmore" ? "https://api.trackingmore.com/v4" : "https://api.aftership.com/tracking/2026-07");
const trackingAuthHeader = process.env.TRACK_AUTH_HEADER || (trackingProvider === "trackingmore" ? "Tracking-Api-Key" : "as-api-key");
const trackingAdapters = makeAdapters({ provider: trackingProvider, apiKey: trackingApiKey, baseUrl: trackingBaseUrl, authHeader: trackingAuthHeader });

app.post("/api/track", authenticate, async (req, res) => {
  if (!trackingApiKey) return res.json({ ok: false, configured: false, message: "Courier tracking is not configured on the server." });
  const mode = String(req.body?.mode || "sweep");
  const limit = Math.min(Math.max(Number(req.body?.limit || 150), 1), 150);
  try {
    const courierRows = await pool.query("select transport_name, slug, trackable from couriers");
    const couriers = courierRows.rows;
    const lookupCourier = transport => {
      const hit = couriers.find(c => String(c.transport_name || "").trim().toLowerCase() === String(transport || "").trim().toLowerCase());
      return hit ? { trackable: Boolean(hit.trackable), slug: hit.slug || "" } : { trackable: true, slug: "" };
    };
    const handle = async (order, register) => {
      const docket = String(order.docket || "").trim();
      if (!docket) return { id: order.id, skipped: "no docket number" };
      const { trackable, slug } = lookupCourier(order.transport);
      if (!trackable) return { id: order.id, skipped: `${order.transport || "This transporter"} does not offer online tracking` };
      if (register) {
        const registered = await trackingAdapters.register(slug, docket);
        if (!registered.ok) return { id: order.id, error: registered.error };
      }
      const result = await trackingAdapters.fetchOne(slug, docket);
      if (!result.ok) return { id: order.id, error: result.error };
      const patch = decidePatch(order, result);
      const updated = await updateOrderById(order.id, patch);
      return { id: order.id, status: patch.status ?? order.status, raw: result.raw, note: patch.tracking_note, updated: Boolean(updated) };
    };
    if (mode === "register" || mode === "refresh") {
      const result = await pool.query("select * from orders where id = $1", [req.body?.order_id]);
      const order = result.rows[0];
      if (!order) return res.status(404).json({ ok: false, message: "That entry was not found." });
      return res.json({ ok: true, configured: true, result: await handle(order, mode === "register") });
    }
    const result = await pool.query(
      `select * from orders where status in ('Dispatched', 'In Transit') and docket <> '' ${rowsOrderByDate()} limit $1`,
      [limit],
    );
    const results = [];
    for (const order of result.rows) {
      results.push(await handle(order, false));
      await new Promise(resolve => setTimeout(resolve, 120));
    }
    res.json({ ok: true, configured: true, checked: results.length, results });
  } catch (error) {
    handleError(res, error);
  }
});

/* ---------------- static app ---------------- */
app.use(express.static(__dirname));
app.get("*", (req, res, next) => {
  if (req.path.startsWith("/api/")) return next();
  res.sendFile(path.join(__dirname, "index.html"));
});

app.use((error, req, res, next) => {
  if (error?.type === "entity.parse.failed") return res.status(400).json({ message: "Invalid JSON request." });
  handleError(res, error);
});

app.listen(port, () => {
  console.log(`Dispatch Register listening on http://localhost:${port}`);
  if (!pool) console.warn("DATABASE_URL is not configured; add it to .env before signing in.");
  if (!jwtSecret) console.warn("JWT_SECRET is not configured; add it to .env before signing in.");
});
