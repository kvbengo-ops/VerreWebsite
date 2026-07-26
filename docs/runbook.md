# Verre operations runbook

## Rotate a Supabase service-role key

1. Pause admin and POS use; confirm every POS shows `Pending 0`.
2. Generate the replacement in Supabase, update `SUPABASE_SERVICE_ROLE_KEY` in
   the Worker/Sites environment, deploy, and verify `/api/products`.
3. Verify an authenticated `/api/admin/me` request and one reversible `made`
   stock adjustment.
4. Revoke the old key. Never put either key in client code, logs, or chat.

## Restore a backup

1. Put admin/POS behind a maintenance Access policy and keep devices from
   syncing.
2. Restore the chosen Supabase backup to a separate project first.
3. Run the integrity queries below and compare order/ledger counts with the
   source project.
4. Point a staging Worker at the restored project and test catalog, one receipt,
   order history, and an idempotent replay.
5. Only then update production secrets and reopen Access. Preserve the old
   project read-only until the next verified backup.

```sql
select * from ledger_drift;
select count(*) from orders where total_cents <> subtotal_cents - discount_cents;
select count(*) from order_items where product_name is null or unit_price_cents is null;
select client_uuid, count(*) from orders where client_uuid is not null
group by client_uuid having count(*) > 1;
```

## Reconcile a bad stocktake

Never edit or delete the incorrect movement. Count the physical stock again,
find the bad `stocktake` movement in Admin → Inventory, and record a new
`stocktake` adjustment for the difference with a note referencing the original
date. Confirm the product disappears from `ledger_drift`.

## Phase 9 rollback

If Supabase is unavailable, the Worker serves `CATALOG_CACHE`'s
`catalog:snapshot`, then its code-owned fallback. To fully roll back, deploy the
previous saved Sites version; do not restore the deleted browser catalog by
hand. Existing receipts and queued POS sales remain in Supabase/IndexedDB.

## Nightly checks

Schedule a daily call to the ledger-drift query and alert if it returns rows.
Also alert on open POS sessions older than 24 hours, active sold-out products,
and oversell orders. Backups are not considered ready until the restore
procedure above has been completed against a disposable project.
