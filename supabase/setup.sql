-- =====================================================================
--  منصة فصل الأبطال — إعداد قاعدة البيانات في Supabase
--  الصق هذا الملف كاملاً في: SQL Editor ← New query ← Run
--  آمن لإعادة التشغيل (لا يحذف بياناتك).
-- =====================================================================

-- ---------- الجداول ----------
create table if not exists public.teachers (
  uid uuid primary key references auth.users(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.students (
  id text primary key,
  name text not null,
  username text not null unique,
  pin text not null,
  qr text not null unique,
  ava text not null default '🦁',
  star boolean not null default false,
  created bigint,
  sort int not null default 0
);

create table if not exists public.student_sessions (
  uid uuid primary key references auth.users(id) on delete cascade,
  student_id text not null references public.students(id) on delete cascade,
  created_at timestamptz not null default now()
);

create table if not exists public.docs (
  col text not null,
  id text not null,
  data jsonb not null,
  sid text generated always as (data->>'sid') stored,
  updated_at timestamptz not null default now(),
  primary key (col, id)
);
create index if not exists docs_sid_idx on public.docs (sid);

create table if not exists public.login_attempts (
  key text primary key,
  fails int not null default 0,
  locked_until timestamptz
);

-- ---------- دوال مساعدة ----------
create or replace function public.is_teacher() returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.teachers where uid = auth.uid());
$$;

create or replace function public.my_student_id() returns text
language sql stable security definer set search_path = public as $$
  select student_id from public.student_sessions where uid = auth.uid();
$$;

-- أول حساب معلم (غير مجهول) يسجّل الدخول يصبح هو المعلم، ولا يتغير بعدها
create or replace function public.claim_teacher() returns boolean
language plpgsql security definer set search_path = public as $$
begin
  if auth.uid() is null then return false; end if;
  if exists (select 1 from auth.users where id = auth.uid() and coalesce(is_anonymous, false)) then return false; end if;
  if exists (select 1 from public.teachers where uid = auth.uid()) then return true; end if;
  if exists (select 1 from public.teachers) then return false; end if;
  insert into public.teachers (uid) values (auth.uid());
  return true;
end $$;

-- تسجيل محاولة خاطئة (قفل 10 دقائق بعد 8 محاولات)
create or replace function public._fail(k text) returns void
language sql security definer set search_path = public as $$
  insert into public.login_attempts (key, fails) values (k, 1)
  on conflict (key) do update set
    fails = case when public.login_attempts.fails + 1 >= 8 then 0 else public.login_attempts.fails + 1 end,
    locked_until = case when public.login_attempts.fails + 1 >= 8 then now() + interval '10 minutes' else public.login_attempts.locked_until end;
$$;

create or replace function public._locked(k text) returns boolean
language sql stable security definer set search_path = public as $$
  select exists (select 1 from public.login_attempts where key = k and locked_until > now());
$$;

create or replace function public._bind(p_sid text) returns void
language sql security definer set search_path = public as $$
  insert into public.student_sessions (uid, student_id) values (auth.uid(), p_sid)
  on conflict (uid) do update set student_id = excluded.student_id, created_at = now();
$$;

-- دخول الطالب باسم المستخدم والرقم السري
create or replace function public.student_login(p_username text, p_pin text) returns json
language plpgsql security definer set search_path = public as $$
declare s public.students; ku text := 'u:' || lower(trim(coalesce(p_username, ''))); kd text := 'd:' || coalesce(auth.uid()::text, '');
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'no_session'); end if;
  if public._locked(ku) or public._locked(kd) then return json_build_object('ok', false, 'error', 'locked'); end if;
  select * into s from public.students where username = lower(trim(p_username)) and pin = trim(p_pin);
  if s.id is null then
    perform public._fail(ku); perform public._fail(kd);
    return json_build_object('ok', false, 'error', 'bad');
  end if;
  delete from public.login_attempts where key in (ku, kd);
  perform public._bind(s.id);
  return json_build_object('ok', true, 'id', s.id);
end $$;

-- دخول الطالب بالباركود
create or replace function public.student_login_qr(p_token text) returns json
language plpgsql security definer set search_path = public as $$
declare s public.students; kd text := 'd:' || coalesce(auth.uid()::text, '');
begin
  if auth.uid() is null then return json_build_object('ok', false, 'error', 'no_session'); end if;
  if public._locked(kd) then return json_build_object('ok', false, 'error', 'locked'); end if;
  select * into s from public.students where qr = trim(p_token) and length(trim(p_token)) >= 16;
  if s.id is null then perform public._fail(kd); return json_build_object('ok', false, 'error', 'bad'); end if;
  perform public._bind(s.id);
  return json_build_object('ok', true, 'id', s.id);
end $$;

-- خروج الطالب من هذا الجهاز
create or replace function public.student_logout() returns void
language sql security definer set search_path = public as $$
  delete from public.student_sessions where uid = auth.uid();
$$;

