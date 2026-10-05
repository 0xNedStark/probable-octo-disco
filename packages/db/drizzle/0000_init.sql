CREATE SEQUENCE "public"."project_code_seq" INCREMENT BY 1 MINVALUE 1 MAXVALUE 9223372036854775807 START WITH 1 CACHE 1;--> statement-breakpoint
CREATE TABLE "bill_readings" (
	"id" text PRIMARY KEY NOT NULL,
	"bill_id" text NOT NULL,
	"project_id" text NOT NULL,
	"consumer_number" text NOT NULL,
	"discom" text NOT NULL,
	"tariff_category" text NOT NULL,
	"sanctioned_load_w" integer NOT NULL,
	"period_start" date NOT NULL,
	"period_end" date NOT NULL,
	"units_kwh" integer NOT NULL,
	"amount_paise" bigint NOT NULL,
	"monthly_history" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"source" text NOT NULL,
	"confidence" jsonb,
	"entered_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "consents" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"purpose" text NOT NULL,
	"text_version" text NOT NULL,
	"channel" text NOT NULL,
	"granted_at" timestamp with time zone DEFAULT now() NOT NULL,
	"withdrawn_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"phone" text NOT NULL,
	"city" text NOT NULL,
	"pincode" text,
	"discom" text,
	"consumer_number" text,
	"preferred_language" text DEFAULT 'hi' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "customers_phone_unique" UNIQUE("phone")
);
--> statement-breakpoint
CREATE TABLE "electricity_bills" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"customer_id" text NOT NULL,
	"storage_key" text NOT NULL,
	"original_filename" text NOT NULL,
	"content_type" text NOT NULL,
	"size_bytes" integer NOT NULL,
	"sha256" text NOT NULL,
	"source" text NOT NULL,
	"uploaded_by" text,
	"uploaded_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "file_access_log" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"bill_id" text NOT NULL,
	"project_id" text NOT NULL,
	"accessed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "leads" (
	"id" text PRIMARY KEY NOT NULL,
	"customer_id" text NOT NULL,
	"source" text NOT NULL,
	"campaign" text,
	"referrer" text,
	"stated_monthly_bill_paise" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"channel" text NOT NULL,
	"template" text NOT NULL,
	"recipient" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_at" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_events" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"type" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"reason" text,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "project_facts" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"fact" text NOT NULL,
	"value" boolean NOT NULL,
	"source" text NOT NULL,
	"note" text,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "solar_projects" (
	"id" text PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"customer_id" text NOT NULL,
	"lead_id" text,
	"stage" text NOT NULL,
	"held_from_stage" text,
	"bill_state" text NOT NULL,
	"finance_state" text NOT NULL,
	"regulatory_state" text NOT NULL,
	"procurement_state" text NOT NULL,
	"installation_state" text NOT NULL,
	"vendor_of_record_id" text,
	"billing_entity" text,
	"owner_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "solar_projects_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"type" text NOT NULL,
	"title" text NOT NULL,
	"status" text DEFAULT 'OPEN' NOT NULL,
	"role" text NOT NULL,
	"assignee_user_id" text,
	"due_at" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"completed_by" text,
	"effort_minutes" integer,
	"outcome" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" text PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"password_hash" text NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"failed_logins" integer DEFAULT 0 NOT NULL,
	"locked_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_email_unique" UNIQUE("email")
);
--> statement-breakpoint
ALTER TABLE "bill_readings" ADD CONSTRAINT "bill_readings_bill_id_electricity_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."electricity_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_readings" ADD CONSTRAINT "bill_readings_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bill_readings" ADD CONSTRAINT "bill_readings_entered_by_users_id_fk" FOREIGN KEY ("entered_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "consents" ADD CONSTRAINT "consents_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electricity_bills" ADD CONSTRAINT "electricity_bills_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electricity_bills" ADD CONSTRAINT "electricity_bills_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "electricity_bills" ADD CONSTRAINT "electricity_bills_uploaded_by_users_id_fk" FOREIGN KEY ("uploaded_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_log" ADD CONSTRAINT "file_access_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_log" ADD CONSTRAINT "file_access_log_bill_id_electricity_bills_id_fk" FOREIGN KEY ("bill_id") REFERENCES "public"."electricity_bills"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "file_access_log" ADD CONSTRAINT "file_access_log_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "leads" ADD CONSTRAINT "leads_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbox" ADD CONSTRAINT "outbox_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_events" ADD CONSTRAINT "project_events_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "project_facts" ADD CONSTRAINT "project_facts_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solar_projects" ADD CONSTRAINT "solar_projects_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solar_projects" ADD CONSTRAINT "solar_projects_lead_id_leads_id_fk" FOREIGN KEY ("lead_id") REFERENCES "public"."leads"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solar_projects" ADD CONSTRAINT "solar_projects_owner_user_id_users_id_fk" FOREIGN KEY ("owner_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_users_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_completed_by_users_id_fk" FOREIGN KEY ("completed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "readings_project_idx" ON "bill_readings" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "consents_customer_idx" ON "consents" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "bills_project_idx" ON "electricity_bills" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "bills_sha_idx" ON "electricity_bills" USING btree ("sha256");--> statement-breakpoint
CREATE INDEX "outbox_pending_idx" ON "outbox" USING btree ("available_at") WHERE "outbox"."status" in ('pending', 'processing');--> statement-breakpoint
CREATE INDEX "events_project_idx" ON "project_events" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "facts_project_idx" ON "project_facts" USING btree ("project_id","fact","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "projects_stage_idx" ON "solar_projects" USING btree ("stage");--> statement-breakpoint
CREATE INDEX "projects_customer_idx" ON "solar_projects" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "tasks_open_idx" ON "tasks" USING btree ("due_at") WHERE "tasks"."status" = 'OPEN';--> statement-breakpoint
CREATE INDEX "tasks_project_idx" ON "tasks" USING btree ("project_id");