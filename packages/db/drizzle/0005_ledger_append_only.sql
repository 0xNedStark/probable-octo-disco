-- Money movements are never edited: corrections are new, reversing entries.
CREATE TRIGGER ledger_entries_append_only
  BEFORE UPDATE OR DELETE ON ledger_entries
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
ALTER TABLE ledger_entries ADD CONSTRAINT ledger_amount_positive CHECK (amount_paise > 0);
--> statement-breakpoint
ALTER TABLE payments ADD CONSTRAINT payments_amount_positive CHECK (amount_paise > 0);
