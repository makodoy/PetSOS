# PetSOS

Protótipo do sistema web inteligente para correspondência de animais perdidos e encontrados em Itapetininga e região (Engenharia de Software III, Fatec Itapetininga).

- **Front-end:** HTML5, CSS3 e JavaScript puro (módulos ES), mapa com Leaflet + OpenStreetMap
- **Back-end:** funções serverless em Python na Vercel (`/api`) + regras de negócio no PostgreSQL (RLS, gatilhos e funções)
- **Banco, autenticação, tempo real e fotos:** Supabase (PostgreSQL + Auth + Realtime + Storage)
- **Versionamento e deploy:** GitHub → Vercel (deploy contínuo a cada push)

## Papéis

| Papel | Pode |
|---|---|
| Visitante | Ver anúncios aprovados, mapa e animais parecidos |
| Usuário | Anunciar (fica pendente), conversar, enviar conversa para revisão, confirmar entrega/recebimento, encerrar ou excluir os próprios anúncios |
| Administrador | Aprovar ou recusar anúncios, ler conversas, liberar ou recusar entregas, excluir qualquer anúncio |

## Fluxos principais

**Anúncio:** usuário envia → `pendente` (só ele e admins veem) → admin aprova (público) ou recusa com motivo.

**Duas situações de quem encontrou ou viu o animal:**
- Anúncio *encontrado*: "Sim, está comigo" (`with_finder`) ou "Não, só vi" (`sighted`).
- Mensagem em anúncio *perdido*: "O animal está comigo" (`has_pet`) ou "Vi o animal" (`sighted`).

Só existe entrega quando o animal **está com alguém**. Avistamentos servem para trocar informação.

**Entrega com dupla confirmação:**
1. Tutor e quem está com o animal conversam pelo PetSOS.
2. Quem está com o animal envia a conversa para revisão: uma cópia congelada vai para o admin.
3. Admin libera a entrega ou recusa com motivo (pode ser reenviada).
4. Quem está com o animal confirma que entregou; o tutor confirma que recebeu.
5. Com as duas confirmações, o anúncio vira `reencontrado`. Ninguém consegue marcar isso de outro jeito.
6. Se a outra pessoa também anunciou o mesmo animal (o "perdido" do tutor ou o "encontrado" de quem estava com ele), esse anúncio par vira `reencontrado` junto. O par é o único anúncio aberto dela com tipo oposto e mesma espécie; com dois ou mais candidatos, nada é fechado automaticamente.

Anúncios reencontrados ficam na página inicial por 30 dias, com o selo "Finalizado!", e depois saem da lista.

Diagramas: `docs/arquitetura.puml` (6.7) e `docs/entrega-atividades.puml` (6.2.3).

## Requisitos

| Código | Requisito funcional | Onde |
|---|---|---|
| RF01 | Criar conta (nome, e-mail, senha) e entrar | `/entrar` |
| RF02 | Anunciar animal perdido ou encontrado, informando se o animal está com a pessoa ou só foi visto | `/anunciar` |
| RF03 | Moderar anúncios (aprovar/recusar com motivo) | `/admin` |
| RF04 | Listar anúncios aprovados com filtros e mapa | `/` |
| RF05 | Ver detalhes e animais parecidos (correspondência inteligente) | `/anuncio`, `/api/matches` |
| RF06 | Conversar com quem anunciou, informando se viu ou está com o animal | `/anuncio`, `/conversa` |
| RF07 | Caixa de mensagens com status da entrega | `/conversas` |
| RF08 | Enviar conversa para revisão do admin (quem está com o animal) | `/conversa` |
| RF09 | Revisar a conversa e liberar ou recusar a entrega | `/admin` |
| RF10 | Confirmar entrega (quem está com o animal) e recebimento (tutor); marcar reencontrado só com as duas | `/conversa` |
| RF11 | Encerrar ou excluir o próprio anúncio | `/anuncio`, `/meus` |

| Código | Requisito não funcional | Como é atendido |
|---|---|---|
| RNF01 | Usabilidade em celular (375 px em diante) | layout responsivo, menu recolhido, alvos de toque de 44 px |
| RNF02 | Acessibilidade | rótulos visíveis, foco visível, abas e diálogos por teclado, contraste AA, `prefers-reduced-motion` |
| RNF03 | Segurança e integridade | RLS em todas as tabelas, gatilho que impede autoaprovação e devolve à moderação anúncios editados, uma entrega em andamento por anúncio, transições de entrega só por funções no banco, contato só pelo chat interno, testes automatizados das regras |
| RNF07 | Privacidade | localização gravada com ~100 m de precisão (nunca o ponto exato), telefone não é exibido |
| RNF04 | Rastreabilidade | cópia congelada da conversa enviada à revisão, quem revisou e quando, horário de cada confirmação |
| RNF05 | Desempenho | site estático em CDN, índices para correspondência e filas de moderação, Realtime em vez de recarregar a página |
| RNF06 | Custo zero no protótipo | planos gratuitos da Vercel e do Supabase, mapa OSM, correspondência sem API paga |

## Modelo de dados

```
profiles (id, display_name, role: user|admin)
reports  (id, user_id, kind: lost|found, custody: with_finder|sighted, species, sex, size, colors[], ...,
          status: open|reunited|closed, review_status: pending|approved|rejected, review_note)
conversations (id, report_id, asker_id, owner_id, asker_context: inquiry|sighted|has_pet)   1 por pessoa por anúncio
messages (id, conversation_id, sender_id, body)
handovers (id, conversation_id, report_id, finder_id, claimant_id,
           status: under_review|approved|rejected|completed, transcript (jsonb), admin_note,
           reviewed_by, reviewed_at, finder_confirmed_at, claimant_confirmed_at)
```