-- أسماء طلاب الفصل فقط (بدون الأرقام السرية) للمتصدرين ولوحة الأبطال
create or replace function public.class_roster() returns table (id text, name text, ava text, star boolean, sort int, created bigint)
language sql stable security definer set search_path = public as $$
  select id, name, ava, star, sort, created from public.students
  where public.is_teacher() or public.my_student_id() is not null
  order by sort, created;
$$;

-- حماية: الطالب لا يغيّر تقييمه، ولا يحذف رسائل المعلم
create or replace function public.docs_guard() returns trigger
language plpgsql set search_path = public as $$
begin
  if not public.is_teacher() and tg_op = 'UPDATE' then
    if new.col = 'subs' and ((new.data->'rating') is distinct from (old.data->'rating') or (new.data->'ratedAt') is distinct from (old.data->'ratedAt')) then
      raise exception 'not allowed';
    end if;
    if new.col = 'threads' and (
      select coalesce(jsonb_agg(e order by o), '[]'::jsonb)
      from jsonb_array_elements(coalesce(new.data->'msgs', '[]'::jsonb)) with ordinality t(e, o)
      where o <= jsonb_array_length(coalesce(old.data->'msgs', '[]'::jsonb))
    ) is distinct from coalesce(old.data->'msgs', '[]'::jsonb) then
      raise exception 'not allowed';
    end if;
  end if;
  new.updated_at = now();
  return new;
end $$;
drop trigger if exists docs_guard on public.docs;
create trigger docs_guard before insert or update on public.docs for each row execute function public.docs_guard();

-- ---------- الصلاحيات (RLS) ----------
alter table public.teachers enable row level security;
alter table public.students enable row level security;
alter table public.student_sessions enable row level security;
alter table public.docs enable row level security;
alter table public.login_attempts enable row level security;

drop policy if exists teachers_self on public.teachers;
create policy teachers_self on public.teachers for select to authenticated using (uid = auth.uid());

drop policy if exists students_teacher on public.students;
create policy students_teacher on public.students for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists docs_teacher on public.docs;
create policy docs_teacher on public.docs for all to authenticated using (public.is_teacher()) with check (public.is_teacher());

drop policy if exists docs_student_read on public.docs;
create policy docs_student_read on public.docs for select to authenticated using (
  public.my_student_id() is not null and (
    col in ('menus','games','sheets','videos','stories','heroes','assign','custom','scores')
    or sid = public.my_student_id()
  ));

drop policy if exists docs_student_insert on public.docs;
create policy docs_student_insert on public.docs for insert to authenticated with check (
  public.my_student_id() is not null and (
    (col in ('scores','subs','threads','gstore') and sid = public.my_student_id() and (col <> 'subs' or data->>'rating' is null))
    or (col = 'notifs' and coalesce(data->>'go', '') in ('quran','results','suggest'))
  ));

drop policy if exists docs_student_update on public.docs;
create policy docs_student_update on public.docs for update to authenticated
  using (public.my_student_id() is not null and col in ('subs','threads','gstore') and sid = public.my_student_id())
  with check (col in ('subs','threads','gstore') and sid = public.my_student_id());

drop policy if exists docs_student_delete on public.docs;
create policy docs_student_delete on public.docs for delete to authenticated
  using (public.my_student_id() is not null and col = 'subs' and sid = public.my_student_id());

revoke all on public.login_attempts from anon, authenticated;
revoke all on public.student_sessions from anon, authenticated;
revoke all on function public._fail(text) from public, anon, authenticated;
revoke all on function public._locked(text) from public, anon, authenticated;
revoke all on function public._bind(text) from public, anon, authenticated;
grant execute on function public.is_teacher(), public.my_student_id(), public.claim_teacher(),
  public.student_login(text, text), public.student_login_qr(text), public.student_logout(), public.class_roster() to authenticated;

-- ---------- الملفات: التسجيلات الصوتية والألعاب ----------
insert into storage.buckets (id, name, public, file_size_limit)
values ('audio', 'audio', false, 15728640), ('games', 'games', false, 20971520)
on conflict (id) do nothing;

drop policy if exists fasl_audio_teacher on storage.objects;
create policy fasl_audio_teacher on storage.objects for all to authenticated
  using (bucket_id in ('audio','games') and public.is_teacher())
  with check (bucket_id in ('audio','games') and public.is_teacher());

drop policy if exists fasl_audio_student_read on storage.objects;
create policy fasl_audio_student_read on storage.objects for select to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = public.my_student_id());

drop policy if exists fasl_audio_student_insert on storage.objects;
create policy fasl_audio_student_insert on storage.objects for insert to authenticated
  with check (bucket_id = 'audio' and (storage.foldername(name))[1] = public.my_student_id());

drop policy if exists fasl_audio_student_delete on storage.objects;
create policy fasl_audio_student_delete on storage.objects for delete to authenticated
  using (bucket_id = 'audio' and (storage.foldername(name))[1] = public.my_student_id());

drop policy if exists fasl_games_read on storage.objects;
create policy fasl_games_read on storage.objects for select to authenticated
  using (bucket_id = 'games' and public.my_student_id() is not null);

select 'تم إعداد قاعدة البيانات بنجاح ✅' as result;
