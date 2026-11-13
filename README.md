# PetSOS

Sistema web inteligente para correspondência de animais perdidos e encontrados em Itapetininga e região (Engenharia de Software III, Fatec Itapetininga).

- **Front-end:** HTML5, CSS3 e JavaScript puro (módulos ES), mapa com Leaflet + OpenStreetMap
- **Back-end:** funções serverless em Python na Vercel (`/api`) + regras de negócio no PostgreSQL (RLS, gatilhos e funções)
- **Banco, autenticação, tempo real e fotos:** Supabase (PostgreSQL + Auth + Realtime + Storage)
- **Versionamento e deploy:** GitHub → Vercel (deploy contínuo a cada push)

## Papéis

| Papel | Pode |
|---|---|
| Visitante | Ver anúncios aprovados, mapa e animais parecidos |
| Usuário | Anunciar (publica na hora com e-mail confirmado), editar, renovar, encerrar ou excluir os próprios anúncios, conversar, iniciar e confirmar entrega, denunciar, bloquear, escolher avisos, baixar os dados e excluir a conta |
| Administrador | Revisar anúncios antes ou depois de publicados, analisar denúncias, ler conversas, cancelar entregas, excluir qualquer anúncio |

## Fluxos principais

**Anúncio:** com e-mail confirmado, é publicado na hora e entra na revisão posterior; sem confirmação, fica `pendente` até o admin aprovar. O admin pode retirar do ar com motivo, e a pessoa corrige e reenvia (volta para `pendente`). Anúncios vencem em 60 dias e podem ser renovados.

**Duas situações de quem encontrou ou viu o animal:**
- Anúncio *encontrado*: "Sim, está comigo" (`with_finder`) ou "Não, só vi" (`sighted`).
- Mensagem em anúncio *perdido*: "O animal está comigo" (`has_pet`) ou "Vi o animal" (`sighted`).

Só existe entrega quando o animal **está com alguém**. Avistamentos servem para trocar informação.

**Entrega com dupla confirmação:**
1. Tutor e quem está com o animal conversam pelo PetSOS.
2. Quem está com o animal inicia a entrega: guardamos uma cópia congelada da conversa, consultada se houver denúncia.
3. Quem está com o animal confirma que entregou; o tutor confirma que recebeu.
4. Com as duas confirmações, o anúncio vira `reencontrado`. Ninguém consegue marcar isso de outro jeito.
5. Se houver denúncia, o admin pode cancelar a entrega com motivo; depois ela pode ser iniciada de novo.
6. Se a outra pessoa também anunciou o mesmo animal (o "perdido" do tutor ou o "encontrado" de quem estava com ele), esse anúncio par vira `reencontrado` junto. O par é o único anúncio aberto dela com tipo oposto e mesma espécie; com dois ou mais candidatos, nada é fechado automaticamente.

Anúncios reencontrados ficam na página inicial por 30 dias, com o selo "Finalizado!", e depois saem da lista.

Diagramas: `docs/arquitetura.puml` (6.7) e `docs/entrega-atividades.puml` (6.2.3).

## Requisitos

| Código | Requisito funcional | Onde |
|---|---|---|
| RF01 | Criar conta (nome, e-mail, senha) e entrar | `/entrar` |
| RF02 | Anunciar animal perdido ou encontrado, informando se o animal está com a pessoa ou só foi visto | `/anunciar` |
| RF03 | Moderar anúncios antes ou depois de publicados (aprovar/retirar com motivo) e denúncias | `/admin` |
| RF04 | Listar anúncios aprovados com filtros e mapa | `/` |
| RF05 | Ver detalhes e animais parecidos (correspondência inteligente) | `/anuncio`, `/api/matches` |
| RF06 | Conversar com quem anunciou, informando se viu ou está com o animal | `/anuncio`, `/conversa` |
| RF07 | Caixa de mensagens com status da entrega | `/conversas` |
| RF08 | Iniciar a entrega (quem está com o animal), com cópia congelada da conversa | `/conversa` |
| RF09 | Denunciar conversa ou anúncio, bloquear pessoa; admin analisa e pode cancelar a entrega | `/conversa`, `/anuncio`, `/admin` |
| RF10 | Confirmar entrega (quem está com o animal) e recebimento (tutor); marcar reencontrado só com as duas | `/conversa` |
| RF11 | Editar, renovar, encerrar ou excluir o próprio anúncio; painel do caso | `/anunciar?editar=`, `/anuncio`, `/meus` |
| RF12 | Receber avisos no site e por e-mail (mensagem, parecido, entrega, bairro acompanhado) | `/meus`, `/conta`, `/api/notify` |
| RF13 | Compartilhar anúncio com prévia de link e imprimir cartaz com QR code | `/a/<id>`, `/cartaz` |
| RF14 | Comparar dois anúncios lado a lado e responder "Não é este animal" | `/comparar` |
| RF15 | Recuperar senha, baixar os dados e excluir a conta | `/entrar`, `/nova-senha`, `/conta` |

