ALTER TABLE users ADD COLUMN onboarding_preference varchar(80);

ALTER TABLE project_settings
  ADD COLUMN pwa_display varchar(20) NOT NULL DEFAULT 'standalone'
    CHECK (pwa_display IN ('fullscreen', 'standalone', 'minimal-ui', 'browser')),
  ADD COLUMN pwa_offline boolean NOT NULL DEFAULT false;

CREATE TABLE project_collections (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name varchar(120) NOT NULL,
  slug varchar(140) NOT NULL,
  fields jsonb NOT NULL DEFAULT '[]'::jsonb CHECK (jsonb_typeof(fields) = 'array'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, slug)
);

CREATE TABLE project_records (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  collection_id uuid NOT NULL REFERENCES project_collections(id) ON DELETE CASCADE,
  data jsonb NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(data) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX project_collections_project_idx ON project_collections(project_id, updated_at DESC);
CREATE INDEX project_records_collection_idx ON project_records(collection_id, created_at DESC);

CREATE TABLE project_releases (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  project_id uuid NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  version integer NOT NULL CHECK (version > 0),
  status varchar(16) NOT NULL CHECK (status IN ('QUEUED', 'BUILDING', 'READY', 'FAILED')),
  url text NOT NULL,
  snapshot jsonb NOT NULL CHECK (jsonb_typeof(snapshot) = 'object'),
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (project_id, version)
);

CREATE INDEX project_releases_project_created_idx ON project_releases(project_id, created_at DESC);

UPDATE templates
   SET definition = jsonb_set(
     definition,
     '{collections}',
     $json$
     [
       {
         "name": "Clientes",
         "slug": "clientes",
         "fields": [
           { "id": "clientes-nome", "name": "Nome", "key": "nome", "type": "text", "required": true },
           { "id": "clientes-email", "name": "Email", "key": "email", "type": "email", "required": true },
           { "id": "clientes-telefone", "name": "Telefone", "key": "telefone", "type": "text", "required": false },
           { "id": "clientes-ativo", "name": "Ativo", "key": "ativo", "type": "boolean", "required": false }
         ]
       },
       {
         "name": "Serviços",
         "slug": "servicos",
         "fields": [
           { "id": "servicos-nome", "name": "Nome", "key": "nome", "type": "text", "required": true },
           { "id": "servicos-descricao", "name": "Descrição", "key": "descricao", "type": "text", "required": false },
           { "id": "servicos-preco", "name": "Preço", "key": "preco", "type": "number", "required": true },
           { "id": "servicos-ativo", "name": "Ativo", "key": "ativo", "type": "boolean", "required": false }
         ]
       },
       {
         "name": "Profissionais",
         "slug": "profissionais",
         "fields": [
           { "id": "profissionais-nome", "name": "Nome", "key": "nome", "type": "text", "required": true },
           { "id": "profissionais-email", "name": "Email", "key": "email", "type": "email", "required": true },
           { "id": "profissionais-especialidade", "name": "Especialidade", "key": "especialidade", "type": "text", "required": false },
           { "id": "profissionais-ativo", "name": "Ativo", "key": "ativo", "type": "boolean", "required": false }
         ]
       },
       {
         "name": "Agendamentos",
         "slug": "agendamentos",
         "fields": [
           { "id": "agendamentos-cliente", "name": "Cliente", "key": "cliente", "type": "text", "required": true },
           { "id": "agendamentos-servico", "name": "Serviço", "key": "servico", "type": "text", "required": true },
           { "id": "agendamentos-data", "name": "Data", "key": "data", "type": "datetime", "required": true },
           { "id": "agendamentos-status", "name": "Status", "key": "status", "type": "text", "required": true }
         ]
       }
     ]
     $json$::jsonb,
     true
   ),
       updated_at = now()
 WHERE slug = 'barber-premium';

UPDATE templates
   SET definition = jsonb_set(
     definition,
     '{pwa}',
     jsonb_build_object(
       'name', COALESCE(definition #>> '{branding,appName}', name),
       'shortName', left(COALESCE(definition #>> '{branding,appName}', name), 32),
       'themeColor', COALESCE(definition #>> '{theme,primaryColor}', '#315CFF'),
       'backgroundColor', COALESCE(definition #>> '{theme,backgroundColor}', '#090A0F'),
       'display', 'standalone',
       'offline', true
     ),
     true
   ),
       updated_at = now()
 WHERE is_active = true;

INSERT INTO project_collections (project_id, name, slug, fields)
SELECT p.id, item ->> 'name', item ->> 'slug', item -> 'fields'
  FROM projects p
  JOIN templates t ON t.id = p.template_id
 CROSS JOIN LATERAL jsonb_array_elements(COALESCE(t.definition -> 'collections', '[]'::jsonb)) item
ON CONFLICT (project_id, slug) DO NOTHING;

UPDATE project_documents pd
   SET document = jsonb_set(pd.document, '{modules}', COALESCE(t.definition -> 'recommendedModules', '[]'::jsonb), true),
       updated_at = now(),
       revision = revision + 1
  FROM projects p
  JOIN templates t ON t.id = p.template_id
 WHERE pd.project_id = p.id
   AND NOT (pd.document ? 'modules');

UPDATE project_settings ps
   SET pwa_name = COALESCE(ps.pwa_name, t.definition #>> '{pwa,name}'),
       pwa_short_name = COALESCE(ps.pwa_short_name, t.definition #>> '{pwa,shortName}'),
       pwa_theme_color = COALESCE(ps.pwa_theme_color, t.definition #>> '{pwa,themeColor}'),
       pwa_background_color = COALESCE(ps.pwa_background_color, t.definition #>> '{pwa,backgroundColor}'),
       pwa_display = COALESCE(t.definition #>> '{pwa,display}', ps.pwa_display),
       pwa_offline = COALESCE((t.definition #>> '{pwa,offline}')::boolean, ps.pwa_offline),
       updated_at = now()
  FROM projects p
  JOIN templates t ON t.id = p.template_id
 WHERE ps.project_id = p.id
   AND t.definition ? 'pwa';
