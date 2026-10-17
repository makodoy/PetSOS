-- Imitação mínima do que o Supabase já traz pronto, para rodar schema.sql num PostgreSQL 16 vazio.
-- auth.uid() lê request.jwt.claim.sub, como no Supabase; os testes trocam de usuário com set_config.

create role anon nologin;
create role authenticated nologin;

create schema auth;
create table auth.users (
  id                 uuid primary key,
  email              text not null,
  raw_user_meta_data jsonb not null default '{}'
);
create function auth.uid() returns uuid language sql stable as $$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid
$$;
grant usage on schema auth to anon, authenticated;

create schema storage;
create table storage.buckets (
  id text primary key, name text, public boolean, file_size_limit bigint, allowed_mime_types text[]
);
create table storage.objects (id uuid primary key default gen_random_uuid(), bucket_id text, name text);
alter table storage.objects enable row level security;
create function storage.foldername(name text) returns text[] language sql immutable as $$
  select (string_to_array(name, '/'))[1:array_length(string_to_array(name, '/'), 1) - 1]
$$;

set client_min_messages = error; -- sem aviso de wal_level: o Realtime não é testado aqui
create publication supabase_realtime;
reset client_min_messages;

-- O Supabase concede tudo nas tabelas de public; quem limita é a RLS.
grant usage on schema public to anon, authenticated;
alter default privileges in schema public grant all on tables to anon, authenticated;
alter default privileges in schema public grant all on sequences to anon, authenticated;
