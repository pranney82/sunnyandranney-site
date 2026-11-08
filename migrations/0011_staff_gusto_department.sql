-- Gusto holds the store and the charity as one company. Its department tells
-- them apart: "Sunny & Ranney" is the store. Both columns are copied from Gusto
-- on every employee sync and never edited here.
ALTER TABLE staff ADD COLUMN gusto_department TEXT;
ALTER TABLE staff ADD COLUMN gusto_terminated INTEGER NOT NULL DEFAULT 0;
