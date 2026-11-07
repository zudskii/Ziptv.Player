import { sql, type Kysely } from 'kysely';

/**
 * Commercial catalogue (Phase 17): the business model is configuration, not code.
 *
 *   packages          a plan = a set of entitlements:
 *                       channels (package_channels, shared by every version of the plan),
 *                       vod_mode included | package (vod_packages = the vendor packages it opens) | none,
 *                       max_quality (null = whatever the licence allows), catchup_days (null = the licence),
 *                       max_streams / max_devices (already there)
 *                     + family_id / version / superseded_by: changing the terms of a plan that people
 *                       hold creates a new version; holders keep theirs (grandfathering)
 *   package_prices    the price in a country (GEL in GE, EUR in DE…); elsewhere the base price
 *   promo_codes       percent or fixed discount on the first payment, per plan family, dated, capped
 *                       (created through four-eyes approval: change_requests kind 'promo.create')
 *   promo_redemptions one per code and account (the checkout that used it)
 *   checkouts         + the price the viewer was quoted (country, promo, discount)
 *   subscriptions     + the price this subscriber pays (kept when the plan gets a new version)
 *   providers         + contract terms for the partner report: minimum guarantee (per month),
 *                       catch-up minutes weight in the revenue share, catch-up fee per viewing hour
 */
export async function up(db: Kysely<unknown>): Promise<void> {
  await sql
    .raw(
      `
ALTER TABLE packages ADD COLUMN vod_mode text NOT NULL DEFAULT 'none' CHECK (vod_mode IN ('included', 'package', 'none'));
ALTER TABLE packages ADD COLUMN vod_packages uuid[] NOT NULL DEFAULT '{}';
ALTER TABLE packages ADD COLUMN max_quality text CHECK (max_quality IN ('sd', 'hd', 'fhd', 'uhd'));
ALTER TABLE packages ADD COLUMN catchup_days integer CHECK (catchup_days BETWEEN 0 AND 30);
ALTER TABLE packages ADD COLUMN family_id uuid;
ALTER TABLE packages ADD COLUMN version integer NOT NULL DEFAULT 1 CHECK (version >= 1);
ALTER TABLE packages ADD COLUMN superseded_by uuid REFERENCES packages (id);
UPDATE packages SET family_id = id;
ALTER TABLE packages ALTER COLUMN family_id SET NOT NULL;
-- A plan created without a family starts its own (its first version).
CREATE FUNCTION packages_default_family() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.family_id := coalesce(NEW.family_id, NEW.id);
  RETURN NEW;
END $$;
CREATE TRIGGER packages_default_family BEFORE INSERT ON packages FOR EACH ROW EXECUTE FUNCTION packages_default_family();
CREATE UNIQUE INDEX packages_family_version_idx ON packages (family_id, version);

CREATE TABLE package_prices (
  package_id  uuid    NOT NULL REFERENCES packages (id) ON DELETE CASCADE,
  country     text    NOT NULL CHECK (country ~ '^[A-Z]{2}$'),
  currency    text    NOT NULL CHECK (currency ~ '^[A-Z]{3}$'),
  price_minor integer NOT NULL CHECK (price_minor >= 0),
  PRIMARY KEY (package_id, country)
);

CREATE TABLE promo_codes (
  id              uuid        PRIMARY KEY,
  code            text        NOT NULL UNIQUE CHECK (code ~ '^[A-Z0-9_-]{3,32}$'),
  kind            text        NOT NULL CHECK (kind IN ('percent', 'amount')),
  value           integer     NOT NULL CHECK (value > 0),
  currency        text        CHECK (currency ~ '^[A-Z]{3}$'),
  -- plan families the code applies to; empty = every plan
  families        uuid[]      NOT NULL DEFAULT '{}',
  max_redemptions integer     CHECK (max_redemptions > 0),
  redemptions     integer     NOT NULL DEFAULT 0,
  starts_at       timestamptz NOT NULL DEFAULT now(),
  ends_at         timestamptz,
  active          boolean     NOT NULL DEFAULT true,
  note            text        NOT NULL DEFAULT '',
  created_by      uuid,
  created_at      timestamptz NOT NULL DEFAULT now(),
  CHECK ((kind = 'amount') = (currency IS NOT NULL)),
  CHECK (kind <> 'percent' OR value <= 100),
  CHECK (ends_at IS NULL OR ends_at > starts_at)
);

CREATE TABLE promo_redemptions (
  promo_id    uuid        NOT NULL REFERENCES promo_codes (id) ON DELETE CASCADE,
  user_id     uuid        NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  checkout_id uuid        NOT NULL UNIQUE,
  at          timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (promo_id, user_id)
);

ALTER TABLE checkouts ADD COLUMN amount_minor integer CHECK (amount_minor >= 0);
ALTER TABLE checkouts ADD COLUMN currency text;
ALTER TABLE checkouts ADD COLUMN country text;
ALTER TABLE checkouts ADD COLUMN promo_id uuid REFERENCES promo_codes (id) ON DELETE SET NULL;
ALTER TABLE checkouts ADD COLUMN discount_minor integer NOT NULL DEFAULT 0 CHECK (discount_minor >= 0);

ALTER TABLE subscriptions ADD COLUMN price_minor integer CHECK (price_minor >= 0);
ALTER TABLE subscriptions ADD COLUMN currency text;

ALTER TABLE change_requests DROP CONSTRAINT change_requests_kind_check;
ALTER TABLE change_requests ADD CONSTRAINT change_requests_kind_check CHECK (kind IN ('package.create', 'package.update', 'rights.grant', 'rights.revoke', 'promo.create'));

ALTER TABLE providers ADD COLUMN minimum_guarantee_minor integer CHECK (minimum_guarantee_minor >= 0);
ALTER TABLE providers ADD COLUMN guarantee_currency text CHECK (guarantee_currency ~ '^[A-Z]{3}$');
ALTER TABLE providers ADD CONSTRAINT providers_guarantee_currency CHECK ((minimum_guarantee_minor IS NULL) = (guarantee_currency IS NULL));
ALTER TABLE providers ADD COLUMN catchup_weight numeric(4, 2) NOT NULL DEFAULT 1 CHECK (catchup_weight >= 0 AND catchup_weight <= 5);
ALTER TABLE providers ADD COLUMN catchup_fee_per_hour_minor integer CHECK (catchup_fee_per_hour_minor >= 0);
ALTER TABLE providers ADD COLUMN catchup_fee_currency text CHECK (catchup_fee_currency ~ '^[A-Z]{3}$');
ALTER TABLE providers ADD CONSTRAINT providers_catchup_fee_currency CHECK ((catchup_fee_per_hour_minor IS NULL) = (catchup_fee_currency IS NULL));
`,
    )
    .execute(db);
}
