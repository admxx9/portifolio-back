import assert from "node:assert/strict";
import { pool } from "../src/db.mjs";

const baseUrl = process.env.API_URL ?? "http://127.0.0.1:3001/api";
const stamp = Date.now();
const email = `smoke-${stamp}@appforge.local`;
const password = "AppForge-Smoke-2026!";
let cookie = "";

async function request(path, init = {}) {
  const response = await fetch(`${baseUrl}${path}`, {
    ...init,
    headers: { "Content-Type": "application/json", ...(cookie ? { Cookie: cookie } : {}), ...init.headers },
  });
  const setCookie = response.headers.get("set-cookie");
  if (setCookie) cookie = setCookie.split(";", 1)[0];
  const body = await response.json();
  return { response, body };
}

async function call(path, init = {}) {
  const { response, body } = await request(path, init);
  assert.ok(response.ok, `${response.status}: ${body.error}`);
  return body;
}

async function expectError(path, status, init = {}) {
  const result = await request(path, init);
  assert.equal(result.response.status, status, JSON.stringify(result.body));
  return result.body;
}

function heroTitle(document) {
  return document.pages.flatMap((page) => page.sections).find((section) => section.type === "hero")?.props.title;
}

try {
  const registered = await call("/auth/register", { method: "POST", body: JSON.stringify({ name: "Smoke Test", email, password }) });
  assert.equal(registered.user.onboardingCompleted, false);
  assert.equal(registered.user.onboardingPreference, null);
  const onboarded = await call("/onboarding", { method: "PATCH", body: JSON.stringify({ preference: "Barbearia" }) });
  assert.equal(onboarded.user.onboardingCompleted, true);
  assert.equal(onboarded.user.onboardingPreference, "Barbearia");

  const catalog = await call("/templates");
  assert.ok(catalog.templates.length >= 3);
  const barber = catalog.templates.find((template) => template.slug === "barber-premium");
  assert.ok(barber, "Template barber-premium não encontrado.");
  assert.equal(heroTitle(barber.definition.document), "SharpCuts");

  const created = await call("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "WR Barber", slug: `wr-barber-${stamp}`, templateId: barber.id }),
  });
  assert.equal(created.project.templateId, barber.id);
  const initialBuilder = await call(`/projects/${created.project.id}/builder`);
  assert.equal(heroTitle(initialBuilder.document), "SharpCuts");
  assert.equal(initialBuilder.settings.theme.primaryColor, barber.definition.theme.primaryColor);
  assert.deepEqual(initialBuilder.document.modules, barber.definition.recommendedModules);

  const editedDocument = structuredClone(initialBuilder.document);
  editedDocument.pages.flatMap((page) => page.sections).find((section) => section.type === "hero").props.title = "WR Barber";
  editedDocument.pages[0].sections.push({
    id: "testimonials-smoke",
    type: "testimonials",
    props: { title: "O que nossos clientes dizem", items: [] },
    styles: { padding: "64px 24px" },
    responsiveStyles: {},
    bindings: {},
    actions: {},
  });
  const saved = await call(`/projects/${created.project.id}/builder`, {
    method: "PATCH",
    body: JSON.stringify({
      document: editedDocument,
      theme: { ...initialBuilder.settings.theme, primaryColor: "#E11D48" },
      expectedRevision: initialBuilder.revision,
    }),
  });
  assert.equal(saved.revision, initialBuilder.revision + 1);
  assert.equal(heroTitle(saved.document), "WR Barber");
  assert.equal(saved.settings.theme.primaryColor, "#E11D48");

  await expectError(`/projects/${created.project.id}/builder`, 409, {
    method: "PATCH",
    body: JSON.stringify({ branding: { appName: "Conflito" }, expectedRevision: initialBuilder.revision }),
  });
  await expectError(`/projects/${created.project.id}/builder`, 422, {
    method: "PATCH",
    body: JSON.stringify({ document: [] }),
  });

  const reloaded = await call(`/projects/${created.project.id}/builder`);
  assert.equal(heroTitle(reloaded.document), "WR Barber");
  assert.equal(reloaded.settings.theme.primaryColor, "#E11D48");
  assert.ok(reloaded.document.pages[0].sections.some((section) => section.id === "testimonials-smoke"));

  const seededCollections = await call(`/projects/${created.project.id}/collections`);
  assert.deepEqual(
    seededCollections.collections.map((collection) => collection.name).sort(),
    ["Agendamentos", "Clientes", "Profissionais", "Serviços"].sort(),
  );
  const clients = seededCollections.collections.find((collection) => collection.slug === "clientes");
  assert.ok(clients);
  const clientsWithBirthday = await call(`/projects/${created.project.id}/collections/${clients.id}`, {
    method: "PATCH",
    body: JSON.stringify({
      fields: [...clients.fields, { id: "clientes-nascimento", name: "Nascimento", key: "nascimento", type: "date", required: false }],
    }),
  });
  assert.ok(clientsWithBirthday.collection.fields.some((field) => field.key === "nascimento"));
  const clientRecord = await call(`/projects/${created.project.id}/collections/${clients.id}/records`, {
    method: "POST",
    body: JSON.stringify({ data: { nome: "Maria Silva", email: "maria@example.com", telefone: "11999990000", ativo: true, nascimento: "1990-05-10" } }),
  });
  assert.equal(clientRecord.record.data.nome, "Maria Silva");
  const updatedRecord = await call(`/projects/${created.project.id}/collections/${clients.id}/records/${clientRecord.record.id}`, {
    method: "PATCH",
    body: JSON.stringify({ data: { telefone: "11888880000" } }),
  });
  assert.equal(updatedRecord.record.data.telefone, "11888880000");
  const recordsReloaded = await call(`/projects/${created.project.id}/collections/${clients.id}/records?q=Maria&limit=10&offset=0`);
  assert.equal(recordsReloaded.total, 1);
  assert.equal(recordsReloaded.records[0].data.nome, "Maria Silva");
  const collectionsReloaded = await call(`/projects/${created.project.id}/collections`);
  assert.equal(collectionsReloaded.collections.find((collection) => collection.id === clients.id).recordCount, 1);

  const leads = await call(`/projects/${created.project.id}/collections`, {
    method: "POST",
    body: JSON.stringify({ name: "Leads", fields: [{ name: "Nome", key: "nome", type: "text", required: true }] }),
  });
  assert.equal(leads.collection.recordCount, 0);
  assert.equal((await call(`/projects/${created.project.id}/collections/${leads.collection.id}`, { method: "DELETE" })).ok, true);

  const pwaDefault = await call(`/projects/${created.project.id}/pwa`);
  assert.equal(pwaDefault.pwa.name, "SharpCuts");
  assert.equal(pwaDefault.pwa.offline, true);
  const pwaSaved = await call(`/projects/${created.project.id}/pwa`, {
    method: "PATCH",
    body: JSON.stringify({
      pwa: {
        name: "WR Barber",
        shortName: "WR Barber",
        themeColor: "#E11D48",
        backgroundColor: "#090A0F",
        display: "standalone",
        offline: true,
      },
    }),
  });
  assert.equal(pwaSaved.pwa.manifest.name, "WR Barber");
  assert.equal(pwaSaved.pwa.manifest.theme_color, "#E11D48");
  const pwaReloaded = await call(`/projects/${created.project.id}/pwa`);
  assert.deepEqual(pwaReloaded.pwa, pwaSaved.pwa);

  await expectError(`/apps/${created.project.id}`, 404);
  const firstRelease = await call(`/projects/${created.project.id}/releases`, { method: "POST" });
  assert.equal(firstRelease.release.version, 1);
  assert.equal(firstRelease.release.status, "READY");
  assert.equal(firstRelease.release.url, `/apps/${created.project.id}`);
  assert.equal(heroTitle(firstRelease.release.snapshot.document), "WR Barber");
  assert.equal(firstRelease.release.snapshot.theme.primaryColor, "#E11D48");
  assert.equal(firstRelease.release.snapshot.pwa.name, "WR Barber");
  const authenticatedCookie = cookie;
  cookie = "";
  const publicApp = await call(`/apps/${created.project.id}`);
  cookie = authenticatedCookie;
  assert.equal(publicApp.app.version, 1);
  assert.equal(heroTitle(publicApp.app.snapshot.document), "WR Barber");

  const v2Document = structuredClone(reloaded.document);
  v2Document.pages.flatMap((page) => page.sections).find((section) => section.type === "hero").props.title = "WR Barber v2";
  await call(`/projects/${created.project.id}/builder`, {
    method: "PATCH",
    body: JSON.stringify({ document: v2Document, expectedRevision: reloaded.revision }),
  });
  const secondRelease = await call(`/projects/${created.project.id}/releases`, { method: "POST" });
  assert.equal(secondRelease.release.version, 2);
  const releases = await call(`/projects/${created.project.id}/releases`);
  assert.deepEqual(releases.releases.map((release) => release.version), [2, 1]);
  assert.equal(heroTitle(releases.releases[1].snapshot.document), "WR Barber");
  assert.equal(heroTitle(releases.releases[0].snapshot.document), "WR Barber v2");
  cookie = "";
  const latestPublicApp = await call(`/apps/${created.project.id}`);
  cookie = authenticatedCookie;
  assert.equal(latestPublicApp.app.version, 2);
  assert.equal(heroTitle(latestPublicApp.app.snapshot.document), "WR Barber v2");

  const freshCatalog = await call("/templates");
  const unchangedTemplate = freshCatalog.templates.find((template) => template.id === barber.id);
  assert.equal(heroTitle(unchangedTemplate.definition.document), "SharpCuts");
  assert.equal(unchangedTemplate.definition.theme.primaryColor, barber.definition.theme.primaryColor);

  const second = await call("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Barbearia Clone", slug: `barbearia-clone-${stamp}`, templateId: barber.id }),
  });
  const secondBuilder = await call(`/projects/${second.project.id}/builder`);
  assert.equal(heroTitle(secondBuilder.document), "SharpCuts");
  assert.equal(secondBuilder.settings.theme.primaryColor, barber.definition.theme.primaryColor);
  assert.deepEqual(secondBuilder.document.modules, barber.definition.recommendedModules);
  const secondCollections = await call(`/projects/${second.project.id}/collections`);
  assert.equal(secondCollections.collections.length, 4);
  assert.equal(secondCollections.collections.find((collection) => collection.slug === "clientes").recordCount, 0);
  assert.ok(!secondCollections.collections.find((collection) => collection.slug === "clientes").fields.some((field) => field.key === "nascimento"));

  const blank = await call("/projects", {
    method: "POST",
    body: JSON.stringify({ name: "Projeto em Branco", slug: `projeto-branco-${stamp}` }),
  });
  const blankBuilder = await call(`/projects/${blank.project.id}/builder`);
  assert.equal(blankBuilder.document.pages[0].name, "Home");
  assert.deepEqual(blankBuilder.document.pages[0].sections, []);

  await pool.query("UPDATE workspace_members SET role = 'VIEWER' WHERE workspace_id = $1 AND user_id = $2", [registered.workspace.id, registered.user.id]);
  await expectError(`/projects/${created.project.id}/builder`, 403, {
    method: "PATCH",
    body: JSON.stringify({ branding: { appName: "Sem permissão" } }),
  });
  await pool.query("UPDATE workspace_members SET role = 'OWNER' WHERE workspace_id = $1 AND user_id = $2", [registered.workspace.id, registered.user.id]);

  await call("/auth/logout", { method: "POST", body: "{}" });
  const loggedIn = await call("/auth/login", { method: "POST", body: JSON.stringify({ email, password }) });
  assert.equal(loggedIn.user.onboardingCompleted, true);
  assert.equal(loggedIn.user.onboardingPreference, "Barbearia");
  const listed = await call("/projects");
  assert.equal(listed.projects.length, 3);
  assert.equal(listed.projects.find((project) => project.id === created.project.id).status, "PUBLISHED");
  console.log("Smoke test passed: builder, data/schema, PWA, immutable releases, public snapshot and onboarding preference.");
} finally {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("DELETE FROM workspaces WHERE owner_id = (SELECT id FROM users WHERE email = $1)", [email]);
    await client.query("DELETE FROM users WHERE email = $1", [email]);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
    await pool.end();
  }
}
