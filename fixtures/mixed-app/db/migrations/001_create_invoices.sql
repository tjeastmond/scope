-- Invoices and their customers.
CREATE TABLE customers (
  id text PRIMARY KEY,
  name text NOT NULL,
  email text NOT NULL UNIQUE
);

CREATE TABLE invoices (
  id text PRIMARY KEY,
  number text NOT NULL UNIQUE,
  customer_id text NOT NULL REFERENCES customers (id),
  total_cents integer NOT NULL CHECK (total_cents >= 0),
  status text NOT NULL DEFAULT 'open',
  due_date date NOT NULL,
  reminded_at timestamptz
);
