import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createServer } from "node:http";
import argon2 from "argon2";
import { pool } from "./db.mjs";
import { migrate } from "./migrate.mjs";

const port = Number(process.env.PORT ?? 3001);
const allowedOrigins = new Set((process.env.APP_ORIGINS ?? "http://127.0.0.1:5173,http://localhost:5173").split(",").map((value) => value.trim()));
const cookieName = "appforge_session";
const sessionSeconds = 60 * 60 * 24 * 30;
const editableWorkspaceRoles = new Set(["OWNER", "ADMIN", "EDITOR"]);
const pwaDisplays = new Set(["fullscreen", "standalone", "minimal-ui", "browser"]);
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const blankDocument = {
  version: 1,
  homePageId: "home",
  pages: [{ id: "home", name: "Home", slug: "", isHome: true, sections: [] }],
};

class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function send(res, status, body, origin) {
  if (origin && allowedOrigins.has(origin)) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Access-Control-Allow-Credentials", "true");
    res.setHeader("Vary", "Origin");
  }
  res.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  res.end(JSON.stringify(body));
}

async function readJson(req) {
  let body = "";
  for await (const chunk of req) {
    body += chunk;
    if (body.length > 1_000_000) throw new HttpError(413, "Corpo da requisição muito grande.");
  }
  if (!body) return {};
  try {
    return JSON.parse(body);
  } catch {
    throw new HttpError(400, "JSON inválido.");
  }
}

function cookies(req) {
  return Object.fromEntries((req.headers.cookie ?? "").split(";").filter(Boolean).map((part) => {
    const index = part.indexOf("=");
    return [part.slice(0, index).trim(), decodeURIComponent(part.slice(index + 1))];
  }));
}

function tokenHash(token) {
  return createHash("sha256").update(token).digest("hex");
}