Funções do banco (chamadas com `supabase.rpc`): `request_handover`, `review_handover`, `confirm_handover`. Elas validam quem pode fazer cada passo e em que ordem; o navegador não grava em `handovers` diretamente.

## Correspondência inteligente

`api/_matching.py` compara um anúncio com os aprovados do tipo oposto:

1. **Eliminatórias:** mesma espécie, tipo oposto, aberto, aprovado, sexo compatível, e o "encontrado" não pode ser mais de 2 dias anterior ao "perdido".
2. **Pontuação (0 a 1):** cores (Jaccard, 30%), distância (decaimento exponencial, 3 km, 30%), porte (15%), tempo entre sumiço e encontro (15%), sexo (10%).
3. Resultados com nota ≥ 0,35, ordenados, com motivos em português.

A função repassa o token do usuário ao banco, então o dono vê correspondências do próprio anúncio mesmo antes da aprovação.

**Fase futura (similaridade de imagem):** implemente a interface `ImageSimilarity` (`compare(a, b) -> float | None`), registre em `IMAGE_MATCHERS` e defina `PETSOS_IMAGE_MATCHER` na Vercel. O peso da imagem (35%) entra e os demais são renormalizados. Caminho sugerido: embeddings das fotos (ex.: CLIP) numa coluna `vector` (pgvector) e similaridade de cosseno.

Testes: `python3 tests/test_matching.py -v`

Regras do banco (RLS, gatilhos, entrega): `supabase/tests/run.sh` num PostgreSQL 16 vazio (instruções no cabeçalho do script). O GitHub Actions roda os dois testes a cada push e pull request.

## Como rodar

### 1. Supabase
1. Crie um projeto em https://supabase.com.
2. Em **SQL Editor**, rode `supabase/schema.sql` e, se quiser dados de exemplo, `supabase/seed.sql`. (Rodou a versão anterior? Execute primeiro o bloco RESET no fim do `schema.sql`.) Banco criado antes de uma mudança no schema: rode, em ordem, os arquivos de `supabase/updates/` com data posterior à criação.
3. Em **Authentication > Providers > Email**, deixe o e-mail habilitado. Para demonstrações, desligue *Confirm email*.
4. Em **Authentication > URL Configuration**, coloque a URL da Vercel em *Site URL* e `http://localhost:3000` em *Redirect URLs*.
5. Crie sua conta no site e torne-se administrador no SQL Editor:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'seu-email@exemplo.com');
   ```
6. Copie *Project URL* e *anon public key* em **Project Settings > API**.

Os anúncios do `seed.sql` não têm dono, então não aceitam conversa. Para testar conversa e entrega, use duas contas (por exemplo, uma janela anônima).

### 2. Vercel
1. Importe `makodoy/PetSOS` em https://vercel.com/new (framework: **Other**, sem build command).
2. Em **Settings > Environment Variables**, adicione `SUPABASE_URL` e `SUPABASE_ANON_KEY`.
3. Deploy. Cada push na `main` gera um deploy; cada pull request ganha uma URL de pré-visualização.

### 3. Local
```bash
npm i -g vercel
cp .env.example .env.local   # preencha as chaves
vercel dev                   # http://localhost:3000
```

## Estrutura

```
index.html  anunciar.html  anuncio.html  entrar.html  meus.html     páginas públicas e do usuário
conversas.html  conversa.html                                       mensagens e entrega
admin.html                                                          moderação
assets/css/styles.css                                               tokens e componentes
assets/js/                                                          um módulo por página + supabase.js, ui.js, map.js
api/config.py  api/matches.py  api/_matching.py                     funções Python
supabase/schema.sql  supabase/seed.sql                              banco, RLS, funções, storage, exemplos
supabase/updates/                                                   atualizações para bancos já criados
docs/arquitetura.puml  docs/entrega-atividades.puml                 diagramas
tests/test_matching.py                                              testes do motor
supabase/tests/                                                     testes das regras do banco
.github/workflows/ci.yml                                            integração contínua
```

## Decisões de arquitetura

| Decisão | Por quê | Custo aceito |
|---|---|---|
| Supabase (PostgreSQL) no lugar de MySQL | Banco, autenticação, tempo real, storage e RLS num serviço gratuito | Atualizar a seção 6.3 do documento |
| Vercel no lugar de Docker + NGINX | CDN, HTTPS, proxy e deploy contínuo prontos | Sem `Dockerfile` neste protótipo |
| Regras de moderação e entrega no banco (RLS, gatilhos, funções) | Valem para qualquer cliente; o navegador não consegue pular etapas | Lógica em SQL/PLpgSQL, versionada em `schema.sql` |
| Chat interno no lugar do WhatsApp | A conversa precisa ser revisável pelo admin e o telefone fica privado | Sem notificação fora do site no protótipo |
| Cópia congelada da conversa na revisão | O admin aprova exatamente o que leu | Mensagens posteriores exigem novo envio se a revisão for recusada |
| Python só para a correspondência | É o diferencial do projeto, isolado e testável | Uma ida extra à rede na página do anúncio |
| Distância em Python (haversine), sem PostGIS | Volume de uma cidade cabe no pré-filtro por espécie, tipo e data | Rever com PostGIS se crescer |

O que revisar quando crescer: notificações (e-mail/push) de mensagem e de animal parecido, anexar fotos no chat, denúncia de mensagens, paginação no servidor, PostGIS e a similaridade de imagem.
