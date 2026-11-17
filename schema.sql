-- =====================================================================
-- YRARBIL database for Supabase
-- Run this whole file once: Supabase dashboard > SQL Editor > New query > paste > Run.
--
-- Security model: the browser only holds the public (publishable) key, so the
-- tables are locked down and every action goes through the app_* functions
-- below. Each function checks the member's QR token on the server.
-- =====================================================================


-- 1. TABLES -----------------------------------------------------------

create table if not exists public.members (
  id         bigint generated always as identity primary key,
  name       text not null,
  token      text not null unique,            -- the text inside the member's QR card
  role       text not null default 'member' check (role in ('member', 'admin')),
  created_at timestamptz not null default now()
);

create table if not exists public.books (
  id         bigint generated always as identity primary key,
  code       text not null unique,            -- the text inside the book's QR label
  title      text not null,
  author     text not null,
  genre      text not null default 'General',
  created_at timestamptz not null default now()
);

create table if not exists public.loans (
  id          bigint generated always as identity primary key,
  member_id   bigint not null references public.members(id) on delete cascade,
  book_id     bigint not null references public.books(id) on delete cascade,
  borrowed_at timestamptz not null default now(),
  due_at      timestamptz not null,
  returned_at timestamptz,
  renewals    int not null default 0
);

-- A book can have only one active (not yet returned) loan.
create unique index if not exists one_active_loan_per_book
  on public.loans (book_id) where returned_at is null;

create table if not exists public.activity_log (
  id        bigint generated always as identity primary key,
  member_id bigint references public.members(id) on delete set null,
  text      text not null,
  at        timestamptz not null default now()
);


-- 2. LOCK THE TABLES --------------------------------------------------
-- Row Level Security on + no policies = the public key cannot read or write
-- the tables directly. Only the functions below can.

alter table public.members      enable row level security;
alter table public.books        enable row level security;
alter table public.loans        enable row level security;
alter table public.activity_log enable row level security;

revoke all on table public.members, public.books, public.loans, public.activity_log
  from anon, authenticated;


-- 3. PRIVATE HELPERS (not callable from the browser) ------------------

-- Keeps only the letters A-Z of a text, upper-cased.
create or replace function public._letters(t text)
returns text language sql immutable as $$
  select upper(regexp_replace(coalesce(t, ''), '[^A-Za-z]', '', 'g'))
$$;

-- Finds the member that owns a QR token (all-null row if none).
create or replace function public._member_by_token(p_token text)
returns public.members language sql stable security definer set search_path = public as $$
  select * from public.members where token = upper(trim(p_token)) limit 1
$$;

revoke execute on function public._letters(text), public._member_by_token(text)
  from public, anon, authenticated;


-- 4. APP FUNCTIONS (called by the website) ----------------------------

