-- Curated corrections for gaps in ESPN's feed (data/curated/game_corrections.json).
-- Curated games have no ESPN event id (espn_id is already nullable; UNIQUE allows multiple NULLs).

alter table games
  add column if not exists is_curated   boolean not null default false,
  add column if not exists time_unknown boolean not null default false;  -- game_date holds the day only (00:00 UTC)

alter table seasons
  add column if not exists conference_record_is_curated boolean not null default false;
