import { Pool } from "pg";
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const pool = new Pool({ connectionString: process.env.DATABASE_URL, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });

const json = (data, status = 200, headers = {}) => Response.json(data, { status, headers });
const secret = () => process.env.SESSION_SECRET || "";
const cookie = (name, value, maxAge = 0) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;

async function schema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_users (id serial primary key, email text unique not null, password_hash text not null, created_at timestamptz default now());
    CREATE TABLE IF NOT EXISTS portfolio_projects (id serial primary key, title text not null, page_url text not null default '', image_url text not null default '', description text not null default '', position integer not null default 0, published boolean not null default true, created_at timestamptz default now(), updated_at timestamptz default now());`);
}
async function hash(password, salt = randomBytes(16).toString("hex")) { return `${salt}:${Buffer.from(await scrypt(password, salt, 64)).toString("hex")}`; }
async function matches(password, stored) { const [salt, saved] = stored.split(":"); const actual = (await hash(password, salt)).split(":")[1]; return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(saved, "hex")); }
function session(user) { const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; const value = `${user.id}.${exp}`; return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`; }
function userFrom(request) { const token = request.headers.get("cookie")?.match(/(?:^|; )portfolio_session=([^;]+)/)?.[1]; if (!token || !secret()) return null; const [id, exp, sig] = token.split("."); const value = `${id}.${exp}`; const expected = createHmac("sha256", secret()).update(value).digest("base64url"); return sig === expected && Number(exp) > Date.now() / 1000 ? { id: Number(id) } : null; }
async function body(request) { try { return await request.json(); } catch { return {}; } }

export default async function handler(request) {
  if (!process.env.DATABASE_URL || !secret()) return json({ error: "Servidor ainda não configurado." }, 503);
  await schema();
  const url = new URL(request.url); const action = url.searchParams.get("action") || "projects"; const user = userFrom(request);
  if (action === "projects" && request.method === "GET") return json((await pool.query("SELECT id,title,page_url,image_url,description,position,published FROM portfolio_projects WHERE published=true ORDER BY position,id")).rows);
  if (action === "setup" && request.method === "POST") {
    const data = await body(request); const count = await pool.query("SELECT count(*)::int AS count FROM portfolio_users");
    if (count.rows[0].count || data.setupKey !== process.env.BACKOFFICE_SETUP_KEY) return json({ error: "Configuração indisponível." }, 403);
    const result = await pool.query("INSERT INTO portfolio_users(email,password_hash) VALUES($1,$2) RETURNING id,email", [data.email?.trim().toLowerCase(), await hash(data.password || "")]);
    return json({ user: result.rows[0] }, 201, { "Set-Cookie": cookie("portfolio_session", session(result.rows[0]), 2592000) });
  }
  if (action === "login" && request.method === "POST") { const data = await body(request); const result = await pool.query("SELECT * FROM portfolio_users WHERE email=$1", [data.email?.trim().toLowerCase()]); if (!result.rows[0] || !(await matches(data.password || "", result.rows[0].password_hash))) return json({ error: "E-mail ou senha inválidos." }, 401); return json({ user: { id: result.rows[0].id, email: result.rows[0].email } }, 200, { "Set-Cookie": cookie("portfolio_session", session(result.rows[0]), 2592000) }); }
  if (action === "logout") return json({}, 200, { "Set-Cookie": cookie("portfolio_session", "", 0) });
  if (action === "me") return user ? json({ user }) : json({ user: null }, 401);
  if (!user) return json({ error: "Não autorizado." }, 401);
  if (action === "manage" && request.method === "GET") return json((await pool.query("SELECT * FROM portfolio_projects ORDER BY position,id")).rows);
  const data = await body(request); const fields = [data.title?.trim(), data.page_url?.trim() || "", data.image_url?.trim() || "", data.description?.trim() || "", Number(data.position) || 0, data.published !== false];
  if (action === "manage" && request.method === "POST") return json((await pool.query("INSERT INTO portfolio_projects(title,page_url,image_url,description,position,published) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", fields)).rows[0], 201);
  if (action === "manage" && request.method === "PUT") return json((await pool.query("UPDATE portfolio_projects SET title=$1,page_url=$2,image_url=$3,description=$4,position=$5,published=$6,updated_at=now() WHERE id=$7 RETURNING *", [...fields, data.id])).rows[0]);
  if (action === "manage" && request.method === "DELETE") { await pool.query("DELETE FROM portfolio_projects WHERE id=$1", [data.id]); return json({ ok: true }); }
  return json({ error: "Rota inválida." }, 404);
}
