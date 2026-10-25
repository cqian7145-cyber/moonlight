CREATE TYPE "public"."attempt_mode" AS ENUM('solo', 'duo');--> statement-breakpoint
CREATE TYPE "public"."attempt_status" AS ENUM('in_progress', 'completed', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."play_group_status" AS ENUM('open', 'paired', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."publication_status" AS ENUM('active', 'inactive');--> statement-breakpoint
CREATE TYPE "public"."template_status" AS ENUM('draft', 'archived');--> statement-breakpoint
CREATE TYPE "public"."venue_status" AS ENUM('active', 'suspended', 'archived');--> statement-breakpoint
CREATE TABLE "activity_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"title" varchar(160) NOT NULL,
	"status" "template_status" DEFAULT 'draft' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_templates_id_venue_unique" UNIQUE("id","venue_id"),
	CONSTRAINT "activity_templates_title_nonempty" CHECK (length(trim("activity_templates"."title")) > 0)
);
--> statement-breakpoint
CREATE TABLE "activity_versions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"version_no" integer NOT NULL,
	"content" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "activity_versions_id_venue_unique" UNIQUE("id","venue_id"),
	CONSTRAINT "activity_versions_positive_version" CHECK ("activity_versions"."version_no" > 0),
	CONSTRAINT "activity_versions_has_cues" CHECK (jsonb_typeof("activity_versions"."content") = 'object' AND CASE
      WHEN jsonb_typeof("activity_versions"."content" -> 'cues') = 'array'
      THEN jsonb_array_length("activity_versions"."content" -> 'cues') > 0
      ELSE false
    END)
);
--> statement-breakpoint
CREATE TABLE "attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"publication_id" uuid NOT NULL,
	"play_group_id" uuid,
	"mode" "attempt_mode" DEFAULT 'solo' NOT NULL,
	"status" "attempt_status" DEFAULT 'in_progress' NOT NULL,
	"session_token_hash" varchar(128) NOT NULL,
	"consented_at" timestamp with time zone,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "attempts_session_token_hash_nonempty" CHECK (length(trim("attempts"."session_token_hash")) > 0),
	CONSTRAINT "attempts_mode_group_consent_match" CHECK (("attempts"."mode" = 'solo' AND "attempts"."play_group_id" IS NULL AND "attempts"."consented_at" IS NULL)
      OR ("attempts"."mode" = 'duo' AND "attempts"."play_group_id" IS NOT NULL AND "attempts"."consented_at" IS NOT NULL)),
	CONSTRAINT "attempts_completion_timestamp_matches_status" CHECK (("attempts"."status" = 'completed' AND "attempts"."completed_at" IS NOT NULL)
      OR ("attempts"."status" <> 'completed' AND "attempts"."completed_at" IS NULL)),
	CONSTRAINT "attempts_completion_after_start" CHECK ("attempts"."completed_at" IS NULL OR "attempts"."completed_at" >= "attempts"."started_at")
);
--> statement-breakpoint
CREATE TABLE "feedback" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"rating" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "feedback_rating_in_range" CHECK ("feedback"."rating" BETWEEN 1 AND 5)
);
--> statement-breakpoint
CREATE TABLE "play_groups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"publication_id" uuid NOT NULL,
	"table_id" uuid,
	"invite_code_hash" varchar(128) NOT NULL,
	"status" "play_group_status" DEFAULT 'open' NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "play_groups_id_publication_unique" UNIQUE("id","publication_id"),
	CONSTRAINT "play_groups_invite_code_hash_nonempty" CHECK (length(trim("play_groups"."invite_code_hash")) > 0),
	CONSTRAINT "play_groups_expiry_after_creation" CHECK ("play_groups"."expires_at" > "play_groups"."created_at")
);
--> statement-breakpoint
CREATE TABLE "publications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"version_id" uuid NOT NULL,
	"status" "publication_status" DEFAULT 'active' NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deactivated_at" timestamp with time zone,
	CONSTRAINT "publications_id_venue_unique" UNIQUE("id","venue_id"),
	CONSTRAINT "publications_status_timestamps_match" CHECK (("publications"."status" = 'active' AND "publications"."deactivated_at" IS NULL)
      OR ("publications"."status" = 'inactive' AND "publications"."deactivated_at" IS NOT NULL)),
	CONSTRAINT "publications_deactivation_after_activation" CHECK ("publications"."deactivated_at" IS NULL OR "publications"."deactivated_at" >= "publications"."activated_at")
);
--> statement-breakpoint
CREATE TABLE "submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"attempt_id" uuid NOT NULL,
	"cue_key" varchar(100) NOT NULL,
	"answer" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "submissions_cue_key_nonempty" CHECK (length(trim("submissions"."cue_key")) > 0)
);
--> statement-breakpoint
CREATE TABLE "venue_tables" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"venue_id" uuid NOT NULL,
	"name" varchar(80) NOT NULL,
	"public_code_hash" varchar(128) NOT NULL,
	"is_enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venue_tables_id_venue_unique" UNIQUE("id","venue_id"),
	CONSTRAINT "venue_tables_name_nonempty" CHECK (length(trim("venue_tables"."name")) > 0),
	CONSTRAINT "venue_tables_public_code_hash_nonempty" CHECK (length(trim("venue_tables"."public_code_hash")) > 0)
);
--> statement-breakpoint
CREATE TABLE "venues" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" varchar(160) NOT NULL,
	"timezone" varchar(64) DEFAULT 'Asia/Shanghai' NOT NULL,
	"status" "venue_status" DEFAULT 'active' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "venues_name_nonempty" CHECK (length(trim("venues"."name")) > 0),
	CONSTRAINT "venues_timezone_nonempty" CHECK (length(trim("venues"."timezone")) > 0)
);
--> statement-breakpoint
ALTER TABLE "activity_templates" ADD CONSTRAINT "activity_templates_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "activity_versions" ADD CONSTRAINT "activity_versions_template_venue_fk" FOREIGN KEY ("template_id","venue_id") REFERENCES "public"."activity_templates"("id","venue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_group_publication_fk" FOREIGN KEY ("play_group_id","publication_id") REFERENCES "public"."play_groups"("id","publication_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attempts" ADD CONSTRAINT "attempts_publication_fk" FOREIGN KEY ("publication_id") REFERENCES "public"."publications"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "feedback" ADD CONSTRAINT "feedback_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_groups" ADD CONSTRAINT "play_groups_publication_venue_fk" FOREIGN KEY ("publication_id","venue_id") REFERENCES "public"."publications"("id","venue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "play_groups" ADD CONSTRAINT "play_groups_table_venue_fk" FOREIGN KEY ("table_id","venue_id") REFERENCES "public"."venue_tables"("id","venue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "publications" ADD CONSTRAINT "publications_version_venue_fk" FOREIGN KEY ("version_id","venue_id") REFERENCES "public"."activity_versions"("id","venue_id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "submissions" ADD CONSTRAINT "submissions_attempt_id_attempts_id_fk" FOREIGN KEY ("attempt_id") REFERENCES "public"."attempts"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "venue_tables" ADD CONSTRAINT "venue_tables_venue_id_venues_id_fk" FOREIGN KEY ("venue_id") REFERENCES "public"."venues"("id") ON DELETE restrict ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "activity_versions_template_version_unique" ON "activity_versions" USING btree ("template_id","version_no");--> statement-breakpoint
CREATE UNIQUE INDEX "attempts_session_token_hash_unique" ON "attempts" USING btree ("session_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "feedback_attempt_unique" ON "feedback" USING btree ("attempt_id");--> statement-breakpoint
CREATE UNIQUE INDEX "play_groups_invite_code_hash_unique" ON "play_groups" USING btree ("invite_code_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "publications_one_active_per_venue" ON "publications" USING btree ("venue_id") WHERE "publications"."status" = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX "submissions_attempt_cue_unique" ON "submissions" USING btree ("attempt_id","cue_key");--> statement-breakpoint
CREATE UNIQUE INDEX "venue_tables_public_code_hash_unique" ON "venue_tables" USING btree ("public_code_hash");
--> statement-breakpoint
-- Drizzle Kit does not model PostgreSQL triggers; keep this invariant in the reviewed migration.
CREATE FUNCTION "public"."reject_activity_version_mutation"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
	RAISE EXCEPTION 'activity_versions are immutable; create a new version instead'
		USING ERRCODE = '55000';
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "activity_versions_immutable"
BEFORE UPDATE OR DELETE ON "public"."activity_versions"
FOR EACH ROW EXECUTE FUNCTION "public"."reject_activity_version_mutation"();
--> statement-breakpoint
-- Validate the complete JSONB cue shape at the database boundary.
CREATE FUNCTION "public"."validate_activity_version_content"()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
	cue jsonb;
	choice jsonb;
	cue_count integer;
	unique_cue_key_count integer;
BEGIN
	IF jsonb_typeof(NEW."content") IS DISTINCT FROM 'object' THEN
		RAISE EXCEPTION 'activity version content must be an object' USING ERRCODE = '23514';
	END IF;
	IF jsonb_typeof(NEW."content" -> 'cues') IS DISTINCT FROM 'array' THEN
		RAISE EXCEPTION 'activity version content must contain a cues array' USING ERRCODE = '23514';
	END IF;
	IF jsonb_array_length(NEW."content" -> 'cues') = 0 THEN
		RAISE EXCEPTION 'activity version cues must not be empty' USING ERRCODE = '23514';
	END IF;

	FOR cue IN SELECT value FROM jsonb_array_elements(NEW."content" -> 'cues') AS items(value)
	LOOP
		IF jsonb_typeof(cue) IS DISTINCT FROM 'object'
			OR jsonb_typeof(cue -> 'key') IS DISTINCT FROM 'string'
			OR jsonb_typeof(cue -> 'prompt') IS DISTINCT FROM 'string' THEN
			RAISE EXCEPTION 'each cue must have string key and prompt fields' USING ERRCODE = '23514';
		END IF;
		IF length(trim(cue ->> 'key')) = 0 OR length(trim(cue ->> 'prompt')) = 0 THEN
			RAISE EXCEPTION 'cue keys and prompts must not be empty' USING ERRCODE = '23514';
		END IF;
		IF jsonb_typeof(cue -> 'choices') IS DISTINCT FROM 'array' THEN
			RAISE EXCEPTION 'each cue must contain a choices array' USING ERRCODE = '23514';
		END IF;
		IF jsonb_array_length(cue -> 'choices') < 2 THEN
			RAISE EXCEPTION 'each cue must contain at least two choices' USING ERRCODE = '23514';
		END IF;
		FOR choice IN SELECT value FROM jsonb_array_elements(cue -> 'choices') AS options(value)
		LOOP
			IF jsonb_typeof(choice) IS DISTINCT FROM 'string' OR length(trim(choice #>> '{}')) = 0 THEN
				RAISE EXCEPTION 'cue choices must be non-empty strings' USING ERRCODE = '23514';
			END IF;
		END LOOP;
	END LOOP;

	SELECT count(*), count(DISTINCT value ->> 'key')
	INTO cue_count, unique_cue_key_count
	FROM jsonb_array_elements(NEW."content" -> 'cues') AS items(value);
	IF cue_count <> unique_cue_key_count THEN
		RAISE EXCEPTION 'cue keys must be unique within a version' USING ERRCODE = '23514';
	END IF;
	RETURN NEW;
END;
$$;
--> statement-breakpoint
CREATE TRIGGER "activity_versions_validate_content"
BEFORE INSERT ON "public"."activity_versions"
FOR EACH ROW EXECUTE FUNCTION "public"."validate_activity_version_content"();
