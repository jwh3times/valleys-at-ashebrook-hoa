-- Apply before deploying code that reads plat_lot_number. Old code is compatible.
-- Source-verified assignments are separate audited roster writes, never guessed here.
ALTER TABLE lots ADD COLUMN plat_lot_number TEXT CHECK (plat_lot_number IS NULL OR (
    length(plat_lot_number) BETWEEN 1 AND 7
    AND substr(plat_lot_number, 1, 1) BETWEEN '1' AND '9'
    AND ((length(plat_lot_number) <= 6 AND plat_lot_number NOT GLOB '*[^0-9]*')
      OR (length(plat_lot_number) >= 2 AND substr(plat_lot_number, -1) GLOB '[A-Z]'
        AND substr(plat_lot_number, 1, length(plat_lot_number) - 1) NOT GLOB '*[^0-9]*'))
  ));
--> statement-breakpoint
CREATE UNIQUE INDEX lots_plat_lot_number_unq ON lots (plat_lot_number);
