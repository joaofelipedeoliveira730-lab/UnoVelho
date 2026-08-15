SELECT table_name FROM information_schema.tables WHERE table_schema='public' ORDER BY table_name;
SELECT column_name, data_type FROM information_schema.columns WHERE table_schema='public' AND table_name='profiles' ORDER BY ordinal_position;
