CREATE TABLE project_documents (
  project_id uuid PRIMARY KEY REFERENCES projects(id) ON DELETE CASCADE,
  document jsonb NOT NULL CHECK (jsonb_typeof(document) = 'object'),
  revision integer NOT NULL DEFAULT 1 CHECK (revision > 0),
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

INSERT INTO templates (id, name, slug, description, category, thumbnail, definition, is_active)
VALUES
  (
    '11111111-1111-4111-8111-111111111111',
    'Barbearia Premium',
    'barber-premium',
    'Agendamento e apresentação profissional para barbearias.',
    'Barbearia',
    NULL,
    $json$
    {
      "document": {
        "version": 1,
        "homePageId": "home",
        "pages": [
          {
            "id": "home",
            "name": "Home",
            "slug": "",
            "isHome": true,
            "sections": [
              {
                "id": "hero-main",
                "type": "hero",
                "props": {
                  "eyebrow": "BARBEARIA PREMIUM",
                  "title": "SharpCuts",
                  "subtitle": "Cortes precisos, atendimento impecável e agendamento em poucos segundos.",
                  "primaryAction": { "label": "Agendar agora", "href": "#servicos" },
                  "secondaryAction": { "label": "Ver serviços", "href": "#servicos" }
                },
                "styles": {
                  "alignment": "center",
                  "padding": "80px 24px",
                  "background": "#090A0F",
                  "color": "#F5F7FF"
                },
                "responsiveStyles": { "mobile": { "padding": "48px 20px" } },
                "bindings": {},
                "actions": {}
              },
              {
                "id": "services-main",
                "type": "services",
                "props": {
                  "title": "Serviços em destaque",
                  "items": [
                    { "title": "Corte Premium", "description": "Consultoria de estilo e acabamento.", "price": "R$ 70" },
                    { "title": "Barba", "description": "Toalha quente e acabamento preciso.", "price": "R$ 45" },
                    { "title": "Combo", "description": "Cabelo e barba no mesmo horário.", "price": "R$ 105" }
                  ]
                },
                "styles": { "padding": "64px 24px", "background": "#11131C" },
                "responsiveStyles": {},
                "bindings": {},
                "actions": {}
              },
              {
                "id": "cta-booking",
                "type": "cta",
                "props": {
                  "title": "Pronto para renovar o visual?",
                  "text": "Escolha um serviço e reserve seu horário.",
                  "action": { "label": "Agendar horário", "href": "#agendamento" }
                },
                "styles": { "padding": "56px 24px", "alignment": "center" },
                "responsiveStyles": {},
                "bindings": {},
                "actions": {}
              }
            ]
          },
          {
            "id": "servicos",
            "name": "Serviços",
            "slug": "servicos",
            "isHome": false,
            "sections": []
          }
        ]
      },
      "theme": {
        "primaryColor": "#315CFF",
        "secondaryColor": "#7047EB",
        "backgroundColor": "#090A0F",
        "surfaceColor": "#11131C",
        "textColor": "#F5F7FF",
        "headingFont": "Geist",
        "bodyFont": "Geist",
        "radius": "12px",
        "buttonStyle": "solid"
      },
      "branding": { "appName": "SharpCuts", "logoUrl": null },
      "recommendedModules": ["services", "professionals", "appointments"]
    }
    $json$::jsonb,
    true
  ),
  (
    '22222222-2222-4222-8222-222222222222',
    'Beauty Studio',
    'beauty-studio',
    'Portfólio elegante e agendamento para estúdios de beleza.',
    'Beleza',
    NULL,
    $json$
    {
      "document": {
        "version": 1,
        "homePageId": "home",
        "pages": [
          {
            "id": "home",
            "name": "Home",
            "slug": "",
            "isHome": true,
            "sections": [
              {
                "id": "hero-main",
                "type": "hero",
                "props": {
                  "eyebrow": "BEAUTY STUDIO",
                  "title": "Sua beleza, do seu jeito",
                  "subtitle": "Tratamentos personalizados em um ambiente acolhedor.",
                  "primaryAction": { "label": "Reservar horário", "href": "#servicos" }
                },
                "styles": { "alignment": "left", "padding": "80px 24px", "background": "#171217", "color": "#FFF7FB" },
                "responsiveStyles": {},
                "bindings": {},
                "actions": {}
              },
              {
                "id": "gallery-main",
                "type": "gallery",
                "props": { "title": "Resultados que inspiram", "items": [] },
                "styles": { "padding": "64px 24px" },
                "responsiveStyles": {},
                "bindings": {},
                "actions": {}
              }
            ]
          }
        ]
      },
      "theme": {
        "primaryColor": "#E879A9",
        "secondaryColor": "#B78AF0",
        "backgroundColor": "#100D11",
        "surfaceColor": "#171217",
        "textColor": "#FFF7FB",
        "headingFont": "Geist",
        "bodyFont": "Geist",
        "radius": "18px",
        "buttonStyle": "solid"
      },
      "branding": { "appName": "Beauty Studio", "logoUrl": null },
      "recommendedModules": ["services", "professionals", "appointments"]
    }
    $json$::jsonb,
    true
  ),
  (
    '33333333-3333-4333-8333-333333333333',
    'Sabor Express',
    'sabor-express',
    'Cardápio direto e conversão rápida para restaurantes e delivery.',
    'Alimentação',
    NULL,
    $json$
    {
      "document": {
        "version": 1,
        "homePageId": "home",
        "pages": [
          {
            "id": "home",
            "name": "Home",
            "slug": "",
            "isHome": true,
            "sections": [
              {
                "id": "hero-main",
                "type": "hero",
                "props": {
                  "eyebrow": "SABOR EXPRESS",
                  "title": "Seu pedido favorito, sem espera",
                  "subtitle": "Conheça o cardápio e peça em poucos cliques.",
                  "primaryAction": { "label": "Ver cardápio", "href": "#cardapio" }
                },
                "styles": { "alignment": "center", "padding": "72px 24px", "background": "#16110C", "color": "#FFF8EF" },
                "responsiveStyles": {},
                "bindings": {},
                "actions": {}
              },
              {
                "id": "menu-main",
                "type": "services",
                "props": { "title": "Mais pedidos", "items": [] },
                "styles": { "padding": "64px 24px" },
                "responsiveStyles": {},
                "bindings": {},
                "actions": {}
              }
            ]
          }
        ]
      },
      "theme": {
        "primaryColor": "#F97316",
        "secondaryColor": "#FACC15",
        "backgroundColor": "#0F0C09",
        "surfaceColor": "#16110C",
        "textColor": "#FFF8EF",
        "headingFont": "Geist",
        "bodyFont": "Geist",
        "radius": "14px",
        "buttonStyle": "solid"
      },
      "branding": { "appName": "Sabor Express", "logoUrl": null },
      "recommendedModules": ["services", "payments", "coupons"]
    }
    $json$::jsonb,
    true
  )
ON CONFLICT (slug) DO UPDATE SET
  name = EXCLUDED.name,
  description = EXCLUDED.description,
  category = EXCLUDED.category,
  thumbnail = EXCLUDED.thumbnail,
  definition = EXCLUDED.definition,
  is_active = EXCLUDED.is_active,
  updated_at = now();

INSERT INTO project_documents (project_id, document)
SELECT
  id,
  $json$
  {
    "version": 1,
    "homePageId": "home",
    "pages": [
      {
        "id": "home",
        "name": "Home",
        "slug": "",
        "isHome": true,
        "sections": []
      }
    ]
  }
  $json$::jsonb
FROM projects
ON CONFLICT (project_id) DO NOTHING;
