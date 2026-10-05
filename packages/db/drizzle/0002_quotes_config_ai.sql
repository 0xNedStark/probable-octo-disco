CREATE TABLE "ai_actions" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text,
	"agent" text NOT NULL,
	"prompt_version" text NOT NULL,
	"model" text NOT NULL,
	"input_ref" jsonb NOT NULL,
	"output" jsonb,
	"outcome" text NOT NULL,
	"error" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "config_versions" (
	"id" text PRIMARY KEY NOT NULL,
	"kind" text NOT NULL,
	"version" integer NOT NULL,
	"body" jsonb NOT NULL,
	"body_hash" text NOT NULL,
	"note" text NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "solar_quotes" (
	"id" text PRIMARY KEY NOT NULL,
	"project_id" text NOT NULL,
	"version" integer NOT NULL,
	"grade" text NOT NULL,
	"status" text DEFAULT 'DRAFT' NOT NULL,
	"calc_version" text NOT NULL,
	"config_version_ids" jsonb NOT NULL,
	"config_hash" text NOT NULL,
	"input" jsonb NOT NULL,
	"output" jsonb NOT NULL,
	"output_hash" text NOT NULL,
	"system_kw" text NOT NULL,
	"total_paise" bigint NOT NULL,
	"share_token_hash" text,
	"valid_until" date NOT NULL,
	"created_by" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"sent_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	CONSTRAINT "solar_quotes_share_token_hash_unique" UNIQUE("share_token_hash")
);
--> statement-breakpoint
ALTER TABLE "bill_readings" ADD COLUMN "status" text DEFAULT 'confirmed' NOT NULL;--> statement-breakpoint
ALTER TABLE "bill_readings" ADD COLUMN "confirmed_by" text;--> statement-breakpoint
ALTER TABLE "bill_readings" ADD COLUMN "confirmed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "ai_actions" ADD CONSTRAINT "ai_actions_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "config_versions" ADD CONSTRAINT "config_versions_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solar_quotes" ADD CONSTRAINT "solar_quotes_project_id_solar_projects_id_fk" FOREIGN KEY ("project_id") REFERENCES "public"."solar_projects"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "solar_quotes" ADD CONSTRAINT "solar_quotes_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "ai_actions_project_idx" ON "ai_actions" USING btree ("project_id");--> statement-breakpoint
CREATE UNIQUE INDEX "config_kind_version_idx" ON "config_versions" USING btree ("kind","version");--> statement-breakpoint
CREATE UNIQUE INDEX "quotes_project_version_idx" ON "solar_quotes" USING btree ("project_id","version");--> statement-breakpoint
ALTER TABLE "bill_readings" ADD CONSTRAINT "bill_readings_confirmed_by_users_id_fk" FOREIGN KEY ("confirmed_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;