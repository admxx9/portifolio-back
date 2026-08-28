import { Pool } from "pg";
import { createHmac, randomBytes, scrypt as scryptCallback, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);
const databaseUrl = process.env.DATABASE_URL || process.env.STORAGE_URL;
const pool = new Pool({ connectionString: databaseUrl, ssl: process.env.NODE_ENV === "production" ? { rejectUnauthorized: false } : undefined });

const cors = { "Access-Control-Allow-Origin": "https://portifolio-front-omega.vercel.app", "Access-Control-Allow-Credentials": "true", "Access-Control-Allow-Headers": "content-type", "Access-Control-Allow-Methods": "GET,POST,PUT,DELETE,OPTIONS" };
const json = (response, data, status = 200, headers = {}) => {
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", ...cors, ...headers });
  response.end(JSON.stringify(data));
};
const header = (request, name) => request.headers[name] || "";
const secret = () => process.env.SESSION_SECRET || "";
const cookie = (name, value, maxAge = 0) => `${name}=${value}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=${maxAge}`;

async function schema() {
  await pool.query(`CREATE TABLE IF NOT EXISTS portfolio_users (id serial primary key, email text unique not null, password_hash text not null, created_at timestamptz default now());
    CREATE TABLE IF NOT EXISTS portfolio_projects (id serial primary key, title text not null, page_url text not null default '', image_url text not null default '', description text not null default '', position integer not null default 0, published boolean not null default true, created_at timestamptz default now(), updated_at timestamptz default now());`);
  const users = await pool.query("SELECT count(*)::int AS count FROM portfolio_users");
  if (!users.rows[0].count && process.env.INITIAL_ADMIN_USERNAME && process.env.INITIAL_ADMIN_PASSWORD) {
    await pool.query("INSERT INTO portfolio_users(email,password_hash) VALUES($1,$2)", [process.env.INITIAL_ADMIN_USERNAME, await hash(process.env.INITIAL_ADMIN_PASSWORD)]);
  }
}
async function hash(password, salt = randomBytes(16).toString("hex")) { return `${salt}:${Buffer.from(await scrypt(password, salt, 64)).toString("hex")}`; }
async function matches(password, stored) { const [salt, saved] = stored.split(":"); const actual = (await hash(password, salt)).split(":")[1]; return timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(saved, "hex")); }
function session(user) { const exp = Math.floor(Date.now() / 1000) + 60 * 60 * 24 * 30; const value = `${user.id}.${exp}`; return `${value}.${createHmac("sha256", secret()).update(value).digest("base64url")}`; }
function userFrom(request) { const token = header(request, "cookie")?.match(/(?:^|; )portfolio_session=([^;]+)/)?.[1]; if (!token || !secret()) return null; const [id, exp, sig] = token.split("."); const value = `${id}.${exp}`; const expected = createHmac("sha256", secret()).update(value).digest("base64url"); return sig === expected && Number(exp) > Date.now() / 1000 ? { id: Number(id) } : null; }
async function body(request) {
  if (request.body && typeof request.body === "object") return request.body;
  const chunks = [];
  for await (const chunk of request) chunks.push(chunk);
  try { return JSON.parse(Buffer.concat(chunks).toString() || "{}"); } catch { return {}; }
}

export default async function handler(request, response) {
  if (request.method === "OPTIONS") { response.writeHead(204, cors); return response.end(); }
  if (!databaseUrl || !secret()) return json(response, { error: "Servidor ainda não configurado." }, 503);
  await schema();
  const url = new URL(request.url, `https://${header(request, "host") || "localhost"}`); const action = url.searchParams.get("action") || "projects"; const user = userFrom(request);
  if (action === "projects" && request.method === "GET") return json(response, (await pool.query("SELECT id,title,page_url,image_url,description,position,published FROM portfolio_projects WHERE published=true ORDER BY position,id")).rows);
  if (action === "setup" && request.method === "POST") {
    const data = await body(request); const count = await pool.query("SELECT count(*)::int AS count FROM portfolio_users");
    if (count.rows[0].count || data.setupKey !== process.env.BACKOFFICE_SETUP_KEY) return json(response, { error: "Configuração indisponível." }, 403);
    const result = await pool.query("INSERT INTO portfolio_users(email,password_hash) VALUES($1,$2) RETURNING id,email", [data.email?.trim().toLowerCase(), await hash(data.password || "")]);
    return json(response, { user: result.rows[0] }, 201, { "Set-Cookie": cookie("portfolio_session", session(result.rows[0]), 2592000) });
  }
  if (action === "login" && request.method === "POST") { const data = await body(request); const username = (data.username || data.email || "").trim().toLowerCase(); const result = await pool.query("SELECT * FROM portfolio_users WHERE email=$1", [username]); if (!result.rows[0] || !(await matches(data.password || "", result.rows[0].password_hash))) return json(response, { error: "Usuário ou senha inválidos." }, 401); return json(response, { user: { id: result.rows[0].id, email: result.rows[0].email } }, 200, { "Set-Cookie": cookie("portfolio_session", session(result.rows[0]), 2592000) }); }
  if (action === "logout") return json(response, {}, 200, { "Set-Cookie": cookie("portfolio_session", "", 0) });
  if (action === "me") return user ? json(response, { user }) : json(response, { user: null }, 401);
  if (!user) return json(response, { error: "Não autorizado." }, 401);
  if (action === "manage" && request.method === "GET") return json(response, (await pool.query("SELECT * FROM portfolio_projects ORDER BY position,id")).rows);
  const data = await body(request); const fields = [data.title?.trim(), data.page_url?.trim() || "", data.image_url?.trim() || "", data.description?.trim() || "", Number(data.position) || 0, data.published !== false];
  if (action === "manage" && request.method === "POST") return json(response, (await pool.query("INSERT INTO portfolio_projects(title,page_url,image_url,description,position,published) VALUES($1,$2,$3,$4,$5,$6) RETURNING *", fields)).rows[0], 201);
  if (action === "manage" && request.method === "PUT") return json(response, (await pool.query("UPDATE portfolio_projects SET title=$1,page_url=$2,image_url=$3,description=$4,position=$5,published=$6,updated_at=now() WHERE id=$7 RETURNING *", [...fields, data.id])).rows[0]);
  if (action === "manage" && request.method === "DELETE") { await pool.query("DELETE FROM portfolio_projects WHERE id=$1", [data.id]); return json(response, { ok: true }); }
  return json(response, { error: "Rota inválida." }, 404);
}
