# PetSOS — contexto para o Claude

Protótipo acadêmico (Engenharia de Software III, Fatec Itapetininga, 2º sem/2026) de um sistema web para correspondência de animais perdidos e encontrados em Itapetininga e região. Autor: Rodrigo Makoto Ozaki. UI e textos em **português (pt-BR)**. Repositório: https://github.com/makodoy/PetSOS. Deploy: Vercel + Supabase.

## Stack (não adicionar ferramentas sem necessidade)
- Front-end: HTML5 + CSS3 + JavaScript puro (módulos ES), sem framework e sem build. Leaflet 1.9.4 (cdnjs) + tiles CARTO. supabase-js 2.45.4 (jsdelivr UMD).
- Back-end: funções Python serverless na Vercel em `api/` (só stdlib, sem requirements.txt).
- Banco/Auth/Realtime/Storage: Supabase (PostgreSQL). **Regras de negócio ficam no banco** (RLS, gatilhos, funções `security definer`).
- O documento acadêmico cita MySQL, Docker e NGINX; foram substituídos conscientemente (Supabase = PostgreSQL; Vercel faz CDN/HTTPS/proxy/deploy). A seção 6.3 do documento precisa refletir isso.

## Estrutura
```
index.html anunciar.html anuncio.html entrar.html meus.html conversas.html conversa.html admin.html
assets/css/styles.css           tokens + componentes (fonte única de cores)
assets/js/                      supabase.js (cliente, getProfile, REPORT_FIELDS), ui.js (header, helpers, confirmDialog,
                                errorText), constants.js (rótulos pt-BR), map.js, um módulo por página
                                (home, report-form, report-detail, auth, mine, inbox, conversation, admin)
api/config.py                   expõe SUPABASE_URL/ANON_KEY das env vars
api/matches.py, api/_matching.py  motor de correspondência (repassa o token do usuário ao PostgREST)
supabase/schema.sql             schema v2 completo (tem bloco RESET no fim) ; supabase/seed.sql (8 anúncios sem dono)
docs/arquitetura.puml, docs/entrega-atividades.puml   diagramas para as seções 6.7 e 6.2.3
tests/test_matching.py          `python3 tests/test_matching.py -v`
supabase/tests/                 stubs do Supabase + testes das regras do banco (`run.sh`, ver cabeçalho)
.github/workflows/ci.yml        CI: testes Python + regras do banco em PostgreSQL 16
vercel.json                     cleanUrls, includeFiles do _matching.py, headers
```
Cabeçalho (`<header class="site-header">`) é repetido em cada HTML: ao mudar, mudar em todos. URLs sem `.html` (`/anuncio?id=`).

## Domínio e regras (aplicadas no banco — não duplicar só no front)
- Papéis: `profiles.role` = `user` | `admin`. Admin é definido via SQL (ver README). `is_admin()` usado nas políticas.
- Anúncio: `kind` lost|found; encontrado exige `custody` = `with_finder` ("está comigo") | `sighted` ("só vi").
- Moderação: todo anúncio nasce `review_status = pending` (gatilho `reports_guard` força). Público vê só `approved`; dono e admin veem os seus/todos. Recusa tem `review_note`. Editar conteúdo depois volta para `pending`; `kind`, `species` e `custody` não mudam depois de criado.
- Localização: `reports_guard` arredonda `lat`/`lng` para 3 casas (~100 m) sempre; o ponto exato nunca é gravado (o formulário arredonda igual, para o pino mostrar o que será publicado).
- Status: `open` → `closed` (dono pode) ou `reunited` (**somente** via `confirm_handover`).
- Conversa: uma por pessoa por anúncio (`unique(report_id, asker_id)`); `owner_id` vem do anúncio (gatilho). `asker_context`: anúncio perdido → `sighted` | `has_pet`; encontrado → `inquiry`.
- Entrega (`handovers`), só quando o animal está com alguém (found+with_finder, ou lost+has_pet):
  1. `request_handover(conversation_id)` — só quem está com o animal; exige mensagens dos dois lados; grava cópia congelada (`transcript`).
  2. `review_handover(id, approve, note)` — só admin; recusa exige motivo; recusada pode ser reenviada.
  3. `confirm_handover(id)` — finder e tutor confirmam (anúncio precisa estar `open`); com as duas confirmações → `completed` e anúncio `reunited`.
  - No máximo uma entrega `under_review`/`approved` por anúncio (índice único parcial + checagem em `request_handover`).
