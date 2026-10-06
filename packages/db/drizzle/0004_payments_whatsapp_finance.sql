CREATE TABLE "ledger_entries" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"payment_id" text,
	"debit_account" text NOT NULL,
	"credit_account" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"memo" text NOT NULL,
	"actor_type" text NOT NULL,
	"actor_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "loan_applications" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"lender" text NOT NULL,
	"product_id" text NOT NULL,
	"requested_paise" bigint NOT NULL,
	"status" text DEFAULT 'DOCS_PENDING' NOT NULL,
	"external_ref" text,
	"sanctioned_paise" bigint,
	"disbursed_paise" bigint,
	"checklist" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"note" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"customer_id" text,
	"channel" text NOT NULL,
	"direction" text NOT NULL,
	"provider_message_id" text,
	"phone" text NOT NULL,
	"kind" text NOT NULL,
	"body" text,
	"media_id" text,
	"media_mime_type" text,
	"author" text,
	"author_id" text,
	"outbox_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "messages_provider_message_id_unique" UNIQUE("provider_message_id")
);
--> statement-breakpoint
CREATE TABLE "otp_challenges" (
	"id" text PRIMARY KEY NOT NULL,
	"purpose" text NOT NULL,
	"subject_id" text NOT NULL,
	"phone" text NOT NULL,
	"code_hash" text NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"purpose" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"status" text DEFAULT 'CREATED' NOT NULL,
	"provider" text NOT NULL,
	"provider_ref" text,
	"provider_payment_id" text,
	"pay_url" text,
	"reference" text,
	"commercial_config_id" text,
	"quote_id" text,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	"refunded_at" timestamp with time zone,
	CONSTRAINT "payments_provider_ref_unique" UNIQUE("provider_ref"),
	CONSTRAINT "payments_provider_payment_id_unique" UNIQUE("provider_payment_id")
);
--> statement-breakpoint
CREATE TABLE "webhook_events" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"event_id" text NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb NOT NULL,
	"received_at" timestamp with time zone DEFAULT now() NOT NULL,
	"processed_at" timestamp with time zone,
	"error" text
);
--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ledger_entries" ADD CONSTRAINT "ledger_entries_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "loan_applications" ADD CONSTRAINT "loan_applications_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_quote_id_solar_quotes_id_fk" FOREIGN KEY ("quote_id") REFERENCES "public"."solar_quotes"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ledger_project_idx" ON "ledger_entries" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "loans_project_idx" ON "loan_applications" USING btree ("project_id");--> statement-breakpoint
CREATE INDEX "messages_phone_idx" ON "messages" USING btree ("phone","created_at");--> statement-breakpoint
CREATE INDEX "messages_project_idx" ON "messages" USING btree ("project_id","created_at");--> statement-breakpoint
CREATE INDEX "otp_subject_idx" ON "otp_challenges" USING btree ("purpose","subject_id","created_at");--> statement-breakpoint
CREATE INDEX "payments_project_idx" ON "payments" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "webhook_provider_event_idx" ON "webhook_events" USING btree ("provider","event_id");