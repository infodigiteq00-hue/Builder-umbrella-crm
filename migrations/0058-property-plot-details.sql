-- Plots (residential or commercial land) as a property type. A plot has no
-- BHK / floors / tower / age, so it keeps its own facts instead. All TEXT so
-- the PROPERTY_EXTRA_MAX registry can save them like the other extras:
--   plot_area         number as typed ('2400', '2.5'); plot_area_unit: sqft | sqyd | guntha | acre
--   plot_dimensions   free text, e.g. '30x60'
--   plot_facing       north | south | east | west | north_east | north_west | south_east | south_west
--   plot_road_width   feet, whole number as text
--   plot_corner / plot_boundary_wall / plot_clear_title   'yes' | 'no'
--   plot_land_use     na | agricultural | residential | commercial | industrial
ALTER TABLE properties ADD COLUMN plot_area TEXT;
ALTER TABLE properties ADD COLUMN plot_area_unit TEXT;
ALTER TABLE properties ADD COLUMN plot_dimensions TEXT;
ALTER TABLE properties ADD COLUMN plot_facing TEXT;
ALTER TABLE properties ADD COLUMN plot_road_width TEXT;
ALTER TABLE properties ADD COLUMN plot_corner TEXT;
ALTER TABLE properties ADD COLUMN plot_boundary_wall TEXT;
ALTER TABLE properties ADD COLUMN plot_land_use TEXT;
ALTER TABLE properties ADD COLUMN plot_clear_title TEXT;
