-- Custom commissions need a stage between "paid" and "fulfilled".
--
-- Alone in its own migration on purpose. Postgres allows ALTER TYPE ... ADD
-- VALUE inside a transaction block, but the new label cannot be *used* in that
-- same transaction. Every migration file runs in one transaction, so putting
-- this beside the functions that reference 'in_production' would fail on a
-- fresh database and work on an existing one — the worst possible bug shape.

alter type order_status add value if not exists 'in_production' after 'paid';

-- The customer has accepted the quote but has not paid the deposit yet. Without
-- it, a commission sits in 'quoted' from the moment Kyle sends a price until
-- money arrives, which can be weeks, and the dashboard cannot tell the difference
-- between "waiting on the customer" and "Kyle hasn't replied yet".
alter type order_status add value if not exists 'awaiting_payment' after 'quoted';