| Código | Requisito não funcional | Como é atendido |
|---|---|---|
| RNF01 | Usabilidade em celular (375 px em diante) | layout responsivo, menu recolhido, alvos de toque de 44 px |
| RNF02 | Acessibilidade | rótulos visíveis, foco visível, abas e diálogos por teclado, contraste AA, `prefers-reduced-motion` |
| RNF03 | Segurança e integridade | RLS em todas as tabelas, gatilho que impede autoaprovação e devolve à revisão anúncios editados, limites de volume (10 anúncios e 20 conversas por dia, 30 mensagens por minuto), uma entrega em andamento por anúncio, transições de entrega só por funções no banco, contato só pelo chat interno, CSP e integridade dos scripts de CDN, testes automatizados das regras e das telas |
| RNF07 | Privacidade | localização gravada com ~100 m de precisão (nunca o ponto exato), foto refeita no navegador sem EXIF, visitante não lê `user_id`, telefone não é exibido, retenção de ~12 meses, exclusão de conta |
| RNF04 | Rastreabilidade | cópia congelada da conversa ao iniciar a entrega, quem revisou e quando, horário de cada confirmação |
| RNF05 | Desempenho | site estático em CDN, paginação no servidor, miniaturas leves, índices para correspondência e filas, Realtime em vez de recarregar a página |
| RNF06 | Custo baixo | funciona nos planos gratuitos para teste e demonstração, mapa OSM, correspondência sem API paga (ver "Antes de abrir ao público") |

## Modelo de dados

```
profiles (id, display_name, role: user|admin, email_alerts)
reports  (id, user_id, has_owner, kind: lost|found, custody: with_finder|sighted, species, sex, size, colors[], ...,
          photo_path, thumb_path, status: open|reunited|closed, review_status: pending|approved|rejected, review_note,
          reviewed_at, reviewed_by, expires_at, matched_at, expiry_warned_at)
conversations (id, report_id, asker_id, owner_id, asker_context: inquiry|sighted|has_pet)   1 por pessoa por anúncio
messages (id, conversation_id, sender_id, body)
handovers (id, conversation_id, report_id, finder_id, claimant_id, status: approved|rejected|completed,
           transcript (jsonb), admin_note, reviewed_by, reviewed_at, finder_confirmed_at, claimant_confirmed_at, linked_report_id)
notifications (id, user_id, kind, report_id, other_report_id, conversation_id, body, read_at, emailed_at)
flags (id, reporter_id, report_id | conversation_id, reason, status: open|resolved)
blocks (blocker_id, blocked_id)
matches (report_id, other_report_id, score)     match_feedback (user_id, report_id, other_report_id, same_animal)
area_alerts (id, user_id, neighborhood)         photo_deletions (path)
```

Funções do banco (chamadas com `supabase.rpc`): `start_conversation`, `request_handover`, `cancel_handover`, `confirm_handover`, `renew_report`, `delete_my_account`, `admin_metrics`. Elas validam quem pode fazer cada passo e em que ordem; o navegador não grava em `handovers` diretamente.

## Correspondência inteligente

`api/_matching.py` compara um anúncio com os aprovados do tipo oposto:

