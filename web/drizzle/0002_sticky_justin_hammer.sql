ALTER TABLE "activity_templates" ADD COLUMN "draft_content" jsonb;--> statement-breakpoint
ALTER TABLE "activity_templates" ADD CONSTRAINT "activity_templates_draft_content_shape" CHECK ("activity_templates"."draft_content" IS NULL OR (
    jsonb_typeof("activity_templates"."draft_content") = 'object' AND
    jsonb_typeof("activity_templates"."draft_content" -> 'cues') = 'array' AND
    jsonb_array_length("activity_templates"."draft_content" -> 'cues') = 3
  ));