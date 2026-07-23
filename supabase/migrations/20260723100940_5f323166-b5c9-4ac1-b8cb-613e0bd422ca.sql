-- Reclaim pkey bloat on the hottest churn table (63 live rows, 25k+ ins/del).
REINDEX TABLE public.crypto_nonces;
REINDEX TABLE public.crypto_sessions;
REINDEX TABLE public.handshake_rate;

-- Match autovacuum aggressiveness to the write pattern so the pkey stays lean
-- (was: default scale 0.2 => vacuum kicks in only after ~thousands of dead tuples).
ALTER TABLE public.crypto_nonces  SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200, autovacuum_analyze_scale_factor = 0.05);
ALTER TABLE public.crypto_sessions SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_threshold = 200);
ALTER TABLE public.handshake_rate  SET (autovacuum_vacuum_scale_factor = 0.05, autovacuum_vacuum_threshold = 200);