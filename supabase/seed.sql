-- Dados de exemplo em Itapetininga (opcional). Rode depois do schema.sql.
-- Sem dono (user_id nulo) e já aprovados: servem para demonstrar lista, mapa e correspondência.
-- Para testar conversas e entrega, crie anúncios reais com duas contas diferentes.
insert into public.reports
  (kind, species, custody, pet_name, sex, size, colors, breed, description, neighborhood, lat, lng, event_date, review_status, user_id)
values
  ('lost',  'dog',   null,          'Thor',  'male',    'medium', '{caramelo,branco}', 'SRD', 'Coleira vermelha, muito dócil. Fugiu durante os fogos.', 'Vila Rio Branco', -23.5872, -48.0418, current_date - 4, 'approved', null),
  ('found', 'dog',   'with_finder', null,    'male',    'medium', '{caramelo,branco}', null,  'Estava perto da praça, com coleira vermelha sem plaquinha.', 'Centro', -23.5913, -48.0485, current_date - 2, 'approved', null),
  ('lost',  'cat',   null,          'Mel',   'female',  'small',  '{tricolor}',        null,  'Castrada, tem uma mancha preta no nariz.', 'Jardim Itália', -23.6002, -48.0601, current_date - 7, 'approved', null),
  ('found', 'cat',   'sighted',     null,    'female',  'small',  '{tricolor}',        null,  'Vi no telhado da padaria duas noites seguidas.', 'Vila Nova Itapetininga', -23.6045, -48.0552, current_date - 5, 'approved', null),
  ('lost',  'dog',   null,          'Pipoca','female',  'small',  '{branco}',          'Poodle', 'Tosada recentemente, usa roupinha azul.', 'Jardim Fogaça', -23.5785, -48.0632, current_date - 1, 'approved', null),
  ('found', 'dog',   'with_finder', null,    'unknown', 'large',  '{preto}',           null,  'Cachorro grande andando na SP-127, levei para casa.', 'Chapadinha', -23.5680, -48.0275, current_date - 3, 'approved', null),
  ('lost',  'dog',   null,          'Bob',   'male',    'large',  '{preto,marrom}',    'Rottweiler', 'Muito amigável. Atende pelo nome.', 'Vila Belo Horizonte', -23.5950, -48.0350, current_date - 6, 'approved', null),
  ('found', 'other', 'sighted',     null,    'unknown', 'small',  '{cinza}',           null,  'Calopsita pousou na janela e voou de novo.', 'Taboãozinho', -23.6110, -48.0440, current_date, 'approved', null);