function sessionCookie(token, maxAge = sessionSeconds) {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${cookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${secure}`;
}

function slugify(value) {
  return value.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 120);
}

function isJsonObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function userPayload(row) {
  return {
    user: {
      id: row.user_id,
      name: row.user_name,
      email: row.email,
      avatarUrl: row.avatar_url,
      onboardingCompleted: row.onboarding_completed,
      onboardingPreference: row.onboarding_preference,
      platformRole: row.platform_role,
    },
    workspace: { id: row.workspace_id, name: row.workspace_name, slug: row.workspace_slug, role: row.workspace_role },
  };
}

async function createSession(client, userId, workspaceId) {
  const token = randomBytes(32).toString("base64url");
  await client.query(
    "INSERT INTO sessions(token_hash, user_id, workspace_id, expires_at) VALUES ($1, $2, $3, now() + interval '30 days')",
    [tokenHash(token), userId, workspaceId],
  );
  return token;
}

async function requireSession(req) {
  const token = cookies(req)[cookieName];
  if (!token) throw new HttpError(401, "Faça login para continuar.");
  const result = await pool.query(`
    SELECT u.id user_id, u.name user_name, u.email, u.avatar_url, u.onboarding_completed, u.onboarding_preference, u.platform_role,
           w.id workspace_id, w.name workspace_name, w.slug workspace_slug, wm.role workspace_role
      FROM sessions s
      JOIN users u ON u.id = s.user_id
      JOIN workspaces w ON w.id = s.workspace_id
      JOIN workspace_members wm ON wm.workspace_id = w.id AND wm.user_id = u.id
     WHERE s.token_hash = $1 AND s.expires_at > now()
  `, [tokenHash(token)]);
  if (!result.rowCount) throw new HttpError(401, "Sua sessão expirou. Entre novamente.");
  await pool.query("UPDATE sessions SET last_seen_at = now() WHERE token_hash = $1 AND last_seen_at < now() - interval '15 minutes'", [tokenHash(token)]);
  return result.rows[0];
}

function projectPayload(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    status: row.status,
    templateId: row.template_id,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    publishedAt: row.published_at,
  };
}

function templatePayload(row) {
  return {
    id: row.id,
    name: row.name,
    slug: row.slug,
    description: row.description,
    category: row.category,
    thumbnail: row.thumbnail,
    definition: row.definition,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function builderPayload(row) {
  return {
    project: projectPayload(row),
    settings: {
      locale: row.locale,
      timezone: row.timezone,
      theme: row.theme,
      branding: row.branding,
    },
    document: row.document,
    revision: row.revision,
    updatedAt: row.builder_updated_at,
  };
}

async function loadBuilder(client, projectId, workspaceId) {
  return client.query(`
    SELECT p.*, ps.locale, ps.timezone, ps.theme, ps.branding,
           pd.document, pd.revision, pd.updated_at builder_updated_at
      FROM projects p
      JOIN project_settings ps ON ps.project_id = p.id
      JOIN project_documents pd ON pd.project_id = p.id
     WHERE p.id = $1 AND p.workspace_id = $2
  `, [projectId, workspaceId]);
}

function normalizeFields(value) {
  if (!Array.isArray(value) || value.length > 100) throw new HttpError(422, "Fields deve ser uma lista com até 100 campos.");
  const ids = new Set();
  const keys = new Set();
  return value.map((field, index) => {
    if (!isJsonObject(field)) throw new HttpError(422, `Campo ${index + 1} inválido.`);
    const name = String(field.name ?? "").trim().slice(0, 120);
    const key = String(field.key ?? slugify(name).replaceAll("-", "_")).trim().toLowerCase();
    const type = String(field.type ?? "text").trim().toLowerCase();
    const id = String(field.id ?? randomUUID()).trim().slice(0, 120);
    if (!name || !/^[a-z][a-z0-9_]{0,63}$/.test(key) || !/^[a-z][a-z0-9_-]{0,31}$/.test(type) || !id) {
      throw new HttpError(422, `Campo ${index + 1} inválido.`);
    }
    if (field.required !== undefined && typeof field.required !== "boolean") throw new HttpError(422, `Required do campo ${name} deve ser booleano.`);
    if (ids.has(id) || keys.has(key)) throw new HttpError(422, "IDs e chaves dos campos devem ser únicos.");
    ids.add(id);
    keys.add(key);
    return { id, name, key, type, required: field.required === true };
  });
}

function validateRecordData(data, fields) {
  if (!isJsonObject(data)) throw new HttpError(422, "Data deve ser um objeto JSON.");
  const knownKeys = new Set(fields.map((field) => field.key));
  for (const key of Object.keys(data)) {
    if (fields.length && !knownKeys.has(key)) throw new HttpError(422, `Campo desconhecido: ${key}.`);
  }
  for (const field of fields) {
    const value = data[field.key];
    if (field.required && (value === undefined || value === null || value === "")) throw new HttpError(422, `O campo ${field.name} é obrigatório.`);
    if (value === undefined || value === null || value === "") continue;
    if (field.type === "boolean" && typeof value !== "boolean") throw new HttpError(422, `${field.name} deve ser booleano.`);
    if (field.type === "number" && (typeof value !== "number" || !Number.isFinite(value))) throw new HttpError(422, `${field.name} deve ser numérico.`);
    if (field.type === "email" && (typeof value !== "string" || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value))) throw new HttpError(422, `${field.name} deve ser um e-mail válido.`);
    if (["date", "datetime"].includes(field.type) && (typeof value !== "string" || Number.isNaN(Date.parse(value)))) throw new HttpError(422, `${field.name} deve ser uma data válida.`);
  }
  return data;
}

function collectionPayload(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    slug: row.slug,
    fields: row.fields,
    recordCount: Number(row.record_count ?? 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function recordPayload(row) {
  return { id: row.id, collectionId: row.collection_id, data: row.data, createdAt: row.created_at, updatedAt: row.updated_at };
}

function pwaPayload(row) {
  const name = row.pwa_name || row.name;
  const shortName = row.pwa_short_name || name.slice(0, 32);
  const themeColor = row.pwa_theme_color || row.theme?.primaryColor || "#315CFF";
  const backgroundColor = row.pwa_background_color || row.theme?.backgroundColor || "#090A0F";
  const display = row.pwa_display || "standalone";
  const offline = row.pwa_offline === true;
  const startUrl = `/apps/${row.id}`;
  return {
    name,
    shortName,
    themeColor,
    backgroundColor,
    display,
    offline,
    manifest: {
      id: startUrl,
      name,
      short_name: shortName,
      start_url: startUrl,
      scope: startUrl,
      display,
      theme_color: themeColor,
      background_color: backgroundColor,
      icons: [],
    },
  };
}

function releasePayload(row) {
  return {
    id: row.id,
    projectId: row.project_id,
    version: row.version,
    status: row.status,
    url: row.url,
    snapshot: row.snapshot,
    createdAt: row.created_at,
  };
}

async function loadPwa(client, projectId, workspaceId) {
  return client.query(`
    SELECT p.id, p.name, ps.theme, ps.pwa_name, ps.pwa_short_name, ps.pwa_theme_color,
           ps.pwa_background_color, ps.pwa_display, ps.pwa_offline
      FROM projects p
      JOIN project_settings ps ON ps.project_id = p.id
     WHERE p.id = $1 AND p.workspace_id = $2
  `, [projectId, workspaceId]);
}

async function loadCollection(client, projectId, collectionId, workspaceId) {
  return client.query(`
    SELECT pc.*
      FROM project_collections pc
      JOIN projects p ON p.id = pc.project_id
     WHERE pc.id = $1 AND pc.project_id = $2 AND p.workspace_id = $3
  `, [collectionId, projectId, workspaceId]);
}

async function handle(req, res) {
  const origin = req.headers.origin;
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "127.0.0.1"}`);
  const path = url.pathname;

  if (req.method === "OPTIONS") {
    if (origin && allowedOrigins.has(origin)) {
      res.setHeader("Access-Control-Allow-Origin", origin);
      res.setHeader("Access-Control-Allow-Credentials", "true");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");
      res.setHeader("Access-Control-Allow-Methods", "GET,POST,PATCH,DELETE,OPTIONS");
    }
    res.writeHead(204).end();
    return;
  }
  if (!["GET", "HEAD"].includes(req.method ?? "GET") && origin && !allowedOrigins.has(origin)) {
    throw new HttpError(403, "Origem não permitida.");
  }

  if (req.method === "GET" && path === "/api/health") {
    await pool.query("SELECT 1");
    return send(res, 200, { status: "ok" }, origin);
  }

  if (req.method === "POST" && path === "/api/auth/register") {
    const { name, email, password } = await readJson(req);
    const cleanName = String(name ?? "").trim();
    const cleanEmail = String(email ?? "").trim().toLowerCase();
    if (cleanName.length < 2 || cleanName.length > 120) throw new HttpError(422, "Informe um nome válido.");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(cleanEmail)) throw new HttpError(422, "Informe um e-mail válido.");
    if (String(password ?? "").length < 8) throw new HttpError(422, "A senha deve ter pelo menos 8 caracteres.");
    const passwordHash = await argon2.hash(String(password), { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 });
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const user = (await client.query("INSERT INTO users(name, email, password_hash) VALUES ($1, $2, $3) RETURNING id", [cleanName, cleanEmail, passwordHash])).rows[0];
      const workspaceName = `Espaço de ${cleanName.split(/\s+/)[0]}`;
      const workspaceSlug = `${slugify(workspaceName) || "workspace"}-${randomBytes(3).toString("hex")}`;
      const workspace = (await client.query("INSERT INTO workspaces(name, slug, owner_id) VALUES ($1, $2, $3) RETURNING id", [workspaceName, workspaceSlug, user.id])).rows[0];
      await client.query("INSERT INTO workspace_members(workspace_id, user_id, role) VALUES ($1, $2, 'OWNER')", [workspace.id, user.id]);
      await client.query("INSERT INTO audit_logs(workspace_id, user_id, action, entity_type, entity_id) VALUES ($1, $2, 'USER_REGISTERED', 'user', $2)", [workspace.id, user.id]);
      const token = await createSession(client, user.id, workspace.id);
      await client.query("COMMIT");
      res.setHeader("Set-Cookie", sessionCookie(token));
    } catch (error) {
      await client.query("ROLLBACK");
      if (error?.code === "23505") throw new HttpError(409, "Já existe uma conta com este e-mail.");
      throw error;
    } finally {
      client.release();
    }
    const session = await requireSession(reqWithCookie(req, res.getHeader("Set-Cookie")));
    return send(res, 201, userPayload(session), origin);
  }

  if (req.method === "POST" && path === "/api/auth/login") {
    const { email, password } = await readJson(req);
    const result = await pool.query("SELECT id, password_hash FROM users WHERE email = $1", [String(email ?? "").trim().toLowerCase()]);
    const valid = result.rowCount ? await argon2.verify(result.rows[0].password_hash, String(password ?? "")) : false;
    if (!valid) throw new HttpError(401, "E-mail ou senha inválidos.");
    const membership = await pool.query("SELECT workspace_id FROM workspace_members WHERE user_id = $1 ORDER BY created_at LIMIT 1", [result.rows[0].id]);
    if (!membership.rowCount) throw new HttpError(403, "Sua conta não pertence a um workspace.");
    const token = await createSession(pool, result.rows[0].id, membership.rows[0].workspace_id);
    res.setHeader("Set-Cookie", sessionCookie(token));
    const session = await requireSession(reqWithCookie(req, res.getHeader("Set-Cookie")));
    return send(res, 200, userPayload(session), origin);
  }

  if (req.method === "POST" && path === "/api/auth/logout") {
    const token = cookies(req)[cookieName];
    if (token) await pool.query("DELETE FROM sessions WHERE token_hash = $1", [tokenHash(token)]);
    res.setHeader("Set-Cookie", sessionCookie("", 0));
    return send(res, 200, { ok: true }, origin);
  }

  if (req.method === "GET" && path === "/api/auth/me") {
    return send(res, 200, userPayload(await requireSession(req)), origin);
  }

  if (req.method === "PATCH" && path === "/api/onboarding") {
    const session = await requireSession(req);
    const body = await readJson(req);
    if (!isJsonObject(body)) throw new HttpError(422, "O corpo deve ser um objeto JSON.");
    const { workspaceName } = body;
    const hasPreference = Object.hasOwn(body, "preference");
    const preference = body.preference === null ? null : String(body.preference ?? "").trim();
    if (hasPreference && preference !== null && (!preference || preference.length > 80)) throw new HttpError(422, "Preferência de onboarding inválida.");
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      await client.query(`
        UPDATE users
           SET onboarding_completed = true,
               onboarding_preference = CASE WHEN $2::boolean THEN $3 ELSE onboarding_preference END,
               updated_at = now()
         WHERE id = $1
      `, [session.user_id, hasPreference, preference]);
      if (String(workspaceName ?? "").trim()) await client.query("UPDATE workspaces SET name = $1, updated_at = now() WHERE id = $2", [String(workspaceName).trim().slice(0, 120), session.workspace_id]);
      await client.query(`
        INSERT INTO audit_logs(workspace_id, user_id, action, entity_type, entity_id, metadata)
        VALUES ($1, $2, 'ONBOARDING_COMPLETED', 'user', $2, $3::jsonb)
      `, [session.workspace_id, session.user_id, JSON.stringify({ preference: hasPreference ? preference : null })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return send(res, 200, userPayload(await requireSession(req)), origin);
  }

  if (req.method === "GET" && path === "/api/templates") {
    await requireSession(req);
    const search = String(url.searchParams.get("search") ?? "").trim().slice(0, 120);
    const category = String(url.searchParams.get("category") ?? "").trim().slice(0, 80);
    const result = await pool.query(`
      SELECT *
        FROM templates
       WHERE is_active = true
         AND ($1 = '' OR name ILIKE '%' || $1 || '%' OR description ILIKE '%' || $1 || '%')
         AND ($2 = '' OR category = $2)
       ORDER BY name
    `, [search, category]);
    return send(res, 200, { templates: result.rows.map(templatePayload) }, origin);
  }

  if (req.method === "GET" && path === "/api/projects") {
    const session = await requireSession(req);
    const result = await pool.query("SELECT * FROM projects WHERE workspace_id = $1 ORDER BY updated_at DESC", [session.workspace_id]);
    return send(res, 200, { projects: result.rows.map(projectPayload) }, origin);
  }

  if (req.method === "POST" && path === "/api/projects") {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para criar projetos.");
    const { name, slug, description, locale, timezone, templateId } = await readJson(req);
    const cleanName = String(name ?? "").trim();
    const cleanSlug = slugify(String(slug ?? ""));
    const cleanTemplateId = String(templateId ?? "").trim() || null;
    if (cleanName.length < 2 || cleanName.length > 120) throw new HttpError(422, "Informe um nome válido para o projeto.");
    if (!cleanSlug) throw new HttpError(422, "Informe um slug válido para o projeto.");
    if (cleanTemplateId && !uuidPattern.test(cleanTemplateId)) throw new HttpError(422, "Template inválido.");
    const client = await pool.connect();
    let project;
    try {
      await client.query("BEGIN");
      let template = null;
      if (cleanTemplateId) {
        const templateResult = await client.query("SELECT id, slug, definition FROM templates WHERE id = $1 AND is_active = true", [cleanTemplateId]);
        if (!templateResult.rowCount) throw new HttpError(422, "Template inválido ou indisponível.");
        template = templateResult.rows[0];
      }
      const definition = isJsonObject(template?.definition) ? template.definition : {};
      const document = structuredClone(isJsonObject(definition.document) ? definition.document : blankDocument);
      if (!Array.isArray(document.modules)) {
        document.modules = Array.isArray(definition.recommendedModules)
          ? definition.recommendedModules.filter((module) => typeof module === "string")
          : [];
      }
      const theme = isJsonObject(definition.theme) ? definition.theme : {};
      const branding = isJsonObject(definition.branding) ? definition.branding : {};
      const pwa = isJsonObject(definition.pwa) ? definition.pwa : {};
      const collections = Array.isArray(definition.collections) ? definition.collections : [];
      project = (await client.query(`
        INSERT INTO projects(workspace_id, name, slug, description, template_id, created_by)
        VALUES ($1, $2, $3, $4, $5, $6) RETURNING *
      `, [session.workspace_id, cleanName, cleanSlug, String(description ?? "").trim() || null, template?.id ?? null, session.user_id])).rows[0];
      await client.query(`
        INSERT INTO project_settings(
          project_id, locale, timezone, theme, branding, pwa_name, pwa_short_name,
          pwa_theme_color, pwa_background_color, pwa_display, pwa_offline
        )
        VALUES ($1, $2, $3, $4::jsonb, $5::jsonb, $6, $7, $8, $9, $10, $11)
      `, [
        project.id,
        String(locale ?? "pt-BR"),
        String(timezone ?? "America/Sao_Paulo"),
        JSON.stringify(theme),
        JSON.stringify(branding),
        String(pwa.name ?? "").trim().slice(0, 120) || null,
        String(pwa.shortName ?? "").trim().slice(0, 32) || null,
        String(pwa.themeColor ?? "").trim().slice(0, 16) || null,
        String(pwa.backgroundColor ?? "").trim().slice(0, 16) || null,
        pwaDisplays.has(pwa.display) ? pwa.display : "standalone",
        pwa.offline === true,
      ]);
      await client.query("INSERT INTO project_documents(project_id, document) VALUES ($1, $2::jsonb)", [project.id, JSON.stringify(document)]);
      for (const collection of collections) {
        if (!isJsonObject(collection)) continue;
        const collectionName = String(collection.name ?? "").trim().slice(0, 120);
        const collectionSlug = slugify(String(collection.slug ?? collectionName));
        if (!collectionName || !collectionSlug) continue;
        const fields = normalizeFields(collection.fields ?? []);
        await client.query(`
          INSERT INTO project_collections(project_id, name, slug, fields)
          VALUES ($1, $2, $3, $4::jsonb)
        `, [project.id, collectionName, collectionSlug, JSON.stringify(fields)]);
      }
      await client.query(`
        INSERT INTO audit_logs(workspace_id, user_id, project_id, action, entity_type, entity_id, metadata)
        VALUES ($1, $2, $3, 'PROJECT_CREATED', 'project', $3, $4::jsonb)
      `, [session.workspace_id, session.user_id, project.id, JSON.stringify({ templateId: template?.id ?? null, templateSlug: template?.slug ?? null })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      if (error?.code === "23505") throw new HttpError(409, "Já existe um projeto com este slug no workspace.");
      if (error?.code === "23503") throw new HttpError(422, "Template inválido.");
      throw error;
    } finally {
      client.release();
    }
    return send(res, 201, { project: projectPayload(project) }, origin);
  }

  const collectionsMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)\/collections$/i);
  if (req.method === "GET" && collectionsMatch) {
    const session = await requireSession(req);
    if (!uuidPattern.test(collectionsMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const project = await pool.query("SELECT id FROM projects WHERE id = $1 AND workspace_id = $2", [collectionsMatch[1], session.workspace_id]);
    if (!project.rowCount) throw new HttpError(404, "Projeto não encontrado.");
    const result = await pool.query(`
      SELECT pc.*, count(pr.id)::int record_count
        FROM project_collections pc
        LEFT JOIN project_records pr ON pr.collection_id = pc.id
       WHERE pc.project_id = $1
       GROUP BY pc.id
       ORDER BY pc.created_at, pc.name
    `, [collectionsMatch[1]]);
    return send(res, 200, { collections: result.rows.map(collectionPayload) }, origin);
  }

  if (req.method === "POST" && collectionsMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para criar coleções.");
    if (!uuidPattern.test(collectionsMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const body = await readJson(req);
    if (!isJsonObject(body)) throw new HttpError(422, "O corpo deve ser um objeto JSON.");
    const name = String(body.name ?? "").trim().slice(0, 120);
    const slug = slugify(String(body.slug ?? name));
    if (!name || !slug) throw new HttpError(422, "Informe nome e slug válidos para a coleção.");
    const fields = normalizeFields(body.fields ?? []);
    const project = await pool.query("SELECT id FROM projects WHERE id = $1 AND workspace_id = $2", [collectionsMatch[1], session.workspace_id]);
    if (!project.rowCount) throw new HttpError(404, "Projeto não encontrado.");
    try {
      const result = await pool.query(`
        INSERT INTO project_collections(project_id, name, slug, fields)
        VALUES ($1, $2, $3, $4::jsonb)
        RETURNING *
      `, [collectionsMatch[1], name, slug, JSON.stringify(fields)]);
      return send(res, 201, { collection: collectionPayload({ ...result.rows[0], record_count: 0 }) }, origin);
    } catch (error) {
      if (error?.code === "23505") throw new HttpError(409, "Já existe uma coleção com este slug.");
      throw error;
    }
  }

  const collectionMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)$/i);
  if (req.method === "PATCH" && collectionMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para editar coleções.");
    if (!uuidPattern.test(collectionMatch[1]) || !uuidPattern.test(collectionMatch[2])) throw new HttpError(404, "Coleção não encontrada.");
    const body = await readJson(req);
    if (!isJsonObject(body)) throw new HttpError(422, "O corpo deve ser um objeto JSON.");
    const current = await loadCollection(pool, collectionMatch[1], collectionMatch[2], session.workspace_id);
    if (!current.rowCount) throw new HttpError(404, "Coleção não encontrada.");
    const hasName = Object.hasOwn(body, "name");
    const hasSlug = Object.hasOwn(body, "slug");
    const hasFields = Object.hasOwn(body, "fields");
    if (!hasName && !hasSlug && !hasFields) throw new HttpError(422, "Informe name, slug ou fields para salvar.");
    const name = hasName ? String(body.name ?? "").trim().slice(0, 120) : current.rows[0].name;
    const slug = hasSlug ? slugify(String(body.slug ?? "")) : current.rows[0].slug;
    const fields = hasFields ? normalizeFields(body.fields) : current.rows[0].fields;
    if (!name || !slug) throw new HttpError(422, "Informe nome e slug válidos para a coleção.");
    try {
      await pool.query(`
        UPDATE project_collections
           SET name = $2, slug = $3, fields = $4::jsonb, updated_at = now()
         WHERE id = $1
      `, [collectionMatch[2], name, slug, JSON.stringify(fields)]);
      const result = await pool.query(`
        SELECT pc.*, count(pr.id)::int record_count
          FROM project_collections pc
          LEFT JOIN project_records pr ON pr.collection_id = pc.id
         WHERE pc.id = $1
         GROUP BY pc.id
      `, [collectionMatch[2]]);
      return send(res, 200, { collection: collectionPayload(result.rows[0]) }, origin);
    } catch (error) {
      if (error?.code === "23505") throw new HttpError(409, "Já existe uma coleção com este slug.");
      throw error;
    }
  }

  if (req.method === "DELETE" && collectionMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para excluir coleções.");
    if (!uuidPattern.test(collectionMatch[1]) || !uuidPattern.test(collectionMatch[2])) throw new HttpError(404, "Coleção não encontrada.");
    const current = await loadCollection(pool, collectionMatch[1], collectionMatch[2], session.workspace_id);
    if (!current.rowCount) throw new HttpError(404, "Coleção não encontrada.");
    await pool.query("DELETE FROM project_collections WHERE id = $1", [collectionMatch[2]]);
    return send(res, 200, { ok: true }, origin);
  }

  const recordsMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/records$/i);
  if (req.method === "GET" && recordsMatch) {
    const session = await requireSession(req);
    if (!uuidPattern.test(recordsMatch[1]) || !uuidPattern.test(recordsMatch[2])) throw new HttpError(404, "Coleção não encontrada.");
    const collection = await loadCollection(pool, recordsMatch[1], recordsMatch[2], session.workspace_id);
    if (!collection.rowCount) throw new HttpError(404, "Coleção não encontrada.");
    const q = String(url.searchParams.get("q") ?? "").trim().slice(0, 200);
    const rawLimit = url.searchParams.get("limit");
    const rawOffset = url.searchParams.get("offset");
    const limit = rawLimit === null ? 25 : Number(rawLimit);
    const offset = rawOffset === null ? 0 : Number(rawOffset);
    if (!Number.isInteger(limit) || limit < 1 || limit > 100 || !Number.isInteger(offset) || offset < 0) throw new HttpError(422, "Paginação inválida.");
    const [records, count] = await Promise.all([
      pool.query(`
        SELECT * FROM project_records
         WHERE collection_id = $1 AND ($2 = '' OR data::text ILIKE '%' || $2 || '%')
         ORDER BY created_at DESC
         LIMIT $3 OFFSET $4
      `, [recordsMatch[2], q, limit, offset]),
      pool.query(`
        SELECT count(*)::int total FROM project_records
         WHERE collection_id = $1 AND ($2 = '' OR data::text ILIKE '%' || $2 || '%')
      `, [recordsMatch[2], q]),
    ]);
    return send(res, 200, { records: records.rows.map(recordPayload), total: count.rows[0].total, limit, offset }, origin);
  }

  if (req.method === "POST" && recordsMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para criar registros.");
    if (!uuidPattern.test(recordsMatch[1]) || !uuidPattern.test(recordsMatch[2])) throw new HttpError(404, "Coleção não encontrada.");
    const collection = await loadCollection(pool, recordsMatch[1], recordsMatch[2], session.workspace_id);
    if (!collection.rowCount) throw new HttpError(404, "Coleção não encontrada.");
    const body = await readJson(req);
    if (!isJsonObject(body)) throw new HttpError(422, "O corpo deve ser um objeto JSON.");
    const data = validateRecordData(body.data, collection.rows[0].fields);
    const result = await pool.query(`
      INSERT INTO project_records(collection_id, data) VALUES ($1, $2::jsonb) RETURNING *
    `, [recordsMatch[2], JSON.stringify(data)]);
    return send(res, 201, { record: recordPayload(result.rows[0]) }, origin);
  }

  const recordMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)\/collections\/([0-9a-f-]+)\/records\/([0-9a-f-]+)$/i);
  if (req.method === "PATCH" && recordMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para editar registros.");
    if (![recordMatch[1], recordMatch[2], recordMatch[3]].every((id) => uuidPattern.test(id))) throw new HttpError(404, "Registro não encontrado.");
    const collection = await loadCollection(pool, recordMatch[1], recordMatch[2], session.workspace_id);
    if (!collection.rowCount) throw new HttpError(404, "Coleção não encontrada.");
    const current = await pool.query("SELECT * FROM project_records WHERE id = $1 AND collection_id = $2", [recordMatch[3], recordMatch[2]]);
    if (!current.rowCount) throw new HttpError(404, "Registro não encontrado.");
    const body = await readJson(req);
    if (!isJsonObject(body) || !isJsonObject(body.data)) throw new HttpError(422, "Informe data como objeto JSON.");
    const data = validateRecordData({ ...current.rows[0].data, ...body.data }, collection.rows[0].fields);
    const result = await pool.query(`
      UPDATE project_records SET data = $2::jsonb, updated_at = now() WHERE id = $1 RETURNING *
    `, [recordMatch[3], JSON.stringify(data)]);
    return send(res, 200, { record: recordPayload(result.rows[0]) }, origin);
  }

  if (req.method === "DELETE" && recordMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para excluir registros.");
    if (![recordMatch[1], recordMatch[2], recordMatch[3]].every((id) => uuidPattern.test(id))) throw new HttpError(404, "Registro não encontrado.");
    const collection = await loadCollection(pool, recordMatch[1], recordMatch[2], session.workspace_id);
    if (!collection.rowCount) throw new HttpError(404, "Coleção não encontrada.");
    const result = await pool.query("DELETE FROM project_records WHERE id = $1 AND collection_id = $2", [recordMatch[3], recordMatch[2]]);
    if (!result.rowCount) throw new HttpError(404, "Registro não encontrado.");
    return send(res, 200, { ok: true }, origin);
  }

  const pwaMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)\/pwa$/i);
  if (req.method === "GET" && pwaMatch) {
    const session = await requireSession(req);
    if (!uuidPattern.test(pwaMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const result = await loadPwa(pool, pwaMatch[1], session.workspace_id);
    if (!result.rowCount) throw new HttpError(404, "Projeto não encontrado.");
    return send(res, 200, { pwa: pwaPayload(result.rows[0]) }, origin);
  }

  if (req.method === "PATCH" && pwaMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para configurar o PWA.");
    if (!uuidPattern.test(pwaMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const body = await readJson(req);
    if (!isJsonObject(body)) throw new HttpError(422, "O corpo deve ser um objeto JSON.");
    const input = Object.hasOwn(body, "pwa") ? body.pwa : body;
    if (!isJsonObject(input)) throw new HttpError(422, "PWA deve ser um objeto JSON.");
    const keys = ["name", "shortName", "themeColor", "backgroundColor", "display", "offline"];
    if (!keys.some((key) => Object.hasOwn(input, key))) throw new HttpError(422, "Informe ao menos uma configuração PWA.");
    const current = await loadPwa(pool, pwaMatch[1], session.workspace_id);
    if (!current.rowCount) throw new HttpError(404, "Projeto não encontrado.");
    const previous = pwaPayload(current.rows[0]);
    const next = {
      name: Object.hasOwn(input, "name") ? String(input.name ?? "").trim() : previous.name,
      shortName: Object.hasOwn(input, "shortName") ? String(input.shortName ?? "").trim() : previous.shortName,
      themeColor: Object.hasOwn(input, "themeColor") ? String(input.themeColor ?? "").trim() : previous.themeColor,
      backgroundColor: Object.hasOwn(input, "backgroundColor") ? String(input.backgroundColor ?? "").trim() : previous.backgroundColor,
      display: Object.hasOwn(input, "display") ? String(input.display ?? "").trim() : previous.display,
      offline: Object.hasOwn(input, "offline") ? input.offline : previous.offline,
    };
    if (!next.name || next.name.length > 120 || !next.shortName || next.shortName.length > 32) throw new HttpError(422, "Nome ou nome curto do PWA inválido.");
    if (!/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(next.themeColor) || !/^#[0-9a-f]{6}([0-9a-f]{2})?$/i.test(next.backgroundColor)) throw new HttpError(422, "Cores do PWA devem usar hexadecimal.");
    if (!pwaDisplays.has(next.display) || typeof next.offline !== "boolean") throw new HttpError(422, "Display ou modo offline inválido.");
    await pool.query(`
      UPDATE project_settings
         SET pwa_name = $2, pwa_short_name = $3, pwa_theme_color = $4,
             pwa_background_color = $5, pwa_display = $6, pwa_offline = $7, updated_at = now()
       WHERE project_id = $1
    `, [pwaMatch[1], next.name, next.shortName, next.themeColor, next.backgroundColor, next.display, next.offline]);
    await pool.query("UPDATE projects SET updated_at = now() WHERE id = $1", [pwaMatch[1]]);
    const result = await loadPwa(pool, pwaMatch[1], session.workspace_id);
    return send(res, 200, { pwa: pwaPayload(result.rows[0]) }, origin);
  }

  const releasesMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)\/releases$/i);
  if (req.method === "GET" && releasesMatch) {
    const session = await requireSession(req);
    if (!uuidPattern.test(releasesMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const project = await pool.query("SELECT id FROM projects WHERE id = $1 AND workspace_id = $2", [releasesMatch[1], session.workspace_id]);
    if (!project.rowCount) throw new HttpError(404, "Projeto não encontrado.");
    const result = await pool.query("SELECT * FROM project_releases WHERE project_id = $1 ORDER BY version DESC", [releasesMatch[1]]);
    return send(res, 200, { releases: result.rows.map(releasePayload) }, origin);
  }

  if (req.method === "POST" && releasesMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para publicar este projeto.");
    if (!uuidPattern.test(releasesMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const client = await pool.connect();
    let release;
    try {
      await client.query("BEGIN");
      const source = await client.query(`
        SELECT p.id, p.name, p.slug, pd.document, ps.theme, ps.branding,
               ps.pwa_name, ps.pwa_short_name, ps.pwa_theme_color,
               ps.pwa_background_color, ps.pwa_display, ps.pwa_offline
          FROM projects p
          JOIN project_documents pd ON pd.project_id = p.id
          JOIN project_settings ps ON ps.project_id = p.id
         WHERE p.id = $1 AND p.workspace_id = $2
         FOR UPDATE OF p
      `, [releasesMatch[1], session.workspace_id]);
      if (!source.rowCount) throw new HttpError(404, "Projeto não encontrado.");
      const version = (await client.query("SELECT COALESCE(max(version), 0)::int + 1 version FROM project_releases WHERE project_id = $1", [releasesMatch[1]])).rows[0].version;
      const pwa = pwaPayload(source.rows[0]);
      const snapshot = {
        schemaVersion: 1,
        project: { id: source.rows[0].id, name: source.rows[0].name, slug: source.rows[0].slug },
        document: source.rows[0].document,
        theme: source.rows[0].theme,
        branding: source.rows[0].branding,
        pwa,
        releasedAt: new Date().toISOString(),
      };
      const urlPath = `/apps/${releasesMatch[1]}`;
      release = (await client.query(`
        INSERT INTO project_releases(project_id, version, status, url, snapshot)
        VALUES ($1, $2, 'READY', $3, $4::jsonb)
        RETURNING *
      `, [releasesMatch[1], version, urlPath, JSON.stringify(snapshot)])).rows[0];
      await client.query("UPDATE projects SET status = 'PUBLISHED', published_at = now(), updated_at = now() WHERE id = $1", [releasesMatch[1]]);
      await client.query(`
        INSERT INTO audit_logs(workspace_id, user_id, project_id, action, entity_type, entity_id, metadata)
        VALUES ($1, $2, $3, 'PROJECT_RELEASED', 'release', $4, $5::jsonb)
      `, [session.workspace_id, session.user_id, releasesMatch[1], release.id, JSON.stringify({ version, url: urlPath })]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return send(res, 201, { release: releasePayload(release) }, origin);
  }

  const publicAppMatch = path.match(/^\/api\/apps\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && publicAppMatch) {
    if (!uuidPattern.test(publicAppMatch[1])) throw new HttpError(404, "Aplicativo não publicado.");
    const result = await pool.query(`
      SELECT * FROM project_releases
       WHERE project_id = $1 AND status = 'READY'
       ORDER BY version DESC
       LIMIT 1
    `, [publicAppMatch[1]]);
    if (!result.rowCount) throw new HttpError(404, "Aplicativo não publicado.");
    return send(res, 200, { app: releasePayload(result.rows[0]) }, origin);
  }

  const builderMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)\/builder$/i);
  if (req.method === "GET" && builderMatch) {
    const session = await requireSession(req);
    if (!uuidPattern.test(builderMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const result = await loadBuilder(pool, builderMatch[1], session.workspace_id);
    if (!result.rowCount) throw new HttpError(404, "Projeto não encontrado.");
    return send(res, 200, builderPayload(result.rows[0]), origin);
  }

  if (req.method === "PATCH" && builderMatch) {
    const session = await requireSession(req);
    if (!editableWorkspaceRoles.has(session.workspace_role)) throw new HttpError(403, "Você não tem permissão para editar este projeto.");
    if (!uuidPattern.test(builderMatch[1])) throw new HttpError(404, "Projeto não encontrado.");
    const body = await readJson(req);
    if (!isJsonObject(body)) throw new HttpError(422, "O corpo deve ser um objeto JSON.");
    const hasDocument = Object.hasOwn(body, "document");
    const hasTheme = Object.hasOwn(body, "theme");
    const hasBranding = Object.hasOwn(body, "branding");
    if (!hasDocument && !hasTheme && !hasBranding) throw new HttpError(422, "Informe document, theme ou branding para salvar.");
    if (hasDocument && !isJsonObject(body.document)) throw new HttpError(422, "Document deve ser um objeto JSON.");
    if (hasTheme && !isJsonObject(body.theme)) throw new HttpError(422, "Theme deve ser um objeto JSON.");
    if (hasBranding && !isJsonObject(body.branding)) throw new HttpError(422, "Branding deve ser um objeto JSON.");
    const expectedRevision = body.expectedRevision === undefined ? null : Number(body.expectedRevision);
    if (expectedRevision !== null && (!Number.isInteger(expectedRevision) || expectedRevision < 1)) throw new HttpError(422, "expectedRevision inválida.");

    const client = await pool.connect();
    let saved;
    try {
      await client.query("BEGIN");
      const project = await client.query("SELECT id FROM projects WHERE id = $1 AND workspace_id = $2 FOR UPDATE", [builderMatch[1], session.workspace_id]);
      if (!project.rowCount) throw new HttpError(404, "Projeto não encontrado.");
      const documentResult = await client.query(`
        UPDATE project_documents
           SET document = CASE WHEN $3::boolean THEN $4::jsonb ELSE document END,
               revision = revision + 1,
               updated_at = now()
         WHERE project_id = $1
           AND ($2::integer IS NULL OR revision = $2)
         RETURNING revision
      `, [builderMatch[1], expectedRevision, hasDocument, hasDocument ? JSON.stringify(body.document) : null]);
      if (!documentResult.rowCount) throw new HttpError(409, "O projeto foi alterado em outra sessão. Recarregue antes de salvar novamente.");
      if (hasTheme || hasBranding) {
        await client.query(`
          UPDATE project_settings
             SET theme = CASE WHEN $2::boolean THEN $3::jsonb ELSE theme END,
                 branding = CASE WHEN $4::boolean THEN $5::jsonb ELSE branding END,
                 updated_at = now()
           WHERE project_id = $1
        `, [builderMatch[1], hasTheme, hasTheme ? JSON.stringify(body.theme) : null, hasBranding, hasBranding ? JSON.stringify(body.branding) : null]);
      }
      await client.query("UPDATE projects SET updated_at = now() WHERE id = $1", [builderMatch[1]]);
      const result = await loadBuilder(client, builderMatch[1], session.workspace_id);
      saved = builderPayload(result.rows[0]);
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
    return send(res, 200, saved, origin);
  }

  const projectMatch = path.match(/^\/api\/projects\/([0-9a-f-]+)$/i);
  if (req.method === "GET" && projectMatch) {
    const session = await requireSession(req);
    const result = await pool.query("SELECT * FROM projects WHERE id = $1 AND workspace_id = $2", [projectMatch[1], session.workspace_id]);
    if (!result.rowCount) throw new HttpError(404, "Projeto não encontrado.");
    return send(res, 200, { project: projectPayload(result.rows[0]) }, origin);
  }

  if (req.method === "GET" && path === "/api/dashboard") {
    const session = await requireSession(req);
    const result = await pool.query(`
      SELECT count(*) FILTER (WHERE status <> 'ARCHIVED')::int active_projects,
             count(*) FILTER (WHERE status = 'PUBLISHED')::int published_projects
        FROM projects WHERE workspace_id = $1
    `, [session.workspace_id]);
    return send(res, 200, { activeProjects: result.rows[0].active_projects, publishedProjects: result.rows[0].published_projects }, origin);
  }

  if (req.method === "GET" && path === "/api/platform") {
    const session = await requireSession(req);
    if (session.platform_role !== "PLATFORM_ADMIN") throw new HttpError(403, "Acesso exclusivo para administradores da plataforma.");
    return send(res, 200, { ok: true }, origin);
  }

  throw new HttpError(404, "Rota não encontrada.");
}

function reqWithCookie(req, setCookie) {
  const token = String(setCookie).match(new RegExp(`^${cookieName}=([^;]+)`))?.[1] ?? "";
  return { ...req, headers: { ...req.headers, cookie: `${cookieName}=${token}` } };
}

await migrate();
await pool.query("DELETE FROM sessions WHERE expires_at <= now()");

const server = createServer((req, res) => {
  handle(req, res).catch((error) => {
    const status = error instanceof HttpError ? error.status : 500;
    if (status === 500) console.error(error);
    send(res, status, { error: error instanceof HttpError ? error.message : "Erro interno do servidor." }, req.headers.origin);
  });
});

server.listen(port, "0.0.0.0", () => console.log(`AppForge API listening on ${port}`));

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.on(signal, () => server.close(() => pool.end().finally(() => process.exit(0))));
}
