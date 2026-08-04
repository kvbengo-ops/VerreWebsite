-- Historical order lines must retain their product relationship. Products with
-- history are archived by the application; this constraint is the final guard
-- against a raced or out-of-band physical delete.
alter table order_items
  drop constraint if exists order_items_product_id_fkey;

alter table order_items
  add constraint order_items_product_id_fkey
  foreign key (product_id) references products(id) on delete restrict;