- Clientes nunca escrevem em `handovers` diretamente. Contato é só pelo chat interno (WhatsApp removido de propósito: conversa precisa ser revisável).
- Excluir anúncio apaga conversas e entregas em cascata (decisão a confirmar; alternativa: soft delete).

## Correspondência
`api/_matching.py`: eliminatórias (espécie, tipo oposto, aberto, aprovado, sexo compatível, encontrado ≤ 2 dias antes do perdido) + pontuação ponderada (cores 30%, distância 30% decaimento 3 km, porte 15%, tempo 15%, sexo 10%), corte 0,35.
**Inovação futura:** similaridade de imagem plugável via `ImageSimilarity` / `IMAGE_MATCHERS` / env `PETSOS_IMAGE_MATCHER` (peso 35%, renormaliza). Sugestão: embeddings CLIP em pgvector. Nesta fase: **sem custo de API**.

## Design (não quebrar)
- Paleta fixa (tokens em `:root` de styles.css, com modo escuro): canvas #F4F5F2, surface #FFFFFF, sunken #ECEEEA, ink #1D2420, ink-muted #58635D, **acento único cobalto #2547B8** (só elementos interativos/foco), status perdido #A8321F, encontrado #2A6B45. Nunca adicionar cores fora dos tokens. Distribuição 60-30-10.
- Elevação: borda 1px sutil primeiro; sombras com alpha < 0.08. Listas/tabelas sempre em painel L1 com divisórias.
- Anti-slop: sem gradientes em botões, sem blur/glassmorphism, sem ilustrações cartoon, sem pílulas em metadados estáticos, sem ícones decorativos em inputs, sem rótulos ALL CAPS, sem "→" em botões, sem "A · B · C".
- Tipografia: Archivo (títulos, condensada via font-stretch) + Atkinson Hyperlegible (corpo).
- UX: rótulos visíveis, validação no blur e erro some ao corrigir, botões com verbo ("Enviar para aprovação", "Confirmar que recebi"), erros sem culpar o usuário e com saída, ações destrutivas com diálogo nomeado (`confirmDialog`), alvos ≥ 44px, funciona de 375px a 1280px, menu recolhido em ≤ 760px, `prefers-reduced-motion`.
- `SKILL.md` na raiz = guia de design do autor (ignorado no git). Se conflitar com as regras acima, as regras acima vencem.

## Como testar
- Motor: `python3 tests/test_matching.py -v`.
- Banco: `supabase/tests/run.sh` (Postgres 16 vazio; com Docker, ver o cabeçalho do script). `stubs.sql` imita `auth.uid()`, roles `anon`/`authenticated`, `storage` e `supabase_realtime`; `rules_test.sql` troca de papel com `t.as_user()` e testa moderação, edição, localização e o fluxo de entrega. Regra nova no banco → teste novo ali.
- CI no GitHub Actions roda os dois a cada push/PR.
- Local completo: `vercel dev` com `.env.local` (ver `.env.example`).
- Não testado ainda em Supabase real: login, Realtime do chat e upload de fotos.

## Pendências / próximos passos
- Rodar schema.sql no Supabase, criar conta, virar admin, testar com duas contas.
- Push para o GitHub e deploy na Vercel (env vars `SUPABASE_URL`, `SUPABASE_ANON_KEY`).
- Notificações (e-mail/push) de mensagem e de animal parecido; fotos no chat; denúncia de mensagens; paginação no servidor; PostGIS se crescer; similaridade de imagem.
- Documento acadêmico: preencher 6.1 (tabelas RF/RNF estão no README), 6.2 (diagramas), 6.3 (tecnologias), 6.7 (arquitetura), 7.2 (link do repositório).

## Convenções
- Commits e push só quando o autor pedir.
- Preferir correção da causa raiz a gambiarras; mudanças pequenas e verificáveis.
