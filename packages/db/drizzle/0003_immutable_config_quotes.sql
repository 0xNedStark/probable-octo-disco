-- Published configuration is immutable: publish a new version instead.
CREATE TRIGGER config_versions_append_only
  BEFORE UPDATE OR DELETE ON config_versions
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
-- A quote's calculation can never change after it is stored; only its lifecycle fields can.
CREATE OR REPLACE FUNCTION forbid_quote_calc_change() RETURNS trigger AS $$
BEGIN
  IF NEW.input IS DISTINCT FROM OLD.input
     OR NEW.output IS DISTINCT FROM OLD.output
     OR NEW.output_hash IS DISTINCT FROM OLD.output_hash
     OR NEW.config_version_ids IS DISTINCT FROM OLD.config_version_ids
     OR NEW.config_hash IS DISTINCT FROM OLD.config_hash
     OR NEW.calc_version IS DISTINCT FROM OLD.calc_version
     OR NEW.total_paise IS DISTINCT FROM OLD.total_paise
     OR NEW.version IS DISTINCT FROM OLD.version
     OR NEW.project_id IS DISTINCT FROM OLD.project_id THEN
    RAISE EXCEPTION 'solar_quotes calculation fields are immutable' USING ERRCODE = 'insufficient_privilege';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER solar_quotes_calc_immutable
  BEFORE UPDATE ON solar_quotes
  FOR EACH ROW EXECUTE FUNCTION forbid_quote_calc_change();
--> statement-breakpoint
CREATE TRIGGER solar_quotes_no_delete
  BEFORE DELETE ON solar_quotes
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
