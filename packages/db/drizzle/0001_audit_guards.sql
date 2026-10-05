-- project_events and project_facts are append-only: the audit trail must be immutable.
CREATE OR REPLACE FUNCTION forbid_mutation() RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = 'insufficient_privilege';
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER project_events_append_only
  BEFORE UPDATE OR DELETE ON project_events
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
--> statement-breakpoint
CREATE TRIGGER project_facts_append_only
  BEFORE UPDATE OR DELETE ON project_facts
  FOR EACH ROW EXECUTE FUNCTION forbid_mutation();