1. **Eliminatórias:** mesma espécie, tipo oposto, aberto, aprovado, sexo compatível, e o "encontrado" não pode ser mais de 2 dias anterior ao "perdido".
2. **Pontuação (0 a 1):** cores (Jaccard, 30%), distância (decaimento exponencial, 3 km, 30%), porte (15%), tempo entre sumiço e encontro (15%), sexo (10%).
3. Resultados com nota ≥ 0,35, ordenados, com motivos em português. A interface mostra faixas (Muito parecido, Parecido, Pode ser), não percentuais, e leva à comparação lado a lado.

`/api/notify` repete a comparação quando um anúncio é publicado ou editado e avisa os donos a partir de nota 0,60, uma vez por par e nunca para um par recusado com "Não é este animal".

A função repassa o token do usuário ao banco, então o dono vê correspondências do próprio anúncio mesmo antes da aprovação.

**Fase futura (similaridade de imagem):** implemente a interface `ImageSimilarity` (`compare_many(report, candidates) -> {id: nota}`, em lote), registre em `IMAGE_MATCHERS` e defina `PETSOS_IMAGE_MATCHER` na Vercel. O peso da imagem (35%) entra e os demais são renormalizados. Caminho sugerido: um processo separado gera os embeddings das fotos (ex.: CLIP) e grava numa coluna `vector` (pgvector); a função só consulta por similaridade de cosseno. Avalie com fotos reais antes de ligar: o CLIP mede semelhança geral, não identifica um animal específico.

Testes: `python3 tests/test_matching.py -v` e `python3 tests/test_jobs.py -v` (tarefas de segundo plano e prévia de link).

Regras do banco (RLS, gatilhos, entrega): `supabase/tests/run.sh` num PostgreSQL 16 vazio (instruções no cabeçalho do script). 

Telas (largura, alvos de toque, CSP, formulário, EXIF, reconexão do chat), com back-end falso: `npm i --no-save puppeteer-core && node tests/e2e/smoke.mjs` (Chrome em `CHROME_PATH`). O GitHub Actions roda tudo a cada push e pull request.

## Como rodar

### 1. Supabase
1. Crie um projeto em https://supabase.com.
2. Em **SQL Editor**, rode `supabase/schema.sql` e, se quiser dados de exemplo, `supabase/seed.sql`. (Rodou a versão anterior? Execute primeiro o bloco RESET no fim do `schema.sql`.) Banco criado antes de uma mudança no schema: rode, em ordem, os arquivos de `supabase/updates/` com data posterior à criação.
3. Em **Authentication > Providers > Email**, deixe o e-mail habilitado e *Confirm email* ligado: é a confirmação que libera a publicação imediata. Para abrir ao público, configure SMTP próprio em **Authentication > Emails**, porque o serviço padrão só entrega para a equipe do projeto.
4. Em **Authentication > URL Configuration**, coloque a URL da Vercel em *Site URL* e, em *Redirect URLs*, `http://localhost:3000/**` e a URL da Vercel com `/**` (necessário para o link de nova senha).
5. Crie sua conta no site e torne-se administrador no SQL Editor:
   ```sql
   update public.profiles set role = 'admin'
   where id = (select id from auth.users where email = 'seu-email@exemplo.com');
   ```
6. Copie *Project URL* e *anon public key* em **Project Settings > API**.

Os anúncios do `seed.sql` não têm dono, então não aceitam conversa. Para testar conversa e entrega, use duas contas (por exemplo, uma janela anônima).

### 2. Vercel
1. Importe `makodoy/PetSOS` em https://vercel.com/new (framework: **Other**, sem build command).
2. Em **Settings > Environment Variables**, adicione as variáveis de `.env.example`. Só `SUPABASE_URL` e `SUPABASE_ANON_KEY` são obrigatórias para o site abrir; sem as demais, não há comparação em segundo plano nem e-mails.
3. Deploy. Cada push na `main` gera um deploy; cada pull request ganha uma URL de pré-visualização.
4. A Vercel chama `/api/notify` uma vez por dia. Para avisos em poucos segundos, crie no Supabase, em **Database > Webhooks**, dois webhooks `POST` para `https://SEU-SITE/api/notify` com o cabeçalho `Authorization: Bearer <CRON_SECRET>`: um em `notifications` (Insert) e outro em `reports` (Insert e Update).

