-- Extra answers from the two-step website form. whatsapp_opt_in: NULL = not a website lead / unknown,
-- 1 = the visitor ticked the WhatsApp opt-in, 0 = a website lead who did not (never message them on WhatsApp).
ALTER TABLE leads ADD COLUMN purpose TEXT;
ALTER TABLE leads ADD COLUMN current_home TEXT;
ALTER TABLE leads ADD COLUMN whatsapp_opt_in INTEGER CHECK (whatsapp_opt_in IS NULL OR whatsapp_opt_in IN (0, 1));