-- Log in: returns the member, or null if the QR token is unknown.
create or replace function public.app_login(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare me public.members;
begin
  me := public._member_by_token(p_token);
  if me.id is null then return null; end if;
  insert into public.activity_log (member_id, text) values (me.id, 'Logged in');
  return json_build_object('id', me.id, 'name', me.name, 'role', me.role);
end $$;

create or replace function public.app_logout(p_token text)
returns void language plpgsql security definer set search_path = public as $$
declare me public.members;
begin
  me := public._member_by_token(p_token);
  if me.id is not null then
    insert into public.activity_log (member_id, text) values (me.id, 'Logged out');
  end if;
end $$;

-- Sign up: creates a member with a token like "ANGELOCASTOR-9F3A1C".
create or replace function public.app_signup(p_name text)
returns json language plpgsql security definer set search_path = public as $$
declare v_name text := trim(coalesce(p_name, '')); v_token text; v_member public.members;
begin
  if v_name = '' or length(v_name) > 60 then
    raise exception 'Please enter your name (60 characters or fewer).';
  end if;
  loop
    v_token := coalesce(nullif(public._letters(v_name), ''), 'MEMBER') || '-' ||
               upper(substr(replace(gen_random_uuid()::text, '-', ''), 1, 6));
    exit when not exists (select 1 from public.members where token = v_token);
  end loop;
  insert into public.members (name, token) values (v_name, v_token) returning * into v_member;
  insert into public.activity_log (member_id, text) values (v_member.id, 'Signed up');
  return json_build_object('id', v_member.id, 'name', v_member.name, 'token', v_member.token, 'role', v_member.role);
end $$;

-- Everything the screen needs. Members only see their own borrower details;
-- librarians also get all loans, the activity log and the member cards.
create or replace function public.app_state(p_token text)
returns json language plpgsql security definer set search_path = public as $$
declare me public.members; is_admin boolean;
begin
  me := public._member_by_token(p_token);
  if me.id is null then return null; end if;
  is_admin := (me.role = 'admin');

  return json_build_object(
    'me', json_build_object('id', me.id, 'name', me.name, 'role', me.role),

    'books', (
      select coalesce(json_agg(json_build_object(
        'id', b.id, 'code', b.code, 'title', b.title, 'author', b.author, 'genre', b.genre,
        'loan', case when l.id is null then null else json_build_object(
          'mine', l.member_id = me.id,
          'member_name', case when is_admin or l.member_id = me.id then m.name end,
          'due_at', l.due_at, 'renewals', l.renewals) end
      ) order by b.id), '[]'::json)
      from public.books b
      left join public.loans l on l.book_id = b.id and l.returned_at is null
      left join public.members m on m.id = l.member_id),

    'loans', case when is_admin then (
      select coalesce(json_agg(json_build_object(
        'member_name', m.name, 'book_title', b.title, 'due_at', l.due_at, 'returned_at', l.returned_at
      ) order by l.id desc), '[]'::json)
      from public.loans l
      join public.members m on m.id = l.member_id
      join public.books b on b.id = l.book_id) else '[]'::json end,

    'log', case when is_admin then (
      select coalesce(json_agg(x order by x.at desc), '[]'::json)
      from (select a.at, m.name as member_name, a.text
            from public.activity_log a left join public.members m on m.id = a.member_id
            order by a.at desc limit 15) x) else '[]'::json end,

    'members', case when is_admin then (
      select coalesce(json_agg(json_build_object(
        'id', m.id, 'name', m.name, 'token', m.token, 'role', m.role) order by m.id), '[]'::json)
      from public.members m) else '[]'::json end
  );
end $$;

-- Borrow: 14 days, max 3 books, no borrowing while something is overdue.
create or replace function public.app_borrow(p_token text, p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare me public.members; b public.books; v_due timestamptz;
begin
  me := public._member_by_token(p_token);
  if me.id is null then raise exception 'Please log in again.'; end if;

  select * into b from public.books where code = upper(trim(p_code));
  if not found then raise exception 'Unknown book code.'; end if;

  if exists (select 1 from public.loans where book_id = b.id and returned_at is null) then
    raise exception 'That book is already borrowed.';
  end if;
  if exists (select 1 from public.loans where member_id = me.id and returned_at is null and due_at < now()) then
    raise exception 'Return your overdue books first.';
  end if;
  if (select count(*) from public.loans where member_id = me.id and returned_at is null) >= 3 then
    raise exception 'Limit reached: 3 books at a time.';
  end if;

  begin
    insert into public.loans (member_id, book_id, due_at)
    values (me.id, b.id, now() + interval '14 days') returning due_at into v_due;
  exception when unique_violation then
    raise exception 'That book is already borrowed.';
  end;

  insert into public.activity_log (member_id, text) values (me.id, 'Borrowed “' || b.title || '”');
  return json_build_object('title', b.title, 'due_at', v_due);
end $$;

-- Return: the borrower, or a librarian, can return a book.
create or replace function public.app_return(p_token text, p_code text)
returns json language plpgsql security definer set search_path = public as $$
declare me public.members; b public.books; l public.loans;
begin
  me := public._member_by_token(p_token);
  if me.id is null then raise exception 'Please log in again.'; end if;

  select * into b from public.books where code = upper(trim(p_code));
  if not found then raise exception 'Unknown book code.'; end if;

  select * into l from public.loans where book_id = b.id and returned_at is null;
  if not found then raise exception 'That book isn’t borrowed.'; end if;
  if l.member_id <> me.id and me.role <> 'admin' then
    raise exception 'That book is borrowed by someone else.';
  end if;

  update public.loans set returned_at = now() where id = l.id;
  insert into public.activity_log (member_id, text) values (me.id, 'Returned “' || b.title || '”');
  return json_build_object('title', b.title);
end $$;

-- Renew: once per loan, only if not overdue.
create or replace function public.app_renew(p_token text, p_book_id bigint)
returns json language plpgsql security definer set search_path = public as $$
declare me public.members; b public.books; l public.loans; v_due timestamptz;
begin
  me := public._member_by_token(p_token);
  if me.id is null then raise exception 'Please log in again.'; end if;

  select * into b from public.books where id = p_book_id;
  select * into l from public.loans where book_id = p_book_id and returned_at is null and member_id = me.id;
  if not found then raise exception 'You don’t have that book.'; end if;
  if l.due_at < now() then raise exception 'Overdue books can’t be renewed.'; end if;
  if l.renewals >= 1 then raise exception 'Already renewed once.'; end if;

  update public.loans set due_at = due_at + interval '14 days', renewals = renewals + 1
  where id = l.id returning due_at into v_due;
  insert into public.activity_log (member_id, text) values (me.id, 'Renewed “' || b.title || '”');
  return json_build_object('title', b.title, 'due_at', v_due);
end $$;

-- Add a book (librarians only). The QR code comes from the title letters + number.
create or replace function public.app_add_book(p_token text, p_title text, p_author text, p_genre text)
returns json language plpgsql security definer set search_path = public as $$
declare me public.members; b public.books; v_code text;
begin
  me := public._member_by_token(p_token);
  if me.id is null or me.role <> 'admin' then raise exception 'Librarians only.'; end if;
  if trim(coalesce(p_title, '')) = '' or trim(coalesce(p_author, '')) = '' then
    raise exception 'Title and author are required.';
  end if;

  insert into public.books (code, title, author, genre)
  values ('TMP-' || gen_random_uuid()::text, trim(p_title), trim(p_author),
          coalesce(nullif(trim(p_genre), ''), 'General'))
  returning * into b;

  update public.books
  set code = coalesce(nullif(left(public._letters(
               regexp_replace(trim(p_title), '^(the|a|an)\s+', '', 'i')), 6), ''), 'BOOK')
             || '-' || lpad(b.id::text, 4, '0')
  where id = b.id returning code into v_code;

  insert into public.activity_log (member_id, text) values (me.id, 'Added book “' || trim(p_title) || '”');
  return json_build_object('title', trim(p_title), 'code', v_code);
end $$;

-- The website (public key = "anon" role) may call only these functions.
revoke execute on function
  public.app_login(text), public.app_logout(text), public.app_signup(text), public.app_state(text),
  public.app_borrow(text, text), public.app_return(text, text), public.app_renew(text, bigint),
  public.app_add_book(text, text, text, text)
  from public;
grant execute on function
  public.app_login(text), public.app_logout(text), public.app_signup(text), public.app_state(text),
  public.app_borrow(text, text), public.app_return(text, text), public.app_renew(text, bigint),
  public.app_add_book(text, text, text, text)
  to anon;


-- 5. DEMO DATA (safe to run again) ------------------------------------

insert into public.members (name, token, role) values
  ('Angelo Castor',  'ANGELOCASTOR-7F3A',  'member'),
  ('Junalyn Nebria', 'JUNALYNNEBRIA-B20C', 'member'),
  ('Joshua Magalo',  'JOSHUAMAGALO-AD11',  'admin')
on conflict (token) do nothing;

insert into public.books (code, title, author, genre) values
  ('LEFTHA-0001', 'The Left Hand of Darkness', 'Ursula K. Le Guin', 'Sci-fi'),
  ('PRIDEA-0002', 'Pride and Prejudice',       'Jane Austen',       'Classic'),
  ('SAPIEN-0003', 'Sapiens',                   'Yuval Noah Harari', 'History'),
  ('EDUCAT-0004', 'Educated',                  'Tara Westover',     'Memoir'),
  ('HOBBIT-0005', 'The Hobbit',                'J.R.R. Tolkien',    'Fantasy'),
  ('CLEANC-0006', 'Clean Code',                'Robert C. Martin',  'Tech'),
  ('KITCHE-0007', 'Kitchen',                   'Banana Yoshimoto',  'Fiction'),
  ('BRIEFH-0008', 'A Brief History of Time',   'Stephen Hawking',   'Science')
on conflict (code) do nothing;

-- One overdue loan so the overdue state shows in the demo.
insert into public.loans (member_id, book_id, borrowed_at, due_at)
select m.id, b.id, now() - interval '20 days', now() - interval '6 days'
from public.members m, public.books b
where m.token = 'JUNALYNNEBRIA-B20C' and b.code = 'PRIDEA-0002'
on conflict do nothing;