### Antes de abrir ao público
- Preencher o contato do responsável pelos dados em `privacidade.html` e revisar a política e os termos com quem entende de LGPD.
- Configurar SMTP próprio no Supabase e o provedor de avisos (`RESEND_API_KEY`, `EMAIL_FROM`).
- Rever os planos: o gratuito do Supabase pausa projetos sem uso e não é pensado para produção; o Hobby da Vercel é só para uso não comercial.
- Definir backup do banco e mais de um administrador.
- Rever o provedor de mapa: os tiles do OpenStreetMap têm política de uso e podem ser bloqueados sem aviso (a URL fica em `assets/js/map.js`, e a CSP em `vercel.json`).

### 3. Local
```bash
npm i -g vercel
cp .env.example .env.local   # preencha as chaves
vercel dev                   # http://localhost:3000
```

## Estrutura

```
index.html  anunciar.html  anuncio.html  comparar.html  cartaz.html    anúncios
entrar.html  nova-senha.html  conta.html  meus.html                    conta e acompanhamento
conversas.html  conversa.html                                          mensagens e entrega
admin.html  privacidade.html  termos.html                              moderação e textos legais
assets/css/styles.css                                                  tokens e componentes
assets/js/                                                             um módulo por página + supabase.js, ui.js, map.js, photo.js
api/config.py  api/matches.py  api/_matching.py                        configuração e correspondência
api/notify.py  api/_jobs.py  api/share.py  api/log.py  api/_supabase.py  tarefas, prévia de link, erros
supabase/schema.sql  supabase/seed.sql                                 banco, RLS, funções, storage, exemplos
supabase/updates/                                                      atualizações para bancos já criados
docs/arquitetura.puml  docs/entrega-atividades.puml                    diagramas
tests/test_matching.py  tests/test_jobs.py  tests/e2e/                 testes do motor, das tarefas e das telas
supabase/tests/                                                        testes das regras do banco
.github/workflows/ci.yml                                               integração contínua
```

## Decisões de arquitetura

| Decisão | Por quê | Custo aceito |
|---|---|---|
| Supabase (PostgreSQL) no lugar de MySQL | Banco, autenticação, tempo real, storage e RLS num serviço gratuito | Atualizar a seção 6.3 do documento |
| Vercel no lugar de Docker + NGINX | CDN, HTTPS, proxy e deploy contínuo prontos | Sem `Dockerfile` |
| Regras de moderação e entrega no banco (RLS, gatilhos, funções) | Valem para qualquer cliente; o navegador não consegue pular etapas | Lógica em SQL/PLpgSQL, versionada em `schema.sql` |
| Chat interno no lugar do WhatsApp | A conversa precisa ser revisável pelo admin e o telefone fica privado | Depende dos avisos por e-mail para a pessoa saber que há mensagem |
| Publicação imediata para e-mail confirmado, com revisão depois | Nas primeiras horas o alerta vale mais; denúncia, limites de volume e revisão posterior seguram abusos | Conteúdo ruim pode ficar no ar até a revisão |
| Entrega sem aprovação prévia do admin | Nada impede o encontro antes da aprovação, então a etapa prometia um controle que não existe e travava a conversa | O admin só atua com denúncia; confirmação continua dupla |
| Foto refeita no navegador | Remove EXIF sem servidor de imagens e reduz o peso no celular | Quem usa a API direto pode enviar outro arquivo; o objetivo é evitar vazamento acidental |
| Tarefas em `/api/notify` chamadas por webhook | Sem servidor próprio nem fila externa; as mesmas tarefas rodam no cron diário | Webhook precisa ser criado à mão no Supabase |
| Cópia congelada da conversa ao iniciar a entrega | Em caso de denúncia, há registro do que foi combinado | Guarda mensagens mesmo sem denúncia |
| Python só para a correspondência | É o diferencial do projeto, isolado e testável | Uma ida extra à rede na página do anúncio |
| Distância em Python (haversine), sem PostGIS | Volume de uma cidade cabe no pré-filtro por espécie, tipo e data | Rever com PostGIS se crescer |

O que revisar quando crescer: notificações push, anexar fotos no chat, PostGIS e a similaridade de imagem.
